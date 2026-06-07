/**
 * portalDb.ts — PostgreSQL access layer for Customer Portal plan lookups.
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { createLogger } from "@/shared/utils/logger";
import type { PlanLimits, UserPlan } from "@/types/rateLimit";

const log = createLogger("portal-db");

export interface PortalDbOptions {
  pool?: Pool;
  connectionString?: string;
  lookupBy?: "userId" | "apiKeyId";
}

interface PlanRow extends QueryResultRow {
  id: string;
  name: string;
  requests_per_minute: number | string | null;
  requests_per_day: number | string | null;
  requests_per_month: number | string | null;
  limit_5h_tokens: number | string | null;
  limit_week_tokens: number | string | null;
  limit_month_tokens: number | string | null;
}

interface UserPlanRow extends QueryResultRow {
  user_id: string;
  plan_id: string | null;
  plan_name: string | null;
  plan_requests_per_minute: number | string | null;
  plan_requests_per_day: number | string | null;
  plan_requests_per_month: number | string | null;
  plan_limit_5h_tokens: number | string | null;
  plan_limit_week_tokens: number | string | null;
  plan_limit_month_tokens: number | string | null;
}

let sharedPool: Pool | null = null;
let sharedPoolInitError: Error | null = null;

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getConnectionString(connectionString?: string): string | null {
  const env = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return (connectionString || env?.PORTAL_DATABASE_URL || "").trim() || null;
}

function buildPool(options: PortalDbOptions = {}): Pool | null {
  if (options.pool) return options.pool;

  if (sharedPool) return sharedPool;
  if (sharedPoolInitError) return null;

  const connectionString = getConnectionString(options.connectionString);
  if (!connectionString) {
    log.warn("PORTAL_DATABASE_URL is not set; portal plan lookups are disabled");
    sharedPoolInitError = new Error("PORTAL_DATABASE_URL is not set");
    return null;
  }

  try {
    const env = (
      globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env;
    const poolMax = toNumber(env?.PORTAL_DATABASE_POOL_MAX, 50);

    sharedPool = new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      // GCP Cloud SQL uses a self-signed cert; ssl accepted at runtime by pg
      // but not reflected in @types/pg PoolConfig — cast to suppress TS error
      ...({ ssl: { rejectUnauthorized: false } } as object),
    });

    sharedPool.on("error", (error) => {
      log.error({ err: error }, "PostgreSQL pool error");
    });

    return sharedPool;
  } catch (error) {
    sharedPoolInitError = error instanceof Error ? error : new Error(String(error));
    log.error({ err: sharedPoolInitError }, "Failed to initialize portal PostgreSQL pool");
    return null;
  }
}

function normalizePlanLimits(row: PlanRow | null): PlanLimits | null {
  if (!row) return null;
  return {
    requestsPerMinute: Math.max(0, toNumber(row.requests_per_minute, 0)),
    requestsPerDay: Math.max(0, toNumber(row.requests_per_day, 0)),
    requestsPerMonth: Math.max(0, toNumber(row.requests_per_month, 0)),
    limit5hTokens: Math.max(0, toNumber(row.limit_5h_tokens, 1500000)),
    limitWeekTokens: Math.max(0, toNumber(row.limit_week_tokens, 5000000)),
    limitMonthTokens: Math.max(0, toNumber(row.limit_month_tokens, 15000000)),
  };
}

async function querySingle<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[]
): Promise<T | null> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.query<T>(text, values);
    return result.rows[0] ?? null;
  } finally {
    client?.release();
  }
}

/**
 * Resolve the active plan for a user from the Customer Portal database.
 *
 * @param userId - Customer Portal user id or OmniRoute API key id.
 * @param options.lookupBy - When set to "apiKeyId", the first argument is treated as an OmniRoute key id.
 * @returns User plan details or null when the user/plan cannot be resolved.
 */
export async function getUserPlan(
  userId: string,
  options: PortalDbOptions = {}
): Promise<UserPlan | null> {
  const pool = buildPool(options);
  if (!pool) return null;

  try {
    const queryByApiKey = options.lookupBy === "apiKeyId";
    const row = await querySingle<UserPlanRow>(
      pool,
      queryByApiKey
        ? `
        SELECT
          u.id AS user_id,
          u.plan_id AS plan_id,
          p.name AS plan_name,
          p.requests_per_minute AS plan_requests_per_minute,
          p.requests_per_day AS plan_requests_per_day,
          p.requests_per_month AS plan_requests_per_month,
          p.limit_5h_tokens AS plan_limit_5h_tokens,
          p.limit_week_tokens AS plan_limit_week_tokens,
          p.limit_month_tokens AS plan_limit_month_tokens
        FROM user_api_keys k
        INNER JOIN users u ON u.id = k.user_id
        LEFT JOIN plans p ON p.id = u.plan_id
        WHERE k.omniroute_key_id = $1 AND k.is_active = true
        LIMIT 1
      `
        : `
        SELECT
          u.id AS user_id,
          u.plan_id AS plan_id,
          p.name AS plan_name,
          p.requests_per_minute AS plan_requests_per_minute,
          p.requests_per_day AS plan_requests_per_day,
          p.requests_per_month AS plan_requests_per_month,
          p.limit_5h_tokens AS plan_limit_5h_tokens,
          p.limit_week_tokens AS plan_limit_week_tokens,
          p.limit_month_tokens AS plan_limit_month_tokens
        FROM users u
        LEFT JOIN plans p ON p.id = u.plan_id
        WHERE u.id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (!row || !row.plan_id) return null;

    const limits = {
      requestsPerMinute: Math.max(0, toNumber(row.plan_requests_per_minute, 0)),
      requestsPerDay: Math.max(0, toNumber(row.plan_requests_per_day, 0)),
      requestsPerMonth: Math.max(0, toNumber(row.plan_requests_per_month, 0)),
      limit5hTokens: Math.max(0, toNumber(row.plan_limit_5h_tokens, 1500000)),
      limitWeekTokens: Math.max(0, toNumber(row.plan_limit_week_tokens, 5000000)),
      limitMonthTokens: Math.max(0, toNumber(row.plan_limit_month_tokens, 15000000)),
    };

    return {
      userId: row.user_id,
      planId: row.plan_id,
      planName: row.plan_name ?? undefined,
      planLimits: limits,
      source: "database",
      active: true,
    };
  } catch (error) {
    log.error({ err: error, userId }, "Failed to fetch user plan");
    return null;
  }
}

/**
 * Resolve a plan's rate limit policy from PostgreSQL.
 *
 * @param planId - Portal plan id (e.g. pro, pro-max).
 * @returns The plan's rate limits or null when the plan is missing.
 */
export async function getPlanLimits(
  planId: string,
  options: PortalDbOptions = {}
): Promise<PlanLimits | null> {
  const pool = buildPool(options);
  if (!pool) return null;

  try {
    const row = await querySingle<PlanRow>(
      pool,
      `
        SELECT
          id,
          name,
          requests_per_minute,
          requests_per_day,
          requests_per_month,
          limit_5h_tokens,
          limit_week_tokens,
          limit_month_tokens
        FROM plans
        WHERE id = $1
        LIMIT 1
      `,
      [planId]
    );

    return normalizePlanLimits(row);
  } catch (error) {
    log.error({ err: error, planId }, "Failed to fetch plan limits");
    return null;
  }
}

/**
 * Close the shared PostgreSQL pool. Useful for tests and graceful shutdown.
 */
export async function closePortalDb(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  sharedPoolInitError = null;
  await pool.end().catch((error) => {
    log.error({ err: error }, "Failed to close portal PostgreSQL pool");
  });
}
