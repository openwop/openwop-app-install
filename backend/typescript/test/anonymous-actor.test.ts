/**
 * RFC 0132 (Draft) — anonymous-actor authorization, reference host.
 * PHASE 1 (read tier) + PHASE 2 (bounded-write-egress tier) + the conformance
 * witness seam (/v1/host/sample/anon-surface/*).
 *
 * Behavioral coverage of the five §F invariants + the honest-off advertisement:
 *   - honest-off: the `anonymousActor` capability + the sample seam are OMITTED/404
 *     unless the operator opts in.
 *   - `anon-actor-no-default-baseline`: only the explicit grant is callable; a
 *     non-granted tool → `anon-not-granted`, never dispatched.
 *   - `anon-actor-no-secret-reach`: a granted read runs tenant-scoped with NO acting
 *     user; a granted deliverable fails closed; the planted BYOK canary never leaks;
 *     a cross-tenant read fails closed.
 *   - `anon-actor-write-egress-gated`: a granted write suspends on the RFC 0051 HITL
 *     gate (no durable write); an UNCONTROLLED write → `anon-write-ungated`.
 *   - `anon-actor-egress-ssrf-guarded`: an out-of-audience egress → `anon-egress-denied`
 *     with NO credential attached.
 *   - `anon-actor-audit-opaque`: the decision principal is the opaque anon id; the
 *     owner witness carries `principalKind:"anonymous"`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import {
  runAnonReadTurn,
  resolveAnonGrant,
  mintAnonPrincipal,
  authorizeAnonTool,
  guardAnonEgress,
  anonRunOwner,
  decideAnonToolCall,
  type AnonSurfaceGrant,
  type AnonSeamGrant,
} from '../src/host/anonymousActor.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const AGENT = { agentId: 'a-anon', persona: 'Greeter', systemPrompt: 'You are a public assistant.' };
const READ = 'openwop:knowledge.search';        // tenant-scoped read, NO acting user needed
const DELIVERABLE = 'openwop:kanban.add-todo';  // ADR 0308 — fails closed without an acting user
const CANARY = 'sk-openwop-anon-canary-DO-NOT-LEAK';

let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const getJson = async (path: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
};
const postJson = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
};

/** A one-round provider that requests `calls`, then answers. Captures the messages
 *  fed to the SECOND (settle) round so a test can inspect tool results. */
function scriptedProvider(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  captured: { round2: AiToolCallRequest['messages'] },
): (r: AiToolCallRequest) => Promise<AiToolCallResult> {
  let round = 0;
  return async (r) => {
    round += 1;
    if (round === 1) return { content: '', toolCalls: calls };
    captured.round2 = r.messages;
    return { content: 'done', toolCalls: [] };
  };
}

describe('RFC 0132 §B — discovery advertisement (honest-off / env-gated, both tiers)', () => {
  it('OMITS anonymousActor by default (honest-off)', async () => {
    delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
    const { body } = await getJson('/.well-known/openwop');
    expect((body.capabilities as Record<string, unknown>).anonymousActor).toBeUndefined();
  });

  it('advertises both tiers + hitl control when enabled', async () => {
    process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
    try {
      const { body } = await getJson('/.well-known/openwop');
      expect((body.capabilities as Record<string, unknown>).anonymousActor).toEqual({
        supported: true, tiers: ['read', 'bounded-write-egress'], writeEgressControls: ['hitl'], failClosed: true,
      });
    } finally {
      delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
    }
  });
});

