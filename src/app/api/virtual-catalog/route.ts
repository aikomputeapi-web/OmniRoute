/**
 * /api/virtual-catalog — Admin API for the virtual model catalog.
 *
 * Manages the auto-generated combo-based model catalog that presents
 * customers with a clean, deduplicated model list.
 *
 * All endpoints require admin authentication.
 */

import { NextResponse } from "next/server";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { getSettings, updateSettings } from "@/lib/db/settings";
import {
  generateVirtualCatalog,
  getVirtualCatalogEntries,
} from "@/lib/catalog/generateVirtualCatalog";

async function requireAdmin(request: Request): Promise<Response | null> {
  if (!(await isDashboardSessionAuthenticated(request))) {
    return NextResponse.json(
      { error: { message: "Unauthorized", code: "unauthorized" } },
      { status: 401 }
    );
  }
  return null;
}

/**
 * GET /api/virtual-catalog
 * List all virtual catalog entries and current settings.
 */
export async function GET(request: Request) {
  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    const [entries, settings] = await Promise.all([getVirtualCatalogEntries(), getSettings()]);

    return NextResponse.json({
      enabled: settings.virtualCatalogEnabled === true,
      brand:
        typeof settings.virtualCatalogBrand === "string"
          ? settings.virtualCatalogBrand
          : "aikompute",
      providerOrder: Array.isArray(settings.virtualCatalogProviderOrder)
        ? settings.virtualCatalogProviderOrder
        : [],
      entries,
      totalModels: entries.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Failed to fetch catalog",
          code: "server_error",
        },
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/virtual-catalog
 * Regenerate the virtual catalog from current providers.
 * Body: { action: "generate" | "toggle", enabled?: boolean, brand?: string, providerOrder?: string[] }
 */
export async function POST(request: Request) {
  const authError = await requireAdmin(request);
  if (authError) return authError;

  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { message: "Invalid JSON body", code: "bad_request" } },
        { status: 400 }
      );
    }

    const action = typeof body.action === "string" ? body.action : "generate";

    if (action === "toggle") {
      // Toggle virtual catalog on/off
      const settingsUpdate: Record<string, unknown> = {};

      if (typeof body.enabled === "boolean") {
        settingsUpdate.virtualCatalogEnabled = body.enabled;
      }
      if (typeof body.brand === "string" && body.brand.trim()) {
        settingsUpdate.virtualCatalogBrand = body.brand.trim();
      }
      if (Array.isArray(body.providerOrder)) {
        settingsUpdate.virtualCatalogProviderOrder = body.providerOrder.filter(
          (item: unknown): item is string => typeof item === "string" && item.trim().length > 0
        );
      }

      if (Object.keys(settingsUpdate).length === 0) {
        return NextResponse.json(
          {
            error: {
              message: "No valid settings to update",
              code: "bad_request",
            },
          },
          { status: 400 }
        );
      }

      const updated = await updateSettings(settingsUpdate);
      return NextResponse.json({
        success: true,
        enabled: updated.virtualCatalogEnabled === true,
        brand: updated.virtualCatalogBrand || "aikompute",
        providerOrder: updated.virtualCatalogProviderOrder || [],
      });
    }

    if (action === "generate") {
      // Regenerate the virtual catalog
      const result = await generateVirtualCatalog();
      return NextResponse.json({
        success: true,
        ...result,
      });
    }

    return NextResponse.json(
      {
        error: {
          message: `Unknown action: ${action}. Use "generate" or "toggle".`,
          code: "bad_request",
        },
      },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Failed to update catalog",
          code: "server_error",
        },
      },
      { status: 500 }
    );
  }
}
