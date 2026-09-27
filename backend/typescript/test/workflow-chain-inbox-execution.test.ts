/**
 * inbox workflow-chain pack — REAL execution (ADR 0190 Phase 2, ADR 0643 D4,
 * RFC 0013).
 *
 * ── Why this file was rewritten ─────────────────────────────────────────────
 *
 * The previous harness reproduced, one for one, the three vacuity sins
 * `workflow-chain-knowledge-execution.test.ts` catalogues in its own docblock —
 * which is how `inbox.triage` and `inbox.call-debrief` kept the WF-KB-5 defect
 * for four months AFTER the knowledge half was fixed:
 *
 *   1. It drove `core.openwop.integration.notification-push` (`:201`) where BOTH
 *      chains declare `feature.notifications.nodes.notify`. Different pack,
 *      different node, different input contract — the notify pack's own docblock
 *      says it REPLACES notification-push for chains precisely because
 *      notification-push requires a per-recipient `deviceToken` no chain author
 *      can know.
 *   2. It HAND-AUTHORED the delivery node's inputs (`{ route: routed.outputs }`,
 *      `:202`) and hand-replicated the edge-port semantics (`:19-20`). So
 *      `buildNodeInputs` — the ONE function that decides whether `inputs.message`
 *      is bound at all, i.e. the function that held the bug — was never called.
 *   3. It asserted the FAILURE as the expected result (`:207`):
 *      `expect(notifyOut.outputs).toMatchObject({sent:false, error:'notification_not_connected'})`.
 *      A non-delivery pinned as the contract. Nothing in the file could tell
 *      "delivered the triage note" from "delivered nothing".
 *
 * This file now walks each chain through the REAL scheduler primitives —
 * `buildGraph`, `freshSnapshot`, `evaluateTrigger` and, above all,
 * `buildNodeInputs` are IMPORTED from `src/executor/scheduler.ts`, never
 * reproduced — drives the REAL shipped node implementations, and asserts
 * DELIVERY AS DELIVERY: a non-empty body on the durable notification row that a
 * human would actually read.
 *
 * ── The root fix: `inbox.triage` could not be fixed with one edge ────────────
 *
 * (ADR 0643 D4 / review #7.) `inbox.triage`'s single `notify` was fed by two
 * MUTUALLY EXCLUSIVE conditional edges — `route → notify.route` on the else
 * branch, `toDrafts → notify.toDrafts` on the then branch — and NEITHER named
 * `.message`, which is the only content port `feature.notifications.nodes.notify`
 * reads (`packs/feature.notifications.nodes/index.mjs:43`). The widened
 * structural gate (`workflow-chain-knowledge-inbox.test.ts`, now over
 * `PHASE2_CHAINS`) passes as soon as ANY edge targets `.message`. So the
 * one-line "fix" — rename ONE of those two edges to `.message` — turns the gate
 * GREEN while the OTHER branch still delivers an empty body. That is the defect
 * surviving its own fix, invisible to the very gate being widened.
 *
 * The chain is therefore SPLIT into two branch-owned notify nodes:
 *
 *   route.value  → notifyTriaged.message   {branch === "else"}
 *   draft.content → notifyDrafted.message              (draft only runs on "then")
 *
 * Chosen over the alternative (one notify with an authored always-non-empty
 * `inputs.message` literal) for four reasons:
 *
 *   a. The authored-literal option cannot carry per-branch content AT ALL on this
 *      host. `executor.ts` merges `{...edgeInputs, ...node.inputs}` — the authored
 *      fixture WINS — so an authored `inputs.message` would statically override
 *      every edge-supplied body. "Always non-empty" would be bought by making the
 *      message always the SAME constant, i.e. by deleting the product.
 *   b. Each notify now has exactly ONE inbound edge, so the multi-fan-in port
 *      collision this file's previous docblock catalogued cannot recur here even
 *      if a future author drops an edge condition.
 *   c. It makes the WIDENED STRUCTURAL GATE cover both branches OF THESE TWO
 *      NODES. With one notify the gate is satisfied by a single `.message`
 *      edge and is blind to the other branch forever; with two, each node must
 *      carry its own binding.
 *
 *      That is a property of THIS SHAPE, not of the gate — an earlier draft of
 *      this docblock said the hole "cannot reopen on either branch" full stop,
 *      which overclaims. The gate
 *      (`workflow-chain-knowledge-inbox.test.ts`, `bound || authored`) is still
 *      satisfiable two ways it should not be: (i) `authored.includes(port)`
 *      accepts the very authored-literal shape reason (a) above rejects as
 *      "deleting the product", and (ii) `bound` is a `.some()` over in-edges,
 *      so a FUTURE fan-in notify with one bound edge of two passes while the
 *      other branch ships empty — the exact defect this ADR closed, re-openable
 *      one refactor from here. Mechanically closing it means requiring `bound`
 *      PER CONDITIONAL IN-EDGE GROUP rather than once per node, and rejecting
 *      the `authored` disjunct unless the node has zero in-edges. Deferred
 *      scope; recorded so the next reader does not mistake these two nodes'
 *      safety for the gate's. The gate also cannot see whether a bound value is
 *      NON-EMPTY at run time — that is what the legs below are for.
 *   d. The two outcomes are genuinely different products ("nothing needed from
 *      you" vs "a reply is drafted, review it") and get their own node `name`
 *      in the builder. They deliberately share one `title`: the corpus
 *      invariant in `chain-node-undeclared-keys.test.ts` requires every notify
 *      node's `inputs.title` to equal its own chain's `label`. The witness
 *      therefore discriminates the branches on the BODY plus an exact row
 *      count, which is the stronger assertion anyway.
 *
 * `inbox.call-debrief` needed only the single named edge the ADR predicted:
 * `debrief` → `notify` was BARE (so `buildNodeInputs` landed the whole
 * chatCompletion output map on the default `input` port and `inputs.message` was
 * `undefined`), and is now `debrief.content → notify.message` —
 * `core.ai.chatCompletion` declares `content` as a real output port
 * (`packs/core.openwop.ai/index.mjs:145`), so the port is not invented.
 *
 * ── What the legs below actually prove ──────────────────────────────────────
 *
 * `inbox.triage` gets BOTH branches, each asserting a NON-EMPTY delivered body
 * on the durable row, because the structural gate provably cannot distinguish
 * them (see above). `inbox.call-debrief` and `inbox.followup-nudger` had NO
 * execution witness at all before this file; both are covered now, the nudger on
 * both its approve and its reject legs (its `send` takes its content BACK OFF
 * THE GATE, the ADR 0582 §10 shape, so a reject must egress nothing).
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
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
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

/** REAL node implementations, loaded from the shipped packs / the host registry. */
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
  ensureNodesRegistered();

  const flow = (await import('../../../packs/core.openwop.flow/index.mjs')) as { ifNode: PackNode; noopNode: PackNode };
  // @ts-expect-error — feature.notifications.nodes ships no declaration file (untyped .mjs)
  const notif = (await import('../../../packs/feature.notifications.nodes/index.mjs')) as { notify: PackNode };
  // @ts-expect-error — core.openwop.integration ships no declaration file (untyped .mjs)
  const integ = (await import('../../../packs/core.openwop.integration/index.mjs')) as { emailSend: PackNode };
  // @ts-expect-error — vendor.myndhyve.chat ships no declaration file (untyped .mjs)
  const chat = (await import('../../../packs/vendor.myndhyve.chat/index.mjs')) as { approvalGate: PackNode };
  const ai = (await import('../../../packs/core.openwop.ai/index.mjs')) as { chatCompletion: PackNode };

  impls['core.flow.if'] = flow.ifNode;
  impls['core.flow.noop'] = flow.noopNode;
  impls['core.ai.chatCompletion'] = ai.chatCompletion;
  impls['feature.notifications.nodes.notify'] = notif.notify;
  impls['core.openwop.integration.email-send'] = integ.emailSend;
  impls['core.chat.approvalGate'] = chat.approvalGate;
  // `core.email.draft` is a HOST-registered node (`bootstrap/nodes.ts`), not a
  // pack module — driven through the same registry the executor uses, so the
  // config/inputs contract under test is the shipped one.
  impls['core.email.draft'] = async (ctx) => {
    const r = await getNodeRegistry().get('core.email.draft')!.execute(ctx as never);
    const rec = r as { status: string; outputs?: Record<string, unknown>; error?: unknown };
    return { status: rec.status, outputs: rec.outputs ?? {}, error: rec.error };
  };
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
async function ownerTenant(): Promise<string> {
  const tenantId = `org:inboxchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `inboxchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return tenantId;
}

