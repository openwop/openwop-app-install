/**
 * ADR 1024 D6 — a journey ends cleanly when the PERSON is the reason it stops, and the
 * shipped chains route that end to a terminal (feature-loop row 73, `CDP2WF-9/-10/-19/-20`).
 *
 * Before: `enroll` failed the run for `not_eligible`, `already_enrolled` and `superseded`,
 * and the re-checks failed every reason except `suppressed`. A welcome series bound to
 * contact creation produced a FAILED run for nearly every new contact who had not opted in
 * (and `run.failed` webhooks and failure counts with it). This file proves:
 *  1. the closed set of normal stops is pinned against the service's reason unions, so a
 *     new reason must be classified rather than silently failing or silently ending;
 *  2. the REAL node handlers end cleanly on a normal stop and still fail on a fault;
 *  3. through the REAL loader and scheduler, every journey chain that enrolls reaches a
 *     completed terminal and sends nothing when the person is ineligible, at enroll, at
 *     the first gate, and at the re-checks;
 *  4. a Viewer cannot reset an enrollment in a workspace with no clients;
 *  5. segment-winback forwards the names its child chain declares.
 * (ADR 1024 D6.6, a same-run enroll retry reading as enrolled, was withdrawn: the ledger
 * cannot tell a sequential retry from a concurrent duplicate of the same run, and the
 * second is a double send. Filed as `CDP2WF-20b`.)
 *
 * Red when (sabotage-witnessed in this PR, each applied and reverted in one step):
 * `NORMAL_STOP_REASONS` gains a fault or loses a person reason; `stopsCleanlyOn` ignores
 * the flag; `enroll` fails instead of stopping on an existing enrollment; any chain loses a
 * `falsy enrolled` / `falsy eligible` edge or its noop terminal; `clientOf` stops checking
 * scope when no client is named; segment-winback forwards `fromAddress`/`text` again.
 * (w86) A fault asserts its error code, not just `failed`, and the reset case seeds a
 * real enrollment: the viewer's 403 keeps it, the editor's reset removes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { CHANNEL_INELIGIBLE_REASONS } from '../src/features/crm/channelEligibility.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, evaluateTrigger } from '../src/executor/scheduler.js';
import { enroll as enrollContact, listEnrollments } from '../src/features/campaign-journeys/journeyService.js';

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
type Handler = (ctx: Record<string, unknown>) => Promise<NodeResult>;
const journeysPack = await import(
  /* @vite-ignore */ new URL('../../../packs/feature.campaign-journeys.nodes/index.mjs', import.meta.url).href
) as { nodes: Record<string, Handler>; NORMAL_STOP_REASONS: readonly string[] };

const ENROLL = 'feature.campaign-journeys.nodes.enroll';
const CHANNEL = 'feature.campaign-journeys.nodes.channel-eligibility';
const LEGACY = 'feature.campaign-journeys.nodes.eligibility';
const SEND_TYPES = new Set(['core.openwop.integration.email-send', 'feature.campaign-journeys.nodes.send-sms']);

/** Every ineligibility reason the services can return, with its classification. A reason
 *  added to `ChannelIneligibleReason` (or the legacy `IneligibleReason`) without a line
 *  here fails case 1: classify it, do not let it default. */
const FAULTS = new Set(['consent_unreadable', 'suppression_unreadable', 'deliverability_paused', 'quiet_hours']);
const LEGACY_ONLY = ['no_email'];

describe('1 — the closed set of normal stops', () => {
  it('classifies every reason the services return, and nothing else', () => {
    const all = new Set<string>([...CHANNEL_INELIGIBLE_REASONS, ...LEGACY_ONLY]);
    const unclassified = [...all].filter((r) => !FAULTS.has(r) && !journeysPack.NORMAL_STOP_REASONS.includes(r));
    expect(unclassified, 'a new ineligibility reason must be classified as a normal stop or a fault').toEqual([]);
    for (const r of journeysPack.NORMAL_STOP_REASONS) {
      expect(all.has(r), `${r} is not a reason any service returns`).toBe(true);
      expect(FAULTS.has(r), `${r} is a fault, not the person's own state`).toBe(false);
    }
  });
});

