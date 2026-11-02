/**
 * ADR 0904 P1b (D12, architect X1) — the ONE GCP metadata client, `host/gcpAdc.ts`.
 * (Drafted in ADR 0906 P0, moved here when the ADR plan gave the helper to 0904 P1b.)
 *
 *  - the token is cached until a minute before expiry, then refetched;
 *  - `invalidate()` drops it (callers do this on a 401/403);
 *  - every failure is a typed `GcpMetadataError` that callers map themselves.
 * The single-fetcher ratchet is `gcp-adc-single-fetcher-ratchet.test.ts`.
 *
 * TST-DEC-2 — red when: the refresh-early margin or the fallback TTL changes,
 * `invalidate()` keeps the token, plain values stop being trimmed, the
 * `Metadata-Flavor: Google` header is dropped, an HTTP error / missing token /
 * network failure / non-JSON body stops being a typed `GcpMetadataError` with its
 * own message, or callers stop sharing ONE process-wide client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GCP_METADATA_TOKEN_URL, GcpMetadataError, createGcpMetadataClient, gcpMetadata, __resetGcpMetadataForTests } from '../src/host/gcpAdc.js';

type TokenReply = { access_token?: string; expires_in?: number } | number;
function fakeMetadata(tokens: TokenReply[]) {
  const calls: Array<{ url: string; flavor?: string }> = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, flavor: init?.headers?.['Metadata-Flavor'] });
    if (url.endsWith('/project/project-id')) return { ok: true, status: 200, text: async () => 'proj-1\n' };
    const next = tokens[Math.min(i++, tokens.length - 1)]!;
    if (typeof next === 'number') return { ok: false, status: next, text: async () => 'nope' };
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  return { fetchImpl, calls };
}

describe('gcpAdc — token caching', () => {
  it('caches until a minute before expiry, then refetches', async () => {
    let now = 1_000_000;
    const md = fakeMetadata([{ access_token: 'a', expires_in: 3600 }, { access_token: 'b', expires_in: 3600 }]);
    const client = createGcpMetadataClient({ fetchImpl: md.fetchImpl, now: () => now });
    expect(await client.accessToken()).toBe('a');
    now += 3540_000 - 1;
    expect(await client.accessToken()).toBe('a');
    expect(md.calls).toHaveLength(1);
    expect(md.calls[0]).toEqual({ url: GCP_METADATA_TOKEN_URL, flavor: 'Google' });
    now += 2;
    expect(await client.accessToken()).toBe('b');
    expect(md.calls).toHaveLength(2);
  });

  it('a missing or tiny expires_in falls back to a one-minute cache', async () => {
    let now = 0;
    const md = fakeMetadata([{ access_token: 'a' }, { access_token: 'b', expires_in: 30 }, { access_token: 'c', expires_in: 30 }]);
    const client = createGcpMetadataClient({ fetchImpl: md.fetchImpl, now: () => now });
    expect(await client.accessToken()).toBe('a');
    now += 60_001;
    expect(await client.accessToken()).toBe('b');
    now += 59_999;
    expect(await client.accessToken()).toBe('b');
  });

  it('invalidate() forces a fresh token', async () => {
    const md = fakeMetadata([{ access_token: 'a', expires_in: 3600 }, { access_token: 'b', expires_in: 3600 }]);
    const client = createGcpMetadataClient({ fetchImpl: md.fetchImpl, now: () => 0 });
    expect(await client.accessToken()).toBe('a');
    client.invalidate();
    expect(await client.accessToken()).toBe('b');
  });

  it('reads plain metadata values trimmed', async () => {
    const md = fakeMetadata([]);
    expect(await createGcpMetadataClient({ fetchImpl: md.fetchImpl }).metadataText('project/project-id')).toBe('proj-1');
    // Same metadata base as the token endpoint, plain-value path.
    expect(md.calls).toEqual([{ url: GCP_METADATA_TOKEN_URL.replace('instance/service-accounts/default/token', 'project/project-id'), flavor: 'Google' }]);
  });
});

describe('gcpAdc — typed failures', () => {
  it.each<[string, TokenReply[], RegExp]>([
    ['an HTTP error', [500], /HTTP 500/],
    ['a body without access_token', [{ expires_in: 10 }], /no access_token/],
  ])('%s is a GcpMetadataError', async (_l, tokens, msg) => {
    const md = fakeMetadata(tokens);
    const p = createGcpMetadataClient({ fetchImpl: md.fetchImpl }).accessToken();
    await expect(p).rejects.toBeInstanceOf(GcpMetadataError);
    await expect(createGcpMetadataClient({ fetchImpl: md.fetchImpl }).accessToken()).rejects.toThrow(msg);
  });

  it('a network failure (off GCP) is a GcpMetadataError', async () => {
    const client = createGcpMetadataClient({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    const p = client.accessToken();
    await expect(p).rejects.toBeInstanceOf(GcpMetadataError);
    // The network cause survives in the message (not re-labelled "not JSON").
    await expect(p).rejects.toThrow('metadata instance/service-accounts/default/token: getaddrinfo ENOTFOUND');
  });

  it('a non-JSON token body is a GcpMetadataError', async () => {
    const client = createGcpMetadataClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
    const p = client.accessToken();
    await expect(p).rejects.toBeInstanceOf(GcpMetadataError);
    await expect(p).rejects.toThrow('metadata token: response was not JSON');
  });
});

describe('gcpAdc — the process-wide client', () => {
  afterEach(() => { __resetGcpMetadataForTests(); });

  it('every caller shares ONE client (one cached token), until the test seam drops it', () => {
    const a = gcpMetadata();
    expect(gcpMetadata(), 'the four callers must share the cached token, not mint their own').toBe(a);
    __resetGcpMetadataForTests();
    const b = gcpMetadata();
    expect(b).not.toBe(a);
    expect(gcpMetadata()).toBe(b);
  });
});
