/**
 * ADR 0582 — "approval gates that do not gate": the GENERALIZED reject witness.
 *
 * The sibling `workflow-chain-email-reject-witness.test.ts` proves the class for
 * ONE effect type (`core.openwop.integration.email-send`) — a REJECTED review
 * mails no one. This file generalizes that same proof to the FULL effect-typeId
 * set (send / slack / notify / create-task / the connector actions / openapi-call)
 * and structures it as a SHRINK-ONLY RATCHET so the corpus can only get better.
 *
 * TWO complementary signals, both computed on the EXPANDED definition through the
 * real loader (never the pack JSON) — the SAME dual structure the email witness
 * uses (its reject leg + its WF-EM-2 structural leg), because each covers the
 * other's blind spot:
 *
 *   1. BEHAVIOURAL (`BASELINE`) — each chain is simulated FORWARD through the real
 *      `evaluateTrigger`, and every `core.chat.approvalGate` is resolved by the
 *      REAL shipped handler driven with the REAL UI reject `{action:'reject'}`.
 *      An effect node whose terminal state is `completed` ESCAPED — the effect
 *      fired on a rejection. This is the ground truth for every path the fixed
 *      reject payload actually enters.
 *   2. STRUCTURAL (`STRUCTURAL_UNGATED`) — every gate-reachable effect node with
 *      an UNCONDITIONAL inbound edge. This catches the escapes the behavioural
 *      sim cannot reach: an effect sitting behind a `core.flow.if` / guard branch
 *      whose value the fixed payload does not take (`marketing.ad-optimization`,
 *      `it-support.incident-triage`, `support.*`) is never simulated as firing,
 *      yet its unconditional edge from a gate is exactly the ADR 0582 defect.
 *      Without this leg those would be a silent blind spot.
 *
 * `core.approvalGate` — the HOST node, a different mechanism — is out of scope
 * (covered by `approval-gate-reject-blocks.test.ts`).
 *
 * The ratchet FAILS if (a) a NON-baselined effect escapes (new / regressed —
 * catches a newly-added ungated chain by EITHER signal) or (b) a baselined entry
 * no longer escapes but was not removed (forcing a shrink as each chain is
 * fixed). The proven fix (`csm-ops.renewal-risk`, `support` CSAT, `commerce`,
 * `knowledge`, `campaign-journeys`) routes the effect behind a single
 * `{truthy approved}` gate edge with a `{falsy approved}` → `core.flow.noop`
 * terminal, so a reject SKIPS the effect and the run still COMPLETES; fixing a
 * chain removes its rows from BOTH sets.
 *
 * RE-DERIVED (not hand-trusted) by running this check. At HEAD the re-derivation
 * was: BASELINE 24 behavioural + BRANCH_MASKED 6 structural-only = 30 not-yet-clean
 * (matching the scout's structural census of 30), plus 4 TRANSITIVELY_SAFE. ADR
 * 0582 Batch 1 then fixed the four CRM task-create chains, Batch 2 fixed the
 * six slack-egress chains (support.kb-answer, support.sentiment-escalation,
 * release.internal-announce, starters.webhook-to-slack, digest.team-status, and
 * it-support.incident-triage::stakeholders — leaving that chain's ::notify for a
 * later batch), and Batch 3+4 fixed the nine Tier-A external-effect escapes
 * (finance ERP post/reimburse, HR/IT provisioning ×4, data-ops upsert, marketing
 * campaign launch, ad-optimization applyReviewed — with three downstream Tier-B
 * notifies transitively cleared into TRANSITIVELY_SAFE).
 *
 * ── ADR 0582 Batch 5 (FINAL) — the sweep is COMPLETE: BASELINE 6→0, BRANCH_MASKED
 * 2→0, DEBT 8→0. ──────────────────────────────────────────────────────────────
 * The last 8 were all notify/report/schedule nodes downstream of a gate. Unlike a
 * Tier-A external effect, a notify-of-OUTCOME may LEGITIMATELY fire on BOTH legs
 * ("your request was [approved/declined]"), so each was judged (A) gate vs (B)
 * documented fire-on-both, per the ADR 0582 Batch 5 disposition:
 *   (A) GATE (approval-ONLY side effect — a reject must NOT fire it):
 *       - marketing.content-repurposing::schedule — "schedule for publishing" is the
 *         approved action; a reject must publish nothing. Now behind `{truthy
 *         approved}` with a `{falsy approved}` → core.flow.noop. Drops out entirely.
 *       - people-hr.pto-routing::notifyTeam — a team-wide Slack broadcast of the PTO;
 *         a declined request must not be broadcast (privacy + noise). Now `{truthy
 *         approved}` on its own gate edge (the classic ungated-sibling defect shape).
 *         Drops out entirely.
 *   (B) NOTIFY_OF_OUTCOME (genuine outcome notification — SHOULD fire on both legs,
 *       message made decision-aware by wiring the gate `decision` output into the
 *       notify `message` input, so a reject can never carry an approval-worded body):
 *       - approvals.request-sign-off::notify, approvals.two-stage-sign-off::notify
 *         ("the decision comes back to you as a notification" — the chain's purpose).
 *       - finance.month-end-close::report (a close-READINESS report — reports "ready"
 *         OR "not ready / approvals missing" honestly).
 *       - people-hr.offboarding::notify (the deprovision/final-pay ran upstream+ungated;
 *         this reports the compliance-attestation OUTCOME — declined must be told, too).
 *   The two BRANCH_MASKED rows were already behaviourally SKIPPED on reject (proven
 *   by probe) — their sources are gate-governed and skip with the gate — so they move
 *   to TRANSITIVELY_SAFE (not debt), no pack change:
 *       - it-support.incident-triage::notify (summary fans in from the gated
 *         `stakeholders`; on a major-reject the summary and thus the notify skip).
 *       - marketing.ad-optimization::log (fed only by `autoApply`/`applyReviewed`,
 *         both skipped on a beyond-guardrail reject).
 * Shipped state after Batch 5:
 *   - BASELINE (behavioural escapes)               :  0   ← sweep complete
 *   - + BRANCH_MASKED (structural-only escapes)    :  0   → 0 not-yet-clean total
 *   - NOTIFY_OF_OUTCOME (uncond edge, fire-on-both, decision-aware): 4
 *   - TRANSITIVELY_SAFE (uncond edge, proven skipped on reject)    : 9
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, evaluateTrigger } from '../src/executor/scheduler.js';

// The SHIPPED pack module, imported by path — the same real handler the email
// witness drives, not a re-implementation and not a host stub.
const chatPack = await import(
  /* @vite-ignore */ new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href
) as { nodes?: Record<string, unknown> };

