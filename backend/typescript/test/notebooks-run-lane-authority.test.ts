/**
 * ADR 1103 D1/D2 — `ctx.features.notebooks` acts for the run's person, through the
 * SAME rule as the HTTP door (`notebookAccess`).
 *
 * Before: the surface served any `visibility:'org'` notebook to any run in the tenant.
 * Its methods name a `notebookId`, never an `orgId`, so the ADR 0832 seam floor never
 * fired for it. A member of org A read org B's source text, and wrote sources and
 * notes into org B's notebooks, by starting a run; a project viewer wrote through a
 * run what the door refuses (`NBK92-1`).
 *
 * Every case pins the HTTP door's answer FIRST, so the surface is held to the door, not
 * to a rule of this file's own. Demo mode is OFF (the single-principal demo arm would
 * make an unknown subject the owner and every refusal vacuous, ADR 0601 C3(b)), and
 * the tenant is a multi-person `org:` tenant.
 *
 * Sabotage (each reds the named case on `origin/main`'s surface, which had no actor
 * arm): restoring `resolveOrgVisibleNotebook` as the gate reds S1/S2/S3/S5 (MEASURED
 * 2026-11-11: removing the actor arm reds exactly those four); letting an actorless run
 * write reds S4; dropping the cause narrowing (either `resolveForRun`'s or the list's)
 * reds S6.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildNotebooksSurface } from '../src/features/notebooks/surface.js';
import { setProjectVisibility, addProjectMember } from '../src/features/projects/projectsService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb', 'notebooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body: JSON.parse(JSON.stringify(out ?? {})) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const H = '/host/openwop-app';
const NB = `${H}/notebooks`;
const SECRET = 'FINANCE ONLY: the Q4 layoffs list is in drawer nine.';
const OPEN = 'Team handbook: lunch is at noon on Fridays.';

/** JSON round-trip narrowing of a surface result (its contract is Record<string, unknown>). */
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }
interface Refusal { error?: { code: string } }

