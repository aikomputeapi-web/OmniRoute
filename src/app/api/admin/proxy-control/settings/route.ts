import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import {
  applyProxyControlSettings,
  buildProxyControlSnapshot,
} from "@/lib/api/proxyControlService";

/**
 * PATCH /api/admin/proxy-control/settings
 *
 * Accepts a partial `ProxySettings` (minute-form intervals + provider toggles)
 * plus an optional `actor`. Persists known keys into the `settings` namespace,
 * which triggers the free-proxy job hot-reload via `applyRuntimeSettings`.
 * Returns the fresh snapshot. Unknown top-level keys are rejected with 400.
 */
export async function PATCH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: "settings patch must be a JSON object" }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Invalid JSON body");
  }

  try {
    const snapshot = await applyProxyControlSettings(body, body.actor as string | undefined);
    return NextResponse.json(snapshot);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to apply settings",
      },
      { status },
    );
  }
}

/**
 * GET /api/admin/proxy-control/settings
 *
 * Convenience read of just the settings block (mirrors the snapshot's settings).
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const snapshot = await buildProxyControlSnapshot();
    return NextResponse.json({ settings: snapshot.settings, lastSyncedAt: snapshot.lastSyncedAt });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to read proxy settings");
  }
}