const GATE = 'core.chat.approvalGate';

/**
 * The effect-node typeIds this ratchet governs — every node type whose
 * completion is an external/durable side effect a rejection must hold back.
 * Confirmed present in the chain corpus (grep over `examples/workflow-chain-packs/`).
 * Additional side-effectful typeIds (`update-contact-owner`, `ticket-transition`,
 * `campaign-connectors.sync`, `market-intel.voc-extraction`) are deferred to
 * later ADR 0582 batches; adding one here only GROWS the population (never hides
 * an escape), so this set is a floor, not a ceiling.
 */
const EFFECT_TYPEIDS = new Set<string>([
  'core.openwop.integration.email-send',
  'feature.campaign-channels.nodes.publish-email-sequence', // ADR 0655 D7 (EMWF-10) — a WRITE declared as one now
  'core.openwop.integration.slack-message',
  'feature.notifications.nodes.notify',
  'feature.crm.nodes.create-task',
  'core.openwop.connectors.erp-action',
  'core.openwop.connectors.hris-action',
  'core.openwop.connectors.ticket-create',
  'core.openwop.connectors.ad-budget-update',
  'core.openwop.http.openapi-call',
  // ADR 0617 D2/D3 — the host-account lifecycle nodes (`people-hr.offboarding`
  // `deprovision-host`). Added so the witness is not blind to them.
  'feature.users.nodes.deactivate',
  'feature.users.nodes.reactivate',
  // ADR 0622 D2/D3 — the org-invitation mint (`people-hr.onboarding`
  // `invite-host`, behind `approve` via ONE `{truthy approved}` edge).
  'feature.orgs.nodes.invite',
  // CSMWF-5 / ADR 0645 D3 — the CSM feature's OWN durable write node. It was
  // absent, so this ratchet — the only DERIVED gate witness in the repo — was
  // blind to it: a future gate feeding `health-set` would have been caught by
  // nothing (not here, wrong typeId set; not `csm-packs.test.ts`, hand-pinned to
  // two node ids; not the execution test, which counts CRM tasks). It writes
  // `healthScore`/`healthFactors`/`healthComputedAt` and, via `refuseToScore`,
  // `healthMeasureFailedReason`, all of which `CsmPage` renders.
  'feature.csm.nodes.health-set',
  // FRMWF-3 / ADR 0648 D1 — the forms-intake chain's ONLY effect node, which lives
  // in the priority-matrix pack (Forms composes it). Absent, this ratchet would
  // iterate the chain, find zero governed effects, and stay green if a gate were
  // ever added above `file` — the exact `WF-FORM-8` scenario, enforced by nothing.
  // The `CSMWF-5` fix above was applied for CSM and not generalized; this is the
  // next instance of the same class.
  'feature.priority-matrix.nodes.submit-idea',
]);

