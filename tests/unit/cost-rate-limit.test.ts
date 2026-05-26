import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "redis";
import { UserRateLimitManager } from "../../open-sse/services/userRateLimitManager.ts";

// Manually load environment variables from the parent directory's .env file
try {
  const envPath = path.resolve(process.cwd(), "../.env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts
          .slice(1)
          .join("=")
          .trim()
          .replace(/^['"]|['"]$/g, "");
        process.env[key] = val;
      }
    }
  }
} catch (e) {
  // ignore
}

test.describe("Token-Equivalent User Rate Limiter", () => {
  let redisClient: any;
  let rateLimitManager: UserRateLimitManager;
  const testUserId = "test-user-rate-limiter";
  const testPlanId = "free";

  test.before(async () => {
    const redisOptions: any = {
      url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    };
    if (process.env.REDIS_PASSWORD) {
      redisOptions.password = process.env.REDIS_PASSWORD;
    }

    redisClient = createClient(redisOptions);
    await redisClient.connect();

    rateLimitManager = new UserRateLimitManager({
      redisClient,
      portalDb: {
        getPlanLimits: async (planId: string) => {
          if (planId === "weekly-block") {
            return {
              requestsPerMinute: 60,
              requestsPerDay: 1000,
              requestsPerMonth: 10000,
              limit5hTokens: 1000000,
              limitWeekTokens: 50000, // Very low weekly limit
              limitMonthTokens: 10000000,
              planName: "Weekly Block Test",
              source: "database",
            };
          }
          if (planId === "monthly-block") {
            return {
              requestsPerMinute: 60,
              requestsPerDay: 1000,
              requestsPerMonth: 10000,
              limit5hTokens: 1000000,
              limitWeekTokens: 1000000,
              limitMonthTokens: 50000, // Very low monthly limit
              planName: "Monthly Block Test",
              source: "database",
            };
          }
          if (planId === "day-count-block") {
            return {
              requestsPerMinute: 60,
              requestsPerDay: 3, // Block after 3 requests
              requestsPerMonth: 10000,
              limit5hTokens: 1000000,
              limitWeekTokens: 1000000,
              limitMonthTokens: 10000000,
              planName: "Day Count Block Test",
              source: "database",
            };
          }
          if (planId === "month-count-block") {
            return {
              requestsPerMinute: 60,
              requestsPerDay: 1000,
              requestsPerMonth: 3, // Block after 3 requests
              limit5hTokens: 1000000,
              limitWeekTokens: 1000000,
              limitMonthTokens: 10000000,
              planName: "Month Count Block Test",
              source: "database",
            };
          }
          return {
            requestsPerMinute: 60,
            requestsPerDay: 1000,
            requestsPerMonth: 10000,
            limit5hTokens: 150000, // 150k 5h limit
            limitWeekTokens: 500000, // 500k weekly limit
            limitMonthTokens: 1500000, // 1.5M monthly limit
            planName: "Free Test",
            source: "database",
          };
        },
      },
      enabled: true,
    });
  });

  test.beforeEach(async () => {
    // Clear all rate limit keys for the test user
    const keys = await redisClient.keys(`user-quota:${testUserId}:*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  });

  test.after(async () => {
    const keys = await redisClient.keys(`user-quota:${testUserId}:*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    await redisClient.quit();
  });

  test("Allows requests within token budget and blocks when 5h exceeded", async () => {
    // Make 10 reservations of 15,000 tokens each. Total = 150,000 tokens (hits the limit exactly)
    for (let i = 0; i < 10; i++) {
      const res = await rateLimitManager.checkUserRateLimit(testUserId, testPlanId, 15000);
      assert.equal(res.allowed, true, `Request ${i + 1} should be allowed`);
      assert.ok(res.reserveId, "Should return a reserveId");
    }

    // The 11th request of 15,000 tokens should exceed the 150,000 limit and be blocked
    const resBlocked = await rateLimitManager.checkUserRateLimit(testUserId, testPlanId, 15000);
    assert.equal(resBlocked.allowed, false, "Request 11 should be blocked");
    assert.equal(resBlocked.reason, "rate_limit_5h");
    assert.ok(resBlocked.retryAfter > 0, "Should suggest retryAfter");
  });

  test("Reconciling/refunding requests restores token budget", async () => {
    // Make 10 reservations of 15,000 tokens each. Budget is now fully consumed.
    const reserveIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await rateLimitManager.checkUserRateLimit(testUserId, testPlanId, 15000);
      assert.equal(res.allowed, true);
      if (res.reserveId) reserveIds.push(res.reserveId);
    }

    // 11th request is blocked
    const resBlockedBefore = await rateLimitManager.checkUserRateLimit(
      testUserId,
      testPlanId,
      15000
    );
    assert.equal(resBlockedBefore.allowed, false);

    // Reconcile one request to actual tokens of 3,000 (refunds 12,000 tokens)
    await rateLimitManager.reconcileUserUsage(testUserId, reserveIds[0], 3000);

    // Request is still blocked because we need 15,000 tokens and only 12,000 was freed
    const resBlockedStill = await rateLimitManager.checkUserRateLimit(
      testUserId,
      testPlanId,
      15000
    );
    assert.equal(resBlockedStill.allowed, false);

    // Reconcile another request to 0 (completely failed/refunded request)
    await rateLimitManager.reconcileUserUsage(testUserId, reserveIds[1], 0);

    // Now we freed up an additional 15,000 tokens.
    // The 11th request of 15,000 should now be allowed!
    const resAllowedNow = await rateLimitManager.checkUserRateLimit(testUserId, testPlanId, 15000);
    assert.equal(resAllowedNow.allowed, true, "Should be allowed after refunds");
  });

  test("Enforces weekly limit", async () => {
    // Let's check with an estimatedTokens (e.g. 60,000) that exceeds the 50,000 weekly limit
    const resBlocked = await rateLimitManager.checkUserRateLimit(testUserId, "weekly-block", 60000);
    assert.equal(resBlocked.allowed, false);
    assert.equal(resBlocked.reason, "rate_limit_week");
  });

  test("Enforces monthly limit", async () => {
    // Let's check with an estimatedTokens (e.g. 60,000) that exceeds the 50,000 monthly limit
    const resBlocked = await rateLimitManager.checkUserRateLimit(
      testUserId,
      "monthly-block",
      60000
    );
    assert.equal(resBlocked.allowed, false);
    assert.equal(resBlocked.reason, "rate_limit_month");
  });

  test("Enforces daily request count limit", async () => {
    // First 3 requests are allowed
    for (let i = 0; i < 3; i++) {
      const res = await rateLimitManager.checkUserRateLimit(testUserId, "day-count-block", 100);
      assert.equal(res.allowed, true, `Day request ${i + 1} should be allowed`);
    }
    // 4th request should be blocked
    const resBlocked = await rateLimitManager.checkUserRateLimit(
      testUserId,
      "day-count-block",
      100
    );
    assert.equal(resBlocked.allowed, false);
    assert.equal(resBlocked.reason, "rate_limit_day");
  });

  test("Enforces monthly request count limit", async () => {
    // First 3 requests are allowed
    for (let i = 0; i < 3; i++) {
      const res = await rateLimitManager.checkUserRateLimit(testUserId, "month-count-block", 100);
      assert.equal(res.allowed, true, `Month request ${i + 1} should be allowed`);
    }
    // 4th request should be blocked
    const resBlocked = await rateLimitManager.checkUserRateLimit(
      testUserId,
      "month-count-block",
      100
    );
    assert.equal(resBlocked.allowed, false);
    assert.equal(resBlocked.reason, "rate_limit_month_req");
  });
});
