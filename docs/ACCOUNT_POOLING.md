# OmniRoute Pooling & Anti-Detection System

## Overview

This system implements the pooling features that run inside OmniRoute as part of the unified AI platform:

1. **Sticky Sessions** — Conversation persistence across backend accounts
2. **Anti-Detection Layer** — IP rotation, fingerprint randomization, and jitter
3. **Smart Account Pool** — Token-level throttling and error-triggered rotation

---

## 1. Sticky Sessions (Session Persistence)

### Problem
In a pooled environment with multiple backend accounts, if a user's first message goes to Account A and their second message goes to Account B, the conversation "breaks" because Account B has no context.

### Solution
**Header-Based Routing** with Redis-backed session mapping:

```typescript
// Client sends custom header
x-session-id: user-conversation-123
```

The gateway:
- Hashes `User_API_Key + Session_ID` → maps to `Backend_Account_ID`
- Stores conversation history in Redis (TTL: 1 hour)
- On 429 error: automatically reassigns to fresh account + re-injects history

### Usage

**Client Side:**
```bash
curl https://yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "x-session-id: conversation-abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Server Side:**
```typescript
import { getSessionMapping, setSessionMapping, reassignSession } from "@/lib/sessionPersistence";

// Get existing session
const mapping = await getSessionMapping(userApiKey, sessionId);

// Create new session
await setSessionMapping(userApiKey, sessionId, backendAccountId, providerId);

// Reassign on rate limit
await reassignSession(userApiKey, sessionId, newAccountId, "rate_limit_429");
```

### Database Schema (Redis)

```
session:{hash}
{
  "userApiKey": "sk-...",
  "sessionId": "conversation-123",
  "backendAccountId": "conn-abc...",
  "providerId": "openai",
  "conversationHistory": [...],
  "createdAt": 1234567890,
  "lastUsed": 1234567890
}

cooldown:{accountId}  → "1" (TTL: 60s)
```

---

## 2. Anti-Detection Layer

### Problem
Large providers (OpenAI, Anthropic) use telemetry to detect "resale" behavior:
- 500 accounts from one server IP = instant ban
- Identical User-Agent across accounts = red flag
- Perfectly consistent response times = bot detection

### Solution

#### A. IP Rotation (Residential Proxies)
Each backend account is pinned to a static residential IP to avoid "Impossible Travel" flags.

```bash
# .env
ROTATING_PROXY_URL=socks5://user:pass@proxy.example.com:1080
```

Recommended providers:
- **Bright Data** (residential IPs, $500/mo for 40GB)
- **Smartproxy** (residential + datacenter mix)
- **Oxylabs** (enterprise-grade)

#### B. Fingerprint Randomization
Randomize browser fingerprints per account:

```typescript
import { applyFingerprint, getProxyAgent } from "@/lib/antiDetect";

const headers = applyFingerprint({}, accountId);
// Result:
// {
//   "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
//   "Accept-Language": "en-US,en;q=0.9",
//   "Sec-Ch-Ua": "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\"",
//   ...
// }

const agent = getProxyAgent(accountId);
```

#### C. Jitter (Human Simulation)
Add random delay (100-500ms) to responses:

```typescript
import { addJitter } from "@/lib/antiDetect";

await addJitter(100, 500); // Random delay between 100-500ms
```

### Advanced: Nstbrowser Integration
For web-based accounts (via Sub2API/CLIProxyAPI):

```typescript
// Future enhancement: integrate Nstbrowser for full browser fingerprinting
// - Canvas fingerprinting
// - WebGL fingerprinting
// - Audio context fingerprinting
```

---

## 3. Smart Account Pool

### Problem
Free/trial accounts have strict limits:
- Token quotas (e.g., 100K tokens/hour)
- Request rate limits (e.g., 60 req/min)
- Providers ban accounts that hit 429 repeatedly

### Solution

#### A. Token-Level Throttling
Track tokens per hour per account (not just requests):

```typescript
import { trackTokenUsage, selectHealthyAccount } from "@/lib/accountPool";

// After each request
await trackTokenUsage(accountId, tokensUsed);

// Before routing
const accountId = await selectHealthyAccount(providerId, excludeAccounts);
```

#### B. Error-Triggered Rotation
Automatically cool down accounts on 429:

```typescript
import { incrementErrorCount, cooldownAccount } from "@/lib/accountPool";

if (response.status === 429) {
  const errorCount = await incrementErrorCount(accountId);
  await cooldownAccount(accountId, 60); // 60 second cooldown
  
  // Reassign session to fresh account
  await reassignSession(userApiKey, sessionId, newAccountId, "rate_limit_429");
}
```

#### C. Account Metrics
Each account tracks:
- `tokensUsedHour` — resets every hour
- `requestsUsedMinute` — resets every minute
- `errorCount` — increments on 4xx/5xx, resets on success
- `lastUsed` — timestamp of last request

### Account Pool Management

**Add Account:**
```typescript
import { addAccountToPool } from "@/lib/accountPool";

await addAccountToPool(
  "conn-abc123",
  "openai",
  100000, // maxTokensPerHour
  60      // maxRequestsPerMinute
);
```

**Remove Account:**
```typescript
import { removeAccountFromPool } from "@/lib/accountPool";

await removeAccountFromPool("conn-abc123", "openai");
```

---

## Integration Example

### Full Request Flow

```typescript
import { handlePooledRequest, handlePooledResponse } from "@/lib/pooledRouting";

