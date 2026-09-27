/**
 * knowledge workflow-chain pack — REAL execution (ADR 0190 Phase 2, ADR 0583,
 * RFC 0013).
 *
 * ── What changed, and why the previous version of this file could not have
 *    caught the defect it was written to cover (WF-KB-7) ─────────────────────
 *
 * The prior harness was vacuous on the delivery leg three ways at once:
 *
 *   1. It drove `core.openwop.integration.notification-push` — a DIFFERENT node
 *      type, from a different pack — where the chain declares
 *      `feature.notifications.nodes.notify`. The notify pack's own docblock
 *      says it REPLACES notification-push for chains.
 *   2. It HAND-AUTHORED that node's inputs (`{title, body}`): `body` is a key
 *      `notify` does not read, and neither key is produced by any edge. Its own
 *      docblock conceded "hand-replicated `sourceOutput`/`targetInput` edge-port
 *      semantics" — so `buildNodeInputs`, the function that actually held the
 *      bug, was never called.
 *   3. It asserted the failure AS the success:
 *      `expect(delivered.outputs).toMatchObject({sent:false, error:'notification_not_connected'})`
 *      pinned a non-delivery as the expected "graceful degrade".
 *
 * This file now walks the chain through the **REAL scheduler primitives** —
 * `buildGraph`, `freshSnapshot`, `evaluateTrigger` and, above all,
 * `buildNodeInputs` are IMPORTED from `src/executor/scheduler.ts`, not
 * reproduced (the `walkChain` harnesses in the marketing/finance execution
 * tests re-implement them by hand, which is precisely how a port-mapping bug
 * stays invisible). The executor's single-`input` back-compat unwrap and its
 * `node.inputs`-wins merge are the only two lines reproduced, and they are
 * quoted from `executor.ts` verbatim below.
 *
 * ── The defect (WF-KB-5) ────────────────────────────────────────────────────
 *
 * `buildNodeInputs` (`executor/scheduler.ts`) writes each inbound edge's value
 * to `e.targetInput ?? 'input'`. A BARE edge (`{from:"route", to:"deliver"}`)
 * therefore lands the ENTIRE upstream output map under the single port `input`
 * — it is never spread by output name. So on all three knowledge chains:
 *
 *   - `feature.notifications.nodes.notify` reads `inputs.message` → `undefined`
 *     ⇒ `asText(undefined) → ''` in `notifications/surface.ts`, only
 *     `title`+`audience` are required, so the row was emitted with an EMPTY
 *     BODY and the node returned `emitted:true`. Run green, product lost.
 *   - `core.chat.approvalGate` reads `inputs.artifact` → `undefined` ⇒ a BLANK
 *     "Approval Required" card. Approve-what-you-see, with nothing to see.
 *   - `core.openwop.integration.slack-message` reads `inputs.text` →
 *     `undefined`. Its `required:["text"]` is decorative: there is no runtime
 *     node-input validation anywhere in the executor.
 *
 * Fixed at the root, in `examples/workflow-chain-packs/knowledge/pack.json`,
 * with PORT-QUALIFIED edges — the in-repo reference cure, root-caused on
 * `csm-ops.health-from-crm` (`workflow-chain-csm-ops-execution.test.ts:12-32`)
 * and re-applied to `csm-ops.renewal-risk` in #3344:
 *
 *   route.value → deliver.message  /  → approveEscalation.artifact
 *   approveEscalation.artifact → escalate.text   {truthy approved}
 *   summarize.content → notify.message
 *
 * ── The escalation content edge comes OFF THE GATE, and that is the gate ────
 *
 * CORRECTION (2026-08-18, adversarial review of this PR). The first cut of this
 * fix routed the escalation content STRAIGHT from `route.value → escalate.text`
 * (conditioned `branch === "else"`) and left `approveEscalation → escalate` as a
 * bare edge. That fix **ARMED** the deferred `WF-CSM-1` hole instead of leaving
 * it inert:
 *
 *   - PRE-fix, a REJECT still fired `escalate` (bare edge + `status:'success'`
 *     on reject ⇒ `all_success` ready) but `text` was never bound, so it posted
 *     `undefined`. Nothing left the org.
 *   - POST-that-fix, the sibling `route.value → escalate.text` edge was
 *     `completed` on the else branch regardless of the decision, so a rejected
 *     escalation posted the FULL uncovered-policy answer to `#people-ops` and
 *     the FULL compliance deviation list to `#compliance`. Five of the gate's
 *     six outcomes (reject, timeout, refine, ask, and the card's unmapped
 *     defer/escalate verbs) leaked.
 *
 * The cure is the one `approvalGate` already documents and `csm-ops.renewal-risk`
 * already ships: the effect node takes its content BACK OFF THE GATE
 * (`packs/vendor.myndhyve.chat/schemas/approvalGate.output.json` §artifact —
 * "so the effect node has no unconditional incoming edge that would fire it on a
 * rejection"; `index.mjs:386-394` restates it with the measurement). The gate
 * returns `artifact = resumePayload?.editedArtifact ?? inputs.artifact`
 * (`index.mjs:395`), so an APPROVE still carries the content — and an edit-accept
 * carries the reviewer's edited version, which the old wiring could not.
 *
 * Edge conditions are CONTROL FLOW (ADR 0208 — `evaluateTrigger` folds a
 * false-conditioned completed upstream to `skipped`), and `all_success` fires a
 * target as soon as ANY upstream completed. `escalate` now has exactly ONE
 * incoming edge and it is conditioned, so on every non-approving outcome that
 * sole upstream folds to `skipped`, `all_success` sees `allTerminal &&
 * !anyCompleted` and returns `skip`. The reject legs below are what hold this;
 * they drive the REAL UI resume payload (`{action:'reject'}` — what
 * `interrupts/ApprovalCard.tsx`, `chat/registry/defaultCards.tsx` and
 * `routes/reviews.ts` actually send), not the `{approved:false}` shape no
 * shipped producer emits.
 *
 * ── WF-KB-15: the primary output was on the wrong terminal ──────────────────
 *
 * `expandChain` stamps `outputRole:'primary'` on the LAST terminal node in
 * declaration order (`workflowChainPackLoader.ts:1090-1092`). `deliver`/`pass`
 * were declared BEFORE `escalate`, so the primary was the else-branch Slack
 * post — a node that does not execute at all on the covered path. The nodes are
 * reordered so the happy-path terminal is declared last. Asserted by NAME
 * below; the structural test only ever counted primaries, which is exactly why
 * this shipped.
 *
 * ── Also fixed here ─────────────────────────────────────────────────────────
 *
 * WF-KB-17: `retrieve → answer` was portless, so `core.ai.chatCompletion` got
 * the whole RAG envelope and `toMessages` picked a channel by object-key order.
 * Now `retrieve.augmentedPrompt → answer.prompt` — a named `toMessages` port.
 * WF-KB-9: the dead `config.query` on both `feature.kb.nodes.rag` nodes is
 * deleted (the node reads `ctx.inputs` exclusively).
 *
 * ── The two premises the earlier deferral rested on were both false ─────────
 *
 * This docblock previously said the cure "is being established" by #3344 and
 * "cannot be half-fixed here". Neither held:
 *
 *   1. #3344 MERGED at 2026-08-18T14:40:46Z (`cdae6af27`) and is an ancestor of
 *      this branch. `csm-ops.renewal-risk@1.1.0` ships the working example
 *      (`open-deals.deals → review.artifact`, then `review → follow-up
 *      {truthy approved}`). This pack is a CONSUMER of a landed fix.
 *   2. "Conditioning only the gate edge leaves the sibling content edge
 *      completed" was a false dilemma — the cure REMOVES the sibling content
 *      edge. It re-parents it onto the gate, so there is no sibling left.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import {
  buildGraph,
  buildNodeInputs,
  evaluateTrigger,
  freshSnapshot,
  type NodeState,
  type SchedulerSnapshot,
} from '../src/executor/scheduler.js';
import type { Storage } from '../src/storage/storage.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

type NodeCtx = Record<string, unknown>;
type NodeResult = { status: string; outputs: Record<string, unknown>; error?: unknown };
type PackNode = (ctx: NodeCtx) => Promise<NodeResult>;

let BASE: string;
let server: http.Server;
let storage: Storage;

/** REAL node implementations, loaded from the shipped packs. */
const impls: Record<string, PackNode> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test');

  // `core.openwop.flow` + `core.openwop.ai` are ambiently declared in
  // `test/pack-modules.d.ts`; the other four are not, hence the directives.
  const flow = (await import('../../../packs/core.openwop.flow/index.mjs')) as { ifNode: PackNode };
  // @ts-expect-error — feature.kb.nodes ships no declaration file (untyped .mjs)
  const kbNodes = (await import('../../../packs/feature.kb.nodes/index.mjs')) as { rag: PackNode };
  // @ts-expect-error — feature.notifications.nodes ships no declaration file (untyped .mjs)
  const notif = (await import('../../../packs/feature.notifications.nodes/index.mjs')) as { notify: PackNode };
  // @ts-expect-error — core.openwop.integration ships no declaration file (untyped .mjs)
  const integ = (await import('../../../packs/core.openwop.integration/index.mjs')) as { slackMessage: PackNode };
  // @ts-expect-error — vendor.myndhyve.chat ships no declaration file (untyped .mjs)
  const chat = (await import('../../../packs/vendor.myndhyve.chat/index.mjs')) as { approvalGate: PackNode };
  const ai = (await import('../../../packs/core.openwop.ai/index.mjs')) as { chatCompletion: PackNode };

  impls['core.flow.if'] = flow.ifNode;
  impls['feature.kb.nodes.rag'] = kbNodes.rag;
  impls['feature.notifications.nodes.notify'] = notif.notify;
  impls['core.openwop.integration.slack-message'] = integ.slackMessage;
  impls['core.chat.approvalGate'] = chat.approvalGate;
  impls['core.ai.chatCompletion'] = ai.chatCompletion;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res<any>>; post: (p: string, b?: unknown) => Promise<Res<any>> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrgWithPolicyDoc(): Promise<{ tenantId: string; orgId: string; collectionId: string }> {
  const tenantId = `org:kbchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `kbchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;

  const col = await owner.post(`/v1/host/openwop-app/kb/orgs/${orgId}/collections`, { name: 'HR Policies' });
  expect(col.status, JSON.stringify(col.body)).toBe(201);
  const collectionId = col.body.collectionId as string;

  const doc = await owner.post(`/v1/host/openwop-app/kb/orgs/${orgId}/collections/${collectionId}/documents`, {
    title: 'PTO Policy',
    text: 'Employees accrue 15 days of paid time off per year. Unused PTO rolls over up to 5 days into the next calendar year.',
  });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);

  return { tenantId, orgId, collectionId };
}