/* ─── The walk: REAL scheduler primitives ──────────────────────── */

interface WalkResult {
  /** shortId → the port-map the REAL `buildNodeInputs` produced for that node. */
  inputsByShortId: Record<string, Record<string, unknown>>;
  /** shortId → what the node actually received as `ctx.inputs` (post-unwrap/merge). */
  ctxInputsByShortId: Record<string, unknown>;
  stateByShortId: Record<string, NodeState>;
  outputsByShortId: Record<string, Record<string, unknown>>;
}

function shortIdOf(nodeId: string): string {
  const i = nodeId.lastIndexOf('_');
  return i === -1 ? nodeId : nodeId.slice(i + 1);
}

/**
 * Drive an expanded chain definition with the REAL `buildGraph` /
 * `freshSnapshot` / `evaluateTrigger` / `buildNodeInputs` (the
 * `workflow-chain-knowledge-execution.test.ts` pattern — the marketing/finance
 * `walkChain` harnesses re-implement these by hand, which is precisely how a
 * port-mapping bug stays invisible). Only two things are reproduced rather than
 * imported, both quoted from `executor/executor.ts`: the single-`input`
 * back-compat unwrap and the `node.inputs`-wins merge.
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

/**
 * The delivery assertion, stated once: EXACTLY ONE durable row with that title,
 * carrying the body a human would actually read.
 *
 * Discriminating on the BODY, not on the title, is forced and is also the
 * stronger check. `chain-node-undeclared-keys.test.ts` enforces a corpus
 * invariant that every `feature.notifications.nodes.notify` node's
 * `inputs.title` equals its OWN chain's `label` (six chains once shipped a
 * neighbour's title — "a wrong title is the one part of this that a user
 * actually reads"), so `inbox.triage`'s two branch-owned notifies MUST share
 * one title. The exact-count leg is what makes the branches discriminable
 * anyway: if both notifies fired, or the wrong one did, either the count or the
 * body is wrong.
 */