describe('RFC 0132 §C — the pure authorization primitives (the one owner)', () => {
  const grant: AnonSurfaceGrant = { read: ['catalog.read'], write: ['lead.capture', 'http.fetch'], writeControl: 'hitl', egressAudiences: ['api.acme.example'] };

  it('authorizeAnonTool is default-deny + tier-aware', () => {
    expect(authorizeAnonTool(grant, 'catalog.read')).toEqual({ allowed: true, reason: 'anon-granted', tier: 'read' });
    expect(authorizeAnonTool(grant, 'lead.capture')).toEqual({ allowed: true, reason: 'anon-granted', tier: 'bounded-write-egress', requiresApproval: true, control: 'hitl' });
    expect(authorizeAnonTool(grant, 'crm.contact.delete')).toEqual({ allowed: false, reason: 'anon-not-granted' });
    expect(authorizeAnonTool({ read: [], write: ['lead.capture'] }, 'lead.capture')).toEqual({ allowed: false, reason: 'anon-write-ungated', tier: 'bounded-write-egress' });
  });

  it('guardAnonEgress denies out-of-audience + SSRF, never attaches a credential', () => {
    expect(guardAnonEgress('https://attacker.example/exfil', ['api.acme.example'])).toEqual({ decision: 'denied', reason: 'out-of-audience', credentialAttached: false });
    expect(guardAnonEgress('http://127.0.0.1/meta', ['127.0.0.1'])).toEqual({ decision: 'denied', reason: 'ssrf-blocked', credentialAttached: false });
    expect(guardAnonEgress('ftp://api.acme.example', ['api.acme.example'])).toEqual({ decision: 'denied', reason: 'unsupported-scheme', credentialAttached: false });
    expect(guardAnonEgress('https://api.acme.example/leads', ['api.acme.example'])).toEqual({ decision: 'downgraded', reason: 'anon-credential-free', credentialAttached: false });
  });

  it('mintAnonPrincipal is opaque, stable-per-session, distinct across sessions, not the raw key', () => {
    const a = mintAnonPrincipal('w:sess-A');
    expect(a).toBe(mintAnonPrincipal('w:sess-A'));
    expect(a).not.toBe(mintAnonPrincipal('w:sess-B'));
    expect(a).toMatch(/^anon:sess-[0-9a-f]{16}$/);
    expect(a).not.toContain('sess-A');
  });

  it('resolveAnonGrant is DEFAULT-DENY (empty) when unset/empty; returns read+write verbatim otherwise', () => {
    expect(resolveAnonGrant({})).toEqual({ read: [], write: [] });
    expect(resolveAnonGrant({ anonToolGrant: { read: [] } })).toEqual({ read: [], write: [] });
    expect(resolveAnonGrant({ anonToolGrant: { read: [READ, READ], write: [DELIVERABLE], writeControl: 'hitl' } }))
      .toEqual({ read: [READ], write: [DELIVERABLE], writeControl: 'hitl' });
  });
});

describe('RFC 0132 §C.1 — widget default-deny (anon-actor-no-default-baseline)', () => {
  it('dispatches ONLY the granted read tool; a NON-granted tool denies + is never dispatched', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const callAIWithTools = scriptedProvider(
      [
        { id: 'c1', name: READ, input: { query: 'hello' } },
        { id: 'c2', name: DELIVERABLE, input: { title: 'x' } },
      ],
      captured,
    );
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [READ], write: [] },
      surfaceSessionKey: 'w:s1', fencedUserMessage: 'hi', callAIWithTools,
    });

    const decisions = (await storage.listEvents(turn.runId))
      .filter((e) => e.type === 'authorization.decided')
      .map((e) => e.payload as { action: string; allowed: boolean; reason: string; principal: string; resource: string });

    expect(decisions).toContainEqual(expect.objectContaining({ action: `tool:${READ}`, allowed: true, reason: 'anon-granted', principal: turn.principal, resource: 'tenant:acme' }));
    expect(decisions).toContainEqual(expect.objectContaining({ action: `tool:${DELIVERABLE}`, allowed: false, reason: 'anon-not-granted' }));
    expect(decisions.some((d) => d.action === `tool:${DELIVERABLE}` && d.allowed)).toBe(false);
  });
});