/** The real UI resume payloads — the exact shapes `ApprovalCard.tsx` /
 *  `routes/reviews.ts` deliver. `action` is the validated wire field. */
const REJECT = { action: 'reject', decidedBy: 'user:reviewer', comment: 'Not this one.' };
const APPROVE = { action: 'approve', decidedBy: 'user:reviewer' };

type GateHandler = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown> }>;
let approvalGate: GateHandler;

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  const handlers = chatPack.nodes as Record<string, GateHandler> | undefined;
  expect(handlers, 'vendor.myndhyve.chat must export its `nodes` handler map').toBeTruthy();
  const h = handlers![GATE];
  expect(h, `${GATE} must be a real handler, not a stub`).toBeTypeOf('function');
  approvalGate = h;
});

/** Run the REAL gate handler against a resume payload; `ctx.suspend` is the only
 *  faked seam — it stands in for the human. */
async function realGateOutputs(
  nodeId: string,
  config: Record<string, unknown>,
  resume: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const vars = new Map<string, unknown>();
  const res = await approvalGate({
    nodeId,
    runId: `run:${nodeId}`,
    config,
    inputs: { artifact: 'the drafted artifact' },
    variables: { get: (k: string) => vars.get(k), set: (k: string, v: unknown) => { vars.set(k, v); } },
    chat: { emitCard: async () => undefined },
    suspend: async () => resume,
    host: { capabilities: { chat: true } },
  });
  expect(res.status, 'the gate returns success on every verb — that IS the defect this guards').toBe('success');
  return res.outputs ?? {};
}

/** Generic success outputs for every non-gate node, so the reviewer's verdict is
 *  the only thing that can hold an effect back and the probe cannot pass by
 *  accident. The reject verdict is carried entirely by the gate. */
const HAPPY_OUTPUTS: Record<string, unknown> = {
  content: 'the drafted body',
  message: 'the drafted body',
  text: 'the drafted body',
  value: 'the drafted body',
  email: 'recipient@example.com',
  to: 'recipient@example.com',
  deals: [],
  tasks: [],
  eligible: true,
  enrolled: true,
};

/**
 * Simulate the run FORWARD through the real scheduler — sources first, each
 * node's state derived from `evaluateTrigger` — with every `core.chat.approvalGate`
 * resolved by the REAL handler against `resume`. Returns each node's terminal
 * state. No stuck-assertion: loopback/refine chains can legitimately leave a
 * node non-terminal, and for THIS ratchet a non-`completed` effect is simply not
 * a behavioural escape (conservative — it can never manufacture a false escape).
 */
