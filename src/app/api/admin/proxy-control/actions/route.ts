import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { dispatchProxyControlAction } from "@/lib/api/proxyControlService";

/**
 * POST /api/admin/proxy-control/actions
 *
 * Dispatches a manual proxy-control action: `promote`, `demote`,
 * `quarantine`, `remove`, `run-check`, `run-sync`. `run-check` / `run-sync`
 * accept an empty `selectionKeys[]` (global tick). Selection keys are
 * `${tier}:${sourceId}` where Tier 1/2 sourceId is a `free_proxies.id` and
 * Tier 3 sourceId is a `proxy_registry.id`.
 *
 * Returns `{ success, action, applied, skipped, errors }`.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: { action?: unknown; selectionKeys?: unknown; actor?: unknown };
  try {
    const raw = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: "action request must be a JSON object" }, { status: 400 });
    }
    body = raw as { action?: unknown; selectionKeys?: unknown; actor?: unknown };
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Invalid JSON body");
  }

  try {
    const result = await dispatchProxyControlAction({
      action: String(body.action ?? ""),
      selectionKeys: body.selectionKeys,
      actor: body.actor,
    });
    return NextResponse.json(result, { status: result.success ? 200 : 207 });
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to dispatch action" },
      { status },
    );
  }
}