describe('RFC 0132 §C.2 — widget no-secret-reach (anon-actor-no-secret-reach)', () => {
  it('a granted read runs tenant-scoped with no acting user; a granted deliverable fails closed', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const callAIWithTools = scriptedProvider(
      [
        { id: 'c1', name: READ, input: { query: 'pricing' } },
        { id: 'c2', name: DELIVERABLE, input: { title: 'call me back' } },
      ],
      captured,
    );
    await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [READ, DELIVERABLE], write: [] }, // both at READ tier — proves the ADR 0308 floor
      surfaceSessionKey: 'w:s2', fencedUserMessage: 'hi', callAIWithTools,
    });

    const asText = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : '');
    const readResult = captured.round2.find((m) => asText(m).startsWith(`Result of ${READ}`));
    const deliverableResult = captured.round2.find((m) => asText(m).startsWith(`Result of ${DELIVERABLE}`));
    expect(readResult).toBeTruthy();
    expect(asText(readResult!)).not.toContain('acting_user_required');
    expect(deliverableResult).toBeTruthy();
    expect(asText(deliverableResult!)).toContain('acting_user_required');
  });
});

describe('RFC 0132 §C.3 — widget write-gating (anon-actor-write-egress-gated)', () => {
  it('an UNCONTROLLED anon write is denied anon-write-ungated + never executes the real tool', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [DELIVERABLE] }, // NO writeControl → uncontrolled
      surfaceSessionKey: 'w:s3', fencedUserMessage: 'hi',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
    });
    const decisions = (await storage.listEvents(turn.runId)).filter((e) => e.type === 'authorization.decided').map((e) => e.payload as { reason: string });
    expect(decisions).toContainEqual(expect.objectContaining({ reason: 'anon-write-ungated' }));
    expect(JSON.stringify(captured.round2)).toContain('anon_write_ungated'); // real write never ran
  });

  it('a HITL-controlled anon write suspends (pending approval) — no durable write', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'hitl' },
      surfaceSessionKey: 'w:s4', fencedUserMessage: 'hi',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
    });
    const decisions = (await storage.listEvents(turn.runId)).filter((e) => e.type === 'authorization.decided').map((e) => e.payload as { reason: string; allowed: boolean });
    expect(decisions).toContainEqual(expect.objectContaining({ allowed: true, reason: 'anon-granted' }));
    expect(JSON.stringify(captured.round2)).toContain('pending_approval'); // held for approval, not written
  });
});

describe('RFC 0132 §A — the owner witness on a widget run', () => {
  it('an anon run snapshot carries owner.principalKind:anonymous with the opaque principal', async () => {
    const storage = await openStorage('memory://');
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [READ], write: [] },
      surfaceSessionKey: 'w:s5', fencedUserMessage: 'hi',
      callAIWithTools: async () => ({ content: 'hi there', toolCalls: [] }),
    });
    const run = await storage.getRun(turn.runId);
    expect(anonRunOwner(run!)).toEqual({ tenant: 'acme', principal: turn.principal, principalKind: 'anonymous' });
    expect(turn.principal).toMatch(/^anon:sess-[0-9a-f]{16}$/);
    expect((run!.metadata as { actingUserId?: unknown }).actingUserId).toBeUndefined();
  });
});