async function simulate(
  chainId: string,
  resume: Record<string, unknown>,
): Promise<Map<string, string>> {
  const entry = listChains().find((c) => c.chain.chainId === chainId)!;
  const def = expandChain(entry.chain, { params: {} });
  const graph = buildGraph(def);
  const snap = freshSnapshot(def);

  for (let pass = 0; pass <= def.nodes.length + 2; pass += 1) {
    let moved = false;
    for (const n of def.nodes) {
      const state = snap.nodeState.get(n.nodeId);
      if (state !== 'pending' && state !== 'ready') continue;
      const verdict = evaluateTrigger(n.nodeId, graph, snap);
      if (verdict === 'skip') { snap.nodeState.set(n.nodeId, 'skipped'); moved = true; continue; }
      if (verdict !== 'ready') continue;
      const outputs = n.typeId === GATE
        ? await realGateOutputs(n.nodeId, (n.config ?? {}) as Record<string, unknown>, resume)
        : HAPPY_OUTPUTS;
      snap.nodeState.set(n.nodeId, 'completed');
      snap.nodeOutputs.set(n.nodeId, outputs);
      moved = true;
    }
    if (!moved) break;
  }
  return new Map([...def.nodes].map((n) => [n.nodeId, String(snap.nodeState.get(n.nodeId))]));
}

/** Node ids are pack-prefixed after expansion; recover the authored suffix. */
const bare = (id: string): string => id.slice(id.lastIndexOf('_') + 1);
const key = (chainId: string, nodeId: string): string => `${chainId}::${bare(nodeId)}`;

/** BFS the expanded edges from every gate node — the set of nodes downstream of
 *  a `core.chat.approvalGate`, ignoring conditions (structural reachability). */
function reachableFromGate(def: ReturnType<typeof expandChain>): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of def.edges ?? []) {
    (adj.get(e.sourceNodeId) ?? adj.set(e.sourceNodeId, []).get(e.sourceNodeId)!).push(e.targetNodeId);
  }
  const seen = new Set<string>();
  const queue = def.nodes.filter((n) => n.typeId === GATE).map((n) => n.nodeId);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/** Every effect node downstream of a gate, across the whole corpus — the witness
 *  population, non-empty by the anti-vacuity floor. */
function governedEffectNodes(): { chainId: string; nodeId: string }[] {
  const out: { chainId: string; nodeId: string }[] = [];
  for (const { chain } of listChains()) {
    const def = expandChain(chain, { params: {} });
    if (!def.nodes.some((n) => n.typeId === GATE)) continue;
    const reachable = reachableFromGate(def);
    for (const n of def.nodes) {
      if (EFFECT_TYPEIDS.has(n.typeId) && reachable.has(n.nodeId)) out.push({ chainId: chain.chainId, nodeId: n.nodeId });
    }
  }
  return out;
}

/** BEHAVIOURAL escapes: gate-reachable effect nodes that terminated `completed`
 *  under a REJECT, keyed `{chainId}::{authored nodeId}`. */
async function behaviouralEscapes(): Promise<string[]> {
  const byChain = new Map<string, string[]>();
  for (const { chainId, nodeId } of governedEffectNodes()) {
    (byChain.get(chainId) ?? byChain.set(chainId, []).get(chainId)!).push(nodeId);
  }
  const escapes: string[] = [];
  for (const [chainId, nodeIds] of byChain) {
    const states = await simulate(chainId, REJECT);
    for (const nodeId of nodeIds) if (states.get(nodeId) === 'completed') escapes.push(key(chainId, nodeId));
  }
  return escapes.sort();
}

/** STRUCTURAL escapes: gate-reachable effect nodes with an UNCONDITIONAL inbound
 *  edge (the ADR 0582 defect shape), keyed the same way. Superset of the
 *  behavioural set — every reject-firing effect has such an edge. */
function structuralUngated(): string[] {
  const out: string[] = [];
  for (const { chain } of listChains()) {
    const def = expandChain(chain, { params: {} });
    if (!def.nodes.some((n) => n.typeId === GATE)) continue;
    const reachable = reachableFromGate(def);
    for (const n of def.nodes) {
      if (!EFFECT_TYPEIDS.has(n.typeId) || !reachable.has(n.nodeId)) continue;
      const inbound = (def.edges ?? []).filter((e) => e.targetNodeId === n.nodeId);
      if (inbound.some((e) => !e.condition)) out.push(key(chain.chainId, n.nodeId));
    }
  }
  return out.sort();
}

