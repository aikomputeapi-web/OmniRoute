/**
 * User Rate Limit Manager — subscription tier enforcement for OmniRoute.
 *
 * Enforces Pro and Pro Max request quotas across Anthropic and OpenAI traffic
 * using Redis-backed sliding windows and PostgreSQL plan lookup/caching.
 */

import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { createLogger } from "@/shared/utils/logger";
import {
  closePortalDb,
  getPlanLimits as getPortalPlanLimits,
  type PortalDbOptions,
} from "@/lib/portalDb";
import type { PlanLimits, QuotaInfo, QuotaWindowInfo, RateLimitResult } from "@/types/rateLimit";

const log = createLogger("user-rate-limit");

const PLAN_CACHE_TTL_SECONDS = 5 * 60;
const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MONTH_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;
const MINUTE_KEY_TTL_SECONDS = 60;
const DAY_KEY_TTL_SECONDS = 25 * 60 * 60;
const MONTH_KEY_TTL_SECONDS = 32 * 24 * 60 * 60;
const SUCCESS_COUNTER_PREFIX = "user-usage-success";

const BUILTIN_PLAN_LIMITS: Record<string, { planName: string; limits: PlanLimits }> = {
  free: {
    planName: "Free",
    limits: {
      requestsPerMinute: 5,
      requestsPerDay: 0,
      requestsPerMonth: 50,
    },
  },
  pro: {
    planName: "Pro",
    limits: {
      requestsPerMinute: 60,
      requestsPerDay: 10_000,
      requestsPerMonth: 300_000,
    },
  },
  "pro-max": {
    planName: "Pro Max",
    limits: {
      requestsPerMinute: 300,
      requestsPerDay: 100_000,
      requestsPerMonth: 3_000_000,
    },
  },
};

const CHECK_AND_RESERVE_SCRIPT = `
local minuteKey = KEYS[1]
local dayKey = KEYS[2]
local monthKey = KEYS[3]
local reserveId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local minuteWindowMs = tonumber(ARGV[3])
local dayStartMs = tonumber(ARGV[4])
local monthStartMs = tonumber(ARGV[5])
local minuteLimit = tonumber(ARGV[6])
local dayLimit = tonumber(ARGV[7])
local monthLimit = tonumber(ARGV[8])
local minuteTtl = tonumber(ARGV[9])
local dayTtl = tonumber(ARGV[10])
local monthTtl = tonumber(ARGV[11])

local function trim_and_count(key, windowStart)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart - 1)
  return redis.call("ZCARD", key)
end

local minuteCount = trim_and_count(minuteKey, nowMs - minuteWindowMs)
local dayCount = trim_and_count(dayKey, dayStartMs)
local monthCount = trim_and_count(monthKey, monthStartMs)

local blockedWindow = ""
local retryAfterSeconds = 0

if minuteLimit > 0 and minuteCount >= minuteLimit then
  blockedWindow = "minute"
  local oldest = redis.call("ZRANGE", minuteKey, 0, 0, "WITHSCORES")
  local oldestMinute = tonumber(oldest[2]) or nowMs
  retryAfterSeconds = math.max(1, math.ceil(((oldestMinute + minuteWindowMs) - nowMs) / 1000))
elseif dayLimit > 0 and dayCount >= dayLimit then
  blockedWindow = "day"
  retryAfterSeconds = math.max(1, math.ceil(((dayStartMs + 24 * 60 * 60 * 1000) - nowMs) / 1000))
elseif monthLimit > 0 and monthCount >= monthLimit then
  blockedWindow = "month"
  retryAfterSeconds = math.max(1, math.ceil(((monthStartMs + 32 * 24 * 60 * 60 * 1000) - nowMs) / 1000))
else
  redis.call("ZADD", minuteKey, nowMs, reserveId)
  redis.call("ZADD", dayKey, nowMs, reserveId)
  redis.call("ZADD", monthKey, nowMs, reserveId)
  redis.call("EXPIRE", minuteKey, minuteTtl)
  redis.call("EXPIRE", dayKey, dayTtl)
  redis.call("EXPIRE", monthKey, monthTtl)
  minuteCount = minuteCount + 1
  dayCount = dayCount + 1
  monthCount = monthCount + 1
end

return { blockedWindow, retryAfterSeconds, minuteCount, dayCount, monthCount }
`;

