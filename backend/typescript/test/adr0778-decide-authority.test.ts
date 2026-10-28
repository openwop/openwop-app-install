/**
 * ADR 0778 D2 / D6 / D8 — who may decide a gate, as WHOM, and whether the inbox
 * says so. Driven through the REAL auth middleware with a synthetic OIDC issuer
 * and unbound bearers (principal `oidc:<sub>`), the ADR 0774/0775 harness,
 * because both the role floor and the identity-spelling half are only
 * observable through it.
 *
 *  - D2 (`APWF-2`): a Viewer in a shared workspace decided every OPEN approval
 *    gate (the membership check was env-gated), and `/reviews` decide required
 *    only `runs:read`, so a read-only key answered gates there.
 *  - C3: the floor is for APPROVALS only; a Viewer still answers a clarification.
 *  - D6 (`APWF-6`): one person was two ledger keys across the two lanes (and an
 *    unbound OIDC caller was refused outright on the node route).
 *  - D8: each review says whether THIS caller can decide it.
 *  - D3: a cancelled run's gate leaves the inbox, and the node route and the
 *    token route both answer `409`.
 *
 * Tracker: TST-BDC-1 (docs/steward/TEST-ASSESSMENT.md).
 *
 * Red when (sabotage-witnessed, wave 60): `requireInterruptDecider` admits a
 * caller without the floor, or applies it to a clarification; `/reviews` drops
 * its `requireProtocolScope('approvals:respond')` (the read-only key's refusal
 * is then the floor's `forbidden_scope`, not the scope gate's `forbidden`) or
 * both of its guards; the interrupt listing hands an approval token to a
 * caller below the floor; `canDecide` stops reading the floor; `/reviews`
 * votes as a different identity than the node route; the answer form leaks a
 * field outside its allowlist, keeps a resolved review's form, or gives an
 * unanswerable kind a form; the token route answers a cancelled run's gate
 * with the generic resolved 409.
 *
 * Double guards (recorded, wave 60):
 *  - the read-only key on `/reviews` is refused by `requireProtocolScope`
 *    (code `forbidden`) and, behind it, by `requireInterruptDecider` (code
 *    `forbidden_scope`); the case asserts the OUTER code, and a probe that
 *    removes both is witnessed too.
 *  - the floor's refusal code is spelled per surface: `forbidden_scope` on the
 *    host-extension `/reviews` route, `openwop-app.forbidden_scope` on the
 *    protocol node route (non-wire codes are host-prefixed there).
 *  - a cancelled run's gate leaves the inbox because `runCancel.ts` CLOSES it
 *    (outer; witnessed in `adr0778-decide-integrity`, "cancel resolves the run")
 *    and `reviewProjection` also drops gates on terminal runs. Over HTTP a
 *    cancel always closes the gate, so the projection filter alone cannot be
 *    reached here.
 *
 * @see docs/adr/0778-interrupts-inbox-decide-integrity.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listMembers } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { bareRunId } from './support/bareRunId.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE: string;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

function mint(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

/** Reproduce middleware/auth.ts `tenantIdFromOidc`. */
function personalTenantOfSub(sub: string): string {
  return `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

interface Res<T = unknown> { status: number; body: T }
/** The error envelope (`{ error: <code>, message, details? }`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface RunBody { status?: string }
interface InterruptRow { interruptId: string; nodeId: string; token?: string }
interface InterruptList { interrupts?: InterruptRow[] }
/** A bearer-carrying client with a cookie jar (the SPA shape: bearer + __session).
 *  Each call site names the body shape it reads. */
type Client = {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = ErrBody>(p: string) => Promise<Res<T>>;
};
function client(token: string): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      // ADR 0621 — honour a cookie CLEAR (`__session=; …Max-Age=0`) the way a
      // browser does: the jar drops the session instead of replaying it.
      if (/^__session=;/.test(sc)) { cookie = ''; continue; }
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = ErrBody>(p: string) => call<T>('GET', p),
    post: <T = ErrBody>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = ErrBody>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    put: <T = ErrBody>(p: string, b?: unknown) => call<T>('PUT', p, b),
    del: <T = ErrBody>(p: string) => call<T>('DELETE', p),
  };
}


const H = '/host/openwop-app';
const WS = `${H}/workspaces`;

/** An unbound OIDC caller (principal `oidc:<sub>`) and its canonical user id. */
async function oidcCaller(sub: string): Promise<{ c: Client; canonical: string; personal: string }> {
  const c = client(mint(sub));
  expect((await c.get(`${H}/me/workspaces`)).status).toBe(200);
  const personal = personalTenantOfSub(sub);
  const owner = (await listMembers(personal, personal)).find((m) => m.roles.includes('owner'));
  expect(owner?.subject).toMatch(/^user:/);
  return { c, canonical: owner!.subject!, personal };
}

/** A shared workspace created by an unbound OIDC owner, with a viewer keyed `oidc:<sub>`. */
async function sharedWorkspace(tag: string): Promise<{ ws: string; owner: Client; viewer: Client }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const owner = await oidcCaller(`ad-${tag}-owner-${stamp}`);
  const viewer = await oidcCaller(`ad-${tag}-viewer-${stamp}`);
  const ws = (await owner.c.post<{ workspaceId: string }>(WS, { name: `AD ${tag} ${stamp}` })).body.workspaceId;
  expect((await owner.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  // MEASURED (ADR 0774): the owner of a workspace an unbound caller created is
  // keyed by the LEGACY spelling — the union is what admits them.
  expect((await listMembers(ws, ws)).find((m) => m.roles.includes('owner'))?.subject).toBe(`oidc:ad-${tag}-owner-${stamp}`);
  const add = await owner.c.post(`${H}/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'viewer', subject: `oidc:ad-${tag}-viewer-${stamp}`, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  expect((await viewer.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  return { ws, owner: owner.c, viewer: viewer.c };
}


interface Review { reviewId: string; interruptId?: string; canDecide?: boolean; policy?: { approvals: number } }

async function pollWaiting(c: Client, runId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await c.get<RunBody | undefined>(`/runs/${runId}`)).body?.status ?? '';
    if (s?.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return s;
  }
  return 'unknown';
}

let wfSeq = 0;
/** The owner stands up a one-gate run in the shared workspace. */
async function gateRun(owner: Client, gate: { typeId: string; config: Record<string, unknown> }): Promise<{ runId: string; interruptId: string; token?: string }> {
  const workflowId = `wf.adr0778.http.${Date.now()}.${++wfSeq}`;
  const made = await owner.post(`${H}/workflows`, { workflowId, nodes: [{ nodeId: 'gate', ...gate }], edges: [] });
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  const started = await owner.post<{ runId: string }>('/runs', { workflowId, inputs: {} });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = started.body.runId;
  expect((await pollWaiting(owner, runId)).startsWith('waiting')).toBe(true);
  const ints = (await owner.get<InterruptList>(`${H}/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
  const it_ = ints.find((i) => i.nodeId === 'gate')!;
  return { runId, interruptId: it_.interruptId, ...(it_.token ? { token: it_.token } : {}) };
}

const APPROVAL = { typeId: 'core.approvalGate', config: { prompt: 'Ship it?' } };

describe('ADR 0778 D2 — deciding an open approval gate needs approvals:respond', () => {
  it('a Viewer is refused on BOTH session lanes, sees canDecide:false, and the gate stays open', async () => {
    const { owner, viewer } = await sharedWorkspace('viewer');
    const { runId, interruptId } = await gateRun(owner, APPROVAL);

    const node = await viewer.post(`/runs/${runId}/interrupts/gate`, { resumeValue: { action: 'approve' } });
    expect(node.status, JSON.stringify(node.body)).toBe(403);
    expect(node.body).toMatchObject({ error: 'openwop-app.forbidden_scope', message: 'Missing required scope: approvals:respond' });
    const inbox = await viewer.post(`${H}/reviews/interrupt:${interruptId}/actions/approve`, {});
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(403);
    expect(inbox.body).toMatchObject({ error: 'forbidden_scope', message: 'Missing required scope: approvals:respond' });

    // grade-code APCD-1 — nor can the Viewer be HANDED the token: the token
    // route checks nothing else, so the listing's token was a third lane round
    // the floor. The owner still gets it.
    const viewerRows = (await viewer.get<InterruptList>(`${H}/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
    expect(viewerRows.find((r) => r.interruptId === interruptId)?.token, 'a Viewer was handed the decide token').toBeUndefined();
    const ownerRows = (await owner.get<InterruptList>(`${H}/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
    expect(ownerRows.find((r) => r.interruptId === interruptId)?.token).toBeTruthy();

    const listed = (await viewer.get<{ items: Review[] }>(`${H}/reviews?status=pending`)).body.items.find((r) => r.interruptId === interruptId);
    expect(listed?.canDecide, 'the viewer was offered a decision the server refuses').toBe(false);
    expect((await owner.get<RunBody>(`/runs/${runId}`)).body.status).toBe('waiting-approval');

    // The owner (Editor and above) sees it as decidable and decides it.
    const mine = (await owner.get<{ items: Review[] }>(`${H}/reviews?status=pending`)).body.items.find((r) => r.interruptId === interruptId);
    expect(mine?.canDecide).toBe(true);
    const ok = await owner.post(`${H}/reviews/interrupt:${interruptId}/actions/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('C3 — the floor is approvals-only: a Viewer still answers a clarification', async () => {
    const { owner, viewer } = await sharedWorkspace('clarify');
    const { runId } = await gateRun(owner, { typeId: 'core.interrupt', config: { kind: 'clarification', data: { prompt: 'Which one?' } } });
    const r = await viewer.post(`/runs/${runId}/interrupts/gate`, { resumeValue: { answer: 'the blue one' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The answer LANDED: the run leaves its wait and completes.
    let status = '';
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(status); i++) {
      await new Promise((res) => setTimeout(res, 20)); // run-settle poll: no hook to await over HTTP
      status = (await owner.get<RunBody | undefined>(`/runs/${runId}`)).body?.status ?? '';
    }
    expect(status).toBe('completed');
  });

  it('a key narrowed to runs:read cannot decide through /reviews (it could: the route checked runs:read)', async () => {
    const { ws, owner } = await sharedWorkspace('key');
    const { interruptId } = await gateRun(owner, APPROVAL);
    // ADR 0795 D6 — issued by a real member: a key whose issuer is nobody in a
    // shared workspace no longer authenticates, which would refuse this for the
    // wrong reason.
    const ownerSubject = (await listMembers(ws, ws)).find((m) => m.roles.includes('owner'))!.subject!;
    const { token } = await issueApiKey({ tenantId: ws, name: 'adr0778-read-only', createdBy: ownerSubject, scopes: ['runs:read'] });
    const readOnly = client(token);
    const r = await readOnly.post(`${H}/reviews/interrupt:${interruptId}/actions/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // The OUTER guard: the route's own scope gate (`forbidden`), not the decide
    // floor behind it (`forbidden_scope`).
    expect(r.body).toMatchObject({ error: 'forbidden', message: 'Missing required scope: approvals:respond' });
    const pending = (await owner.get<{ items: Review[] }>(`${H}/reviews?status=pending`)).body.items.some((x) => x.interruptId === interruptId);
    expect(pending, 'the read-only key decided the gate').toBe(true);
  });
});

describe('ADR 0778 D10 correction — a typed review is answerable on the card', () => {
  // `/runs/:runId` is admin-tier in the SPA, so "Respond on the run" stranded
  // every member. The card answers through `/reviews/:id/actions/resolve`; this
  // proves the projection carries what the form needs and the lane takes it.
  type FormReview = Review & { kind: string; answerForm?: Record<string, unknown>; actions: Array<{ action: string; requiresValue?: boolean }> };

  /** Like `gateRun`, but a cancellation suspends the run as `paused`, not `waiting-*`. */
  async function typedRun(owner: Client, kind: string, data: Record<string, unknown>): Promise<string> {
    const workflowId = `wf.adr0778.form.${Date.now()}.${++wfSeq}`;
    expect((await owner.post(`${H}/workflows`, { workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.interrupt', config: { kind, data } }], edges: [] })).status).toBeLessThan(300);
    const runId = (await owner.post<{ runId: string }>('/runs', { workflowId, inputs: {} })).body.runId;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const ints = (await owner.get<InterruptList | undefined>(`${H}/runs/${bareRunId(runId)}/interrupts`)).body?.interrupts;
      const hit = ints?.find((x) => x.nodeId === 'gate');
      if (hit) return hit.interruptId;
    }
    throw new Error(`no open ${kind} interrupt on ${runId}`);
  }

  it('a member answers a clarification through /reviews with the question the card shows', async () => {
    const { owner, viewer } = await sharedWorkspace('answer');
    const { runId, interruptId } = await gateRun(owner, { typeId: 'core.interrupt', config: { kind: 'clarification', data: { question: 'Which colour?' } } });

    const listed = (await viewer.get<{ items: FormReview[] }>(`${H}/reviews?status=pending`)).body.items.find((r) => r.interruptId === interruptId);
    expect(listed?.answerForm).toEqual({ question: 'Which colour?' });
    expect(listed?.actions).toEqual([expect.objectContaining({ action: 'resolve', requiresValue: true })]);
    expect(listed?.canDecide).toBe(true);

    const r = await viewer.post(`${H}/reviews/interrupt:${interruptId}/actions/resolve`, { value: { answer: 'the blue one' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    let status = '';
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(status); i++) {
      await new Promise((res) => setTimeout(res, 20));
      status = (await owner.get<RunBody | undefined>(`/runs/${runId}`)).body?.status ?? '';
    }
    expect(status).toBe('completed');
    expect((await owner.get<FormReview>(`${H}/reviews/interrupt:${interruptId}`)).body.answerForm, 'a resolved review still offered a form').toBeUndefined();
  });

  it('the answer form is a closed allowlist: nothing else in data reaches the projection', async () => {
    const { owner } = await sharedWorkspace('allow');
    const { interruptId } = await gateRun(owner, {
      typeId: 'core.interrupt',
      config: { kind: 'clarification', data: {
        question: 'Q?', profile: 'openwop-connection', apiSecret: 'leak-me-1',
        connection: { ref: 'conn:crm', providerId: 'hubspot', label: 'HubSpot', token: 'leak-me-2' },
      } },
    });
    const review = (await owner.get<FormReview>(`${H}/reviews/interrupt:${interruptId}`)).body;
    expect(review.answerForm).toEqual({
      question: 'Q?', profile: 'openwop-connection',
      connection: { ref: 'conn:crm', providerId: 'hubspot', label: 'HubSpot' },
    });
    expect(JSON.stringify(review)).not.toMatch(/leak-me/);
  });

  it('refinement carries its draft, cancellation its reason, and a kind the card cannot answer carries no form', async () => {
    const { owner } = await sharedWorkspace('kinds');
    const refine = await typedRun(owner, 'refinement', { current: { title: 'Draft 1' }, extra: 'x' });
    expect((await owner.get<FormReview>(`${H}/reviews/interrupt:${refine}`)).body.answerForm).toEqual({ current: { title: 'Draft 1' } });
    const cancel = await typedRun(owner, 'cancellation', { reason: 'Budget cut', extra: 'x' });
    expect((await owner.get<FormReview>(`${H}/reviews/interrupt:${cancel}`)).body.answerForm).toEqual({ reason: 'Budget cut' });
    const ext = await typedRun(owner, 'external-event', { question: 'not a human ask' });
    expect((await owner.get<FormReview>(`${H}/reviews/interrupt:${ext}`)).body.answerForm).toBeUndefined();
  });
});

describe('ADR 0778 D2 × ADR 0755 D3 — a declared responder key', () => {
  it('in a tenant WITH members, a Viewer-issued key declaring approvals:respond gets no token and cannot decide', async () => {
    const { ws, owner } = await sharedWorkspace('viewerkey');
    const { runId, interruptId } = await gateRun(owner, APPROVAL);
    const viewerSubject = (await listMembers(ws, ws)).find((m) => m.roles.includes('viewer'))!.subject!;
    const { token } = await issueApiKey({ tenantId: ws, name: 'adr0778-viewer-key', createdBy: viewerSubject, scopes: ['runs:read', 'approvals:respond'] });
    const key = client(token);
    const rows = (await key.get<InterruptList>(`${H}/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
    expect(rows.find((r) => r.interruptId === interruptId)?.token, 'a Viewer\'s key was handed the decide token').toBeUndefined();
    const decided = await key.post(`/runs/${runId}/interrupts/gate`, { resumeValue: { action: 'approve' } });
    expect(decided.status, JSON.stringify(decided.body)).toBe(403);
    expect(decided.body).toMatchObject({ error: 'openwop-app.forbidden_scope', message: 'Missing required scope: approvals:respond' });
  });
});

describe('ADR 0778 D6 — one person is one voter on both lanes', () => {
  it('an unbound OIDC owner votes on the node route AND /reviews, and is counted once', async () => {
    const { owner } = await sharedWorkspace('quorum');
    const { interruptId, runId } = await gateRun(owner, { typeId: 'core.approvalGate', config: { prompt: 'Two of you', requiredApprovals: 2, approversList: [], actions: ['accept', 'reject'] } });
    const first = await owner.post(`/runs/${runId}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    expect(first.status, `the node route refused a signed-in owner: ${JSON.stringify(first.body)}`).toBe(200);
    const second = await owner.post(`${H}/reviews/interrupt:${interruptId}/actions/accept`, {});
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const review = (await owner.get<Review>(`${H}/reviews/interrupt:${interruptId}`)).body;
    expect(review.policy?.approvals, 'one person counted as two approvers').toBe(1);
    expect((await owner.get<RunBody>(`/runs/${runId}`)).body.status).toBe('waiting-approval');
  });
});

describe('ADR 0778 D3 — a cancelled run\'s gate is gone from every surface', () => {
  it('leaves the inbox; the node route and the token route both answer 409', async () => {
    const { owner } = await sharedWorkspace('cancel');
    const { runId, interruptId, token } = await gateRun(owner, APPROVAL);
    expect(token, 'the owner holds approvals:respond, so the listing carries the token').toBeTruthy();
    expect((await owner.post(`/runs/${runId}/cancel`, {})).status).toBeLessThan(300);

    const listed = (await owner.get<{ items: Review[] }>(`${H}/reviews?status=pending`)).body.items.some((r) => r.interruptId === interruptId);
    expect(listed, 'a cancelled run\'s gate is still in the inbox').toBe(false);
    // Still readable by id (a decided gate is not "not found", APCD-10), and not decidable.
    expect((await owner.post(`${H}/reviews/interrupt:${interruptId}/actions/approve`, {})).status).toBe(409);
    // v2 `interrupt.md` §Errors: a cancelled run's gate is `409 interrupt_already_resolved` on
    // BOTH surfaces (major 1's node route answered 410).
    const node = await owner.post(`/runs/${runId}/interrupts/gate`, { resumeValue: { action: 'approve' } });
    expect(node.status).toBe(409);
    expect(node.body.error).toBe('interrupt_already_resolved');
    expect((await owner.get(`/interrupts/${encodeURIComponent(token!)}`)).status).toBe(409);
  });
});
