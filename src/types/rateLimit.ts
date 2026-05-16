/**
 * Shared subscription rate limit types for OmniRoute.
 */

export interface PlanLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
}

export interface UserPlan {
  userId: string;
  planId: string;
  planName?: string;
  planLimits?: PlanLimits;
  source?: "redis" | "database" | "fallback";
  subscriptionStatus?: string;
  active?: boolean;
}

export interface QuotaWindowInfo {
  limit: number;
  used: number;
  remaining: number | null;
  resetAt: string;
  isUnlimited: boolean;
}

export interface QuotaInfo {
  userId: string;
  planId: string;
  planName: string;
  source: "redis" | "database" | "fallback";
  minute: QuotaWindowInfo;
  day: QuotaWindowInfo;
  month: QuotaWindowInfo;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  reason?:
    | "rate_limit_minute"
    | "rate_limit_day"
    | "rate_limit_month"
    | "unknown_plan"
    | "dependency_unavailable";
  quotaInfo: QuotaInfo;
}
