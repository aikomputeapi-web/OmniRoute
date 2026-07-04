import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { listFreeProxies, deleteFreeProxy } from "@/lib/localDb";

const TEST_URL = "https://api.openai.com/v1/models";
const TEST_TIMEOUT_MS = 5000;

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { testSingleProxy } = await import("@omniroute/open-sse/utils/proxyFallback");

    // Only test proxies that have been validated before (qualityScore != null)
    const proxies = await listFreeProxies({ onlyNotInPool: true });
    const candidates = proxies.filter((p) => p.qualityScore != null);

    let removed = 0;
    for (const proxy of candidates) {
      const url = `${proxy.type}://${proxy.host}:${proxy.port}`;
      try {
        const { ok } = await testSingleProxy(url, TEST_URL, TEST_TIMEOUT_MS);
        if (!ok) {
          await deleteFreeProxy(proxy.id);
          removed++;
        }
      } catch {
        await deleteFreeProxy(proxy.id);
        removed++;
      }
    }

    return Response.json({ success: true, removed });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to remove dead proxies");
  }
}
