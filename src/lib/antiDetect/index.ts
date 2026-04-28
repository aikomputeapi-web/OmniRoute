import { SocksProxyAgent } from "socks-proxy-agent";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

const ACCEPT_LANGUAGES = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-CA,en;q=0.9"];

interface AccountFingerprint {
  accountId: string;
  userAgent: string;
  acceptLanguage: string;
  proxyUrl?: string;
  staticIp?: string;
}

const fingerprintCache = new Map<string, AccountFingerprint>();

export function getOrCreateFingerprint(accountId: string): AccountFingerprint {
  if (fingerprintCache.has(accountId)) {
    return fingerprintCache.get(accountId)!;
  }

  const fingerprint: AccountFingerprint = {
    accountId,
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    acceptLanguage: ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)],
    proxyUrl: process.env.ROTATING_PROXY_URL,
  };

  fingerprintCache.set(accountId, fingerprint);
  return fingerprint;
}

export function applyFingerprint(headers: Record<string, string>, accountId: string): Record<string, string> {
  const fp = getOrCreateFingerprint(accountId);
  
  return {
    ...headers,
    "User-Agent": fp.userAgent,
    "Accept-Language": fp.acceptLanguage,
    "Sec-Ch-Ua": `"Not_A Brand";v="8", "Chromium";v="120"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  };
}

export function getProxyAgent(accountId: string): any {
  const fp = getOrCreateFingerprint(accountId);
  if (!fp.proxyUrl) return undefined;
  
  return new SocksProxyAgent(fp.proxyUrl);
}

export async function addJitter(minMs: number = 100, maxMs: number = 500): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise(resolve => setTimeout(resolve, delay));
}

export function shouldRotateProxy(accountId: string, errorCount: number): boolean {
  return errorCount > 3;
}
