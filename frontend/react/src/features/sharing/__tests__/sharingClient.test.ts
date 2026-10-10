/**
 * ADR 0122 Phase 5 — listResources now enumerates document/conversation/prompt
 * (the backend already resolves all 5 types). Asserts each type hits its owning
 * feature's list endpoint + maps to {id,label}. Plus the Phase 6 public resolve
 * (R2 SR-2/SR-10 failure discrimination, no auth headers) and R2 review F1
 * (only a 404 is "feature off"; any other failure THROWS).
 *
 * Sabotage-witnessed (w7 grade-tests): dropping the 404 branch reds the F1
 * case; `410` → `411` reds the discrimination case; passing auth headers on
 * the public resolve reds the no-auth case.
 *
 * Fakes are REAL `Response`s — no `as unknown as Response` laundering.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listResources, resolveSharedPublic } from '../sharingClient.js';

const res = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (impl: (url: string) => Promise<Response>): ReturnType<typeof vi.fn<typeof fetch>> => {
  const spy = vi.fn<typeof fetch>((input) => impl(String(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
};

/** Only the expected endpoint answers 200; anything else is an explicit 500. */
function mockFetchOnce(url: RegExp, body: unknown): void {
  stubFetch(async (u) => (url.test(u) ? res(200, body) : res(500)));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('listResources — Phase 5 types', () => {
  it('document → /documents, maps documentId+title', async () => {
    mockFetchOnce(/\/documents\/orgs\/org1\/documents/, { documents: [{ documentId: 'd1', title: 'Spec' }] });
    expect(await listResources('org1', 'document')).toEqual([{ id: 'd1', label: 'Spec' }]);
  });
  it('prompt → /prompts entries, maps entryId+name', async () => {
    mockFetchOnce(/\/prompts\/orgs\/org1\/entries/, { entries: [{ entryId: 'e1', name: 'Greeting' }] });
    expect(await listResources('org1', 'prompt')).toEqual([{ id: 'e1', label: 'Greeting' }]);
  });
  it('conversation → /chat/sessions (tenant-scoped), maps sessionId+title', async () => {
    mockFetchOnce(/\/chat\/sessions/, { sessions: [{ sessionId: 's1', title: 'Roadmap' }] });
    expect(await listResources('org1', 'conversation')).toEqual([{ id: 's1', label: 'Roadmap' }]);
  });
});

describe('resolveSharedPublic — public viewer (ADR 0122 Phase 6)', () => {
  it('resolves the public resource on 200', async () => {
    stubFetch(async () => res(200, { resourceType: 'conversation', resource: { kind: 'conversation', title: 'T', markdown: '# hi' } }));
    const out = await resolveSharedPublic('tok');
    expect(out.resourceType).toBe('conversation');
    expect(out.resource.markdown).toBe('# hi');
  });

  it('R2 SR-2/SR-10 — discriminates the failure: 404→gone, 410→expired, 5xx/network→unavailable', async () => {
    stubFetch(async () => res(404));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'gone' });
    stubFetch(async () => res(410));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'expired' });
    stubFetch(async () => res(500));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'unavailable' });
    stubFetch(async () => { throw new TypeError('network down'); });
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('sends NO auth headers (the token is the credential)', async () => {
    const spy = stubFetch(async () => res(200, { resourceType: 'conversation', resource: {} }));
    await resolveSharedPublic('tok');
    // plain fetch(url) — a single positional arg, no init/headers object
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]!.length).toBe(1);
  });
});

describe('R2 review F1 — the picker read fails HONESTLY', () => {
  it('404 (feature off) resolves []; 500 THROWS so the page can say the read failed', async () => {
    stubFetch(async () => res(404));
    await expect(listResources('o1', 'cms_page')).resolves.toEqual([]);
    await expect(listResources('o1', 'document')).resolves.toEqual([]);
    stubFetch(async () => res(500));
    await expect(listResources('o1', 'creative_brief')).rejects.toThrow(/500/);
    stubFetch(async () => { throw new TypeError('network down'); });
    await expect(listResources('o1', 'document')).rejects.toThrow();
  });
});