// ── The conformance WITNESS seam (/v1/host/sample/anon-surface/*) ──
describe('RFC 0132 — the sample conformance seam', () => {
  beforeAll(() => { process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true'; });
  afterAll(() => { delete process.env.OPENWOP_ANON_ACTOR_ENABLED; });

  it('honest-off: the seam 404s when disabled', async () => {
    delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
    try {
      expect((await getJson('/v1/host/sample/anon-surface/tools?surface=sample-public-widget')).status).toBe(404);
      expect((await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'catalog.read' })).status).toBe(404);
    } finally {
      process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
    }
  });

  it('GET /tools returns the EXPLICIT grant only (fails empty on unknown surface)', async () => {
    const configured = await getJson('/v1/host/sample/anon-surface/tools?surface=sample-public-widget');
    expect(configured.body.tools).toEqual([{ name: 'catalog.read' }, { name: 'lead.capture' }, { name: 'http.fetch' }]);
    const unknown = await getJson('/v1/host/sample/anon-surface/tools?surface=nope');
    expect(unknown.body.tools).toEqual([]);
  });

  it('dispatch on an UNKNOWN surface → uniform 404 (no cross-tenant existence oracle)', async () => {
    // The hardened publicGateway precedent: an unknown surface must not 400/leak that
    // it does not exist (vs an existing-but-forbidden one). A missing tool on a KNOWN
    // surface, by contrast, is an honest 400 (the caller already reached the surface).
    expect((await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'nope', tool: 'catalog.read' })).status).toBe(404);
    expect((await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget' })).status).toBe(400);
  });

  it('read tier: catalog.read → allowed anon-granted + owner.principalKind anonymous + result; NO canary', async () => {
    const { body, text } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'catalog.read', args: { probeSecrets: true } });
    const decided = body.authorizationDecided as { payload: { allowed: boolean; reason: string; principal: string; resource: string } };
    expect(decided.payload).toEqual(expect.objectContaining({ allowed: true, reason: 'anon-granted', resource: 'tenant:sample-anon-tenant' }));
    expect(decided.payload.principal).toMatch(/^anon:sess-[0-9a-f]{16}$/);
    expect(body.owner).toEqual({ tenant: 'sample-anon-tenant', principal: decided.payload.principal, principalKind: 'anonymous' });
    // The tenant-scoped RFC 0078 catalog — the explicit grant, no secret (probeSecrets ignored).
    expect(body.result).toEqual({ tenant: 'sample-anon-tenant', catalog: ['catalog.read', 'lead.capture', 'http.fetch'] });
    expect(text).not.toContain(CANARY);
  });

  it('read tier: a cross-tenant read fails closed (result OMITTED — no other-tenant data)', async () => {
    const { body, text } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'catalog.read', args: { tenant: 'other-tenant' } });
    // The read is granted, but a cross-tenant ask yields NOTHING — the result is omitted entirely.
    expect((body.authorizationDecided as { payload: { allowed: boolean } }).payload.allowed).toBe(true);
    expect(body.result).toBeUndefined();
    expect(text).not.toContain(CANARY);
  });

  it('ungranted baseline: crm.contact.delete → anon-not-granted, NO result', async () => {
    const { body } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'crm.contact.delete' });
    expect((body.authorizationDecided as { payload: { allowed: boolean; reason: string } }).payload).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-not-granted' }));
    expect(body.result).toBeUndefined();
  });

  it('egress: http.fetch to an out-of-audience destination → anon-egress-denied, no credential, NO result', async () => {
    const { body } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'http.fetch', destination: 'https://attacker.example/exfil' });
    expect((body.authorizationDecided as { payload: { allowed: boolean; reason: string } }).payload).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-egress-denied' }));
    expect(body.egressDecided).toEqual({ decision: 'denied', reason: 'out-of-audience', credentialAttached: false });
    expect(body.result).toBeUndefined();
  });

  it('bounded-write: lead.capture behind hitl → suspends on interrupt.approval, NO result', async () => {
    const { body } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-public-widget', tool: 'lead.capture', args: { email: 'v@example.com' } });
    expect((body.authorizationDecided as { payload: { allowed: boolean; reason: string } }).payload).toEqual(expect.objectContaining({ allowed: true, reason: 'anon-granted' }));
    expect(body.interrupt).toEqual({ kind: 'approval' });
    expect(body.result).toBeUndefined();
  });

  it('uncontrolled surface: lead.capture with NO control → anon-write-ungated, NO result/interrupt', async () => {
    const { body } = await postJson('/v1/host/sample/anon-surface/dispatch', { surface: 'sample-uncontrolled-surface', tool: 'lead.capture' });
    expect((body.authorizationDecided as { payload: { allowed: boolean; reason: string } }).payload).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-write-ungated' }));
    expect(body.interrupt).toBeUndefined();
    expect(body.result).toBeUndefined();
  });
});

