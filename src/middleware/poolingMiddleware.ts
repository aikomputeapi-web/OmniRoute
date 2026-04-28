import { NextRequest } from "next/server";
import { handlePooledRequest, handlePooledResponse, injectConversationHistory } from "../pooledRouting";

export async function wrapWithPooling(
  request: NextRequest,
  userApiKey: string,
  providerId: string,
  executeRequest: (body: any, headers: Record<string, string>, agent?: any) => Promise<any>
): Promise<any> {
  const sessionId = request.headers.get("x-session-id") || `default-${userApiKey}`;
  
  const { accountId, headers, agent, history } = await handlePooledRequest(
    request,
    userApiKey,
    providerId
  );

  const body = await request.json();
  const enrichedBody = await injectConversationHistory(body, history || []);

  const response = await executeRequest(enrichedBody, headers, agent);
  
  const tokensUsed = response.usage?.total_tokens || 0;
  await handlePooledResponse(userApiKey, sessionId, accountId, response, tokensUsed);

  return response;
}
