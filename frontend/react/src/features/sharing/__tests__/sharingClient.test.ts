/**
 * ADR 0122 Phase 5 — listResources now enumerates document/conversation/prompt
 * (the backend already resolves all 5 types). Asserts each type hits its owning
 * feature's list endpoint + maps to {id,label}.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listResources, resolveSharedPublic } from '../sharingClient.js';

function mockFetchOnce(url: RegExp, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (!url.test(String(u))) return { ok: false, json: async () => ({}) } as unknown as Response;
    return { ok: true, json: async () => body } as unknown as Response;
  }));
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
  it('returns [] when the source feature is off (404 — its routes do not exist)', async () => {
    // R2 review F1 narrowed the contract: only 404 is the documented
    // "feature off" case; any other failure THROWS (see the F1 suite below).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    expect(await listResources('org1', 'document')).toEqual([]);
  });
});

describe('resolveSharedPublic — public viewer (ADR 0122 Phase 6)', () => {
  it('resolves the public resource on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ resourceType: 'conversation', resource: { kind: 'conversation', title: 'T', markdown: '# hi' } }) } as unknown as Response)));
    const out = await resolveSharedPublic('tok');
    expect(out.resourceType).toBe('conversation');
    expect((out.resource as { markdown: string }).markdown).toBe('# hi');
  });

  it('R2 SR-2/SR-10 — discriminates the failure: 404→gone, 410→expired, 5xx/network→unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'gone' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410, json: async () => ({}) } as unknown as Response)));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'expired' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'unavailable' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(resolveSharedPublic('tok')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('sends NO auth headers (the token is the credential)', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ resourceType: 'conversation', resource: {} }) } as unknown as Response));
    vi.stubGlobal('fetch', spy);
    await resolveSharedPublic('tok');
    // plain fetch(url) — a single positional arg, no init/headers object
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]!.length).toBe(1);
  });
});

describe('R2 review F1 — the picker read fails HONESTLY', () => {
  it('404 (feature off) resolves []; 500 THROWS so the page can say the read failed', async () => {
    const { listResources } = await import('../sharingClient.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    await expect(listResources('o1', 'cms_page')).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));
    await expect(listResources('o1', 'creative_brief')).rejects.toThrow(/500/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(listResources('o1', 'document')).rejects.toThrow();
  });
});