// The seam's UNIFIED decision core, tested directly (deterministic, transport-free):
// this is the one owner of the seam's authorize→egress→dispatch logic, so exercising
// it head-on pins every §C branch + the EXACT conformance reason strings.
describe('RFC 0132 §C — decideAnonToolCall (the seam decision core)', () => {
  const grant: AnonSeamGrant = {
    read: ['catalog.read'],
    write: [{ tool: 'lead.capture', control: 'hitl' }, { tool: 'lead.capture.raw', control: 'none' }],
    egress: [{ tool: 'http.fetch', audience: ['api.sample-widget.example'] }],
  };
  const base = { principal: 'anon:sess-deadbeefdeadbeef', tenantId: 'acme', grant } as const;

  it('read tier → allowed anon-granted + dispatch, with the closed authz shape', () => {
    const d = decideAnonToolCall({ ...base, tool: 'catalog.read' });
    expect(d.authorization).toEqual({ principal: base.principal, action: 'tool:catalog.read', resource: 'tenant:acme', allowed: true, reason: 'anon-granted' });
    expect(d.dispatch).toBe(true);
    expect(d.interrupt).toBeUndefined();
    expect(d.egress).toBeUndefined();
  });

  it('HITL write → allowed anon-granted + approval interrupt, never dispatched', () => {
    const d = decideAnonToolCall({ ...base, tool: 'lead.capture' });
    expect(d.authorization).toEqual(expect.objectContaining({ allowed: true, reason: 'anon-granted' }));
    expect(d.interrupt).toEqual({ kind: 'approval' });
    expect(d.dispatch).toBe(false);
  });

  it('uncontrolled write → anon-write-ungated, no interrupt, no dispatch', () => {
    const d = decideAnonToolCall({ ...base, tool: 'lead.capture.raw' });
    expect(d.authorization).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-write-ungated' }));
    expect(d.interrupt).toBeUndefined();
    expect(d.dispatch).toBe(false);
  });

  it('egress out-of-audience / SSRF → anon-egress-denied, credential-free, no dispatch', () => {
    const out = decideAnonToolCall({ ...base, tool: 'http.fetch', destination: 'https://attacker.example/exfil' });
    expect(out.authorization).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-egress-denied' }));
    expect(out.egress).toEqual({ decision: 'denied', reason: 'out-of-audience', credentialAttached: false });
    expect(out.dispatch).toBe(false);
    const ssrf = decideAnonToolCall({ ...base, tool: 'http.fetch', destination: 'http://127.0.0.1/latest/meta-data' });
    expect(ssrf.egress).toEqual({ decision: 'denied', reason: 'ssrf-blocked', credentialAttached: false });
    expect(ssrf.authorization.reason).toBe('anon-egress-denied');
  });

  it('egress in-audience → allowed anon-granted, credential-free, decision-only (no dispatch)', () => {
    const d = decideAnonToolCall({ ...base, tool: 'http.fetch', destination: 'https://api.sample-widget.example/leads' });
    expect(d.authorization).toEqual(expect.objectContaining({ allowed: true, reason: 'anon-granted' }));
    expect(d.egress).toEqual({ decision: 'downgraded', reason: 'anon-credential-free', credentialAttached: false });
    expect(d.dispatch).toBe(false);
  });

  it('a tool in NO list → anon-not-granted (default-deny, never the ADR 0315 baseline)', () => {
    expect(decideAnonToolCall({ ...base, tool: 'crm.contact.delete' }).authorization).toEqual(expect.objectContaining({ allowed: false, reason: 'anon-not-granted' }));
  });
});

