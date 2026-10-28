/**
 * ADR 0906 follow-up (ADR 0904 D12) — with no injected metadata, the
 * Certificate Manager adapter reads its token and project through the ONE
 * shared client, `host/gcpAdc.ts`. A metadata failure surfaces as a typed
 * provider error, not a raw fetch error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GCP_METADATA_TOKEN_URL, __resetGcpMetadataForTests } from '../src/host/gcpAdc.js';
import { EdgeProviderError, createGcpCertificateManagerProvider } from '../src/host/edgeCertificates/gcpCertificateManager.js';

const metadataCalls: string[] = [];

beforeEach(() => {
  __resetGcpMetadataForTests();
  metadataCalls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetGcpMetadataForTests();
});

function stubMetadata(ok: boolean): void {
  vi.stubGlobal('fetch', async (url: string) => {
    metadataCalls.push(String(url));
    if (!ok) return new Response('no metadata here', { status: 404 });
    if (String(url) === GCP_METADATA_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'adc-tok', expires_in: 3600 }));
    if (String(url).endsWith('/project/project-id')) return new Response('adc-proj\n');
    return new Response('?', { status: 404 });
  });
}

describe('the edge adapter uses host/gcpAdc by default', () => {
  it('token and project come from the shared metadata client', async () => {
    stubMetadata(true);
    const cm: Array<{ url: string; auth?: string }> = [];
    const p = createGcpCertificateManagerProvider({
      certMap: 'm1',
      fetch: async (url, init) => {
        cm.push({ url, auth: init.headers['authorization'] });
        return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'n', dnsResourceRecord: { name: '_acme-challenge_x.h.example.com.', data: 'x.authorize.certificatemanager.goog.' } }) };
      },
    });
    const out = await p.prepare('h.example.com');
    expect(out.done).toBe(true);
    expect(metadataCalls).toContain(GCP_METADATA_TOKEN_URL);
    expect(cm[0]!.url).toContain('/projects/adc-proj/locations/global/');
    for (const c of cm) expect(c.auth).toBe('Bearer adc-tok');
  });

  it('no metadata server ⇒ a typed EdgeProviderError', async () => {
    stubMetadata(false);
    const p = createGcpCertificateManagerProvider({ certMap: 'm1', fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
    await expect(p.prepare('h.example.com')).rejects.toBeInstanceOf(EdgeProviderError);
  });

  it.each(['token', 'project'] as const)('bounds a stalled %s metadata read and preserves its typed error', async (which) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal('fetch', (_url: string, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      started();
    }));
    const cmFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    const p = createGcpCertificateManagerProvider({ certMap: 'm1', ...(which === 'token' ? { project: 'adc-proj' } : {}), fetch: cmFetch });
    const pending = p.prepare('h.example.com');
    await requestStarted;
    expect(timeout).toHaveBeenCalledWith(3_000);
    const rejected = expect(pending).rejects.toBeInstanceOf(EdgeProviderError);
    controller.abort(new Error('metadata timed out'));
    await rejected;
    expect(cmFetch).not.toHaveBeenCalled();
  });
});