/* ─── The walk: REAL scheduler primitives ──────────────────────── */

interface WalkResult {
  /** shortId → the port-map the REAL `buildNodeInputs` produced for that node. */
  inputsByShortId: Record<string, Record<string, unknown>>;
  /** shortId → what the node actually received as `ctx.inputs` (post-unwrap/merge). */
  ctxInputsByShortId: Record<string, unknown>;
  /** shortId → terminal scheduler state. */
  stateByShortId: Record<string, NodeState>;
  outputsByShortId: Record<string, Record<string, unknown>>;
}

function shortIdOf(nodeId: string): string {
  const i = nodeId.lastIndexOf('_');
  return i === -1 ? nodeId : nodeId.slice(i + 1);
}

/**
 * Drive an expanded chain definition with the REAL `buildGraph` /
 * `freshSnapshot` / `evaluateTrigger` / `buildNodeInputs`. Only two things are
 * reproduced rather than imported, both quoted from `executor/executor.ts`:
 * the single-`input` back-compat unwrap and the `node.inputs`-wins merge. Host
 * primitives (`callAI`, `suspend`, `chat.emitCard`, `slack.postMessage`) come
 * from the caller; feature surfaces are the REAL ones.
 */
async function walk(
  def: WorkflowDefinition,
  runInputs: Record<string, unknown>,
  hostCtx: (node: WorkflowDefinition['nodes'][number]) => NodeCtx,
): Promise<WalkResult> {
  const graph = buildGraph(def);
  const snapshot: SchedulerSnapshot = freshSnapshot(def);
  const byId = new Map(def.nodes.map((nd) => [nd.nodeId, nd]));
  const out: WalkResult = { inputsByShortId: {}, ctxInputsByShortId: {}, stateByShortId: {}, outputsByShortId: {} };

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const nodeId of snapshot.order) {
      const state = snapshot.nodeState.get(nodeId);
      if (state !== 'pending' && state !== 'ready') continue;
      const verdict = evaluateTrigger(nodeId, graph, snapshot);
      if (verdict === 'wait') continue;
      progressed = true;
      if (verdict === 'skip') {
        snapshot.nodeState.set(nodeId, 'skipped');
        continue;
      }
      const node = byId.get(nodeId)!;
      const inputsByPort = buildNodeInputs(nodeId, graph, snapshot, runInputs);
      // executor.ts — the back-compat unwrap, verbatim in shape.
      const baseInputs: unknown =
        Object.keys(inputsByPort).length === 1 && 'input' in inputsByPort
          ? inputsByPort.input
          : inputsByPort;
      // executor.ts — `node.inputs` (already frozen by expandChain) wins on conflict.
      const fixture = (node.inputs ?? {}) as Record<string, unknown>;
      const ctxInputs: unknown = Object.keys(fixture).length === 0
        ? baseInputs
        : baseInputs && typeof baseInputs === 'object' && !Array.isArray(baseInputs)
          ? { ...(baseInputs as Record<string, unknown>), ...fixture }
          : fixture;

      const impl = impls[node.typeId];
      expect(impl, `no real implementation loaded for ${node.typeId}`).toBeTruthy();
      const res = await impl!({ ...hostCtx(node), nodeId, config: node.config ?? {}, inputs: ctxInputs });
      const short = shortIdOf(nodeId);
      out.inputsByShortId[short] = inputsByPort;
      out.ctxInputsByShortId[short] = ctxInputs;
      out.outputsByShortId[short] = res.outputs;
      snapshot.nodeOutputs.set(nodeId, res.outputs);
      snapshot.nodeState.set(nodeId, res.status === 'success' ? 'completed' : 'failed');
    }
  }
  for (const nodeId of snapshot.order) out.stateByShortId[shortIdOf(nodeId)] = snapshot.nodeState.get(nodeId)!;
  return out;
}

