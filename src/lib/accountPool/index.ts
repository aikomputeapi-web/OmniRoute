import { getRedisClient } from "../db/core";
import { isAccountInCooldown } from "../sessionPersistence";

const ACCOUNT_POOL_PREFIX = "pool:";
const TOKEN_USAGE_PREFIX = "tokens:";
const ERROR_COUNT_PREFIX = "errors:";

interface AccountMetrics {
  accountId: string;
  providerId: string;
  tokensUsedHour: number;
  requestsUsedMinute: number;
  errorCount: number;
  lastUsed: number;
  maxTokensPerHour: number;
  maxRequestsPerMinute: number;
}

export async function selectHealthyAccount(
  providerId: string,
  excludeAccounts: string[] = []
): Promise<string | null> {
  const redis = await getRedisClient();
  const poolKey = `${ACCOUNT_POOL_PREFIX}${providerId}`;
  const accountIds = await redis.smembers(poolKey);

  for (const accountId of accountIds) {
    if (excludeAccounts.includes(accountId)) continue;
    if (await isAccountInCooldown(accountId)) continue;
    
    const metrics = await getAccountMetrics(accountId);
    if (!metrics) continue;

    if (metrics.tokensUsedHour < metrics.maxTokensPerHour &&
        metrics.requestsUsedMinute < metrics.maxRequestsPerMinute &&
        metrics.errorCount < 5) {
      return accountId;
    }
  }

  return null;
}

export async function getAccountMetrics(accountId: string): Promise<AccountMetrics | null> {
  const redis = await getRedisClient();
  const data = await redis.get(`${ACCOUNT_POOL_PREFIX}metrics:${accountId}`);
  return data ? JSON.parse(data) : null;
}

export async function trackTokenUsage(accountId: string, tokensUsed: number): Promise<void> {
  const redis = await getRedisClient();
  const key = `${TOKEN_USAGE_PREFIX}${accountId}`;
  const current = parseInt((await redis.get(key)) || "0");
  await redis.setex(key, 3600, String(current + tokensUsed));
}

export async function trackRequestUsage(accountId: string): Promise<void> {
  const redis = await getRedisClient();
  const key = `${ACCOUNT_POOL_PREFIX}requests:${accountId}`;
  const current = parseInt((await redis.get(key)) || "0");
  await redis.setex(key, 60, String(current + 1));
}

export async function incrementErrorCount(accountId: string): Promise<number> {
  const redis = await getRedisClient();
  const key = `${ERROR_COUNT_PREFIX}${accountId}`;
  const count = await redis.incr(key);
  await redis.expire(key, 300);
  return count;
}

export async function resetErrorCount(accountId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(`${ERROR_COUNT_PREFIX}${accountId}`);
}

export async function addAccountToPool(
  accountId: string,
  providerId: string,
  maxTokensPerHour: number = 100000,
  maxRequestsPerMinute: number = 60
): Promise<void> {
  const redis = await getRedisClient();
  await redis.sadd(`${ACCOUNT_POOL_PREFIX}${providerId}`, accountId);
  
  const metrics: AccountMetrics = {
    accountId,
    providerId,
    tokensUsedHour: 0,
    requestsUsedMinute: 0,
    errorCount: 0,
    lastUsed: Date.now(),
    maxTokensPerHour,
    maxRequestsPerMinute,
  };
  
  await redis.set(`${ACCOUNT_POOL_PREFIX}metrics:${accountId}`, JSON.stringify(metrics));
}

export async function removeAccountFromPool(accountId: string, providerId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.srem(`${ACCOUNT_POOL_PREFIX}${providerId}`, accountId);
  await redis.del(`${ACCOUNT_POOL_PREFIX}metrics:${accountId}`);
}