async function login(c: Client, tenantId: string, who: string): Promise<string> {
  const r = await c.post(`${H}/test/login`, { email: `nb1103-${who}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.user as { userId: string }).userId;
}

async function fixture() {
  const tenantId = `org:nb1103-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = await login(owner, tenantId, 'owner');
  const editor = client();
  const editorId = await login(editor, tenantId, 'editor');
  const viewer = client();
  const viewerId = await login(viewer, tenantId, 'viewer');
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Everyone' })).body.orgId as string;
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Finance' })).body.orgId as string;
  for (const [subject, roles] of [[editorId, ['editor']], [viewerId, ['viewer']]] as const) {
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject, roles });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  const mk = async (orgId: string, name: string, text: string): Promise<{ id: string; sourceId: string }> => {
    const nb = await owner.post(NB, { orgId, name });
    expect(nb.status, JSON.stringify(nb.body)).toBe(201);
    const id = (nb.body.notebook as { id: string }).id;
    const src = await owner.post(`${NB}/${id}/sources`, { title: name, text });
    expect(src.status, JSON.stringify(src.body)).toBe(201);
    return { id, sourceId: src.body.documentId as string };
  };
  const nbA = await mk(orgA, 'Handbook', OPEN);
  const nbB = await mk(orgB, 'Finance', SECRET);
  return { tenantId, owner, editor, viewer, ownerId, editorId, viewerId, orgA, orgB, nbA, nbB };
}

const asActor = (tenantId: string, actingUserId: string) => buildNotebooksSurface({ tenantId, runId: 'r', actingUserId });
const sourceCount = async (owner: Client, id: string): Promise<number> => ((await owner.get(`${NB}/${id}/sources`)).body.sources as unknown[]).length;
const leaks = (v: unknown): boolean => JSON.stringify(v).includes('drawer nine');

describe('ADR 1103 D2 — the run lane gives the door\'s answer', () => {
  it('S1 a run for an org-A member reads nothing of org B', async () => {
    const f = await fixture();
    // The door's answer: org B's notebook does not exist for this person.
    expect((await f.editor.get(`${NB}/${f.nbB.id}/sources`)).status).toBe(404);
    const s = asActor(f.tenantId, f.editorId);
    const text = as<Refusal & { text?: string }>(await s.getSourceText({ notebookId: f.nbB.id, sourceId: f.nbB.sourceId }));
    expect(text.error?.code).toBe('notebook_unavailable');
    expect(leaks(await s.listSources({ notebookId: f.nbB.id }))).toBe(false);
    expect(leaks(await s.searchNotebook({ notebookId: f.nbB.id, query: 'layoffs drawer' }))).toBe(false);
    expect(leaks(await s.ask({ notebookId: f.nbB.id, query: 'layoffs drawer' }))).toBe(false);
    const listed = as<{ notebooks: Array<{ id: string }> }>(await s.listNotebooks({})).notebooks.map((x) => x.id);
    expect(listed).not.toContain(f.nbB.id);
    // Control: the same run reads its own org (a gate that blocks everyone is a wall).
    expect(listed).toContain(f.nbA.id);
    expect(as<{ text: string }>(await s.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).text).toContain('lunch');
  });

  it('S2 nor writes into org B (nothing lands)', async () => {
    const f = await fixture();
    const s = asActor(f.tenantId, f.editorId);
    const before = await sourceCount(f.owner, f.nbB.id);
    expect(as<Refusal>(await s.ingestSource({ notebookId: f.nbB.id, title: 'x', text: 'planted' })).error?.code).toBe('notebook_unavailable');
    expect(as<Refusal>(await s.addNote({ notebookId: f.nbB.id, content: 'planted' })).error?.code).toBe('notebook_unavailable');
    expect(as<Refusal>(await s.setSourceSummary({ notebookId: f.nbB.id, sourceId: f.nbB.sourceId, summary: 'planted' })).error?.code).toBe('notebook_unavailable');
    expect(as<Refusal>(await s.transformTarget({ notebookId: f.nbB.id })).error?.code).toBe('notebook_unavailable');
    expect(await sourceCount(f.owner, f.nbB.id)).toBe(before);
    expect(((await f.owner.get(`${NB}/${f.nbB.id}/notes`)).body.notes as unknown[])).toHaveLength(0);
    // Control: the editor writes its own org's notebook through the same surface.
    const own = as<{ ingested?: boolean }>(await s.ingestSource({ notebookId: f.nbA.id, title: 'mine', text: 'a real addition' }));
    expect(own.ingested).toBe(true);
    expect(as<{ orgId: string; ownerSubject: { kind: string; id: string } }>(await s.transformTarget({ notebookId: f.nbA.id })))
      .toEqual({ orgId: f.orgA, ownerSubject: { kind: 'project', id: f.nbA.id } });
  });

  it('S3 a project viewer cannot write through a run what the door refuses', async () => {
    const f = await fixture();
    expect((await f.viewer.post(`${NB}/${f.nbA.id}/sources`, { title: 'x', text: 'y' })).status).toBe(403);
    const s = asActor(f.tenantId, f.viewerId);
    const before = await sourceCount(f.owner, f.nbA.id);
    expect(as<Refusal>(await s.ingestSource({ notebookId: f.nbA.id, title: 'x', text: 'planted' })).error?.code).toBe('notebook_write_forbidden');
    expect(as<Refusal>(await s.addNote({ notebookId: f.nbA.id, content: 'planted' })).error?.code).toBe('notebook_write_forbidden');
    expect(await sourceCount(f.owner, f.nbA.id)).toBe(before);
    // Control: the viewer still READS (read is what the door gives them).
    expect(as<{ text: string }>(await s.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).text).toContain('lunch');
  });

  it('S4 a run with no person reads org-visible notebooks and writes nothing', async () => {
    const f = await fixture();
    const s = buildNotebooksSurface({ tenantId: f.tenantId, runId: 'r' });
    expect(as<Refusal>(await s.ingestSource({ notebookId: f.nbA.id, title: 'x', text: 'planted' })).error?.code).toBe('notebook_write_needs_person');
    expect(as<Refusal>(await s.setSourceSummary({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId, summary: 'S' })).error?.code).toBe('notebook_write_needs_person');
    // Control: an org-visible read still works (the system-run rule is unchanged).
    expect(as<{ text: string }>(await s.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).text).toContain('lunch');
  });

  it('S5 a private notebook: its member reads it, a non-member org reader does not, a system run does not', async () => {
    const f = await fixture();
    await setProjectVisibility(f.tenantId, f.nbA.id, 'private');
    expect((await f.viewer.get(`${NB}/${f.nbA.id}/sources`)).status).toBe(404); // the door
    const viewerRun = asActor(f.tenantId, f.viewerId);
    expect(as<Refusal>(await viewerRun.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).error?.code).toBe('notebook_unavailable');
    const system = buildNotebooksSurface({ tenantId: f.tenantId, runId: 'r' });
    expect(as<Refusal>(await system.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).error?.code).toBe('notebook_unavailable');
    // The editor (workspace:write in the org) writes a private notebook — the case
    // NBK92-2 broke: the route's run reached it as a system run and was refused.
    const editorRun = asActor(f.tenantId, f.editorId);
    expect(as<{ ingested?: boolean }>(await editorRun.ingestSource({ notebookId: f.nbA.id, title: 'p', text: 'private add' })).ingested).toBe(true);
    // Made a project member, the viewer now reads it — exactly as the door does.
    await addProjectMember(f.tenantId, f.nbA.id, `user:${f.viewerId}`, 'viewer');
    expect((await f.viewer.get(`${NB}/${f.nbA.id}/sources`)).status).toBe(200);
    expect(as<{ text: string }>(await viewerRun.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).text).toContain('lunch');
  });

  it('S6 a causing member narrows an actorless run, never widens it', async () => {
    const f = await fixture();
    const outsider = client();
    const outsiderId = await login(outsider, f.tenantId, 'outsider');
    const add = await f.owner.post(`${H}/orgs/${encodeURIComponent(f.orgB)}/members`, { displayName: 'O', subject: outsiderId, roles: ['editor'] });
    expect(add.status).toBe(201);
    const caused = buildNotebooksSurface({ tenantId: f.tenantId, runId: 'r', orgScopeSubject: outsiderId });
    expect(as<Refusal>(await caused.getSourceText({ notebookId: f.nbA.id, sourceId: f.nbA.sourceId })).error?.code).toBe('notebook_unavailable');
    // A cause grants no write even where it could write.
    expect(as<Refusal>(await caused.ingestSource({ notebookId: f.nbB.id, title: 'x', text: 'y' })).error?.code).toBe('notebook_write_needs_person');
    // Control: the cause's own org-visible notebook reads.
    expect(as<{ text: string }>(await caused.getSourceText({ notebookId: f.nbB.id, sourceId: f.nbB.sourceId })).text).toContain('drawer');
    // …and the list narrows the same way (one scan for the cause, not the whole tenant).
    const listed = as<{ notebooks: Array<{ id: string }> }>(await caused.listNotebooks({})).notebooks.map((x) => x.id);
    expect(listed).toContain(f.nbB.id);
    expect(listed).not.toContain(f.nbA.id);
    // A cause never opens a PRIVATE notebook, even one it is a project member of (a
    // cause narrows an actorless run; it is not that run's person).
    const secret = await f.owner.post(NB, { orgId: f.orgB, name: 'Board only' });
    const secretId = (secret.body.notebook as { id: string }).id;
    await setProjectVisibility(f.tenantId, secretId, 'private');
    await addProjectMember(f.tenantId, secretId, `user:${outsiderId}`, 'viewer');
    const listed2 = as<{ notebooks: Array<{ id: string }> }>(await caused.listNotebooks({})).notebooks.map((x) => x.id);
    expect(listed2).toContain(f.nbB.id);
    expect(listed2).not.toContain(secretId);
    // Control for the narrowing: a system run with no cause lists both org-visible notebooks.
    const all = as<{ notebooks: Array<{ id: string }> }>(await buildNotebooksSurface({ tenantId: f.tenantId, runId: 'r' }).listNotebooks({})).notebooks.map((x) => x.id);
    expect(all).toEqual(expect.arrayContaining([f.nbA.id, f.nbB.id]));
  });
});
