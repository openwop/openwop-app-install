/**
 * Chat artifact workbench (ADR 0069) — ROUTE-level harness. Boots the real app
 * and drives the type-neutral `/artifacts/*` projection over a Documents-backed
 * artifact: get, revisions, immutable-revision diff, toggle gating, and
 * cross-org IDOR (404, no existence leak).
 *
 * TST-BZE-28 (grade-tests w66). Red when: a missing diff revision stops being a 422; a
 * media artifact becomes diffable; the Library sorts oldest-first; the org `workspace:read`
 * gate is dropped (the SAME-tenant non-member below — a cross-tenant stranger is refused
 * earlier, by the tenant-scoped document lookup, and so never reaches the org gate).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAsset } from '../src/features/media/mediaService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
/** Narrow views of the bodies this file reads (the projection's public fields). */
interface ArtifactBody { source?: string; kind?: string; format?: string; artifactTypeId?: string; latestRevisionId?: string; status?: string }
interface RevisionsBody { revisions: Array<{ version?: number; revisionId: string }> }
interface RevisionBody { content?: unknown }
interface DiffBody { diff: { format: string; added: number; removed: number } }
interface LibraryBody { artifacts: Array<{ artifactId: string; createdAt: string }> }
interface Client {
  get: <T = Record<string, unknown>>(p: string) => Promise<Res<T>>;
  post: <T = Record<string, unknown>>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    // JSON off the wire is untyped: each call site names the narrow body it reads.
    const out = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, tenantId: string): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('art'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** An owner with an org + a 2-version document; returns the artifactId + version ids. */
async function seedArtifact(): Promise<{ owner: Client; tenantId: string; artifactId: string; v1: string; v2: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId;
  const D = (s = ''): string => `/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}${s}`;
  const doc = await owner.post<{ documentId: string }>(D('/documents'), { title: 'Acme SOW', kind: 'sow' });
  const id = doc.body.documentId;
  await owner.post(D(`/documents/${id}/versions`), { content: '# SOW\nalpha\nbeta' });
  await owner.post(D(`/documents/${id}/versions`), { content: '# SOW\nalpha\nGAMMA\ndelta' });
  return { owner, tenantId, artifactId: `document:${id}`, v1: `${id}:1`, v2: `${id}:2` };
}

const A = (artifactId: string, suffix = ''): string => `/host/openwop-app/artifacts/${encodeURIComponent(artifactId)}${suffix}`;

describe('GET /artifacts/:artifactId — Documents-backed projection', () => {
  it('projects the document into a type-neutral artifact + revision timeline', async () => {
    const { owner, artifactId, v2 } = await seedArtifact();
    const art = await owner.get<ArtifactBody>(A(artifactId));
    expect(art.status).toBe(200);
    expect(art.body.source).toBe('document');
    expect(art.body.kind).toBe('sow');
    expect(art.body.artifactTypeId).toBe('doc.sow'); // seeded host type
    expect(art.body.latestRevisionId).toBe(v2);
    expect(art.body.status).toBe('draft');

    const revs = await owner.get<RevisionsBody>(A(artifactId, '/revisions'));
    expect(revs.status).toBe(200);
    expect(revs.body.revisions.map((r) => r.version)).toEqual([2, 1]); // newest-first
  });

  it('diffs two IMMUTABLE revisions (line diff); rejects a missing revision (422)', async () => {
    const { owner, artifactId, v1, v2 } = await seedArtifact();
    const diff = await owner.get<DiffBody>(A(artifactId, `/diff?from=${encodeURIComponent(v1)}&to=${encodeURIComponent(v2)}`));
    expect(diff.status).toBe(200);
    expect(diff.body.diff.format).toBe('text');
    // Hand-computed: [# SOW, alpha, beta] → [# SOW, alpha, GAMMA, delta].
    expect(diff.body.diff.added).toBe(2); // GAMMA + delta added
    expect(diff.body.diff.removed).toBe(1); // beta removed

    expect((await owner.get(A(artifactId, `/diff?from=${encodeURIComponent(v1)}`))).status).toBe(422); // no `to`
    expect((await owner.get(A(artifactId, `/diff?from=${encodeURIComponent(v1)}&to=${encodeURIComponent(artifactId)}:99`))).status).toBe(422); // bad `to`
  });
});

describe('GET /artifacts/media:… — Media-backed projection (ADR 0069 item 2)', () => {
  async function seedMediaArtifact(): Promise<{ owner: Client; tenantId: string; artifactId: string }> {
    const tenantId = `org:test-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, tenantId);
    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const asset = await createAsset({
      tenantId, orgId, name: 'diagram.png', contentType: 'image/png',
      sizeBytes: 1024, storageRef: 'local:diagram', serveToken: 'tok-diagram', uploadedBy: 'u1',
    });
    return { owner, tenantId, artifactId: `media:${asset.assetId}` };
  }

  it('projects a media asset as a single-revision artifact with a serve-URL preview', async () => {
    const { owner, artifactId } = await seedMediaArtifact();
    const art = await owner.get<ArtifactBody>(A(artifactId));
    expect(art.status).toBe(200);
    expect(art.body.source).toBe('media');
    expect(art.body.kind).toBe('image');
    expect(art.body.format).toBe('image/png');

    const revs = await owner.get<RevisionsBody>(A(artifactId, '/revisions'));
    expect(revs.body.revisions.length).toBe(1); // a media blob is one immutable revision
    const rid = revs.body.revisions[0]!.revisionId;
    const rev = await owner.get<RevisionBody>(A(artifactId, `/revisions/${encodeURIComponent(rid)}`));
    expect(typeof rev.body.content).toBe('string'); // the serve URL

    // A media artifact has nothing to diff → 422 (not 404).
    expect((await owner.get(A(artifactId, `/diff?from=${encodeURIComponent(rid)}&to=${encodeURIComponent(rid)}`))).status).toBe(422);
  });

  it('404s a foreign-tenant caller for a media artifact (no existence leak)', async () => {
    const { artifactId } = await seedMediaArtifact();
    const stranger = client();
    await signup(stranger, `org:other-${Date.now()}-${n++}`);
    expect((await stranger.get(A(artifactId))).status).toBe(404);
  });
});

describe('GET /artifacts — authorization', () => {
  it('404s a non-existent artifact and a foreign-tenant caller (no existence leak)', async () => {
    const { owner, tenantId, artifactId } = await seedArtifact();
    // A different tenant's caller cannot see the artifact → 404, not 403.
    const stranger = client();
    await signup(stranger, `org:other-${Date.now()}-${n++}`);
    expect((await stranger.get(A(artifactId))).status).toBe(404);
    expect((await stranger.get(A('document:doc:nope'))).status).toBe(404);
    // Cross-ORG IDOR: a SAME-tenant user who is a member of no org. The tenant lookup
    // finds the document, so only the org `workspace:read` gate can refuse it.
    const sameTenantNonMember = client();
    await signup(sameTenantNonMember, tenantId);
    expect((await sameTenantNonMember.get(A(artifactId))).status, 'an org outsider in the same tenant read the artifact').toBe(404);
    // Positive control: the owner still reads it.
    expect((await owner.get(A(artifactId))).status).toBe(200);
  });

  it('remains accessible when the documents toggle is off (ADR 0083 — artifacts are gated by workspace:read, not the documents feature toggle, so run-output artifacts surface regardless)', async () => {
    const { owner, artifactId } = await seedArtifact();
    await setToggle('documents', 'off');
    try {
      expect((await owner.get(A(artifactId))).status).toBe(200);
    } finally {
      await setToggle('documents', 'on');
    }
  });
});

describe('GET /artifacts — the Library collection (ADR 0083 review MED-2)', () => {
  const LIB = '/host/openwop-app/artifacts';

  it('lists the caller’s artifacts and EXCLUDES a foreign tenant’s (no cross-tenant leak)', async () => {
    const a = await seedArtifact();
    const b = await seedArtifact(); // seedArtifact mints a fresh `org:` tenant each call
    const listA = await a.owner.get<LibraryBody>(LIB);
    expect(listA.status).toBe(200);
    const idsA = listA.body.artifacts.map((x) => x.artifactId);
    expect(idsA).toContain(a.artifactId);
    expect(idsA).not.toContain(b.artifactId); // b belongs to another tenant — excluded
  });

  it('returns artifacts newest-first', async () => {
    // Fake only `Date`, so the two documents are created a known minute apart — two
    // creates in one millisecond tie on createdAt and cannot show an order.
    const base = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: base });
    try {
      const { owner } = await seedArtifact();
      vi.setSystemTime(base + 60_000);
      const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme2' })).body.orgId;
      const D = (s = ''): string => `/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}${s}`;
      const doc2 = await owner.post<{ documentId: string }>(D('/documents'), { title: 'Newer SOW', kind: 'sow' });
      await owner.post(D(`/documents/${doc2.body.documentId}/versions`), { content: '# newer' });
      const list = await owner.get<LibraryBody>(LIB);
      expect(list.status).toBe(200);
      const created = list.body.artifacts.map((x) => x.createdAt);
      expect(created.length).toBeGreaterThanOrEqual(2);
      expect(new Set(created).size, 'the fixture must not tie on createdAt').toBe(created.length);
      expect([...created].sort((x, y) => y.localeCompare(x))).toEqual(created); // descending
      expect(list.body.artifacts[0]!.artifactId).toBe(`document:${doc2.body.documentId}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
