import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { runFreeProxyCheckTick } from "@/lib/jobs/freeProxyJob";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    // Run candidate proxy verification checks asynchronously so the HTTP request completes immediately
    void runFreeProxyCheckTick().catch((err) => {
      console.error("[ProxyTestAll] Verification check tick failed:", err);
    });

    return Response.json({
      success: true,
      message: "Verification checks started on all candidates",
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to trigger proxy validation checks");
  }
}