describe('RFC 0132 sample seam — bounded-write-egress decision table', () => {
  const P = 'anon:sess-0011223344556677';
  const T = 'sample-anon-tenant';
  const grant: AnonSeamGrant = {
    read: ['catalog.read'],
    write: [{ tool: 'lead.capture', control: 'hitl' }],
    egress: [{ tool: 'http.fetch', audience: ['api.sample-widget.example'] }],
  };
  const uncontrolled: AnonSeamGrant = {
    read: [],
    write: [{ tool: 'lead.capture', control: 'none' }],
    egress: [],
  };
  const decide = (tool: string, extra?: { args?: Record<string, unknown>; destination?: string; grant?: AnonSeamGrant }) =>
    decideAnonToolCall({ principal: P, tenantId: T, grant: extra?.grant ?? grant, tool, args: extra?.args, destination: extra?.destination });

  it('read tier: catalog.read → allowed anon-granted, dispatch true', () => {
    const d = decide('catalog.read');
    expect(d.authorization).toEqual({ principal: P, action: 'tool:catalog.read', resource: `tenant:${T}`, allowed: true, reason: 'anon-granted' });
    expect(d.dispatch).toBe(true);
    expect(d.egress).toBeUndefined();
    expect(d.interrupt).toBeUndefined();
  });

  it('read tier is tenant-agnostic: a cross-tenant catalog.read still decides granted (the SEAM omits the data)', () => {
    const d = decide('catalog.read', { args: { tenant: 'other-tenant' } });
    expect(d.authorization.allowed).toBe(true);
    expect(d.authorization.reason).toBe('anon-granted');
    expect(d.dispatch).toBe(true);
  });

  it('ungranted: crm.contact.delete → anon-not-granted, no dispatch, no egress/interrupt', () => {
    const d = decide('crm.contact.delete');
    expect(d.authorization.allowed).toBe(false);
    expect(d.authorization.reason).toBe('anon-not-granted');
    expect(d.dispatch).toBe(false);
    expect(d.egress).toBeUndefined();
    expect(d.interrupt).toBeUndefined();
  });

  it('egress: http.fetch to attacker.example → anon-egress-denied out-of-audience, credentialAttached false, no dispatch', () => {
    const d = decide('http.fetch', { destination: 'https://attacker.example/exfil' });
    expect(d.authorization.allowed).toBe(false);
    expect(d.authorization.reason).toBe('anon-egress-denied');
    expect(d.egress).toEqual({ decision: 'denied', reason: 'out-of-audience', credentialAttached: false });
    expect(d.dispatch).toBe(false);
  });

  it('egress: http.fetch in-audience → allowed anon-granted, egress in-audience credential-free, no dispatch (decision-only)', () => {
    const d = decide('http.fetch', { destination: 'https://api.sample-widget.example/leads' });
    expect(d.authorization.allowed).toBe(true);
    expect(d.authorization.reason).toBe('anon-granted');
    expect(d.egress).toEqual({ decision: 'downgraded', reason: 'anon-credential-free', credentialAttached: false });
    expect(d.dispatch).toBe(false);
  });

  it('egress: http.fetch to a private/SSRF host → anon-egress-denied ssrf-blocked, credentialAttached false', () => {
    const d = decide('http.fetch', { destination: 'http://169.254.169.254/latest/meta-data' });
    expect(d.authorization.reason).toBe('anon-egress-denied');
    expect(d.egress).toEqual({ decision: 'denied', reason: 'ssrf-blocked', credentialAttached: false });
    expect(d.dispatch).toBe(false);
  });

  it('bounded-write hitl: lead.capture → allowed anon-granted + approval interrupt, no dispatch', () => {
    const d = decide('lead.capture');
    expect(d.authorization.allowed).toBe(true);
    expect(d.authorization.reason).toBe('anon-granted');
    expect(d.interrupt).toEqual({ kind: 'approval' });
    expect(d.dispatch).toBe(false);
    expect(d.egress).toBeUndefined();
  });

  it('bounded-write none: lead.capture uncontrolled → anon-write-ungated, no interrupt, no dispatch', () => {
    const d = decide('lead.capture', { grant: uncontrolled });
    expect(d.authorization.allowed).toBe(false);
    expect(d.authorization.reason).toBe('anon-write-ungated');
    expect(d.interrupt).toBeUndefined();
    expect(d.dispatch).toBe(false);
  });
});