/* ─── knowledge.policy-qa ──────────────────────────────────────── */

describe('knowledge.policy-qa — the chain DELIVERS, it does not merely complete', () => {
  it('a covered question: the answer text reaches the notify node AND the durable notification body', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.policy-qa');
    expect(found, 'knowledge.policy-qa chain must be loaded at boot').toBeTruthy();

    const params = { query: 'How much PTO do I get per year?', orgId, collectionId, escalationChannel: '#people-ops' };
    const def = expandChain(found!.chain, { params });

    // WF-KB-15 — the primary output is the HAPPY-PATH terminal, by NAME.
    const primaries = def.nodes.filter((nd) => nd.outputRole === 'primary');
    expect(primaries).toHaveLength(1);
    expect(shortIdOf(primaries[0]!.nodeId)).toBe('deliver');

    const runId = `run:kb-covered-${n++}`;
    const features = buildFeatureSurfaces({ tenantId, runId });
    const answerContent = 'You accrue 15 days of PTO per year [PTO Policy §1]. COVERED: yes';
    const slackCalls: Array<Record<string, unknown>> = [];

    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features,
      callAI: async () => ({ content: answerContent }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'm1' }; } },
    }));

    // The RAG node really retrieved the really-seeded document.
    expect((result.outputsByShortId.retrieve!.augmentedPrompt as string)).toContain('15 days of paid time off');
    // WF-KB-17 — the AI node got a NAMED `prompt` port, not the whole envelope.
    expect(Object.keys(result.inputsByShortId.answer!)).toEqual(['prompt']);
    expect(result.inputsByShortId.answer!.prompt).toBe(result.outputsByShortId.retrieve!.augmentedPrompt);

    expect(result.outputsByShortId.route!.branch).toBe('then');

    // ── WF-KB-5, the assertion that fails against the pre-fix pack ──
    // The port-map the REAL `buildNodeInputs` produced for `deliver` carries
    // `message`. Pre-fix it carried a single `input` key holding the whole
    // route output map, and `message` was `undefined`.
    expect(result.inputsByShortId.deliver).toHaveProperty('message', answerContent);
    expect(result.ctxInputsByShortId.deliver).toMatchObject({
      title: 'HR & Policy Q&A Agent',
      message: answerContent,
    });
    expect(result.outputsByShortId.deliver).toMatchObject({ emitted: true });

    // And the DURABLE row — delivery, not merely a green node. Pre-fix this
    // row existed with `message: ''` (surface.ts `asText(undefined) → ''`).
    const rows = await storage.listNotifications({ tenantId, limit: 20 });
    const row = rows.find((x) => x.title === 'HR & Policy Q&A Agent');
    expect(row, 'the notify node must have written a durable inbox row').toBeTruthy();
    expect(row!.message).toBe(answerContent);

    // The escalation branch did not run, and nothing was posted to Slack.
    expect(result.stateByShortId.approveEscalation).toBe('skipped');
    expect(result.stateByShortId.escalate).toBe('skipped');
    expect(slackCalls).toHaveLength(0);
  });

  it('an uncovered question, APPROVED: the approver SEES the answer and the Slack escalation CARRIES it — off the GATE', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.policy-qa');
    const params = { query: 'What is the parental leave policy in Germany?', orgId, collectionId, escalationChannel: '#people-ops' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-uncovered-${n++}`;
    const features = buildFeatureSurfaces({ tenantId, runId });
    const answerContent = 'The retrieved policies do not address parental leave. COVERED: no';
    const cards: Array<Record<string, unknown>> = [];
    const slackCalls: Array<Record<string, unknown>> = [];

    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features,
      callAI: async () => ({ content: answerContent }),
      chat: { emitCard: async (c: Record<string, unknown>) => { cards.push(c); } },
      // The REAL UI resume payload — `{action}`, what `ApprovalCard.tsx` /
      // `defaultCards.tsx` / `routes/reviews.ts` all send (ADR 0582 §9).
      suspend: async () => ({ action: 'approve', decidedBy: 'user:hr', decidedAt: '2026-08-18T00:00:00.000Z' }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'm2' }; } },
    }));

    expect(result.outputsByShortId.route!.branch).toBe('else');
    expect(result.stateByShortId.deliver).toBe('skipped');
    expect(result.outputsByShortId.approveEscalation).toMatchObject({ decision: 'accept', approved: true });

    // ── WF-KB-5, the approval card ──
    // The gate reads `inputs.artifact`. Pre-fix that was `undefined` and the
    // human approved a BLANK card.
    expect(result.inputsByShortId.approveEscalation).toHaveProperty('artifact', answerContent);
    expect(cards).toHaveLength(1);
    expect((cards[0]!.payload as Record<string, unknown>).artifact).toBe(answerContent);
    expect((cards[0]!.payload as Record<string, unknown>).title)
      .toBe('Approve escalating this uncovered policy question');

    // ── WF-KB-5, the Slack send ──
    // `slack-message` reads `inputs.text`; its declared `required:["text"]` is
    // unenforced, so pre-fix it posted `text: undefined` and reported success.
    // The value now comes off the GATE (`approveEscalation.artifact`), not off
    // `route.value` — same content on an approval, nothing at all on anything
    // else. `escalate` has exactly ONE incoming edge, and it is conditioned.
    expect(Object.keys(result.inputsByShortId.escalate!)).toEqual(['text']);
    expect(result.inputsByShortId.escalate).toHaveProperty('text', answerContent);
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]).toMatchObject({ channel: '#people-ops', text: answerContent });
  });

  it('an uncovered question, REJECTED: `escalate` is SKIPPED and nothing reaches Slack', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.policy-qa');
    const params = { query: 'What is the parental leave policy in Germany?', orgId, collectionId, escalationChannel: '#people-ops' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-uncovered-reject-${n++}`;
    const features = buildFeatureSurfaces({ tenantId, runId });
    const answerContent = 'The retrieved policies do not address parental leave. COVERED: no';
    const cards: Array<Record<string, unknown>> = [];
    const slackCalls: Array<Record<string, unknown>> = [];

    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features,
      callAI: async () => ({ content: answerContent }),
      chat: { emitCard: async (c: Record<string, unknown>) => { cards.push(c); } },
      // The REAL Reject click. NOT `{approved:false}` — no shipped producer
      // sends that, and reading it would let a test pass on a payload the
      // product never emits.
      suspend: async () => ({ action: 'reject', decidedBy: 'user:hr', decidedAt: '2026-08-18T00:00:00.000Z' }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'never' }; } },
    }));

    // The gate RAN and the reviewer really saw the answer…
    expect(result.stateByShortId.approveEscalation).toBe('completed');
    expect(result.outputsByShortId.approveEscalation).toMatchObject({ decision: 'reject', approved: false });
    expect((cards[0]!.payload as Record<string, unknown>).artifact).toBe(answerContent);

    // …and the gate returns `status:'success'` on a reject, so `escalate` would
    // fire on `all_success` if it had ANY unconditional incoming edge. It has
    // none: its sole upstream folds to `skipped` on the false condition.
    //
    // EGRESS FIRST, deliberately. Under the sabotage probe (the pre-correction
    // wiring restored) the node-state assertion fires first and masks whether
    // the egress assertion discriminates at all. Ordering it first proves the
    // property that actually matters — nothing left the org — on its own.
    expect(slackCalls, 'a rejected escalation must post NOTHING to #people-ops').toHaveLength(0);
    expect(result.stateByShortId.escalate).toBe('skipped');
    expect(result.outputsByShortId.escalate).toBeUndefined();

    // And the answer did not escape down the covered-path leg either.
    expect(result.stateByShortId.deliver).toBe('skipped');
    const rows = await storage.listNotifications({ tenantId, limit: 20 });
    expect(rows.filter((x) => x.title === 'HR & Policy Q&A Agent')).toHaveLength(0);
  });

  it('an uncovered question the reviewer sends back for changes: still no egress', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.policy-qa');
    const params = { query: 'What is the sabbatical policy?', orgId, collectionId, escalationChannel: '#people-ops' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-uncovered-refine-${n++}`;
    const slackCalls: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: 'Sabbaticals are not covered by the retrieved policies. COVERED: no' }),
      chat: { emitCard: async () => {} },
      variables: new Map<string, unknown>(),
      // `request-changes` is the card's third button. It maps to `refine`, which
      // is non-approving — one of the FIVE outcomes the pre-correction wiring
      // leaked on (reject, timeout, refine, ask, and the unmapped defer/escalate
      // verbs, which also fall through to `refine`).
      suspend: async () => ({ action: 'request-changes', feedback: 'add the German statutory minimum' }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'never' }; } },
    }));

    expect(result.outputsByShortId.approveEscalation).toMatchObject({ decision: 'refine', approved: false });
    expect(result.stateByShortId.escalate).toBe('skipped');
    expect(slackCalls).toHaveLength(0);
  });
});

/* ─── knowledge.compliance-review ──────────────────────────────── */

describe('knowledge.compliance-review — the review text reaches every leg', () => {
  it('a clean document notifies WITH the review body, and does not escalate', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.compliance-review');
    expect(found).toBeTruthy();
    const params = {
      documentText: 'We offer 15 days of PTO.',
      query: 'paid time off policy',
      orgId,
      collectionId,
      escalationChannel: '#compliance',
    };
    const def = expandChain(found!.chain, { params });

    const primaries = def.nodes.filter((nd) => nd.outputRole === 'primary');
    expect(primaries).toHaveLength(1);
    expect(shortIdOf(primaries[0]!.nodeId)).toBe('pass');

    const runId = `run:kb-clean-${n++}`;
    const reviewContent = 'The document matches the PTO policy §1. FLAGS: 0';
    const slackCalls: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: reviewContent }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'm3' }; } },
    }));

    expect(result.outputsByShortId.route!.branch).toBe('then');
    expect(result.inputsByShortId.pass).toHaveProperty('message', reviewContent);
    const rows = await storage.listNotifications({ tenantId, limit: 20 });
    const row = rows.find((x) => x.title === 'Compliance Review vs Your Policies');
    expect(row).toBeTruthy();
    expect(row!.message).toBe(reviewContent);
    expect(slackCalls).toHaveLength(0);
    expect(result.stateByShortId.escalate).toBe('skipped');
  });

  it('a flagged document shows the reviewer the deviation list and escalates it verbatim', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.compliance-review');
    const params = {
      documentText: 'We guarantee 100% uptime, forever.',
      query: 'uptime and availability commitments',
      orgId,
      collectionId,
      escalationChannel: '#compliance',
    };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-flagged-${n++}`;
    const reviewContent = 'Deviation: "100% uptime" conflicts with the SLA policy §4 (99.9%). Risk: contractual. FLAGS: 1';
    const cards: Array<Record<string, unknown>> = [];
    const slackCalls: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: reviewContent }),
      chat: { emitCard: async (c: Record<string, unknown>) => { cards.push(c); } },
      suspend: async () => ({ action: 'approve', decidedAt: '2026-08-18T00:00:00.000Z' }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'm4' }; } },
    }));

    expect(result.outputsByShortId.route!.branch).toBe('else');
    expect(result.stateByShortId.pass).toBe('skipped');
    expect((cards[0]!.payload as Record<string, unknown>).artifact).toBe(reviewContent);
    expect(Object.keys(result.inputsByShortId.escalate!)).toEqual(['text']);
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]).toMatchObject({ channel: '#compliance', text: reviewContent });
  });

  it('a flagged document the reviewer REJECTS: the deviation list never reaches #compliance', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.compliance-review');
    const params = {
      documentText: 'We guarantee 100% uptime, forever.',
      query: 'uptime and availability commitments',
      orgId,
      collectionId,
      escalationChannel: '#compliance',
    };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-flagged-reject-${n++}`;
    const reviewContent = 'Deviation: "100% uptime" conflicts with the SLA policy §4 (99.9%). Risk: contractual. FLAGS: 1';
    const cards: Array<Record<string, unknown>> = [];
    const slackCalls: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: reviewContent }),
      chat: { emitCard: async (c: Record<string, unknown>) => { cards.push(c); } },
      suspend: async () => ({ action: 'reject', decidedAt: '2026-08-18T00:00:00.000Z' }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'never' }; } },
    }));

    expect(result.stateByShortId.approveEscalation).toBe('completed');
    expect(result.outputsByShortId.approveEscalation).toMatchObject({ decision: 'reject', approved: false });
    expect((cards[0]!.payload as Record<string, unknown>).artifact).toBe(reviewContent);
    expect(result.stateByShortId.escalate).toBe('skipped');
    expect(slackCalls, 'a rejected compliance review must post NOTHING').toHaveLength(0);
    expect(result.stateByShortId.pass).toBe('skipped');
  });

  it('a flagged document whose gate TIMES OUT: no egress, and no `artifact` to leak', async () => {
    const { tenantId, orgId, collectionId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.compliance-review');
    const params = {
      documentText: 'We guarantee 100% uptime, forever.',
      query: 'uptime and availability commitments',
      orgId,
      collectionId,
      escalationChannel: '#compliance',
    };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-flagged-timeout-${n++}`;
    const slackCalls: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: 'Deviation: … FLAGS: 2' }),
      chat: { emitCard: async () => {} },
      // `index.mjs:302-311` — the timeout return is a `status:'success'` with
      // `approved:false` and NO `artifact` at all. Pre-correction this was the
      // second leaking path: the sibling content edge did not care.
      suspend: async () => ({ timedOut: true }),
      slack: { postMessage: async (a: Record<string, unknown>) => { slackCalls.push(a); return { sent: true, messageId: 'never' }; } },
    }));

    expect(result.outputsByShortId.approveEscalation).toMatchObject({ decision: 'timeout', approved: false, timedOut: true });
    expect(result.outputsByShortId.approveEscalation).not.toHaveProperty('artifact');
    expect(result.stateByShortId.escalate).toBe('skipped');
    expect(slackCalls).toHaveLength(0);
  });
});

/* ─── knowledge.doc-summarizer ─────────────────────────────────── */

describe('knowledge.doc-summarizer — the summary IS the notification body', () => {
  it('delivers the summary text, not an empty-bodied titled row', async () => {
    const { tenantId } = await ownerOrgWithPolicyDoc();
    const found = getChain('knowledge.doc-summarizer');
    expect(found).toBeTruthy();
    const params = { documentText: 'Q3 plan: ship the connector suite by October.' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:kb-summary-${n++}`;
    const summary = 'Purpose: Q3 delivery plan · Key points: connector suite by October · Decisions: none · Open questions: staffing';
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: summary }),
    }));

    // This chain has ONE outbound leg and no gate: pre-fix, its ENTIRE product
    // was lost while the run reported success.
    expect(result.inputsByShortId.notify).toHaveProperty('message', summary);
    expect(result.outputsByShortId.notify).toMatchObject({ emitted: true });
    const rows = await storage.listNotifications({ tenantId, limit: 20 });
    const row = rows.find((x) => x.title === 'Document Summarizer');
    expect(row, 'the summary must exist as a durable inbox row').toBeTruthy();
    expect(row!.message).toBe(summary);
  });
});
