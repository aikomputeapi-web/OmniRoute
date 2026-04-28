import { AUGMENT_CONFIG } from "../constants/oauth";

function parseJwtEmail(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return decoded.email || decoded.name || null;
  } catch {
    return null;
  }
}

/**
 * Discover the tenant URL for an Augment token by probing known subdomains.
 * Augment routes accounts to specific shards: d0-d20 and i0-i5.
 */
async function discoverTenantURL(token: string): Promise<string | null> {
  const candidates: string[] = [];
  for (let i = 0; i <= 20; i++) candidates.push(`https://d${i}.api.augmentcode.com/`);
  for (let i = 0; i <= 5; i++) candidates.push(`https://i${i}.api.augmentcode.com/`);

  const sessionId = crypto.randomUUID();
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
          "x-api-version": "2",
          "x-request-id": crypto.randomUUID(),
          "x-request-session-id": sessionId,
        },
        body: testBody,
        signal: AbortSignal.timeout(8000),
      });

      // 200 or 402 (payment required) both mean the token is valid for this shard
      if (res.status === 200 || res.status === 402) {
        // Consume body to avoid leaking connections
        await res.body?.cancel();
        return tenantURL;
      }

      // 401 with "Invalid token" means token is bad — stop probing
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

export const augment = {
  config: AUGMENT_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = Object.entries({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scope,
      audience: config.audience,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod,
    })
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");
    return `${config.authorizeUrl}?${params}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Augment token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    // Fetch user info from Auth0
    let userInfo: any = {};
    try {
      const userInfoRes = await fetch(AUGMENT_CONFIG.userInfoUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userInfoRes.ok) userInfo = await userInfoRes.json();
    } catch (e) {
      console.log("[Augment] User info fetch failed:", e);
    }

    // The access_token from Auth0 IS the bearer token used against the Augment API.
    // Discover which shard/tenant this account belongs to.
    let tenantURL: string | null = null;
    try {
      tenantURL = await discoverTenantURL(tokens.access_token);
    } catch (e) {
      console.log("[Augment] Tenant URL discovery failed:", e);
    }

    return { userInfo, tenantURL };
  },
  mapTokens: (tokens, extra) => {
    const email =
      extra?.userInfo?.email ||
      parseJwtEmail(tokens.id_token || "") ||
      null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in || 3600,
      email,
      name: extra?.userInfo?.name || extra?.userInfo?.nickname || email,
      providerSpecificData: {
        tenantURL: extra?.tenantURL || null,
        sessionId: crypto.randomUUID(), // persistent session ID for this account
        idToken: tokens.id_token || null,
      },
    };
  },
};