export async function POST(request: NextRequest) {
  const userApiKey = extractApiKey(request);
  const sessionId = request.headers.get("x-session-id") || `default-${userApiKey}`;
  
  // 1. Get healthy account + apply anti-detection
  const { accountId, headers, agent, history } = await handlePooledRequest(
    request,
    userApiKey,
    "openai"
  );
  
  // 2. Inject conversation history
  const body = await request.json();
  const enrichedBody = await injectConversationHistory(body, history);
  
  // 3. Execute request with fingerprinted headers + proxy
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      ...headers,
      "Authorization": `Bearer ${accountToken}`,
    },
    body: JSON.stringify(enrichedBody),
    agent, // SOCKS5 proxy agent
  });
  
  // 4. Track usage + handle errors
  const tokensUsed = response.usage?.total_tokens || 0;
  await handlePooledResponse(userApiKey, sessionId, accountId, response, tokensUsed);
  
  return response;
}
```

---

## Configuration

### Environment Variables

```bash
# Enable features
ENABLE_SESSION_PERSISTENCE=true
ENABLE_FINGERPRINT_RANDOMIZATION=true
ENABLE_ACCOUNT_POOLING=true

# Proxy
ROTATING_PROXY_URL=socks5://user:pass@proxy.example.com:1080

# Limits
DEFAULT_MAX_TOKENS_PER_HOUR=100000
DEFAULT_MAX_REQUESTS_PER_MINUTE=60
ACCOUNT_COOLDOWN_SECONDS=60
ACCOUNT_ERROR_THRESHOLD=5

# Jitter
JITTER_MIN_MS=100
JITTER_MAX_MS=500
```

### Redis Requirements

Ensure Redis is configured with:
```bash
maxmemory 256mb
maxmemory-policy allkeys-lru
appendonly yes
```

---

## Monitoring

### Key Metrics to Track

1. **Session Reassignments** — how often sessions switch accounts
2. **Account Cooldowns** — frequency of 429 errors per account
3. **Token Usage** — tokens/hour per account
4. **Error Rates** — 4xx/5xx per account
5. **Proxy Latency** — response time with/without proxy

### Logs

```bash
[SessionPersistence] Reassigned session-123: conn-abc → conn-xyz (rate_limit_429)
[AccountPool] 429 detected on conn-abc, errors: 3
[AntiDetect] Applied fingerprint for conn-abc: Chrome/120.0 Windows
```

---

## Best Practices

### 1. Session ID Strategy
- **Per-conversation:** `x-session-id: conv-{uuid}`
- **Per-user:** `x-session-id: user-{userId}`
- **Default:** Auto-generated from API key

### 2. Proxy Selection
- Use **residential proxies** for OAuth accounts (Claude, Gemini)
- Use **datacenter proxies** for API key providers (DeepSeek, Groq)
- Pin each account to a **static IP** (avoid rotation mid-session)

### 3. Account Limits
- Set conservative limits: 80% of provider's actual limit
- Monitor token usage in real-time
- Rotate accounts before hitting hard limits

### 4. Error Handling
- On 429: cooldown + reassign immediately
- On 401/403: mark account as invalid, remove from pool
- On 5xx: retry with exponential backoff

---

## Scaling

### 100 Users
- 10-20 backend accounts per provider
- 1 Redis instance (256MB)
- No proxy required (use server IP)

### 500 Users
- 50-100 backend accounts per provider
- Redis cluster (1GB)
- Rotating residential proxy (40GB/mo)

### 1000+ Users
- 200+ backend accounts per provider
- Redis cluster (4GB+)
- Dedicated proxy pool (100GB/mo)
- Account harvester automation

---

## Security Considerations

1. **Rate Limit Evasion** — This system is designed for legitimate use cases (aggregation, failover). Do not use for abusive traffic.

2. **Provider ToS** — Ensure your use case complies with provider terms of service.

3. **Data Privacy** — Conversation history is stored in Redis. Use encryption at rest.

4. **Proxy Security** — Use authenticated SOCKS5 proxies. Avoid free/public proxies.

---

## Troubleshooting

### Sessions Not Persisting
```bash
# Check Redis connection
redis-cli -a YOUR_PASSWORD ping

# Check session keys
redis-cli -a YOUR_PASSWORD keys "session:*"
```

### Accounts Still Getting Banned
- Verify proxy is working: `curl --socks5 proxy.example.com:1080 https://api.ipify.org`
- Check fingerprint diversity: ensure User-Agent varies per account
- Increase jitter: set `JITTER_MAX_MS=1000`

### High Latency
- Proxy overhead: 50-200ms typical for residential proxies
- Reduce jitter: set `JITTER_MIN_MS=50 JITTER_MAX_MS=200`
- Use datacenter proxies for API key providers

---

## Future Enhancements

1. **Account Harvester** — Automate trial account creation
2. **Nstbrowser Integration** — Full browser fingerprinting
3. **ML-Based Routing** — Predict account exhaustion before 429
4. **Multi-Region Proxies** — Route based on user geography
5. **Account Health Dashboard** — Real-time metrics per account

---

## References

- [Sticky Sessions Pattern](https://en.wikipedia.org/wiki/Load_balancing_(computing)#Persistence)
- [Browser Fingerprinting](https://github.com/fingerprintjs/fingerprintjs)
- [SOCKS5 Proxy Protocol](https://datatracker.ietf.org/doc/html/rfc1928)
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
