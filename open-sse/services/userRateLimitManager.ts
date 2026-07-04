/**
 * User Rate Limit Manager — subscription tier enforcement for OmniRoute.
 *
 * Enforces Pro and Pro Max request quotas across all premium provider traffic
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
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

const MINUTE_KEY_TTL_SECONDS = 60;
const KEY_5H_TTL_SECONDS = 6 * 60 * 60;
const KEY_WEEK_TTL_SECONDS = 8 * 24 * 60 * 60;
const MONTH_KEY_TTL_SECONDS = 32 * 24 * 60 * 60;
const SUCCESS_COUNTER_PREFIX = "user-usage-success";

// Token weight scaling multipliers relative to Claude 4 Sonnet (Base rate: $3/$15)
export const TOKEN_MULTIPLIERS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 1.0, output: 1.0 },
  "claude-sonnet-4": { input: 1.0, output: 1.0 },
  "claude-sonnet-4.5": { input: 1.0, output: 1.0 },
  "claude-opus-4": { input: 5.0, output: 5.0 },
  "claude-opus-4-6": { input: 1.67, output: 1.67 },
  "claude-opus-4.6": { input: 1.67, output: 1.67 },
  "claude-haiku-4.5": { input: 0.33, output: 0.33 },
  "gpt-4o": { input: 0.83, output: 0.67 },
  "gpt-4o-mini": { input: 0.05, output: 0.04 },
  o1: { input: 5.0, output: 4.0 },
  "o1-mini": { input: 1.0, output: 0.8 },
  "gemini-3.1-pro": { input: 0.67, output: 0.8 },
  "gemini-2.5-flash": { input: 0.1, output: 0.17 },
  "deepseek-chat": { input: 0.09, output: 0.03 },
  "deepseek-reasoner": { input: 0.18, output: 0.15 },
  "deepseek-r1": { input: 0.18, output: 0.15 },
};

export function getModelMultipliers(modelName: string): { input: number; output: number } {
  const normalized = modelName
    .trim()
    .toLowerCase()
    .replace(/^(?:accounts\/[^/]+\/models\/)?/, "");
  for (const [key, mult] of Object.entries(TOKEN_MULTIPLIERS)) {
    if (normalized.includes(key)) return mult;
  }
  return { input: 1.0, output: 1.0 }; // Default 1x multiplier
}

const BUILTIN_PLAN_LIMITS: Record<string, { planName: string; limits: PlanLimits }> = {
  free: {
    planName: "Free",
    limits: {
      requestsPerMinute: 5,
      requestsPerDay: 20,
      requestsPerMonth: 50,
      limit5hTokens: 150_000,
      limitWeekTokens: 500_000,
      limitMonthTokens: 1_500_000,
    },
  },
  "pay-as-you-go": {
    planName: "Pay As You Go",
    limits: {
      requestsPerMinute: 30,
      requestsPerDay: 1200,
      requestsPerMonth: 0,
      limit5hTokens: 0,
      limitWeekTokens: 0,
      limitMonthTokens: 0,
    },
  },
  pro: {
    planName: "Pro",
    limits: {
      requestsPerMinute: 0,
      requestsPerDay: 0,
      requestsPerMonth: 0,
      limit5hTokens: 2_000_000,
      limitWeekTokens: 8_000_000,
      limitMonthTokens: 25_000_000,
    },
  },
  "max-5x": {
    planName: "Max 5x",
    limits: {
      requestsPerMinute: 0,
      requestsPerDay: 0,
      requestsPerMonth: 0,
      limit5hTokens: 10_000_000,
      limitWeekTokens: 40_000_000,
      limitMonthTokens: 125_000_000,
    },
  },
  "max-20x": {
    planName: "Max 20x",
    limits: {
      requestsPerMinute: 0,
      requestsPerDay: 0,
      requestsPerMonth: 0,
      limit5hTokens: 40_000_000,
      limitWeekTokens: 160_000_000,
      limitMonthTokens: 500_000_000,
    },
  },
  "pro-max": {
    planName: "Pro Max",
    limits: {
      requestsPerMinute: 0,
      requestsPerDay: 0,
      requestsPerMonth: 0,
      limit5hTokens: 40_000_000,
      limitWeekTokens: 160_000_000,
      limitMonthTokens: 500_000_000,
    },
  },
};

const CHECK_AND_RESERVE_SCRIPT = `
local minuteKey = KEYS[1]
local dayKey = KEYS[2]
local key5h = KEYS[3]
local weekKey = KEYS[4]
local monthKey = KEYS[5]
local hashKey = KEYS[6]

local reserveId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local minuteWindowMs = tonumber(ARGV[3])
local dayWindowMs = tonumber(ARGV[4])
local window5hMs = tonumber(ARGV[5])
local windowWeekMs = tonumber(ARGV[6])
local monthStartMs = tonumber(ARGV[7])

local minuteLimit = tonumber(ARGV[8])
local dayLimit = tonumber(ARGV[9])
local monthLimit = tonumber(ARGV[10])
local limit5hTokens = tonumber(ARGV[11])
local limitWeekTokens = tonumber(ARGV[12])
local limitMonthTokens = tonumber(ARGV[13])
local estimatedTokens = tonumber(ARGV[14])

local minuteTtl = tonumber(ARGV[15])
local dayTtl = tonumber(ARGV[16])
local ttl5h = tonumber(ARGV[17])
local ttlWeek = tonumber(ARGV[18])
local monthTtl = tonumber(ARGV[19])

-- 1. O(M) Hash Cleanup (using ZRANGEBYSCORE on monthKey before trimming)
local expiredMembers = redis.call("ZRANGEBYSCORE", monthKey, "-inf", monthStartMs)
if #expiredMembers > 0 then
  local chunk_size = 1000
  for i = 1, #expiredMembers, chunk_size do
    local chunk = {}
    for j = i, math.min(i + chunk_size - 1, #expiredMembers) do
      table.insert(chunk, expiredMembers[j])
    end
    redis.call("HDEL", hashKey, unpack(chunk))
  end
end

-- 2. Trim ZSETs
redis.call("ZREMRANGEBYSCORE", minuteKey, "-inf", nowMs - minuteWindowMs)
redis.call("ZREMRANGEBYSCORE", dayKey, "-inf", nowMs - dayWindowMs)
redis.call("ZREMRANGEBYSCORE", key5h, "-inf", nowMs - window5hMs)
redis.call("ZREMRANGEBYSCORE", weekKey, "-inf", nowMs - windowWeekMs)
redis.call("ZREMRANGEBYSCORE", monthKey, "-inf", monthStartMs)

-- 3. Check Minute request count limit
local minuteCount = redis.call("ZCARD", minuteKey)
if minuteLimit > 0 and minuteCount >= minuteLimit then
  return { "minute", 60, minuteCount, 0, 0, 0, 0 }
end

-- 4. Check Day request count limit
local dayCount = redis.call("ZCARD", dayKey)
if dayLimit > 0 and dayCount >= dayLimit then
  local oldest = redis.call("ZRANGE", dayKey, 0, 0, "WITHSCORES")
  local oldestMs = tonumber(oldest[2]) or nowMs
  local retryAfter = math.max(1, math.ceil(((oldestMs + dayWindowMs) - nowMs) / 1000))
  return { "day", retryAfter, minuteCount, 0, 0, 0, dayCount }
end

-- 5. Check Month request count limit
local monthCount = redis.call("ZCARD", monthKey)
if monthLimit > 0 and monthCount >= monthLimit then
  local retryAfter = math.max(1, math.ceil(((monthStartMs + 32 * 24 * 60 * 60 * 1000) - nowMs) / 1000))
  return { "month_req", retryAfter, minuteCount, 0, 0, 0, dayCount }
end

-- Function to sum costs in a ZSET (chunked to prevent stack limit crash)
local function get_cumulative_cost(zset_key)
  local members = redis.call("ZRANGE", zset_key, 0, -1)
  if #members == 0 then
    return 0
  end
  local total = 0
  local chunk_size = 1000
  for i = 1, #members, chunk_size do
    local chunk = {}
    for j = i, math.min(i + chunk_size - 1, #members) do
      table.insert(chunk, members[j])
    end
    local costs = redis.call("HMGET", hashKey, unpack(chunk))
    for _, c in ipairs(costs) do
      total = total + (tonumber(c) or 0)
    end
  end
  return total
end

-- 6. Check 5h token limit
local used5h = get_cumulative_cost(key5h)
if limit5hTokens > 0 and (used5h + estimatedTokens) > limit5hTokens then
  local oldest = redis.call("ZRANGE", key5h, 0, 0, "WITHSCORES")
  local oldestMs = tonumber(oldest[2]) or nowMs
  local retryAfter = math.max(1, math.ceil(((oldestMs + window5hMs) - nowMs) / 1000))
  return { "5h", retryAfter, minuteCount, used5h, 0, 0, dayCount }
end

-- 7. Check Week token limit
local usedWeek = get_cumulative_cost(weekKey)
if limitWeekTokens > 0 and (usedWeek + estimatedTokens) > limitWeekTokens then
  local oldest = redis.call("ZRANGE", weekKey, 0, 0, "WITHSCORES")
  local oldestMs = tonumber(oldest[2]) or nowMs
  local retryAfter = math.max(1, math.ceil(((oldestMs + windowWeekMs) - nowMs) / 1000))
  return { "week", retryAfter, minuteCount, used5h, usedWeek, 0, dayCount }
end

-- 8. Check Month token limit
local usedMonth = get_cumulative_cost(monthKey)
if limitMonthTokens > 0 and (usedMonth + estimatedTokens) > limitMonthTokens then
  local retryAfter = math.max(1, math.ceil(((monthStartMs + 32 * 24 * 60 * 60 * 1000) - nowMs) / 1000))
  return { "month", retryAfter, minuteCount, used5h, usedWeek, usedMonth, dayCount }
end

-- 9. Reserve
redis.call("ZADD", minuteKey, nowMs, reserveId)
redis.call("ZADD", dayKey, nowMs, reserveId)
redis.call("ZADD", key5h, nowMs, reserveId)
redis.call("ZADD", weekKey, nowMs, reserveId)
redis.call("ZADD", monthKey, nowMs, reserveId)
redis.call("HSET", hashKey, reserveId, tostring(estimatedTokens))

-- Set TTLs
redis.call("EXPIRE", minuteKey, minuteTtl)
redis.call("EXPIRE", dayKey, dayTtl)
redis.call("EXPIRE", key5h, ttl5h)
redis.call("EXPIRE", weekKey, ttlWeek)
redis.call("EXPIRE", monthKey, monthTtl)
redis.call("EXPIRE", hashKey, monthTtl)

minuteCount = minuteCount + 1
dayCount = dayCount + 1
used5h = used5h + estimatedTokens
usedWeek = usedWeek + estimatedTokens
usedMonth = usedMonth + estimatedTokens

return { "", 0, minuteCount, used5h, usedWeek, usedMonth, dayCount }
`;

const SNAPSHOT_SCRIPT = `
local minuteKey = KEYS[1]
local dayKey = KEYS[2]
local key5h = KEYS[3]
local weekKey = KEYS[4]
local monthKey = KEYS[5]
local hashKey = KEYS[6]

local nowMs = tonumber(ARGV[1])
local minuteWindowMs = tonumber(ARGV[2])
local dayWindowMs = tonumber(ARGV[3])
local window5hMs = tonumber(ARGV[4])
local windowWeekMs = tonumber(ARGV[5])
local monthStartMs = tonumber(ARGV[6])

-- Trim ZSETs
redis.call("ZREMRANGEBYSCORE", minuteKey, "-inf", nowMs - minuteWindowMs)
redis.call("ZREMRANGEBYSCORE", dayKey, "-inf", nowMs - dayWindowMs)
redis.call("ZREMRANGEBYSCORE", key5h, "-inf", nowMs - window5hMs)
redis.call("ZREMRANGEBYSCORE", weekKey, "-inf", nowMs - windowWeekMs)
redis.call("ZREMRANGEBYSCORE", monthKey, "-inf", monthStartMs)

local minuteCount = redis.call("ZCARD", minuteKey)
local dayCount = redis.call("ZCARD", dayKey)

-- Function to sum costs in a ZSET (chunked to prevent stack limit crash)
local function get_cumulative_cost(zset_key)
  local members = redis.call("ZRANGE", zset_key, 0, -1)
  if #members == 0 then
    return 0
  end
  local total = 0
  local chunk_size = 1000
  for i = 1, #members, chunk_size do
    local chunk = {}
    for j = i, math.min(i + chunk_size - 1, #members) do
      table.insert(chunk, members[j])
    end
    local costs = redis.call("HMGET", hashKey, unpack(chunk))
    for _, c in ipairs(costs) do
      total = total + (tonumber(c) or 0)
    end
  end
  return total
end

local used5h = get_cumulative_cost(key5h)
local usedWeek = get_cumulative_cost(weekKey)
local usedMonth = get_cumulative_cost(monthKey)

return { minuteCount, used5h, usedWeek, usedMonth, dayCount }
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
  private connectPromise: Promise<unknown> | null = null;

  constructor(options: UserRateLimitManagerOptions = {}) {
    const env = getEnv();
    const redisUrl = options.redisUrl || env.REDIS_URL || env.REDIS_CONNECTION_STRING;

    const redisOptions: any = { url: redisUrl };
    if (env?.REDIS_PASSWORD) {
      redisOptions.password = env.REDIS_PASSWORD;
    }

    this.redisClient = options.redisClient || createClient(redisOptions);

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
   * Check whether a user may make another request using Sonnet-Equivalent Tokens.
   */
  async checkUserRateLimit(
    userId: string,
    planId: string,
    estimatedTokens = 15000
  ): Promise<RateLimitResult> {
    const normalizedPlanId = normalizePlanId(planId);
    const plan = await this.resolvePlanLimits(normalizedPlanId);
    const nowMs = Date.now();
    const reserveId = randomUUID();

    if (!this.enabled) {
      return {
        allowed: true,
        quotaInfo: this.buildQuotaInfo(
          userId,
          normalizedPlanId,
          plan ?? getFallbackPlan(normalizedPlanId),
          null,
          null,
          null,
          null,
          null,
          nowMs,
          reserveId
        ),
        reserveId,
      };
    }

    if (!plan) {
      const fallbackPlan = getFallbackPlan(normalizedPlanId);
      const quotaInfo = this.buildQuotaInfo(
        userId,
        normalizedPlanId,
        fallbackPlan,
        null,
        null,
        null,
        null,
        null,
        nowMs,
        reserveId
      );
      if (this.failOpen) {
        return { allowed: true, reason: "dependency_unavailable", quotaInfo, reserveId };
      }
      return {
        allowed: false,
        retryAfter: 60,
        reason: "unknown_plan",
        quotaInfo,
        reserveId,
      };
    }

    try {
      const client = await this.getRedisClient();
      const { monthStartMs } = getUtcWindowStarts(nowMs);
      const result = (await client.eval(CHECK_AND_RESERVE_SCRIPT, {
        keys: [
          this.getMinuteKey(userId),
          this.getDayKey(userId),
          this.get5hKey(userId),
          this.getWeekKey(userId),
          this.getMonthKey(userId, nowMs),
          this.getCostsKey(userId),
        ],
        arguments: [
          reserveId,
          String(nowMs),
          String(MINUTE_WINDOW_MS),
          String(24 * 60 * 60 * 1000), // dayWindowMs (24h)
          String(WINDOW_5H_MS),
          String(WINDOW_WEEK_MS),
          String(monthStartMs),
          String(plan.requestsPerMinute),
          String(plan.requestsPerDay),
          String(plan.requestsPerMonth),
          String(plan.limit5hTokens ?? 1500000),
          String(plan.limitWeekTokens ?? 5000000),
          String(plan.limitMonthTokens ?? 15000000),
          String(estimatedTokens),
          String(MINUTE_KEY_TTL_SECONDS),
          String(25 * 60 * 60), // dayTtl (25h)
          String(KEY_5H_TTL_SECONDS),
          String(KEY_WEEK_TTL_SECONDS),
          String(MONTH_KEY_TTL_SECONDS),
        ],
      })) as unknown[];

      const blockedWindow = String(result[0] ?? "");
      const retryAfter = Number(result[1] ?? 0);
      const minuteUsed = Number(result[2] ?? 0);
      const used5h = Number(result[3] ?? 0);
      const usedWeek = Number(result[4] ?? 0);
      const usedMonth = Number(result[5] ?? 0);
      const dayUsed = Number(result[6] ?? 0);
      const quotaInfo = this.buildQuotaInfo(
        userId,
        normalizedPlanId,
        plan,
        minuteUsed,
        dayUsed,
        used5h,
        usedWeek,
        usedMonth,
        nowMs,
        reserveId
      );

      if (blockedWindow) {
        return {
          allowed: false,
          retryAfter:
            retryAfter > 0 ? retryAfter : this.getRetryAfterForWindow(blockedWindow, nowMs),
          reason: `rate_limit_${blockedWindow}` as RateLimitResult["reason"],
          quotaInfo,
          reserveId,
        };
      }

      return { allowed: true, quotaInfo, reserveId };
    } catch (error) {
      log.error({ err: error, userId, planId: normalizedPlanId }, "Rate limit check failed");
      const quotaInfo = this.buildQuotaInfo(
        userId,
        normalizedPlanId,
        plan,
        null,
        null,
        null,
        null,
        null,
        nowMs,
        reserveId
      );
      if (this.failOpen) {
        return { allowed: true, reason: "dependency_unavailable", quotaInfo, reserveId };
      }
      return {
        allowed: false,
        retryAfter: 60,
        reason: "dependency_unavailable",
        quotaInfo,
        reserveId,
      };
    }
  }

  /**
   * Record success metric counter.
   */
  async incrementUserUsage(userId: string): Promise<void> {
    try {
      const client = await this.getRedisClient();
      const nowMs = Date.now();
      const key = `${SUCCESS_COUNTER_PREFIX}:${userId}:day:${formatUtcDay(nowMs)}`;
      await client
        .multi()
        .incr(key)
        .expire(key, 25 * 60 * 60)
        .exec();
    } catch (error) {
      log.error({ err: error, userId }, "Failed to increment user usage counter");
      if (!this.failOpen) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  /**
   * Reconcile/update the actual token cost of a previously reserved request.
   */
  async reconcileUserUsage(userId: string, reserveId: string, actualTokens: number): Promise<void> {
    try {
      const client = await this.getRedisClient();
      const costsKey = this.getCostsKey(userId);
      await client.hSet(costsKey, reserveId, String(actualTokens));
    } catch (error) {
      log.error(
        { err: error, userId, reserveId, actualTokens },
        "Failed to reconcile user tokens in Redis"
      );
    }
  }

  /**
   * Return the current remaining quota for a user/plan pair.
   */
  async getUserQuotaInfo(userId: string, planId: string): Promise<QuotaInfo> {
    const normalizedPlanId = normalizePlanId(planId);
    const plan =
      (await this.resolvePlanLimits(normalizedPlanId)) || getFallbackPlan(normalizedPlanId);
    const nowMs = Date.now();

    try {
      const client = await this.getRedisClient();
      const { monthStartMs } = getUtcWindowStarts(nowMs);
      const result = (await client.eval(SNAPSHOT_SCRIPT, {
        keys: [
          this.getMinuteKey(userId),
          this.getDayKey(userId),
          this.get5hKey(userId),
          this.getWeekKey(userId),
          this.getMonthKey(userId, nowMs),
          this.getCostsKey(userId),
        ],
        arguments: [
          String(nowMs),
          String(MINUTE_WINDOW_MS),
          String(24 * 60 * 60 * 1000), // dayWindowMs (24h)
          String(WINDOW_5H_MS),
          String(WINDOW_WEEK_MS),
          String(monthStartMs),
        ],
      })) as unknown[];

      return this.buildQuotaInfo(
        userId,
        normalizedPlanId,
        plan,
        Number(result[0] ?? 0),
        Number(result[4] ?? 0), // dayCount
        Number(result[1] ?? 0), // used5h
        Number(result[2] ?? 0), // usedWeek
        Number(result[3] ?? 0), // usedMonth
        nowMs
      );
    } catch (error) {
      log.error({ err: error, userId, planId: normalizedPlanId }, "Failed to load quota info");
      if (this.failOpen) {
        return this.buildQuotaInfo(
          userId,
          normalizedPlanId,
          plan,
          null,
          null,
          null,
          null,
          null,
          nowMs
        );
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
        const parsed = JSON.parse(cached as string) as CachedPlanLimits;
        return {
          requestsPerMinute: Math.max(0, Number(parsed.requestsPerMinute ?? 0)),
          requestsPerDay: Math.max(0, Number(parsed.requestsPerDay ?? 0)),
          requestsPerMonth: Math.max(0, Number(parsed.requestsPerMonth ?? 0)),
          limit5hTokens: Math.max(0, Number(parsed.limit5hTokens ?? 1500000)),
          limitWeekTokens: Math.max(0, Number(parsed.limitWeekTokens ?? 5000000)),
          limitMonthTokens: Math.max(0, Number(parsed.limitMonthTokens ?? 15000000)),
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
        limit5hTokens: limits.limit5hTokens,
        limitWeekTokens: limits.limitWeekTokens,
        limitMonthTokens: limits.limitMonthTokens,
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
    used5h: number | null,
    usedWeek: number | null,
    usedMonth: number | null,
    nowMs: number,
    reserveId?: string
  ): QuotaInfo {
    const minuteResetAt = new Date(
      nowMs - (nowMs % MINUTE_WINDOW_MS) + MINUTE_WINDOW_MS
    ).toISOString();
    const reset5hAt = new Date(nowMs + WINDOW_5H_MS).toISOString();
    const resetWeekAt = new Date(nowMs + WINDOW_WEEK_MS).toISOString();
    const monthResetAt = new Date(getNextUtcMonthStart(nowMs)).toISOString();

    return {
      userId,
      planId,
      planName: plan.planName,
      source: plan.source,
      minute: this.buildWindowInfo(plan.requestsPerMinute, minuteUsed, minuteResetAt),
      day: this.buildWindowInfo(
        plan.requestsPerDay,
        dayUsed,
        new Date(nowMs + 24 * 60 * 60 * 1000).toISOString()
      ),
      limit5h: this.buildWindowInfo(plan.limit5hTokens ?? 1500000, used5h, reset5hAt),
      limitWeek: this.buildWindowInfo(plan.limitWeekTokens ?? 5000000, usedWeek, resetWeekAt),
      month: this.buildWindowInfo(plan.limitMonthTokens ?? 15000000, usedMonth, monthResetAt),
      reserveId,
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
      return Math.max(1, 24 * 60 * 60);
    }
    if (blockedWindow === "month_req") {
      return Math.max(1, Math.ceil((getNextUtcMonthStart(nowMs) - nowMs) / 1000));
    }
    if (blockedWindow === "5h") {
      return Math.max(1, Math.ceil(WINDOW_5H_MS / 1000));
    }
    if (blockedWindow === "week") {
      return Math.max(1, Math.ceil(WINDOW_WEEK_MS / 1000));
    }
    if (blockedWindow === "month") {
      return Math.max(1, Math.ceil((getNextUtcMonthStart(nowMs) - nowMs) / 1000));
    }
    return 60;
  }

  private getDayKey(userId: string): string {
    return `user-quota:${userId}:day`;
  }

  private get5hKey(userId: string): string {
    return `user-quota:${userId}:5h`;
  }

  private getWeekKey(userId: string): string {
    return `user-quota:${userId}:week`;
  }

  private getCostsKey(userId: string): string {
    return `user-quota:${userId}:costs`;
  }

  private getPlanCacheKey(planId: string): string {
    return `plan-limits:${normalizePlanId(planId)}`;
  }

  private getMinuteKey(userId: string): string {
    return `user-quota:${userId}:minute`;
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
  return (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
}