/**
 * SHRINK-ONLY BASELINE — the gate-governed effect nodes that STILL fire on a
 * REJECT under the real-gate behavioural sim. RE-DERIVED by running
 * `behaviouralEscapes()` at HEAD, not copied.
 *
 * COUNT: 0 — ADR 0582 Batch 5 (FINAL) drained the last six behavioural escapes.
 * Two were GATED (A): `marketing.content-repurposing::schedule` and
 * `people-hr.pto-routing::notifyTeam` now sit behind a `{truthy approved}` edge (the
 * latter's sibling `{falsy approved}` → `core.flow.noop` already existed; the former
 * gained one), so a reject SKIPS them and they drop out of the structural set
 * entirely. Four were re-homed as genuine fire-on-both outcome notifications, made
 * decision-aware and moved to NOTIFY_OF_OUTCOME (`approvals.request-sign-off::notify`,
 * `approvals.two-stage-sign-off::notify`, `finance.month-end-close::report`,
 * `people-hr.offboarding::notify`). The BASELINE is now empty — the shrink-only
 * ratchet guarantees it can never regrow without a red.
 */
const BASELINE = new Set<string>([]);

/**
 * Structural-only escapes the behavioural sim cannot REACH.
 *
 * COUNT: 0 — ADR 0582 Batch 5 (FINAL) re-homed the last two. Both
 * `it-support.incident-triage::notify` and `marketing.ad-optimization::log` were
 * PROVEN (by probe) to be SKIPPED on a reject — their inbound sources are
 * gate-governed and skip with the gate (the incident summary fans in from the gated
 * `stakeholders`; `log` is fed only by `autoApply`/`applyReviewed`, both skipped on a
 * beyond-guardrail reject). Being skipped-on-reject, they are NOT escapes; they moved
 * to TRANSITIVELY_SAFE (which asserts exactly that behaviourally). Empty and
 * shrink-only — it can never regrow without a red.
 */
const BRANCH_MASKED = new Set<string>([]);

/**
 * Effect nodes that carry an unconditional inbound edge yet are PROVABLY SAFE:
 * the edge's source is itself gated on `{truthy approved}` (a re-check
 * eligibility node downstream of the gate), so on a reject the source is skipped
 * and the effect is skipped with it. This is the reference-fix shape
 * (`campaign-journeys`, the WF-EM-6 pattern). The behavioural leg proves each is
 * SKIPPED on reject (asserted below), so they are NOT escapes — they are
 * allow-listed OUT of the structural check, not baselined. COUNT: 9 (ADR 0582
 * Batch 3+4 added the three Tier-B rows that became transitively safe once their
 * upstream Tier-A effect was gated: `finance.invoice-ap::notify` (behind `post`),
 * `finance.expense-approval::flag` (behind `reimburse`), and
 * `people-hr.onboarding::notify` (behind the provisioning fan-in → `track`). Batch 5
 * added the two former BRANCH_MASKED rows — `it-support.incident-triage::notify`
 * (its `summary` source fans in from the gated `stakeholders`) and
 * `marketing.ad-optimization::log` (fed only by `autoApply`/`applyReviewed`) — both
 * PROVEN skipped-on-reject by the behavioural leg below).
 */
const TRANSITIVELY_SAFE = new Set<string>([
  'campaign-journeys.re-engage-contact::send',
  'campaign-journeys.re-engage-contact::task',
  'campaign-journeys.welcome-series::followup',
  'campaign-journeys.welcome-series::welcome',
  'finance.expense-approval::flag',
  'finance.invoice-ap::notify',
  'it-support.incident-triage::notify',
  'marketing.ad-optimization::log',
  'people-hr.onboarding::notify',
]);

/**
 * NOTIFY_OF_OUTCOME (ADR 0582 Batch 5) — effect nodes that carry an unconditional
 * inbound edge and DO fire on a reject, and SHOULD: they are genuine outcome
 * notifications whose whole job is to report the decision back ("your request was
 * approved / declined"). Firing on both legs is correct behaviour, NOT an escape —
 * so they are documented here rather than baselined. The bar for membership is
 * DECISION-AWARENESS: the notify's `message` input is wired from the gate's
 * `decision` output (asserted below), so a reject can never carry an
 * approval-worded body; the static `title` is a neutral workflow label. This set is
 * SHRINK-AWARE two ways — the behavioural leg asserts each STILL fires on reject
 * (if someone later GATES one, it stops firing and must be removed), and the
 * structural leg asserts each still has an unconditional inbound edge.
 */
