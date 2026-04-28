import crypto from "crypto";
import { OAuthService } from "./oauth";
import { AUGMENT_CONFIG } from "../constants/oauth";
import { getServerCredentials } from "../config/index";
import { spinner as createSpinner } from "../utils/ui";

export class AugmentService extends OAuthService {
  constructor() {
    super(AUGMENT_CONFIG);
  }

  buildAugmentAuthUrl(redirectUri: string, state: string, codeChallenge: string) {
    const params = Object.entries({
      response_type: "code",
      client_id: AUGMENT_CONFIG.clientId,
      redirect_uri: redirectUri,
      scope: AUGMENT_CONFIG.scope,
      audience: AUGMENT_CONFIG.audience,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: AUGMENT_CONFIG.codeChallengeMethod,
    })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${AUGMENT_CONFIG.authorizeUrl}?${params}`;
  }

  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Discover which Augment shard/tenant this token belongs to.
   * Augment routes accounts to specific shards: d0-d20 and i0-i5.
   * The access_token from Auth0 is used directly as the Bearer token.
   */
  async discoverTenantURL(token: string): Promise<string | null> {
    const candidates: string[] = [];
    for (let i = 0; i <= 20; i++) candidates.push(`https://d${i}.api.augmentcode.com/`);
    for (let i = 0; i <= 5; i++) candidates.push(`https://i${i}.api.augmentcode.com/`);

    const sessionId = this.generateSessionId();
    const testBody = JSON.stringify({
      message: "hi",
      mode: "CHAT",
      prefix: "You are an AI assistant.",
      suffix: " ",
      lang: "HTML",
      user_guidelines: "",
      workspace_guidelines: "",
      feature_detection_flags: { support_raw_output: true },
      tool_definitions: [],
      blobs: { checkpoint_id: null, added_blobs: [], deleted_blobs: [] },
    });

    for (const tenantURL of candidates) {
      try {
        const res = await fetch(`${tenantURL}chat-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": AUGMENT_CONFIG.userAgent,
            "x-api-version": AUGMENT_CONFIG.apiVersion,
            "x-request-id": this.generateSessionId(),
            "x-request-session-id": sessionId,
          },
          body: testBody,
          signal: AbortSignal.timeout(8000),
        });

        // 200 or 402 (payment required) both mean the token is valid for this shard
        if (res.status === 200 || res.status === 402) {
          await res.body?.cancel();
          return tenantURL;
        }

        // 401 with "Invalid token" means the token itself is bad — stop probing
        if (res.status === 401) {
          const body = await res.text();
          if (body.includes("Invalid token")) return null;
        }
      } catch {
        // timeout or network error — try next shard
      }
    }

    return null;
  }

  async saveTokens(tokens: any) {
    const { server, token, userId } = getServerCredentials();

    const response = await fetch(`${server}/api/cli/providers/augment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-User-Id": userId,
      },
      body: JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        email: tokens.email,
        providerSpecificData: tokens.providerSpecificData,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to save tokens");
    }

    return await response.json();
  }

  async connect() {
    const spinner = createSpinner("Starting Augment OAuth...").start();

    try {
      const { code, codeVerifier, redirectUri } = await this.authenticate(
        "Augment",
        this.buildAugmentAuthUrl.bind(this)
      );

      spinner.start("Exchanging code for tokens...");

      const tokens = await this.exchangeCode(
        code,
        redirectUri,
        codeVerifier,
        "application/x-www-form-urlencoded"
      );

      spinner.text = "Fetching user info...";

      let userInfo: any = {};
      try {
        const userInfoRes = await fetch(AUGMENT_CONFIG.userInfoUrl, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userInfoRes.ok) userInfo = await userInfoRes.json();
      } catch (e) {
        console.log("[Augment] User info fetch failed:", e);
      }

      spinner.text = "Discovering tenant shard...";

      let tenantURL: string | null = null;
      try {
        tenantURL = await this.discoverTenantURL(tokens.access_token);
      } catch (e) {
        console.log("[Augment] Tenant URL discovery failed:", e);
      }

      spinner.text = "Saving tokens to server...";

      await this.saveTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in || 3600,
        email: userInfo.email || null,
        providerSpecificData: {
          tenantURL: tenantURL || null,
          sessionId: this.generateSessionId(),
          idToken: tokens.id_token || null,
        },
      });

      spinner.succeed(
        `Augment connected successfully!${userInfo.email ? ` (${userInfo.email})` : ""}${
          tenantURL ? ` [${new URL(tenantURL).hostname}]` : ""
        }`
      );
      return true;
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      throw error;
    }
  }
}
