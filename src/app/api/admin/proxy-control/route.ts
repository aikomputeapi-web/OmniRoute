import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { buildProxyControlSnapshot } from "@/lib/api/proxyControlService";

/**
 * GET /api/admin/proxy-control
 *
 * Returns the full Proxy Control Center snapshot (three-tier proxy pool +
 * persisted job settings + provider toggles + last sync timestamp). This is
 * the live source-of-truth read consumed by the customer-portal Proxy Control
 * Center UI via the `omnirouteFetch` bridge. See
 * `customer-portal/PROXY_CONTROL_CENTER_HANDOFF.md` for the wire contract.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const snapshot = await buildProxyControlSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to build proxy-control snapshot");
  }
}
