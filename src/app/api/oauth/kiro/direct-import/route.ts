import { NextResponse } from "next/server";
import { createProviderConnection, isCloudEnabled, resolveProxyForProvider } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { isAuthRequired, isAuthenticated } from "@/shared/utils/apiAuth";
import { KiroService } from "@/lib/oauth/services/kiro";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";

const directImportSchema = z.object({
  refreshToken: z.string().min(10),
  accessToken: z.string().min(10).optional(),
  email: z.string().optional(),
  region: z.string().default("us-east-1"),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

/**
 * POST /api/oauth/kiro/direct-import
 *
 * Import a Kiro account by supplying pre-validated tokens.
 * Unlike /import, this endpoint does NOT attempt social-auth validation.
 * It refreshes tokens via OIDC if clientId/clientSecret are provided,
 * or accepts already-refreshed tokens directly.
 *
 * This enables importing AWS Builder ID tokens that cannot be refreshed
 * via the social auth path.
 */
export async function POST(request: Request) {
  if (await isAuthRequired(request)) {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid request", details: [{ field: "body", message: "Invalid JSON body" }] } },
      { status: 400 }
    );
  }

  const validation = validateBody(directImportSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const targetProvider = searchParams.get("targetProvider") === "amazon-q" ? "amazon-q" : "kiro";

  try {
    const { refreshToken, region, clientId, clientSecret } = validation.data;
    let { accessToken, email } = validation.data;

    const kiroService = new KiroService();
    const proxy = await resolveProxyForProvider(targetProvider);

    const providerSpecificData: Record<string, any> = {
      authMethod: "imported",
      provider: "Imported (direct)",
      region,
    };

    // If clientId/clientSecret provided, refresh via OIDC to validate
    if (clientId && clientSecret) {
      providerSpecificData.clientId = clientId;
      providerSpecificData.clientSecret = clientSecret;

      const refreshed = await runWithProxyContext(proxy, () =>
        kiroService.refreshToken(refreshToken, {
          clientId,
          clientSecret,
          region,
          authMethod: "direct", // NOT "imported" — so it uses OIDC path
        })
      );

      accessToken = refreshed.accessToken;
      const finalRefreshToken = refreshed.refreshToken || refreshToken;

      if (refreshed._newClientId) {
        providerSpecificData.clientId = refreshed._newClientId;
        providerSpecificData.clientSecret = refreshed._newClientSecret;
        if (refreshed._newClientSecretExpiresAt) {
          providerSpecificData.clientSecretExpiresAt = refreshed._newClientSecretExpiresAt;
        }
      }

      if (!email && accessToken) {
        email = kiroService.extractEmailFromJWT(accessToken) || undefined;
      }

      const expiresAt = new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString();

      const connection: any = await createProviderConnection({
        provider: targetProvider,
        authType: "oauth",
        accessToken,
        refreshToken: finalRefreshToken,
        expiresAt,
        email: email || null,
        providerSpecificData,
        testStatus: "active",
      });

      await syncToCloudIfEnabled();

      return NextResponse.json({
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
        },
      });
    }

    // No client creds — accept the tokens as-is (caller must pre-validate)
    if (!accessToken) {
      return NextResponse.json(
        { error: "accessToken required when clientId/clientSecret not provided" },
        { status: 400 }
      );
    }

    if (!email) {
      email = kiroService.extractEmailFromJWT(accessToken) || undefined;
    }

    const connection: any = await createProviderConnection({
      provider: targetProvider,
      authType: "oauth",
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      email: email || null,
      providerSpecificData,
      testStatus: "active",
    });

    await syncToCloudIfEnabled();

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error: any) {
    console.error("Kiro direct-import error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

async function syncToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;
    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing to cloud after Kiro direct-import:", error);
  }
}
