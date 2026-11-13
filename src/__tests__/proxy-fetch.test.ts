import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  proxyAgentCtor: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mocks.undiciFetch,
  ProxyAgent: class {
    constructor(public readonly url: string) {
      mocks.proxyAgentCtor(url);
    }
  },
}));

const ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

async function load(): Promise<typeof import('../proxy-fetch.js')> {
  vi.resetModules();
  return import('../proxy-fetch.js');
}

describe('proxy-fetch', () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    mocks.undiciFetch.mockReset().mockResolvedValue(new Response('via-proxy'));
    mocks.proxyAgentCtor.mockReset();
    globalFetch.mockReset().mockResolvedValue(new Response('direct'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the global fetch when no proxy is configured', async () => {
    const { proxyFetch } = await load();
    const init = { method: 'GET' };

    await proxyFetch('https://data.bka.gv.at/x', init);

    expect(globalFetch).toHaveBeenCalledWith('https://data.bka.gv.at/x', init);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('ignores empty proxy variables', async () => {
    vi.stubEnv('HTTPS_PROXY', '   ');
    const { proxyFetch } = await load();

    await proxyFetch('https://example.test', {});

    expect(globalFetch).toHaveBeenCalledOnce();
    expect(mocks.proxyAgentCtor).not.toHaveBeenCalled();
  });

  it('routes through undici with a ProxyAgent dispatcher when HTTPS_PROXY is set', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128');
    const { proxyFetch } = await load();

    await proxyFetch('https://example.test', { method: 'GET' });

    expect(globalFetch).not.toHaveBeenCalled();
    expect(mocks.proxyAgentCtor).toHaveBeenCalledWith('http://proxy.internal:3128');
    const [url, init] = mocks.undiciFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://example.test');
    expect(init['method']).toBe('GET');
    expect(init['dispatcher']).toBeDefined();
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY and falls back to lowercase names', async () => {
    const { resolveProxyUrl } = await load();

    expect(resolveProxyUrl({ HTTP_PROXY: 'http://b', HTTPS_PROXY: 'http://a' })).toBe('http://a');
    expect(resolveProxyUrl({ http_proxy: 'http://c' })).toBe('http://c');
    expect(resolveProxyUrl({})).toBeUndefined();
  });

  it('reuses one ProxyAgent per proxy URL', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://proxy.internal:3128');
    const { proxyFetch } = await load();

    await proxyFetch('https://a.test', {});
    await proxyFetch('https://b.test', {});

    expect(mocks.proxyAgentCtor).toHaveBeenCalledTimes(1);
  });
});