/** A ctx for a real node handler with a stubbed `ctx.features['campaign-journeys']`. */
function ctxFor(inputs: Record<string, unknown>, cj: Record<string, unknown>): Record<string, unknown> {
  return {
    nodeId: 'n', runId: 'run-1024', inputs, config: {},
    features: { 'campaign-journeys': { enroll: async () => ({ enrolled: true }), checkEligibility: async () => ({ eligible: true, email: 'a@x.test', name: 'A' }), ...cj } },
  };
}

describe('2 — the real handlers end cleanly on a normal stop and still fail on a fault', () => {
  const enroll = journeysPack.nodes[ENROLL]!;
  const channel = journeysPack.nodes[CHANNEL]!;
  const legacy = journeysPack.nodes[LEGACY]!;
  const ineligible = (reason: string) => ({ checkEligibility: async () => ({ eligible: false, reason }), checkChannelEligibility: async () => ({ eligible: false, reason, channel: 'email' }) });

  it('enroll: consent stops cleanly with the flag, fails without it, and a fault always fails', async () => {
    const base = { journeyId: 'j', contactId: 'c1' };
    const stopped = await enroll(ctxFor({ ...base, stopOnIneligible: true }, ineligible('consent')));
    expect(stopped).toMatchObject({ status: 'success', outputs: { enrolled: false, stopped: 'consent' } });
    expect(await enroll(ctxFor(base, ineligible('consent')))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
    expect(await enroll(ctxFor({ ...base, stopOnIneligible: true }, ineligible('consent_unreadable')))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
  });

  it('enroll: an existing enrollment and a superseding journey stop cleanly with the flag', async () => {
    const base = { journeyId: 'j', contactId: 'c1', stopOnIneligible: true };
    const already = await enroll(ctxFor(base, { enroll: async () => ({ enrolled: false, enrolledAt: '2026-01-01' }) }));
    expect(already).toMatchObject({ status: 'success', outputs: { enrolled: false, stopped: 'already_enrolled' } });
    const superseded = await enroll(ctxFor(base, { enroll: async () => ({ enrolled: false, reason: 'superseded' }) }));
    expect(superseded).toMatchObject({ status: 'success', outputs: { enrolled: false, stopped: 'superseded' } });
    expect(await enroll(ctxFor({ journeyId: 'j', contactId: 'c1' }, { enroll: async () => ({ enrolled: false }) }))).toMatchObject({ status: 'failed', error: { code: 'already_enrolled' } });
  });

  it('channel-eligibility and the legacy eligibility node: same set, faults still fail', async () => {
    const i = { contactId: 'c1', channel: 'email', stopOnIneligible: true };
    expect(await channel(ctxFor(i, ineligible('topic_opt_out')))).toMatchObject({ status: 'success', outputs: { eligible: false, stopped: 'topic_opt_out' } });
    expect(await channel(ctxFor(i, ineligible('deliverability_paused')))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
    expect(await legacy(ctxFor({ contactId: 'c1', stopOnIneligible: true }, ineligible('no_email')))).toMatchObject({ status: 'success', outputs: { eligible: false, stopped: 'no_email' } });
    // The predecessor flag keeps its one reason and no more.
    expect(await channel(ctxFor({ contactId: 'c1', stopOnSuppressed: true }, ineligible('suppressed')))).toMatchObject({ status: 'success', outputs: { eligible: false, stopped: 'suppressed' } });
    expect(await channel(ctxFor({ contactId: 'c1', stopOnSuppressed: true }, ineligible('consent')))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
  });
});

describe('3 — every enrolling journey chain ends at a completed terminal and sends nothing', () => {
  beforeAll(() => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    expect(errors).toEqual([]);
  });

  const journeyChains = () => listChains().filter(({ chain }) => chain.dag.nodes.some((n) => n.typeId.replace(/@.*$/, "") === ENROLL));

  /** Forward-simulate the expanded chain through the REAL scheduler. Node outputs come from
   *  the REAL handlers for enroll/eligibility (with `ineligibleAt` deciding which one sees an
   *  ineligible person) and a generic success for everything else; approval gates approve. */
  async function simulate(chainId: string, ineligibleAt: 'enroll' | 'gate' | 'recheck'): Promise<{ sends: string[]; completedSinks: string[] }> {
    const entry = listChains().find((c) => c.chain.chainId === chainId)!;
    const def = expandChain(entry.chain, { params: {} });
    const graph = buildGraph(def);
    const snap = freshSnapshot(def);
    const bare = (id: string): string => id.slice(id.lastIndexOf('_') + 1);
    let gateSeen = 0;
    for (let pass = 0; pass <= def.nodes.length; pass += 1) {
      let moved = false;
      for (const n of def.nodes) {
        const state = snap.nodeState.get(n.nodeId);
        if (state !== 'pending' && state !== 'ready') continue;
        const verdict = evaluateTrigger(n.nodeId, graph, snap);
        if (verdict === 'skip') { snap.nodeState.set(n.nodeId, 'skipped'); moved = true; continue; }
        if (verdict !== 'ready') continue;
        const type = n.typeId.replace(/@.*$/, '');
        let outputs: Record<string, unknown> = { approved: true, decision: 'approve', email: 'a@x.test', to: 'a@x.test' };
        if (type === ENROLL || type === CHANNEL) {
          const isGate = type === CHANNEL && bare(n.nodeId).startsWith('gate') && !bare(n.nodeId).startsWith('gate2');
          const isRecheck = type === CHANNEL && !isGate;
          if (isGate) gateSeen += 1;
          const reasonHere = (ineligibleAt === 'enroll' && type === ENROLL) || (ineligibleAt === 'gate' && isGate) || (ineligibleAt === 'recheck' && isRecheck);
          const cj = reasonHere
            ? { checkEligibility: async () => ({ eligible: false, reason: 'consent' }), checkChannelEligibility: async () => ({ eligible: false, reason: 'consent', channel: 'email' }) }
            : { checkChannelEligibility: async () => ({ eligible: true, channel: 'email', address: 'a@x.test', name: 'A' }) };
          const res = await journeysPack.nodes[type]!(ctxFor({ ...(n.inputs as Record<string, unknown>), contactId: 'c1' }, cj));
          if (res.status !== 'success') throw new Error(`${chainId}:${bare(n.nodeId)} FAILED (${res.error?.code}) — the run would fail, not end`);
          outputs = res.outputs ?? {};
        }
        snap.nodeState.set(n.nodeId, 'completed');
        snap.nodeOutputs.set(n.nodeId, outputs);
        moved = true;
      }
      if (!moved) break;
    }
    expect(gateSeen + (ineligibleAt === 'enroll' ? 1 : 0)).toBeGreaterThan(0);
    const hasOut = new Set((def.edges ?? []).map((e) => e.sourceNodeId));
    const sinks = def.nodes.filter((n) => !hasOut.has(n.nodeId));
    return {
      sends: def.nodes.filter((n) => SEND_TYPES.has(n.typeId.replace(/@.*$/, '')) && snap.nodeState.get(n.nodeId) === 'completed').map((n) => bare(n.nodeId)),
      completedSinks: sinks.filter((n) => snap.nodeState.get(n.nodeId) === 'completed').map((n) => bare(n.nodeId)),
    };
  }

  it('finds the five enrolling journey chains (anti-vacuity floor)', () => {
    expect(journeyChains().length).toBeGreaterThanOrEqual(5);
  });

  for (const at of ['enroll', 'gate', 'recheck'] as const) {
    it(`ineligible at ${at}: no send completes and a terminal does`, async () => {
      const failures: string[] = [];
      for (const { chain } of journeyChains()) {
        const r = await simulate(chain.chainId, at);
        // Every mode stops before the FIRST send: enroll and the first gate precede the
        // sign-off, and the post-approval re-check feeds the first send's address, so an
        // ineligible re-check must skip it and everything after it (grade-code M4).
        if (r.sends.length > 0) failures.push(`${chain.chainId}: sent ${r.sends.join(',')}`);
        if (r.completedSinks.length === 0) failures.push(`${chain.chainId}: no terminal completed (all_terminals_skipped)`);
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});

describe('4 — the enrollment routes', () => {
  let server: Server;
  let BASE = '';
  let WS = '';
  beforeAll(async () => {
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
    for (const id of ['crm', 'campaign-journeys']) {
      const d = getToggleDefault(id);
      if (!d) throw new Error(`no toggle ${id}`);
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
    const ws = await createWorkspace({ name: 'ADR 1024 journeys', ownerSubject: 'oidc:j1024-owner' });
    WS = ws.orgId ?? ws.tenantId;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: userIdFor(WS, 'oidc:j1024-viewer'), roles: ['viewer'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, 'oidc:j1024-editor'), roles: ['editor'] });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  async function login(subject: string): Promise<string> {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  it('a viewer cannot reset an enrollment in a workspace with no clients; an editor can', async () => {
    // A real enrollment to reset, so the editor's 200 removes something and the
    // viewer's 403 is shown to have kept it.
    expect(await enrollContact(WS, 'welcome', 'c-reset')).toMatchObject({ enrolled: true });
    const held = async (): Promise<boolean> => (await listEnrollments(WS, 'welcome')).some((e) => e.contactId === 'c-reset');
    const body = JSON.stringify({ journeyId: 'welcome', contactId: 'c-reset' });
    const del = async (cookie: string) => fetch(`${BASE}/host/openwop-app/campaign-journeys/enrollments`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body });
    const viewer = await login('oidc:j1024-viewer');
    const refused = await del(viewer);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error?: string }).error).toBe('forbidden_scope');
    expect(await held()).toBe(true);
    // The read half stays open to the viewer, and shows the row the refusal kept.
    const list = await fetch(`${BASE}/host/openwop-app/campaign-journeys/enrollments?journeyId=welcome`, { headers: { cookie: viewer } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { enrollments: Array<{ contactId: string }> }).enrollments.map((e) => e.contactId)).toContain('c-reset');
    const reset = await del(await login('oidc:j1024-editor'));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ reset: true });
    expect(await held()).toBe(false);
  });
});

describe('5 — segment-winback forwards the names its child declares', () => {
  it('every forwarded key is a re-engage-contact parameter, and every required one is forwarded', () => {
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const chains = listChains().map((c) => c.chain);
    const winback = chains.find((c) => c.chainId === 'campaign-journeys.segment-winback')!;
    const child = chains.find((c) => c.chainId === 'campaign-journeys.re-engage-contact')!;
    const plan = winback.dag.nodes.find((n) => n.id === 'plan')!;
    const forwarded = Object.keys((plan.config ?? {}) as Record<string, unknown>).filter((k) => k !== 'childWorkflowId');
    const childParams = (child.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const declared = new Set(Object.keys(childParams.properties ?? {}));
    expect(forwarded.filter((k) => !declared.has(k)), 'forwarded keys the child does not declare (additionalProperties:false)').toEqual([]);
    const provided = new Set([...forwarded, 'contactId']);
    expect((childParams.required ?? []).filter((k) => !provided.has(k)), 'required child params nobody forwards').toEqual([]);
    expect(Object.keys(((winback.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})).toContain('segmentId');
  });
});
