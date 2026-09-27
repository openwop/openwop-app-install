/**
 * PROBE-RCL-2 (WF-RCL-7 / feature 17's PROBE-TWIN-6, twice-deferred) — the
 * fork-after-revoke BEHAVIOURAL witness for the corpus-reference replay
 * property: grant → run → revoke → `:fork` ⇒ the fork composes NO borrowed
 * content, because the agent-runner node RE-EXECUTES on a replay fork and
 * recall re-resolves LIVE (no run stamp anywhere on the path).
 *
 * Until now this property rested on static mechanics (executor.ts serves
 * recorded outcomes only for side-effecting nodes; agent-runner is
 * unclassified). This drives it end-to-end through the REAL stack: the
 * catalog's `openwop-app.agent-mention` workflow → POST /v1/runs → the real
 * executor → the real `resolveBorrowedRecall` → `POST /v1/runs/:id:fork`
 * (mode=replay), with the deterministic `mock` provider (test-seam-gated).
 *
 * Three behavioural legs, each observable without reading source:
 *   1. SOURCE run: the mock provider's `lastReceivedMessages` — the actual
 *      prompt the model got — CONTAINS the owner's note (recall composed),
 *      and a `twin.recall` ok audit row lands under the source runId.
 *   2. FORK with the grant INTACT: the node re-executes (a NEW audit row under
 *      the fork's runId — the exact fact the old docblock denied), composes
 *      the SAME prompt, and the provider call is SERVED from the source run's
 *      invocation log (no live mock call: `lastReceivedMessages` unchanged).
 *   3. REVOKE, then fork again: the re-executed node composes a DIFFERENT
 *      prompt (no borrowed block) ⇒ the invocation-log lookup misses ⇒ a LIVE
 *      mock call records the fork's prompt — which contains NO borrowed
 *      content — and no new ok audit row is written. The fork still completes
 *      (revocation degrades recall; it does not fail the run).
 *
 * What this does NOT discriminate: RFC 0041 divergence EVENT emission (leg 3
 * asserts the live-miss consequence, not the event), and `mode:'branch'`
 * forks (replay-mode only).
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { programMock, lastReceivedMessages } from '../src/providers/dispatchMock.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // gates the `mock` provider
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'twin-recall']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const twin = (id: string): string => `/v1/host/openwop-app/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/openwop-app/profiles/me/twin-grants';
const MEM = '/v1/host/openwop-app/profiles/me/memory';
const OWNER_FACT = 'cc finance on vendor contracts';

/** Poll the run to a terminal state (the executor runs in-process, async). */
async function waitTerminal(c: Client, runId: string, timeoutMs = 20_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const r = await c.get(`/v1/runs/${encodeURIComponent(runId)}`);
    const status = r.body?.status as string | undefined;
    if (status && ['completed', 'failed', 'cancelled'].includes(status)) return status;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} not terminal after ${timeoutMs}ms (last: ${status})`);
    await new Promise((res) => setTimeout(res, 150));
  }
}

const promptOf = (): string => (lastReceivedMessages('run') ?? []).map((m) => m.content).join('\n');

describe('PROBE-RCL-2 — grant → run → revoke → :fork re-resolves recall live', () => {
  it('the fork after revocation composes NO borrowed content; the fork before it re-executes and serves deterministically', async () => {
    const tenantId = `org:twf-${Date.now()}-${n++}`;
    const admin = client();
    await admin.post('/v1/host/openwop-app/test/login', { email: `twf-admin-${Date.now()}-${n++}@acme.test`, tenantId });
    const member = client();
    const m = await member.post('/v1/host/openwop-app/test/login', { email: `twf-member-${Date.now()}-${n++}@acme.test`, tenantId });
    const memberId = m.body.user.userId as string;

    // A registered manifest agent + roster entry (packs are not mounted here).
    getAgentRegistry().register({
      agentId: 'probe.twin.fork-aide', persona: 'Fork Aide', modelClass: 'chat',
      systemPrompt: 'PERSONA-MARKER-RCL-FORK: you are the fork aide.',
      packName: 'test.twin-fork', packVersion: '0.0.1', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const entry = await createRosterEntry({ tenantId, persona: 'Fork Aide', agentRef: { agentId: 'probe.twin.fork-aide' } });
    const rosterId = entry.rosterId;
    __clearAgentIdentityCache();

    // Owner corpus + link + grant.
    await member.post(MEM, { content: `I always ${OWNER_FACT}.` });
    expect((await admin.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    const okRowsFor = async (runId: string): Promise<number> =>
      (await __hostExtStorage()!.listAudit({ actionPrefix: 'twin.recall', limit: 500 }))
        .filter((r) => r.resource === `user:${memberId}` && r.outcome === 'ok' && (r.payload as { runId?: unknown }).runId === runId).length;

    // ── Leg 1: the SOURCE run (created by the OWNER ⇒ actingUserId = owner). ──
    programMock('run', [{ content: 'SOURCE-ANSWER' }]); // exactly ONE entry — exhausted after this run
    const created = await member.post('/v1/runs', {
      workflowId: 'openwop-app.agent-mention',
      // The REGISTRY id (dispatch resolves the manifest by it); the node's
      // reverse roster scan maps it to `rosterId` = the twin-link key.
      inputs: { agentId: 'probe.twin.fork-aide', task: 'summarize vendor contract finance practice', provider: 'mock', model: 'mock-1' },
      // ADR 0458 P2 confinement: a ZERO-tool surface ⇒ single completion — the
      // mock provider has no tool-calling capability, and tools are not what
      // this witness is about.
      configurable: { offerTools: [] },
    });
    expect([200, 201, 202], JSON.stringify(created.body)).toContain(created.status);
    const sourceRunId = created.body.runId as string;
    expect(await waitTerminal(member, sourceRunId)).toBe('completed');
    const sourcePrompt = promptOf();
    expect(sourcePrompt, 'the source prompt must carry the borrowed owner note').toContain(OWNER_FACT);
    expect(sourcePrompt).toContain('BEGIN UNTRUSTED CONTENT');
    expect(await okRowsFor(sourceRunId), 'the source recall is audited under its runId').toBe(1);

    // ── Leg 2: fork with the grant INTACT (forked BY the owner). ──
    const fork1 = await member.post(`/v1/runs/${encodeURIComponent(sourceRunId)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork1.status, JSON.stringify(fork1.body)).toBe(201);
    const fork1Id = fork1.body.runId as string;
    expect(await waitTerminal(member, fork1Id)).toBe('completed');
    // The node RE-EXECUTED (the fact the old docblock denied): the fork's live
    // re-read really read the corpus, so it honestly audits under ITS runId.
    expect(await okRowsFor(fork1Id), 'fork re-execution re-reads live and audits').toBe(1);
    // …and the PROVIDER call was invocation-log-SERVED. The discriminating
    // fact (review F4): the mock program held exactly ONE entry, exhausted by
    // the source run — so `SOURCE-ANSWER` appearing in the FORK'S OWN run
    // events can only have come from the recorded result in the source run's
    // invocation log. (The previous `promptOf()` equality was
    // non-discriminating: an unexhausted queue serving a live call on the
    // same prompt would also have left the last-seen prompt byte-identical.)
    const fork1Events = await member.get(`/v1/runs/${encodeURIComponent(fork1Id)}/events/poll?fromSeq=0&limit=500`);
    expect(fork1Events.status).toBe(200);
    expect(
      JSON.stringify(fork1Events.body.events),
      'the fork\'s answer must be the log-served recorded result',
    ).toContain('SOURCE-ANSWER');
    // The mock's last-seen prompt is still the source's (no live call) —
    // kept as the supporting no-live-call signal alongside the leg above.
    expect(promptOf()).toBe(sourcePrompt);

    // ── Leg 3: REVOKE, then fork again. ──
    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).body.removed).toBe(true);
    const fork2 = await member.post(`/v1/runs/${encodeURIComponent(sourceRunId)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork2.status, JSON.stringify(fork2.body)).toBe(201);
    const fork2Id = fork2.body.runId as string;
    // Revocation DEGRADES recall — it must not fail the fork.
    expect(await waitTerminal(member, fork2Id)).toBe('completed');
    // The re-executed node re-resolved recall LIVE, found the grant revoked,
    // and composed WITHOUT the borrowed block ⇒ different semantic digest ⇒
    // the invocation-log lookup MISSED ⇒ a live mock call recorded the fork's
    // actual prompt. THE property: no borrowed content in the fork.
    const fork2Prompt = promptOf();
    expect(fork2Prompt, 'a live provider call must have happened (prompt diverged)').not.toBe(sourcePrompt);
    expect(fork2Prompt, 'the fork after revocation must compose NO borrowed content').not.toContain(OWNER_FACT);
    // And no new consent-ledger row claims a read that did not happen.
    expect(await okRowsFor(fork2Id)).toBe(0);
  }, 60_000);
});