const SNAPSHOT_SCRIPT = `
local minuteKey = KEYS[1]
local dayKey = KEYS[2]
local monthKey = KEYS[3]
local nowMs = tonumber(ARGV[1])
local minuteWindowMs = tonumber(ARGV[2])
local dayStartMs = tonumber(ARGV[3])
local monthStartMs = tonumber(ARGV[4])

local function trim_and_count(key, windowStart)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart - 1)
  return redis.call("ZCARD", key)
end

local minuteCount = trim_and_count(minuteKey, nowMs - minuteWindowMs)
local dayCount = trim_and_count(dayKey, dayStartMs)
local monthCount = trim_and_count(monthKey, monthStartMs)

return { minuteCount, dayCount, monthCount }
`;

interface ResolvedPlanLimits extends PlanLimits {
  planName: string;
  source: "redis" | "database" | "fallback";
}

interface CachedPlanLimits extends ResolvedPlanLimits {
  cachedAt?: number;
}

export interface UserRateLimitManagerOptions {
  redisClient?: RedisClientType;
  portalDb?: Pick<typeof import("@/lib/portalDb"), "getPlanLimits">;
  portalDbOptions?: PortalDbOptions;
  failOpen?: boolean;
  unknownPlanFallback?: "free" | "reject";
  redisUrl?: string;
  enabled?: boolean;
}

export class UserRateLimitManager {
  private readonly redisClient: RedisClientType;
  private readonly portalDb: { getPlanLimits: typeof getPortalPlanLimits };
  private readonly portalDbOptions: PortalDbOptions;
  private readonly failOpen: boolean;
  private readonly unknownPlanFallback: "free" | "reject";
  private readonly enabled: boolean;
  private readonly ownsRedisClient: boolean;
  private connectPromise: Promise<void> | null = null;

  constructor(options: UserRateLimitManagerOptions = {}) {
    const env = getEnv();
    const redisUrl = options.redisUrl || env.REDIS_URL || env.REDIS_CONNECTION_STRING;

    this.redisClient =
      options.redisClient ||
      createClient({
        url: redisUrl,
      });

    this.portalDb = {
      getPlanLimits: options.portalDb?.getPlanLimits || getPortalPlanLimits,
    };
    this.portalDbOptions = options.portalDbOptions || {};
    this.failOpen = options.failOpen ?? readBoolEnv(env, "USER_RATE_LIMIT_FAIL_OPEN", false);
    this.unknownPlanFallback = options.unknownPlanFallback ?? "free";
    this.enabled = options.enabled ?? readBoolEnv(env, "USER_RATE_LIMIT_ENABLED", true);
    this.ownsRedisClient = !options.redisClient;

    this.redisClient.on?.("error", (error) => {
      log.error({ err: error }, "Redis client error");
    });
  }

  /**
   * Check whether a user may make another Anthropic/OpenAI request.
   *
   * Uses an atomic Redis Lua script to enforce a sliding window across the
   * minute, day, and month quotas and reserve the request when allowed.
   */
  async checkUserRateLimit(userId: string, planId: string): Promise<RateLimitResult> {
    const normalizedPlanId = normalizePlanId(planId);
    const plan = await this.resolvePlanLimits(normalizedPlanId);
    const nowMs = Date.now();

    if (!this.enabled) {
      return {
        allowed: true,
        quotaInfo: this.buildQuotaInfo(userId, normalizedPlanId, plan ?? getFallbackPlan(normalizedPlanId), null, null, null, nowMs),
      };
    }

    if (!plan) {
      const fallbackPlan = getFallbackPlan(normalizedPlanId);
      const quotaInfo = this.buildQuotaInfo(userId, normalizedPlanId, fallbackPlan, null, null, null, nowMs);
      if (this.failOpen) {
        return { allowed: true, reason: "dependency_unavailable", quotaInfo };
      }
      return {
        allowed: false,
        retryAfter: 60,
        reason: "unknown_plan",
        quotaInfo,
      };
    }

    try {
      const client = await this.getRedisClient();
      const { dayStartMs, monthStartMs } = getUtcWindowStarts(nowMs);
      const result = (await client.eval(CHECK_AND_RESERVE_SCRIPT, {
        keys: [this.getMinuteKey(userId), this.getDayKey(userId, nowMs), this.getMonthKey(userId, nowMs)],
        arguments: [
          randomUUID(),
          String(nowMs),
          String(MINUTE_WINDOW_MS),
          String(dayStartMs),
          String(monthStartMs),
          String(plan.requestsPerMinute),
          String(plan.requestsPerDay),
          String(plan.requestsPerMonth),
          String(MINUTE_KEY_TTL_SECONDS),
          String(DAY_KEY_TTL_SECONDS),
          String(MONTH_KEY_TTL_SECONDS),
        ],
      })) as unknown[];

      const blockedWindow = String(result[0] ?? "");
      const retryAfter = Number(result[1] ?? 0);
      const minuteUsed = Number(result[2] ?? 0);
      const dayUsed = Number(result[3] ?? 0);
      const monthUsed = Number(result[4] ?? 0);
      const quotaInfo = this.buildQuotaInfo(userId, normalizedPlanId, plan, minuteUsed, dayUsed, monthUsed, nowMs);

      if (blockedWindow) {
        return {
          allowed: false,
          retryAfter: retryAfter > 0 ? retryAfter : this.getRetryAfterForWindow(blockedWindow, nowMs),
          reason: `rate_limit_${blockedWindow}` as RateLimitResult["reason"],
          quotaInfo,
        };
      }

      return { allowed: true, quotaInfo };
    } catch (error) {
      log.error({ err: error, userId, planId: normalizedPlanId }, "Rate limit check failed");
      const quotaInfo = this.buildQuotaInfo(userId, normalizedPlanId, plan, null, null, null, nowMs);
      if (this.failOpen) {
        return { allowed: true, reason: "dependency_unavailable", quotaInfo };
      }
      return {
        allowed: false,
        retryAfter: 60,
        reason: "dependency_unavailable",
        quotaInfo,
      };
    }
  }

