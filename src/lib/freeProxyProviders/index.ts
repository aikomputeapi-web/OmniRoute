import type { FreeProxyProvider, FreeProxySourceId } from "./types";
import { OneproxyProvider } from "./oneproxy";
import { ProxiflyProvider } from "./proxifly";
import { IplocateProvider } from "./iplocate";
import { ProxyPoolProvider } from "./proxypool";

const ALL_PROVIDERS: FreeProxyProvider[] = [
  new OneproxyProvider(),
  new ProxiflyProvider(),
  new IplocateProvider(),
  new ProxyPoolProvider(),
];

export function getProvider(id: FreeProxySourceId): FreeProxyProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

export function getEnabledProviders(): FreeProxyProvider[] {
  return ALL_PROVIDERS.filter((p) => p.isEnabled());
}

export function getAllProviders(): FreeProxyProvider[] {
  return ALL_PROVIDERS;
}
