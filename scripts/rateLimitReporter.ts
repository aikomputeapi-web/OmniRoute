import { getUsageHistory } from "../src/lib/usage/usageHistory.ts";
import {
  getModelMultipliers,
  TOKEN_MULTIPLIERS,
} from "../open-sse/services/userRateLimitManager.ts";

async function fetchOpenRouterPrices(): Promise<Record<string, { input: number; output: number }>> {
  console.log("🔍 Fetching real-time model pricing from OpenRouter API...");
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) {
      throw new Error(`HTTP error: ${res.status}`);
    }
    const body = (await res.json()) as {
      data: Array<{ id: string; pricing: { prompt: string; completion: string } }>;
    };
    const priceMap: Record<string, { input: number; output: number }> = {};
    for (const model of body.data) {
      const promptPrice = Number(model.pricing.prompt) * 1_000_000; // to $/1M
      const completionPrice = Number(model.pricing.completion) * 1_000_000;
      priceMap[model.id] = { input: promptPrice, output: completionPrice };
    }
    return priceMap;
  } catch (error: any) {
    console.warn("⚠️ Failed to fetch pricing from OpenRouter:", error.message);
    return {};
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isMonthly = args.includes("--monthly");
  const days = isMonthly ? 30 : 7;
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(
    `📊 Generating ${isMonthly ? "Monthly" : "Weekly"} Token Usage and Pricing Report...`
  );
  console.log(`📅 Date Range: since ${sinceDate.toISOString().slice(0, 10)}`);

  // 1. Fetch usage history
  let history = [];
  try {
    history = await getUsageHistory({ startDate: sinceDate });
  } catch (e: any) {
    console.error("❌ Failed to query usage history:", e.message);
    return;
  }

  // 2. Aggregate token usage per model
  const aggregates: Record<
    string,
    {
      provider: string;
      rawInput: number;
      rawOutput: number;
      weightedTokens: number;
      requestCount: number;
    }
  > = {};

  let totalWeightedTokens = 0;

  for (const entry of history) {
    const model = entry.model || "unknown";
    const provider = entry.provider || "unknown";
    const input = entry.tokens?.input || 0;
    const output = entry.tokens?.output || 0;

    const mult = getModelMultipliers(model);
    const weighted = Math.ceil(input * mult.input + output * mult.output);

    if (!aggregates[model]) {
      aggregates[model] = {
        provider,
        rawInput: 0,
        rawOutput: 0,
        weightedTokens: 0,
        requestCount: 0,
      };
    }

    const agg = aggregates[model];
    agg.rawInput += input;
    agg.rawOutput += output;
    agg.weightedTokens += weighted;
    agg.requestCount += 1;

    totalWeightedTokens += weighted;
  }

  // 3. Print Token Usage Table
  console.log(
    "\n================================================================================================"
  );
  console.log("📈 TOKEN ENFORCEMENT & CONSUMPTION ANALYSIS");
  console.log(
    "================================================================================================"
  );
  console.log("%-30s | %-12s | %-12s | %-12s | %-15s | %-8s".replace(/%/g, "%"));
  console.log(
    "Model Name                     | Raw Input    | Raw Output   | Weighted     | % of Total Usg | Requests"
  );
  console.log(
    "------------------------------------------------------------------------------------------------"
  );

  const sorted = Object.entries(aggregates).sort(
    (a, b) => b[1].weightedTokens - a[1].weightedTokens
  );
  for (const [model, agg] of sorted) {
    const pct =
      totalWeightedTokens > 0
        ? ((agg.weightedTokens / totalWeightedTokens) * 100).toFixed(1)
        : "0.0";
    console.log(
      `${model.slice(0, 30).padEnd(30)} | ${String(agg.rawInput).padEnd(12)} | ${String(agg.rawOutput).padEnd(12)} | ${String(agg.weightedTokens).padEnd(12)} | ${pct.padStart(13)}% | ${String(agg.requestCount).padEnd(8)}`
    );
  }
  console.log(
    "================================================================================================"
  );
  console.log(
    `Total Normalized (Sonnet-Equivalent) Tokens: ${totalWeightedTokens.toLocaleString()}`
  );

  // 4. Online Price Checking & Recommendation Verification
  const externalPrices = await fetchOpenRouterPrices();
  if (Object.keys(externalPrices).length === 0) return;

  console.log("\n🕵️  PRICE DRIFT AND ANOMALY DETECTION REPORT");
  console.log(
    "================================================================================================"
  );

  // Mapping of internal config keys to standard OpenRouter model IDs
  const mapping: Record<string, string> = {
    "claude-sonnet-4-6": "anthropic/claude-3.5-sonnet",
    "claude-opus-4": "anthropic/claude-3-opus",
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gemini-3.1-pro": "google/gemini-pro-1.5",
    "deepseek-chat": "deepseek/deepseek-chat",
  };

  const sonnetInput = 3.0; // $3/1M
  const sonnetOutput = 15.0; // $15/1M

  let alertsCount = 0;

  for (const [key, mappingId] of Object.entries(mapping)) {
    const ext = externalPrices[mappingId];
    if (!ext) continue;

    const currentMultipliers = TOKEN_MULTIPLIERS[key];
    if (!currentMultipliers) continue;

    // Calculate expected multipliers based on current OpenRouter pricing relative to Sonnet base
    const expectedInputMult = ext.input / sonnetInput;
    const expectedOutputMult = ext.output / sonnetOutput;

    // Check if there is drift > 10%
    const inputDrift =
      Math.abs(currentMultipliers.input - expectedInputMult) /
      Math.max(0.01, currentMultipliers.input);
    const outputDrift =
      Math.abs(currentMultipliers.output - expectedOutputMult) /
      Math.max(0.01, currentMultipliers.output);

    if (inputDrift > 0.1 || outputDrift > 0.1) {
      alertsCount++;
      console.log(`⚠️  [DRIFT DETECTED] Multiplier drift for model alias: ${key}`);
      console.log(`   - Model ID: ${mappingId}`);
      console.log(
        `   - Config Multipliers: Input=${currentMultipliers.input}x, Output=${currentMultipliers.output}x`
      );
      console.log(
        `   - External Price rates: Input=$${ext.input.toFixed(2)}/1M, Output=$${ext.output.toFixed(2)}/1M`
      );
      console.log(
        `   - Suggested Multipliers: Input=${expectedInputMult.toFixed(2)}x, Output=${expectedOutputMult.toFixed(2)}x`
      );
      console.log(
        "------------------------------------------------------------------------------------------------"
      );
    }
  }

  if (alertsCount === 0) {
    console.log(
      "✅ No pricing drift or rate anomalies detected. All token multipliers are aligned with market rates."
    );
  } else {
    console.log(`🚨 Action Required: Found ${alertsCount} model(s) with pricing drift of > 10%.`);
    console.log(
      "   Please review and adjust the TOKEN_MULTIPLIERS config in open-sse/services/userRateLimitManager.ts."
    );
  }
  console.log(
    "================================================================================================"
  );
}

main().catch(console.error);