  /**
   * Record that a previously allowed request completed successfully.
   *
   * Quota reservation happens in {@link checkUserRateLimit}; this method only
   * increments an operational success counter for observability.
   */
  async incrementUserUsage(userId: string): Promise<void> {
    try {
      const client = await this.getRedisClient();
      const nowMs = Date.now();
      const key = `${SUCCESS_COUNTER_PREFIX}:${userId}:day:${formatUtcDay(nowMs)}`;
      await client.multi().incr(key).expire(key, DAY_KEY_TTL_SECONDS).exec();
    } catch (error) {
      log.error({ err: error, userId }, "Failed to increment user usage counter");
      if (!this.failOpen) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  /**
   * Return the current remaining quota for a user/plan pair.
   */
  async getUserQuotaInfo(userId: string, planId: string): Promise<QuotaInfo> {
    const normalizedPlanId = normalizePlanId(planId);
    const plan = (await this.resolvePlanLimits(normalizedPlanId)) || getFallbackPlan(normalizedPlanId);
    const nowMs = Date.now();

    try {
      const client = await this.getRedisClient();
      const { dayStartMs, monthStartMs } = getUtcWindowStarts(nowMs);
      const result = (await client.eval(SNAPSHOT_SCRIPT, {
        keys: [this.getMinuteKey(userId), this.getDayKey(userId, nowMs), this.getMonthKey(userId, nowMs)],
        arguments: [String(nowMs), String(MINUTE_WINDOW_MS), String(dayStartMs), String(monthStartMs)],
      })) as unknown[];

      return this.buildQuotaInfo(
        userId,
        normalizedPlanId,
        plan,
        Number(result[0] ?? 0),
        Number(result[1] ?? 0),
        Number(result[2] ?? 0),
        nowMs
      );
    } catch (error) {
      log.error({ err: error, userId, planId: normalizedPlanId }, "Failed to load quota info");
      if (this.failOpen) {
        return this.buildQuotaInfo(userId, normalizedPlanId, plan, null, null, null, nowMs);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Close the underlying Redis client if this manager created it.
   */
  async close(): Promise<void> {
    if (this.ownsRedisClient && this.redisClient.isOpen) {
      await this.redisClient.quit().catch((error) => {
        log.error({ err: error }, "Failed to close Redis client");
      });
    }
    await closePortalDb();
  }

  private async getRedisClient(): Promise<RedisClientType> {
    if (this.redisClient.isOpen || this.redisClient.isReady) {
      return this.redisClient;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.redisClient.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
    return this.redisClient;
  }

  private async resolvePlanLimits(planId: string): Promise<ResolvedPlanLimits | null> {
    const cacheKey = this.getPlanCacheKey(planId);
    try {
      const client = await this.getRedisClient();
      const cached = await client.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedPlanLimits;
        return {
          requestsPerMinute: Math.max(0, Number(parsed.requestsPerMinute ?? 0)),
          requestsPerDay: Math.max(0, Number(parsed.requestsPerDay ?? 0)),
          requestsPerMonth: Math.max(0, Number(parsed.requestsPerMonth ?? 0)),
          planName: parsed.planName || normalizePlanId(planId),
          source: "redis",
        };
      }
    } catch (error) {
      log.warn({ err: error, planId }, "Failed to read plan cache from Redis");
    }

    try {
      const dbLimits = await this.portalDb.getPlanLimits(planId, this.portalDbOptions);
      if (dbLimits) {
        const builtin = BUILTIN_PLAN_LIMITS[planId] || BUILTIN_PLAN_LIMITS[normalizePlanId(planId)];
        const planName = builtin?.planName || normalizePlanId(planId);
        const resolved: ResolvedPlanLimits = {
          ...dbLimits,
          planName,
          source: "database",
        };
        await this.cachePlanLimits(planId, resolved);
        return resolved;
      }
    } catch (error) {
      log.warn({ err: error, planId }, "Failed to fetch plan limits from PostgreSQL");
    }

    if (this.unknownPlanFallback === "free") {
      return getFallbackPlan(planId);
    }

    return null;
  }

  private async cachePlanLimits(planId: string, limits: ResolvedPlanLimits): Promise<void> {
    try {
      const client = await this.getRedisClient();
      const payload = JSON.stringify({
        requestsPerMinute: limits.requestsPerMinute,
        requestsPerDay: limits.requestsPerDay,
        requestsPerMonth: limits.requestsPerMonth,
        planName: limits.planName,
        source: limits.source,
        cachedAt: Date.now(),
      } satisfies CachedPlanLimits);
      await client.set(this.getPlanCacheKey(planId), payload, { EX: PLAN_CACHE_TTL_SECONDS });
    } catch (error) {
      log.warn({ err: error, planId }, "Failed to cache plan limits in Redis");
    }
  }

  private buildQuotaInfo(
    userId: string,
    planId: string,
    plan: ResolvedPlanLimits,
    minuteUsed: number | null,
    dayUsed: number | null,
    monthUsed: number | null,
    nowMs: number
  ): QuotaInfo {
    const minuteResetAt = new Date(nowMs - (nowMs % MINUTE_WINDOW_MS) + MINUTE_WINDOW_MS).toISOString();
    const dayResetAt = new Date(getUtcWindowStarts(nowMs).dayStartMs + DAY_WINDOW_MS).toISOString();
    const monthResetAt = new Date(getNextUtcMonthStart(nowMs)).toISOString();

    return {
      userId,
      planId,
      planName: plan.planName,
      source: plan.source,
      minute: this.buildWindowInfo(plan.requestsPerMinute, minuteUsed, minuteResetAt),
      day: this.buildWindowInfo(plan.requestsPerDay, dayUsed, dayResetAt),
      month: this.buildWindowInfo(plan.requestsPerMonth, monthUsed, monthResetAt),
    };
  }

  private buildWindowInfo(limit: number, used: number | null, resetAt: string): QuotaWindowInfo {
    const currentUsed = used ?? 0;
    const isUnlimited = limit <= 0;
    return {
      limit,
      used: currentUsed,
      remaining: isUnlimited ? null : Math.max(0, limit - currentUsed),
      resetAt,
      isUnlimited,
    };
  }

  private getRetryAfterForWindow(blockedWindow: string, nowMs: number): number {
    if (blockedWindow === "minute") {
      return Math.max(1, Math.ceil(MINUTE_WINDOW_MS / 1000));
    }
    if (blockedWindow === "day") {
      return Math.max(1, Math.ceil((getUtcWindowStarts(nowMs).dayStartMs + DAY_WINDOW_MS - nowMs) / 1000));
    }
    if (blockedWindow === "month") {
      return Math.max(1, Math.ceil((getNextUtcMonthStart(nowMs) - nowMs) / 1000));
    }
    return 60;
  }

  private getPlanCacheKey(planId: string): string {
    return `plan-limits:${normalizePlanId(planId)}`;
  }

  private getMinuteKey(userId: string): string {
    return `user-quota:${userId}:minute`;
  }

  private getDayKey(userId: string, nowMs: number): string {
    return `user-quota:${userId}:day:${formatUtcDay(nowMs)}`;
  }

  private getMonthKey(userId: string, nowMs: number): string {
    return `user-quota:${userId}:month:${formatUtcMonth(nowMs)}`;
  }
}

function getFallbackPlan(planId: string): ResolvedPlanLimits {
  const normalized = normalizePlanId(planId);
  const fallback = BUILTIN_PLAN_LIMITS.free;
  return {
    ...fallback.limits,
    planName: fallback.planName,
    source: "fallback",
  };
}

function normalizePlanId(planId: string): string {
  return planId.trim().toLowerCase().replace(/_/g, "-");
}

function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatUtcMonth(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getUtcWindowStarts(nowMs: number): { dayStartMs: number; monthStartMs: number } {
  const date = new Date(nowMs);
  return {
    dayStartMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    monthStartMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  };
}

function getNextUtcMonthStart(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function readBoolEnv(
  env: Record<string, string | undefined> | undefined,
  name: string,
  fallback: boolean
): boolean {
  const value = env?.[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "on";
}

function getEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
}