const NOTIFY_OF_OUTCOME = new Set<string>([
  'approvals.request-sign-off::notify',
  'approvals.two-stage-sign-off::notify',
  'finance.month-end-close::report',
  'people-hr.offboarding::notify',
]);

describe('ADR 0582 — the generalized reject witness (shrink-only ratchet)', () => {
  it('the corpus has gate-governed effect nodes to witness (anti-vacuity floor)', () => {
    expect(listChains().length, 'the registry failed to load — every assertion below would be vacuous').toBeGreaterThan(50);
    expect(governedEffectNodes().length, 'no effect node is downstream of a core.chat.approvalGate — enumeration broken').toBeGreaterThanOrEqual(30);
  });

  it('drives the REAL gate: a reject yields approved:false', async () => {
    const rejected = await realGateOutputs('probe', {}, REJECT);
    expect(rejected.approved).toBe(false);
    expect(rejected.decision).toBe('reject');
  });

  it('BEHAVIOURAL — no non-baselined effect fires on reject, and every baselined/allow-listed entry still fires (shrink-only)', async () => {
    const escapes = await behaviouralEscapes();
    const escapeSet = new Set(escapes);

    // An effect that fires on reject is an ADR 0582 escape UNLESS it is (a) still
    // baselined debt or (b) a documented decision-aware NOTIFY_OF_OUTCOME that is
    // SUPPOSED to fire on both legs.
    const unexpected = escapes.filter((k) => !BASELINE.has(k) && !NOTIFY_OF_OUTCOME.has(k));
    expect(
      unexpected,
      `these effect nodes FIRE on a REJECT and are not baselined/allow-listed (ADR 0582):\n${unexpected.join('\n')}`,
    ).toEqual([]);

    const stale = [...BASELINE].filter((k) => !escapeSet.has(k)).sort();
    expect(
      stale,
      `these BASELINE entries no longer fire on reject and must be removed (the ratchet shrinks only):\n${stale.join('\n')}`,
    ).toEqual([]);

    // Shrink-aware allow-list: a NOTIFY_OF_OUTCOME row that STOPS firing on reject
    // (e.g. someone gated it) is no longer fire-on-both and must be removed — either
    // gated-out entirely or, if still reachable+skipped, moved to TRANSITIVELY_SAFE.
    const staleNoo = [...NOTIFY_OF_OUTCOME].filter((k) => !escapeSet.has(k)).sort();
    expect(
      staleNoo,
      `these NOTIFY_OF_OUTCOME entries no longer fire on reject and must be removed (allow-list shrinks only):\n${staleNoo.join('\n')}`,
    ).toEqual([]);
  });

  it('STRUCTURAL — every gate-reachable effect with an unconditional inbound edge is baselined, masked, or proven-safe', () => {
    const structural = structuralUngated();
    const known = new Set<string>([...BASELINE, ...BRANCH_MASKED, ...TRANSITIVELY_SAFE, ...NOTIFY_OF_OUTCOME]);

    const unexpected = structural.filter((k) => !known.has(k));
    expect(
      unexpected,
      `these gate-reachable effect nodes have an UNCONDITIONAL inbound edge and are not accounted for (ADR 0582):\n${unexpected.join('\n')}`,
    ).toEqual([]);

    // Anti-rot: every declared entry must still name a real structurally-ungated
    // node, so a stale allowance cannot sit here silently widening the gate.
    const structuralSet = new Set(structural);
    const stale = [...BASELINE, ...BRANCH_MASKED, ...TRANSITIVELY_SAFE, ...NOTIFY_OF_OUTCOME].filter((k) => !structuralSet.has(k)).sort();
    expect(
      stale,
      `these declared entries no longer describe an unconditional-inbound effect node and must be removed:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  // ── ADR 0582 Batch 1 — the four CRM task-create chains, paired legs ──────────
  // The BEHAVIOURAL leg above proves each is SKIPPED on reject. These paired
  // positives prove the fix did not simply break the chain: on APPROVE the effect
  // must still fire, and no fixed effect may retain an unconditional inbound edge.
  const BATCH1 = [
    { chainId: 'crm-ops.deal-hygiene', effect: 'follow-up' },
    { chainId: 'feedback-triage.classify-and-route', effect: 'task' },
    { chainId: 'postmortem.action-items', effect: 'task' },
    { chainId: 'meeting.notes-to-actions', effect: 'task' },
  ];

  it.each(BATCH1)('Batch 1 $chainId — APPROVE fires the effect, REJECT skips it', async ({ chainId, effect }) => {
    const findEffect = (states: Map<string, string>): string => {
      for (const [id, s] of states) if (bare(id) === effect) return s;
      throw new Error(`${chainId}: effect node ${effect} not found in the expanded def`);
    };
    expect(findEffect(await simulate(chainId, APPROVE)), `${chainId}:${effect} must COMPLETE on approve`).toBe('completed');
    expect(findEffect(await simulate(chainId, REJECT)), `${chainId}:${effect} must SKIP on reject`).toBe('skipped');
  });

  it('Batch 1 — no fixed CRM effect retains an unconditional inbound edge', () => {
    const structural = new Set(structuralUngated());
    const failures = BATCH1
      .map(({ chainId, effect }) => `${chainId}::${effect}`)
      .filter((k) => structural.has(k));
    expect(failures, `these fixed effects still carry an unconditional inbound edge:\n${failures.join('\n')}`).toEqual([]);
  });

  // ── ADR 0582 Batch 3+4 — the Tier-A external-effect escapes, paired legs ──────
  // The high-value external effects (ERP posting/reimbursement, HR/IT provisioning,
  // openapi upsert, ad-platform launch/budget). Each must FIRE on approve and SKIP
  // on reject — proving the gate holds the effect back without breaking the run's
  // happy path. `marketing.ad-optimization::applyReviewed` is EXCLUDED here: it sits
  // behind the within/beyond-guardrail `core.flow.if`, which the generic-output sim
  // never routes into, so its reject-safety is proven STRUCTURALLY (its removal from
  // BRANCH_MASKED) rather than behaviourally.
  const BATCH34 = [
    { chainId: 'finance.invoice-ap', effect: 'post' },
    { chainId: 'finance.expense-approval', effect: 'reimburse' },
    { chainId: 'people-hr.onboarding', effect: 'itProvision' },
    { chainId: 'people-hr.onboarding', effect: 'hris' },
    { chainId: 'people-hr.onboarding', effect: 'tickets' },
    // ADR 0622 D3 — the host-workspace invitation joins the provisioning fan-out.
    { chainId: 'people-hr.onboarding', effect: 'invite-host' },
    { chainId: 'people-hr.pto-routing', effect: 'hris' },
    { chainId: 'data-ops.records-to-system', effect: 'upsert' },
    { chainId: 'marketing.campaign-launch', effect: 'launch' },
  ];

  it.each(BATCH34)('Batch 3+4 $chainId::$effect — APPROVE fires the effect, REJECT skips it', async ({ chainId, effect }) => {
    const findEffect = (states: Map<string, string>): string => {
      for (const [id, s] of states) if (bare(id) === effect) return s;
      throw new Error(`${chainId}: effect node ${effect} not found in the expanded def`);
    };
    expect(findEffect(await simulate(chainId, APPROVE)), `${chainId}:${effect} must COMPLETE on approve`).toBe('completed');
    expect(findEffect(await simulate(chainId, REJECT)), `${chainId}:${effect} must SKIP on reject`).toBe('skipped');
  });

  it('Batch 3+4 — no fixed Tier-A effect retains an unconditional inbound edge', () => {
    const structural = new Set(structuralUngated());
    const fixed = [
      ...BATCH34.map(({ chainId, effect }) => `${chainId}::${effect}`),
      'marketing.ad-optimization::applyReviewed',
    ];
    const failures = fixed.filter((k) => structural.has(k));
    expect(failures, `these fixed effects still carry an unconditional inbound edge:\n${failures.join('\n')}`).toEqual([]);
  });

  it('TRANSITIVELY_SAFE — each is behaviourally SKIPPED on reject (proving it is safe, not mislabeled)', async () => {
    const failures: string[] = [];
    const byChain = new Map<string, string[]>();
    for (const k of TRANSITIVELY_SAFE) {
      const [chainId] = k.split('::');
      (byChain.get(chainId!) ?? byChain.set(chainId!, []).get(chainId!)!).push(k);
    }
    for (const [chainId, keys] of byChain) {
      const states = await simulate(chainId, REJECT);
      const byBare = new Map([...states].map(([id, s]) => [key(chainId, id), s]));
      for (const k of keys) {
        const s = byBare.get(k);
        if (s !== 'skipped') failures.push(`${k} → ${s} (a TRANSITIVELY_SAFE node must be skipped on reject)`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // ── ADR 0582 Batch 5 (FINAL) — the two GATED notify/schedule effects ──────────
  // The two Tier-B effects judged approval-ONLY: a reject must not schedule the
  // content for publishing, nor broadcast a declined PTO to the whole team. Each
  // must FIRE on approve and SKIP on reject. Reverting either gate reddens the
  // BEHAVIOURAL leg (a sabotage-witnessed positive), so this pins the fix.
  const BATCH5_GATED = [
    { chainId: 'marketing.content-repurposing', effect: 'schedule' },
    { chainId: 'people-hr.pto-routing', effect: 'notifyTeam' },
  ];

  it.each(BATCH5_GATED)('Batch 5 $chainId::$effect — APPROVE fires the effect, REJECT skips it', async ({ chainId, effect }) => {
    const findEffect = (states: Map<string, string>): string => {
      for (const [id, s] of states) if (bare(id) === effect) return s;
      throw new Error(`${chainId}: effect node ${effect} not found in the expanded def`);
    };
    expect(findEffect(await simulate(chainId, APPROVE)), `${chainId}:${effect} must COMPLETE on approve`).toBe('completed');
    expect(findEffect(await simulate(chainId, REJECT)), `${chainId}:${effect} must SKIP on reject`).toBe('skipped');
  });

  it('Batch 5 — no gated Tier-B effect retains an unconditional inbound edge', () => {
    const structural = new Set(structuralUngated());
    const failures = BATCH5_GATED
      .map(({ chainId, effect }) => `${chainId}::${effect}`)
      .filter((k) => structural.has(k));
    expect(failures, `these gated effects still carry an unconditional inbound edge:\n${failures.join('\n')}`).toEqual([]);
  });

  // ── ADR 0582 Batch 5 (FINAL) — NOTIFY_OF_OUTCOME is decision-aware ────────────
  // A fire-on-both outcome notification is only legitimate if a REJECT cannot carry
  // an approval-worded message. Each of these notifies takes its `message` input
  // from the gate's `decision` output (never a static string), so the body is the
  // real verdict ('reject' on a reject). This asserts that wiring STRUCTURALLY in
  // the expanded definition, and that no such notify carries a static, potentially
  // approval-worded `message` in its authored inputs.
  it('NOTIFY_OF_OUTCOME — each notify body is wired from the gate decision (decision-aware, never approval-worded)', () => {
    const failures: string[] = [];
    for (const k of NOTIFY_OF_OUTCOME) {
      const [chainId, node] = k.split('::');
      const entry = listChains().find((c) => c.chain.chainId === chainId);
      if (!entry) { failures.push(`${k}: chain not loaded`); continue; }
      const def = expandChain(entry.chain, { params: {} });
      const target = def.nodes.find((n) => bare(n.nodeId) === node);
      if (!target) { failures.push(`${k}: node not found`); continue; }

      // The authored `message` input must NOT be a static string — the decision
      // must arrive over an edge, never be hard-coded (an approval-word risk).
      const staticMsg = (target.inputs as Record<string, unknown> | undefined)?.message;
      if (typeof staticMsg === 'string') {
        failures.push(`${k}: carries a STATIC message input ${JSON.stringify(staticMsg)} — must be wired from the gate decision`);
      }

      const gateIds = new Set(def.nodes.filter((n) => n.typeId === GATE).map((n) => n.nodeId));
      const msgEdge = (def.edges ?? []).find(
        (e) => e.targetNodeId === target.nodeId
          && (e as { targetInput?: string }).targetInput === 'message'
          && gateIds.has(e.sourceNodeId)
          && (e as { sourceOutput?: string }).sourceOutput === 'decision',
      );
      if (!msgEdge) {
        failures.push(`${k}: no edge feeding the notify \`message\` input from a gate \`decision\` output — not decision-aware`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
