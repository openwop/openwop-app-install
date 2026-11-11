/**
 * ADR 1051 D1 — the creative-video spend methods behind the workflow surface.
 *
 * Every leg goes through `buildFeatureSurfaces`, the seam the executor binds into
 * `ctx.features`, because the floor lives at the seam. Each refusal sits beside
 * an allowed leg (an org editor reaches the method and gets past the floor), so a
 * floor that refuses everybody fails here too.
 *
 *  - an org READER (viewer role) is refused all three spend methods
 *    (`forbidden_scope`), while `getVideoStatus` stays a read;
 *  - a run with no person (no actor, no causing member) is refused before any
 *    row or reservation;
 *  - `OPENWOP_CREATIVE_VIDEO_ENABLED=false` stops the surface, as it stops the routes;
 *  - D8: a DSAR for the requester re-attributes their job rows (the booted app's
 *    LIVE eraser registry, not a direct call).
 *
 * RED on unmodified main `ec97cbb21`: the surface registered no policy, so the
 * reader and the system run both reached the service; the surface never read
 * the kill switch.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { listJobs, claimJob, putJob, requestHashFor } from '../src/features/creative-video/entities/videoJob.js';
import { recordLikenessConsent, findLikenessConsent } from '../src/features/creative-video/likenessConsent.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { ERASED, ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'creative-video', 'creative-video.t2v']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_CREATIVE_VIDEO_ENABLED; });

interface Body { user?: { userId: string }; orgId?: string; error?: string; code?: string; status?: string }
function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: Body }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
    },
  };
}

const H = '/host/openwop-app';

/** One tenant, one org. The OWNER created it; READER is a viewer of it; EDITOR an editor. */
async function fixture(): Promise<{ tenantId: string; orgId: string; ownerId: string; readerId: string; editorId: string; editor: ReturnType<typeof client> }> {
  const tenantId = `org:cv1051-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post(`${H}/test/login`, { email: `cv-o-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const readerId = (await client().post(`${H}/test/login`, { email: `cv-r-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const editor = client();
  const editorId = (await editor.post(`${H}/test/login`, { email: `cv-e-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgId = (await owner.post(`${H}/orgs`, { name: 'Studio' })).body.orgId ?? '';
  expect(ownerId && readerId && editorId && orgId, 'fixture: users and the org exist').toBeTruthy();
  for (const [subject, role] of [[readerId, 'viewer'], [editorId, 'editor']] as const) {
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { tenantId, orgId, ownerId, readerId, editorId, editor };
}

const video = (scope: BundleScope): FeatureSurface => {
  const s = buildFeatureSurfaces(scope)['creative-video'];
  if (!s) throw new Error('creative-video surface is not registered');
  return s;
};

const avatarArgs = (orgId: string) => ({ orgId, script: 'Hello from the studio', avatarId: 'av-1' });

describe('ADR 1051 D1 — a reader cannot spend through the surface', () => {
  it('an org viewer is refused generateVideo, textToVideo and imageToVideo', async () => {
    const f = await fixture();
    const s = video({ tenantId: f.tenantId, runId: 'r-reader', actingUserId: f.readerId });
    await expect(s.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.textToVideo!({ orgId: f.orgId, prompt: 'A lighthouse at dusk' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.imageToVideo!({ orgId: f.orgId, sourceAssetId: 'a-1', prompt: 'Slow pan' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await listJobs(f.tenantId, f.orgId), 'nothing was claimed').toEqual([]);
  });

  it('…while getVideoStatus stays a read for the same viewer', async () => {
    const f = await fixture();
    const s = video({ tenantId: f.tenantId, runId: 'r-reader-2', actingUserId: f.readerId });
    await expect(s.getVideoStatus!({ orgId: f.orgId, jobId: 'nope' })).resolves.toEqual({ success: false, error: 'not_found' });
  });

  it('an org editor gets past the floor (refused later, for the missing consent, not the scope)', async () => {
    const f = await fixture();
    const s = video({ tenantId: f.tenantId, runId: 'r-editor', actingUserId: f.editorId });
    await expect(s.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'likeness_consent_required' });
  });
});

describe('ADR 1051 D1 — spend needs a person', () => {
  it('a run with no actor and no causing member is refused, and claims nothing', async () => {
    const f = await fixture();
    const s = video({ tenantId: f.tenantId, runId: 'r-system' });
    await expect(s.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.textToVideo!({ orgId: f.orgId, prompt: 'A lighthouse at dusk' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await listJobs(f.tenantId, f.orgId)).toEqual([]);
  });
});

describe('ADR 1051 D1 — the host kill switch reaches the surface', () => {
  it('OPENWOP_CREATIVE_VIDEO_ENABLED=false refuses the spend methods', async () => {
    const f = await fixture();
    process.env.OPENWOP_CREATIVE_VIDEO_ENABLED = 'false';
    const s = video({ tenantId: f.tenantId, runId: 'r-off', actingUserId: f.editorId });
    await expect(s.textToVideo!({ orgId: f.orgId, prompt: 'A lighthouse at dusk' })).rejects.toMatchObject({ code: 'host_capability_missing' });
    expect(await listJobs(f.tenantId, f.orgId)).toEqual([]);
  });
});

describe('ADR 1051 D8 — DSAR reaches the video job', () => {
  it("the requester's job rows are re-attributed and the prompt snippet redacted; other people's rows stay", async () => {
    const f = await fixture();
    const mine = await claimJob({ tenantId: f.tenantId, orgId: f.orgId, requestHash: requestHashFor({ provider: 'heygen', orgId: f.orgId, script: 'mine', avatarId: 'av' }), kind: 'avatar', provider: 'heygen', createdBy: f.editorId });
    const snapshot = await recordLikenessConsent({ tenantId: f.tenantId, orgId: f.orgId, userId: f.editorId, avatarId: 'av' });
    await putJob({ ...mine.job, status: 'processing', providerJobId: 'p1', promptSnippet: 'Hi, I am Erin from Studio', promptHash: 'h', submitterUserId: f.editorId, likenessConsent: snapshot });
    const theirs = await claimJob({ tenantId: f.tenantId, orgId: f.orgId, requestHash: requestHashFor({ provider: 'heygen', orgId: f.orgId, script: 'theirs', avatarId: 'av' }), kind: 'avatar', provider: 'heygen', createdBy: f.ownerId });
    const result = await eraseSubject(f.tenantId, f.editorId);
    expect(result.failed, JSON.stringify(result)).toBe(0);
    const rows = await listJobs(f.tenantId, f.orgId);
    const after = rows.find((j) => j.jobId === mine.job.jobId);
    expect(after?.createdBy).toBe(ERASED_USER_REF);
    expect(after?.promptSnippet).toBe(ERASED);
    expect(after?.promptHash, 'the hash names nobody and stays').toBe('h');
    expect(after?.submitterUserId).toBe(ERASED_USER_REF);
    expect(after?.likenessConsent?.attestedBy).toBe(ERASED_USER_REF);
    expect(after?.likenessConsent?.attestedAt, 'the evidence that consent was given stays').toBe(snapshot.attestedAt);
    expect(await findLikenessConsent({ tenantId: f.tenantId, orgId: f.orgId, userId: f.editorId, avatarId: 'av' }), 'the record keyed by the person is deleted').toBeNull();
    expect(rows.find((j) => j.jobId === theirs.job.jobId)?.createdBy).toBe(f.ownerId);
  });
});

describe('ADR 1051 D5 — a person attests on the page; a workflow uses their record', () => {
  it('a run CAUSED by a member (no actor) cannot render a likeness on that member\'s record (CV83CD-3: orgScopeSubject only narrows)', async () => {
    const f = await fixture();
    await recordLikenessConsent({ tenantId: f.tenantId, orgId: f.orgId, userId: f.editorId, avatarId: 'av-1' });
    const caused = video({ tenantId: f.tenantId, runId: 'r-caused', orgScopeSubject: f.editorId });
    await expect(caused.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'likeness_consent_required' });
    const acting = video({ tenantId: f.tenantId, runId: 'r-acting', actingUserId: f.editorId });
    await expect(acting.generateVideo!(avatarArgs(f.orgId)), 'the same record serves the person acting').resolves.toMatchObject({ error: 'no_connection' });
  });

  const generate = (_f: { orgId: string }, extra: Record<string, unknown> = {}) => ({ script: 'Hello', avatarId: 'av-1', ...extra });

  it('the route refuses a missing or stale attestation (422) and records nothing', async () => {
    const f = await fixture();
    const none = await f.editor.post(`${H}/creative-video/orgs/${encodeURIComponent(f.orgId)}/generate`, generate(f));
    expect(none.status, JSON.stringify(none.body)).toBe(422);
    const stale = await f.editor.post(`${H}/creative-video/orgs/${encodeURIComponent(f.orgId)}/generate`, generate(f, { likenessConsent: { attested: true, textVersion: 'cv-likeness-2025-01' } }));
    expect(stale.status).toBe(422);
    // No record was written, so the workflow lane still refuses.
    const s = video({ tenantId: f.tenantId, runId: 'r-wf', actingUserId: f.editorId });
    await expect(s.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'likeness_consent_required' });
  });

  it('after the page attestation, the same person\'s workflow passes consent (and stops at the missing connection, with no row)', async () => {
    const f = await fixture();
    const r = await f.editor.post(`${H}/creative-video/orgs/${encodeURIComponent(f.orgId)}/generate`, generate(f, { likenessConsent: { attested: true, textVersion: 'cv-likeness-2026-11' } }));
    expect(r.status, JSON.stringify(r.body)).toBe(409); // no HeyGen connection: refused before any row
    const s = video({ tenantId: f.tenantId, runId: 'r-wf2', actingUserId: f.editorId });
    await expect(s.generateVideo!(avatarArgs(f.orgId))).resolves.toMatchObject({ success: false, status: 'failed', error: 'no_connection' });
    // Another person's run cannot ride the editor's attestation.
    const other = video({ tenantId: f.tenantId, runId: 'r-wf3', actingUserId: f.ownerId });
    await expect(other.generateVideo!(avatarArgs(f.orgId))).rejects.toMatchObject({ code: 'likeness_consent_required' });
    expect(await listJobs(f.tenantId, f.orgId)).toEqual([]);
  });
});