async function assertDeliveredOnce(tenantId: string, title: string, message: string): Promise<void> {
  const rows = await storage.listNotifications({ tenantId, limit: 20 });
  const matching = rows.filter((x) => x.title === title);
  expect(matching, `expected EXACTLY ONE durable row titled "${title}" — got ${matching.length}`).toHaveLength(1);
  // Pre-fix this row EXISTED with `message: ''` (`notifications/surface.ts`
  // `asText(undefined) → ''`), and the node still reported `emitted:true`.
  expect(matching[0]!.message, `the row titled "${title}" was delivered with an EMPTY body`).not.toBe('');
  expect(matching[0]!.message).toBe(message);
}

/** A connectors stub that accepts the Graph/Gmail draft POST and records it. */
function draftConnector(): { calls: Array<Record<string, unknown>>; connectors: { invoke: (ref: string, req: Record<string, unknown>) => Promise<unknown> } } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    connectors: {
      invoke: async (ref: string, req: Record<string, unknown>) => {
        calls.push({ ref, ...req });
        return { ok: true, status: 201, data: { id: 'draft-1', webLink: 'https://outlook.test/drafts/draft-1' } };
      },
    },
  };
}

/* ─── inbox.triage — BOTH branches deliver ─────────────────────── */

/** Both branch-owned notifies carry the chain's own label — see `assertDeliveredOnce`. */
const TRIAGE_TITLE = 'Personal Inbox Triage';

