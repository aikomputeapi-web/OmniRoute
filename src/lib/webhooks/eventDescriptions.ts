export type WebhookEvent =
  | "request.completed"
  | "request.failed"
  | "provider.error"
  | "provider.recovered"
  | "quota.exceeded"
  | "combo.switched"
  | "proxy.demoted"
  | "proxy.pool-low"
  | "test.ping";

export interface EventDescription {
  label: string;
  description: string;
  emoji: string;
  exampleData: Record<string, unknown>;
}

export const EVENT_DESCRIPTIONS: Record<WebhookEvent, EventDescription> = {
  "request.completed": {
    label: "Request Completed",
    emoji: "✅",
    description: "Triggered when an upstream request completes successfully (HTTP 2xx).",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      latencyMs: 1240,
      tokensIn: 142,
      tokensOut: 38,
    },
  },
  "request.failed": {
    label: "Request Failed",
    emoji: "🚨",
    description: "Triggered when a request fails after all retries and fallback combo targets.",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      error: "503 Service Unavailable",
      attempts: 3,
    },
  },
  "provider.error": {
    label: "Provider Error",
    emoji: "⚠️",
    description: "A provider tripped the circuit breaker due to repeated failures.",
    exampleData: { provider: "openai", model: "gpt-4o", errorCode: 503, consecutiveFailures: 3 },
  },
  "provider.recovered": {
    label: "Provider Recovered",
    emoji: "✅",
    description: "A provider recovered from a circuit-breaker OPEN state.",
    exampleData: { provider: "openai", recoveredAfterMs: 60000 },
  },
  "quota.exceeded": {
    label: "Quota Exceeded",
    emoji: "📊",
    description: "A usage threshold (e.g. 95% of quota) was reached.",
    exampleData: { quota: "daily_tokens", used: 950000, limit: 1000000, pct: 95 },
  },
  "combo.switched": {
    label: "Combo Switched",
    emoji: "🔄",
    description: "Combo routing switched to a different target.",
    exampleData: {
      combo: "auto-fallback",
      fromModel: "gpt-4o",
      toModel: "claude-opus-4-7",
      reason: "provider.error",
    },
  },
  "proxy.demoted": {
    label: "Proxy Demoted",
    emoji: "⬇️",
    description: "A proxy was demoted between tiers due to liveness failures or repeated real-request errors.",
    exampleData: {
      tier: 3,
      host: "1.2.3.4",
      port: 8080,
      reason: "liveness-failed",
    },
  },
  "proxy.pool-low": {
    label: "Proxy Pool Low",
    emoji: "🪫",
    description: "The live Tier 3 proxy pool dropped below the minimum healthy threshold.",
    exampleData: {
      liveCount: 1,
      threshold: 3,
    },
  },
  "test.ping": {
    label: "Test Ping",
    emoji: "🏓",
    description: "Manual test delivery to verify your webhook is reachable.",
    exampleData: { message: "Test ping from OmniRoute", webhookId: "preview" },
  },
};
