import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/db/core";
import { isAccountInCooldown } from "@/lib/sessionPersistence";

export async function GET() {
  try {
    const redis = await getRedisClient();
    const providers = ["openai", "anthropic", "gemini", "deepseek", "groq"];
    const accounts = [];

    for (const providerId of providers) {
      const poolKey = `pool:${providerId}`;
      const accountIds = await redis.smembers(poolKey);

      for (const accountId of accountIds) {
        const metricsData = await redis.get(`pool:metrics:${accountId}`);
        if (!metricsData) continue;

        const metrics = JSON.parse(metricsData);
        const tokensUsed = parseInt((await redis.get(`tokens:${accountId}`)) || "0");
        const requestsUsed = parseInt((await redis.get(`pool:requests:${accountId}`)) || "0");
        const errorCount = parseInt((await redis.get(`errors:${accountId}`)) || "0");
        const inCooldown = await isAccountInCooldown(accountId);

        accounts.push({
          ...metrics,
          tokensUsedHour: tokensUsed,
          requestsUsedMinute: requestsUsed,
          errorCount,
          inCooldown,
        });
      }
    }

    return NextResponse.json({ accounts });
  } catch (error) {
    console.error("Failed to fetch account metrics:", error);
    return NextResponse.json({ error: "Failed to fetch metrics" }, { status: 500 });
  }
}
