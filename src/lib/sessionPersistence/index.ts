import { createHash } from "crypto";
import { getRedisClient } from "../db/core";

const SESSION_TTL = 3600;
const SESSION_PREFIX = "session:";
const ACCOUNT_COOLDOWN_PREFIX = "cooldown:";

interface SessionMapping {
  userApiKey: string;
  sessionId: string;
  backendAccountId: string;
  providerId: string;
  conversationHistory: any[];
  createdAt: number;
  lastUsed: number;
}

export function hashSessionId(userApiKey: string, sessionId: string): string {
  return createHash("sha256").update(`${userApiKey}:${sessionId}`).digest("hex").slice(0, 16);
}

export async function getSessionMapping(
  userApiKey: string,
  sessionId: string
): Promise<SessionMapping | null> {
  const redis = await getRedisClient();
  const key = `${SESSION_PREFIX}${hashSessionId(userApiKey, sessionId)}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}

export async function setSessionMapping(
  userApiKey: string,
  sessionId: string,
  backendAccountId: string,
  providerId: string,
  conversationHistory: any[] = []
): Promise<void> {
  const redis = await getRedisClient();
  const key = `${SESSION_PREFIX}${hashSessionId(userApiKey, sessionId)}`;
  const mapping: SessionMapping = {
    userApiKey,
    sessionId,
    backendAccountId,
    providerId,
    conversationHistory,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };
  await redis.setex(key, SESSION_TTL, JSON.stringify(mapping));
}

export async function updateSessionHistory(
  userApiKey: string,
  sessionId: string,
  newMessage: any
): Promise<void> {
  const mapping = await getSessionMapping(userApiKey, sessionId);
  if (!mapping) return;
  
  mapping.conversationHistory.push(newMessage);
  mapping.lastUsed = Date.now();
  
  const redis = await getRedisClient();
  const key = `${SESSION_PREFIX}${hashSessionId(userApiKey, sessionId)}`;
  await redis.setex(key, SESSION_TTL, JSON.stringify(mapping));
}

export async function reassignSession(
  userApiKey: string,
  sessionId: string,
  newBackendAccountId: string,
  reason: string = "rate_limit"
): Promise<SessionMapping | null> {
  const mapping = await getSessionMapping(userApiKey, sessionId);
  if (!mapping) return null;

  const oldAccountId = mapping.backendAccountId;
  mapping.backendAccountId = newBackendAccountId;
  mapping.lastUsed = Date.now();

  const redis = await getRedisClient();
  const key = `${SESSION_PREFIX}${hashSessionId(userApiKey, sessionId)}`;
  await redis.setex(key, SESSION_TTL, JSON.stringify(mapping));

  await cooldownAccount(oldAccountId, 60);

  console.log(`[SessionPersistence] Reassigned ${sessionId}: ${oldAccountId} → ${newBackendAccountId} (${reason})`);
  return mapping;
}

export async function cooldownAccount(accountId: string, seconds: number): Promise<void> {
  const redis = await getRedisClient();
  await redis.setex(`${ACCOUNT_COOLDOWN_PREFIX}${accountId}`, seconds, "1");
}

export async function isAccountInCooldown(accountId: string): Promise<boolean> {
  const redis = await getRedisClient();
  return (await redis.get(`${ACCOUNT_COOLDOWN_PREFIX}${accountId}`)) !== null;
}
