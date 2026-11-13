/**
 * Proxy-aware fetch (fork addition).
 *
 * Kept in its own file so upstream merges never conflict with it. The only
 * upstream file that references it is `fetch-context.ts`, patched by
 * `.github/fork/apply-fork-changes.sh` on every upstream sync.
 *
 * Without a proxy: delegates to the global `fetch()`, so test suites can stub
 * it with `vi.stubGlobal('fetch', mock)`.
 *
 * With a proxy (HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy, in that
 * order): uses undici's own `fetch()` together with a `ProxyAgent`. Both must
 * come from the same undici build — mixing the npm-installed `ProxyAgent` with
 * Node's built-in global fetch (a different undici build) fails at dispatch
 * time with "invalid onRequestStart method" / UND_ERR_INVALID_ARG.
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici';

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** First non-empty proxy variable, or undefined for a direct connection. */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROXY_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

const agentCache = new Map<string, ProxyAgent>();

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

export function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) {
    return globalThis.fetch(url, init);
  }
  // undici's fetch/Response types differ nominally from the DOM ones; the
  // runtime shapes are compatible.
  return undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: getProxyAgent(proxyUrl),
  }) as unknown as Promise<Response>;
}
