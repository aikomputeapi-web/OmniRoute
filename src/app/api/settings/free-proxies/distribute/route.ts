import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { distributeProxiesToAccounts } from "@/lib/jobs/freeProxyJob";
import { getSettings, updateSettings } from "@/lib/db/settings";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const result = await distributeProxiesToAccounts();

    return Response.json({
      success: true,
      ...result,
      message: `Distributed proxies across ${result.providers} provider(s): ${result.assigned} assigned, ${result.unassigned} unassigned (1:1, no same-provider sharing)`,
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to distribute proxies to accounts");
  }
}

/**
 * GET — returns the current auto-distribute setting.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const settings = await getSettings();
    return Response.json({
      autoDistribute: settings.freeProxyAutoDistribute === true,
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to load auto-distribute setting");
  }
}

/**
 * PUT — toggle the freeProxyAutoDistribute setting (true/false in JSON body).
 */
export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json().catch(() => ({}))) as { autoDistribute?: boolean };
    if (typeof body.autoDistribute !== "boolean") {
      return createErrorResponse({
        status: 400,
        message: "autoDistribute (boolean) is required",
        type: "invalid_request",
      });
    }

    await updateSettings({ freeProxyAutoDistribute: body.autoDistribute });

    // Hot-reload the job so the new setting takes effect immediately
    const { reloadFreeProxyJob } = await import("@/lib/jobs/freeProxyJob");
    await reloadFreeProxyJob().catch((err) =>
      console.warn("[FreeProxyDistribute] hot-reload failed:", err)
    );

    return Response.json({
      success: true,
      autoDistribute: body.autoDistribute,
      message: body.autoDistribute
        ? "Auto-distribute enabled — Tier 3 proxies will be spread across provider accounts each sync cycle"
        : "Auto-distribute disabled",
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to update auto-distribute setting");
  }
}