describe('inbox.triage — a non-empty triage note on BOTH branches', () => {
  it('the primary output is the reply-drafted terminal, by NAME', () => {
    const found = getChain('inbox.triage');
    expect(found, 'inbox.triage must be loaded at boot').toBeTruthy();
    const def = expandChain(found!.chain, { params: { emailText: 'x', replyToAddress: 'a@b.test' } });
    const primaries = def.nodes.filter((nd) => nd.outputRole === 'primary');
    expect(primaries).toHaveLength(1);
    // `expandChain` stamps `primary` on the LAST TERMINAL IN DECLARATION ORDER
    // (`workflowChainPackLoader.ts:1165`), so a node reorder moves it silently.
    // Pinned by NAME here and in `workflow-chain-knowledge-inbox.test.ts`.
    expect(shortIdOf(primaries[0]!.nodeId)).toBe('notifyDrafted');
  });

  it('"REPLY: no" → the ELSE branch delivers the classification as the note body', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.triage');
    const params = { emailText: 'Weekly newsletter: 10 gardening tips', replyToAddress: 'me@acme.test', replySubject: 'Re: hi' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-else-${n++}`;
    const classification = 'Classification: newsletter. Not personal correspondence, no action needed. REPLY: no';
    const { calls, connectors } = draftConnector();

    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: classification }),
      connectors,
    }));

    expect(result.outputsByShortId.route!.branch).toBe('else');

    // ── The WF-KB-5 assertion, against the REAL `buildNodeInputs` ──
    // Pre-fix this port-map held a single `route` key carrying the whole `if`
    // output object, and `inputs.message` was `undefined`.
    expect(Object.keys(result.inputsByShortId.notifyTriaged!)).toEqual(['message']);
    expect(result.inputsByShortId.notifyTriaged).toHaveProperty('message', classification);
    expect(result.ctxInputsByShortId.notifyTriaged).toMatchObject({ title: TRIAGE_TITLE, message: classification });
    expect(result.outputsByShortId.notifyTriaged).toMatchObject({ emitted: true });

    // Delivery AS DELIVERY — the ONE durable row a human reads, carrying the
    // classification. Exactly one: the reply-lane notify must not also fire.
    await assertDeliveredOnce(tenantId, TRIAGE_TITLE, classification);

    // The reply lane did not run at all, and its note was NOT delivered.
    expect(result.stateByShortId.draft).toBe('skipped');
    expect(result.stateByShortId.toDrafts).toBe('skipped');
    expect(result.stateByShortId.notifyDrafted).toBe('skipped');
    expect(calls, 'no email draft may be created for an email needing no reply').toHaveLength(0);
  });

  it('"REPLY: yes" → the THEN branch delivers the drafted reply as the note body, and really drafts it', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.triage');
    const params = {
      emailText: "Can we move Friday's meeting to 3pm?",
      replyToAddress: 'sender@acme.test',
      replySubject: 'Re: Friday meeting',
    };
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-then-${n++}`;
    const classification = 'Classification: needs-reply. Must confirm the new time. REPLY: yes';
    const replyText = 'Yes, 3pm Friday works on my end — see you then!';
    const { calls, connectors } = draftConnector();

    let aiTurn = 0;
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      // classify first, then the reply composition — the chain's two AI nodes.
      callAI: async () => ({ content: aiTurn++ === 0 ? classification : replyText }),
      connectors,
    }));

    expect(result.outputsByShortId.route!.branch).toBe('then');
    expect(result.stateByShortId.notifyTriaged).toBe('skipped');

    // ── The other half of WF-KB-5: the branch a single `.message` binding would
    // have left empty while the widened structural gate went green. ──
    // TWO in-ports: the content binding plus the `toDrafts → …savedTo`
    // ORDERING edge that makes `all_success` require a real mailbox save
    // before the "reply drafted" note can fire. `savedTo` is not a port
    // `notify` reads — it exists to gate the trigger, and the leg below
    // ('a mailbox that refuses the draft…') is what proves it gates.
    expect(Object.keys(result.inputsByShortId.notifyDrafted!).sort()).toEqual(['message', 'savedTo']);
    expect(result.inputsByShortId.notifyDrafted).toHaveProperty('message', replyText);
    expect(result.inputsByShortId.notifyDrafted!.savedTo).toMatchObject({ drafted: true });
    expect(result.outputsByShortId.notifyDrafted).toMatchObject({ emitted: true });
    // Exactly one row, and its body is the DRAFTED REPLY — not the
    // classification the else-branch notify would have delivered.
    await assertDeliveredOnce(tenantId, TRIAGE_TITLE, replyText);

    // …and the mailbox draft really carried the composed body and the params'
    // recipient/subject (the `{{params.*}}` freeze `expandChain` performs).
    expect(result.stateByShortId.toDrafts).toBe('completed');
    expect(result.inputsByShortId.toDrafts).toHaveProperty('body', replyText);
    expect(result.outputsByShortId.toDrafts).toMatchObject({
      drafted: true,
      to: ['sender@acme.test'],
      subject: 'Re: Friday meeting',
      body: replyText,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]!.body)).toContain('3pm Friday works');
  });

  it('a mailbox that refuses the draft does NOT fabricate a "reply drafted" note', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.triage');
    const params = { emailText: 'Can we move Friday to 3pm?', replyToAddress: 'sender@acme.test', replySubject: 'Re: Friday' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-nodraft-${n++}`;
    let aiTurn = 0;
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: aiTurn++ === 0 ? 'needs a reply. REPLY: yes' : 'Sure — 3pm works.' }),
      // No Outlook/Gmail Connection in this tenant: `core.email.draft` fails
      // CLOSED (`connector_no_connection`). Reported honestly as a FAILURE —
      // the previous version of this file asserted that failure as the expected
      // result of the whole chain.
      connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) },
    }));

    expect(result.stateByShortId.toDrafts).toBe('failed');

    // The note is named "Triage note (reply drafted)" and the chain's own
    // `outputs.triage` promised "a drafted reply in your mail drafts". Neither
    // is true when the mailbox refused the save, so the note MUST NOT fire.
    //
    // The guarantee is structural, not a string: `notifyDrafted` takes a second
    // in-edge from `toDrafts` (`→ notifyDrafted.savedTo`), so under
    // `all_success` a FAILED upstream makes `evaluateTrigger` return `skip`
    // (`scheduler.ts:318`). The `.message` binding is untouched, so the widened
    // structural gate is unaffected, and `savedTo` is not a port `notify` reads
    // — it is an ordering edge, nothing more.
    //
    // THIS IS THE ASSERTION THIS TEST WAS NAMED FOR. It previously asserted the
    // OPPOSITE of its own title (`assertDeliveredOnce`), pinning the fabricated
    // note as the contract — the same shape as the `{sent:false}` pin this file
    // was rewritten to remove.
    expect(result.stateByShortId.notifyDrafted, 'a refused mailbox save must SKIP the "reply drafted" note').toBe('skipped');
    expect(result.outputsByShortId.notifyDrafted).toBeUndefined();
    const rows = await storage.listNotifications({ tenantId, limit: 20 });
    expect(rows.filter((x) => x.title === TRIAGE_TITLE), 'no triage note may be fabricated when the draft was never saved').toHaveLength(0);
  });
});

/* ─── inbox.call-debrief ───────────────────────────────────────── */

describe('inbox.call-debrief — the debrief IS the notification body', () => {
  it('delivers the debrief text, not an empty-bodied titled row', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.call-debrief');
    expect(found, 'inbox.call-debrief must be loaded at boot').toBeTruthy();
    const params = { transcript: 'Buyer: pricing feels high. Rep: compared to what, exactly?' };
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-debrief-${n++}`;
    const debrief = 'Summary: pricing objection raised twice · Objections: cost vs value, handled with a comparison ask · Coaching: quantify ROI earlier · Next steps: send the ROI model (Rep, Fri)';
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: debrief }),
    }));

    // This chain has ONE outbound leg and no gate: pre-fix (a BARE
    // `debrief → notify` edge) its ENTIRE product was lost while the run
    // reported success.
    expect(Object.keys(result.inputsByShortId.notify!)).toEqual(['message']);
    expect(result.inputsByShortId.notify).toHaveProperty('message', debrief);
    expect(result.outputsByShortId.notify).toMatchObject({ emitted: true });
    await assertDeliveredOnce(tenantId, 'Call Debrief & Coaching Notes', debrief);
  });
});

