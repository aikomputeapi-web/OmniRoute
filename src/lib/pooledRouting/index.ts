import { NextRequest, NextResponse } from "next/server";
import {
  getSessionMapping,
  setSessionMapping,
  updateSessionHistory,
  reassignSession,
} from "../sessionPersistence";
import { applyFingerprint, getProxyAgent, addJitter } from "../antiDetect";
import {
  selectHealthyAccount,
  trackTokenUsage,
  trackRequestUsage,
  incrementErrorCount,
  resetErrorCount,
} from "../accountPool";

export async function handlePooledRequest(
  request: NextRequest,
  userApiKey: string,
  providerId: string
): Promise<{ accountId: string; headers: Record<string, string>; agent?: any; history?: any[] }> {
  const sessionId = request.headers.get("x-session-id") || `default-${userApiKey}`;
  
  let mapping = await getSessionMapping(userApiKey, sessionId);
  
  if (!mapping) {
    const accountId = await selectHealthyAccount(providerId);
    if (!accountId) {
      throw new Error("No healthy accounts available");
    }
    
    await setSessionMapping(userApiKey, sessionId, accountId, providerId);
    mapping = await getSessionMapping(userApiKey, sessionId);
  }

  const accountId = mapping!.backendAccountId;
  const headers = applyFingerprint({}, accountId);
  const agent = getProxyAgent(accountId);
  
  await trackRequestUsage(accountId);
  
  return {
    accountId,
    headers,
    agent,
    history: mapping!.conversationHistory,
  };
}

export async function handlePooledResponse(
  userApiKey: string,
  sessionId: string,
  accountId: string,
  response: any,
  tokensUsed: number
): Promise<void> {
  if (response.status === 429) {
    const errorCount = await incrementErrorCount(accountId);
    console.log(`[AccountPool] 429 detected on ${accountId}, errors: ${errorCount}`);
    
    const mapping = await getSessionMapping(userApiKey, sessionId);
    if (mapping) {
      const newAccountId = await selectHealthyAccount(mapping.providerId, [accountId]);
      if (newAccountId) {
        await reassignSession(userApiKey, sessionId, newAccountId, "rate_limit_429");
      }
    }
  } else if (response.status >= 200 && response.status < 300) {
    await resetErrorCount(accountId);
    await trackTokenUsage(accountId, tokensUsed);
  }
  
  await addJitter();
}

export async function injectConversationHistory(
  requestBody: any,
  history: any[]
): Promise<any> {
  if (!history || history.length === 0) return requestBody;
  
  const messages = requestBody.messages || [];
  const combinedMessages = [...history, ...messages];
  
  return {
    ...requestBody,
    messages: combinedMessages,
  };
}