/* ─── inbox.followup-nudger ────────────────────────────────────── */

describe('inbox.followup-nudger — the approver sees the draft, and only an approval sends', () => {
  const params = {
    threadText: 'Me (Jun 20): any thoughts on the proposal?',
    recipientEmail: 'buyer@acme.test',
    senderEmail: 'rep@acme.test',
    emailSubject: 'Following up',
  };

  it('APPROVED: the gate carries the draft and the SAME text leaves the building', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.followup-nudger');
    expect(found, 'inbox.followup-nudger must be loaded at boot').toBeTruthy();
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-nudge-approve-${n++}`;
    const followup = 'Quick nudge on the proposal — is a 15-minute call this week useful? If now is not the time, just say the word.';
    const cards: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];

    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: followup }),
      chat: { emitCard: async (c: Record<string, unknown>) => { cards.push(c); } },
      // The REAL UI resume payload — `{action}`, what `ApprovalCard.tsx` /
      // `defaultCards.tsx` / `routes/reviews.ts` all send (ADR 0582 §9).
      suspend: async () => ({ action: 'approve', decidedBy: 'user:rep', decidedAt: '2026-09-03T00:00:00.000Z' }),
      email: { send: async (m: Record<string, unknown>) => { sends.push(m); return { sent: true, messageId: 'm1' }; } },
    }));

    // The approver SAW the draft (the gate reads `inputs.artifact`).
    expect(result.inputsByShortId.approve).toHaveProperty('artifact', followup);
    expect((cards[0]!.payload as Record<string, unknown>).artifact).toBe(followup);

    // The send takes its content BACK OFF THE GATE, so an approval carries it.
    expect(result.inputsByShortId.send).toHaveProperty('text', followup);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ to: 'buyer@acme.test', from: 'rep@acme.test', subject: 'Following up', text: followup });
    expect(result.outputsByShortId.send).toMatchObject({ sent: true });
    expect(result.stateByShortId['gate-reject']).toBe('skipped');
  });

  it('REJECTED: `send` is SKIPPED and NOTHING leaves the building', async () => {
    const tenantId = await ownerTenant();
    const found = getChain('inbox.followup-nudger');
    const def = expandChain(found!.chain, { params });

    const runId = `run:inbox-nudge-reject-${n++}`;
    const sends: Array<Record<string, unknown>> = [];
    const result = await walk(def, params, () => ({
      runId,
      tenantId,
      attempt: 1,
      secrets: {},
      configurable: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      features: buildFeatureSurfaces({ tenantId, runId }),
      callAI: async () => ({ content: 'Quick nudge on the proposal.' }),
      chat: { emitCard: async () => {} },
      suspend: async () => ({ action: 'reject', decidedBy: 'user:rep', decidedAt: '2026-09-03T00:00:00.000Z' }),
      email: { send: async (m: Record<string, unknown>) => { sends.push(m); return { sent: true, messageId: 'never' }; } },
    }));

    // EGRESS FIRST, deliberately — under a sabotage probe a node-state
    // assertion ordered first masks whether the egress assertion discriminates
    // at all (the `workflow-chain-knowledge-execution.test.ts` lesson).
    expect(sends, 'a rejected follow-up must send NOTHING').toHaveLength(0);
    expect(result.stateByShortId.send).toBe('skipped');
    expect(result.outputsByShortId.approve).toMatchObject({ decision: 'reject', approved: false });
    expect(result.stateByShortId['gate-reject']).toBe('completed');
  });
});
