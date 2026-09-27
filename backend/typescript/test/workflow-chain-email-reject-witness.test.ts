/**
 * WF-EM-1/2/3/4 — a REJECTED review sends NO email, on every chain in the
 * corpus that mails a contact.
 *
 * **Why this file exists (WF-EM-4).** The only witness the corpus had for
 * "these chains are human-gated" was `chainRequirements.approvalGateCount >= 1`
 * — a count of NODES matching `/approvalgate/i` (`workflowChainPackLoader.ts`).
 * Three suites asserted it, and all ten broken chains passed all three: a gate
 * node that is present and ignored is indistinguishable from a gate that gates.
 * The one email reject-witness that did exist
 * (`workflow-chain-lighthouse.test.ts`) hand-wrote the gate's outputs, so it
 * proved the CONDITION discriminates but never that the real gate produces
 * `approved:false` from the real UI payload.
 *
 * So this suite refuses both shortcuts:
 *   1. It never reads the pack JSON. The subject is the EXPANDED definition
 *      through the real loader, and the verdict comes from the real
 *      `evaluateTrigger`.
 *   2. It never synthesises gate outputs. It invokes the REAL
 *      `core.chat.approvalGate` handler from `packs/vendor.myndhyve.chat/`
 *      with the REAL UI resume payloads — `{action:'approve'}` and
 *      `{action:'reject'}`, the shape `ApprovalCard.tsx`, `defaultCards.tsx`
 *      and `routes/reviews.ts` actually send — and uses whatever it returns.
 *      That closes the ADR 0582 §9 class in which the gate read `decision`
 *      only, so every real click produced `approved:false`.
 *
 * MEASURED against `origin/main` before the pack fix: the REJECT leg is RED on
 * 11 of 13 send nodes (10 of 12 chains, 6 packs) — `evaluateTrigger` returns
 * `ready`, i.e. the mail goes out on a rejection. Two mechanisms had to be
 * fixed together, which is why a partial fix is indistinguishable from none:
 * `core.chat.approvalGate` returns `status:'success'` on every verb, so the
 * bare `gate → send` edge is satisfied regardless; and the body arrived on an
 * unconditional `draft.content → send.text` SIBLING, whose single `completed`
 * upstream satisfies `all_success` (`allTerminal && !anyFailed &&
 * anyCompleted`) all by itself. Conditioning the gate edge alone is a NO-OP.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, evaluateTrigger, buildNodeInputs } from '../src/executor/scheduler.js';
import { validateResumeValue } from '../src/routes/interrupts.js';

// The SHIPPED pack module, imported by path — not a re-implementation and not
// a host stub. `nodes` is its typeId → handler map (`index.mjs:498`).
const chatPack = await import(
  /* @vite-ignore */ new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href
) as { nodes?: Record<string, unknown> };

const SEND = 'core.openwop.integration.email-send';
const GATE = 'core.chat.approvalGate';

/** The real UI resume payloads. `action` is the VALIDATED field on the wire
 *  (`validateResumeValue` enforces it against the card's `actions` array), so
 *  it is what a reviewer's click actually delivers. */
const APPROVE = { action: 'approve', decidedBy: 'user:reviewer' };
const REJECT = { action: 'reject', decidedBy: 'user:reviewer', comment: 'Not this one.' };

type GateHandler = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown> }>;

let approvalGate: GateHandler;

beforeAll(async () => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);

  const handlers = chatPack.nodes as Record<string, GateHandler> | undefined;
  expect(handlers, 'vendor.myndhyve.chat must export its `nodes` handler map').toBeTruthy();
  const h = handlers![GATE];
  expect(h, `${GATE} must be a real handler, not a stub`).toBeTypeOf('function');
  approvalGate = h;
});

/**
 * Run the REAL gate handler against a resume payload and return its REAL
 * outputs. `ctx.suspend` is the only seam faked — it stands in for the human,
 * which is the whole point.
 */
async function realGateOutputs(
  nodeId: string,
  config: Record<string, unknown>,
  artifact: unknown,
  resume: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const vars = new Map<string, unknown>();
  const res = await approvalGate({
    nodeId,
    runId: `run:${nodeId}`,
    config,
    inputs: { artifact },
    variables: { get: (k: string) => vars.get(k), set: (k: string, v: unknown) => { vars.set(k, v); } },
    chat: { emitCard: async () => undefined },
    suspend: async () => resume,
    host: { capabilities: { chat: true } },
  });
  expect(res.status, 'the gate returns success on every verb — that IS the defect this guards').toBe('success');
  return res.outputs ?? {};
}

/** Every chain in the corpus with at least one email-send node. Derived from
 *  the loaded registry, never a hand-kept list — a new mailing chain joins this
 *  witness automatically instead of shipping ungated. */
function mailingChains(): { chainId: string; sendIds: string[] }[] {
  const out: { chainId: string; sendIds: string[] }[] = [];
  for (const { chain } of listChains()) {
    const sends = chain.dag.nodes.filter((n) => n.typeId === SEND).map((n) => n.id);
    if (sends.length) out.push({ chainId: chain.chainId, sendIds: sends });
  }
  return out.sort((a, b) => a.chainId.localeCompare(b.chainId));
}

/** Generic success outputs for a non-gate node: EVERY other node succeeds, so
 *  the reviewer's verdict is the only thing that can hold a send back and the
 *  probe cannot pass by accident. */
const HAPPY_OUTPUTS = {
  content: 'the drafted email body',
  message: 'the drafted email body',
  email: 'recipient@example.com',
  to: 'recipient@example.com',
  eligible: true,
  enrolled: true,
};

/**
 * Simulate the run FORWARD through the real scheduler — sources first, each
 * node's state derived from `evaluateTrigger` rather than assumed — with every
 * approvalGate resolved by the REAL handler against `resume`.
 *
 * Deriving it forward is load-bearing, not tidiness. A harness that pre-marks
 * every non-send node `completed` cannot see TRANSITIVE coverage: it hands the
 * downstream send a completed upstream that a real rejected run would never
 * have produced. That is exactly `welcome-series.followup`, whose only
 * protection is that a rejected `welcome` never happens (WF-EM-3) — this
 * harness reported it as an ungated send until the simulation was made real.
 *
 * Returns each send node's TERMINAL state (`completed` ⇒ the mail would go out)
 * AND the input port-map the executor would hand it, built by the real
 * `buildNodeInputs`. WF-EM-6 needs the second half: "the node ran" and "the node
 * ran addressed to the RIGHT PERSON" are different claims, and the vulnerability
 * this witness now also covers lives entirely in the second.
 */
async function sendVerdicts(
  chainId: string,
  resume: Record<string, unknown>,
): Promise<Record<string, { state: string; inputs: Record<string, unknown> }>> {
  const entry = listChains().find((c) => c.chain.chainId === chainId)!;
  const def = expandChain(entry.chain, { params: {} });
  const graph = buildGraph(def);
  const snap = freshSnapshot(def);
  const sendIds = new Set(def.nodes.filter((n) => n.typeId === SEND).map((n) => n.nodeId));

  for (let pass = 0; pass <= def.nodes.length; pass += 1) {
    let moved = false;
    for (const n of def.nodes) {
      // `freshSnapshot` seeds SOURCES as 'ready', not 'pending' — a loop that
      // only advances 'pending' leaves them un-run forever and every successor
      // then reads as "stuck".
      const state = snap.nodeState.get(n.nodeId);
      if (state !== 'pending' && state !== 'ready') continue;
      const verdict = evaluateTrigger(n.nodeId, graph, snap);
      if (verdict === 'skip') { snap.nodeState.set(n.nodeId, 'skipped'); moved = true; continue; }
      if (verdict !== 'ready') continue;
      const outputs = n.typeId === GATE
        ? await realGateOutputs(n.nodeId, (n.config ?? {}) as Record<string, unknown>, HAPPY_OUTPUTS.content, resume)
        : HAPPY_OUTPUTS;
      snap.nodeState.set(n.nodeId, 'completed');
      snap.nodeOutputs.set(n.nodeId, outputs);
      moved = true;
    }
    if (!moved) break;
  }

  const stuck = def.nodes
    .filter((n) => { const s = snap.nodeState.get(n.nodeId); return s === 'pending' || s === 'ready'; })
    .map((n) => n.nodeId);
  expect(stuck, `${chainId} left nodes neither ready nor skippable — the simulation is incomplete`).toEqual([]);
  return Object.fromEntries([...sendIds].map((id) => [id, {
    state: String(snap.nodeState.get(id)),
    inputs: buildNodeInputs(id, graph, snap, {}),
  }]));
}

describe('WF-EM-4 — the email reject witness is behavioural, not a node count', () => {
  it('finds every mailing chain in the corpus (anti-vacuity floor)', () => {
    const chains = mailingChains();
    // A registry that failed to load would make every assertion below vacuous.
    expect(chains.length, 'the corpus must contain mailing chains to witness').toBeGreaterThanOrEqual(10);
    const totalSends = chains.reduce((n, c) => n + c.sendIds.length, 0);
    expect(totalSends).toBeGreaterThanOrEqual(11);
  });

  it('drives the REAL gate, not a synthetic output map', async () => {
    // Proves the harness is wired to the shipped handler: the real gate must
    // turn the real UI verbs into the `approved` boolean the edges read. If it
    // ever regresses to the ADR 0582 §9 `decision`-only read, this goes red
    // before any chain assertion does.
    const rejected = await realGateOutputs('probe', {}, 'body', REJECT);
    expect(rejected.approved).toBe(false);
    expect(rejected.decision).toBe('reject');
    const approved = await realGateOutputs('probe', {}, 'body', APPROVE);
    expect(approved.approved).toBe(true);
    expect(approved.artifact).toBe('body'); // the passthrough the fix routes through
  });
});

describe('WF-EM-1/2/3 — a rejected review reaches no email-send node', () => {
  const CHAINS = mailingChains;

  it('REJECT — every email-send node in every mailing chain is skipped', async () => {
    const failures: string[] = [];
    for (const { chainId } of CHAINS()) {
      const verdicts = await sendVerdicts(chainId, REJECT);
      for (const [nodeId, v] of Object.entries(verdicts)) {
        if (v.state !== 'skipped') failures.push(`${chainId}:${nodeId} → ${v.state} (the mail goes out on a REJECT)`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // The paired positive leg: a chain that simply never sends would satisfy the
  // reject assertion trivially. Both must hold for the gate to be real.
  it('APPROVE — every email-send node in every mailing chain still sends', async () => {
    const failures: string[] = [];
    for (const { chainId } of CHAINS()) {
      const verdicts = await sendVerdicts(chainId, APPROVE);
      for (const [nodeId, v] of Object.entries(verdicts)) {
        if (v.state !== 'completed') failures.push(`${chainId}:${nodeId} → ${v.state} (an APPROVED review cannot send)`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('WF-EM-2 — no email-send node has an unconditional inbound edge', async () => {
    // The structural half of the same defect, stated as a property rather than
    // a shape assertion: ANY unconditional inbound edge satisfies `all_success`
    // on its own, so the gate's conditioned edge becomes decorative. Asserted
    // on the EXPANDED definition (what actually runs), not the pack JSON.
    const failures: string[] = [];
    for (const { chain } of listChains()) {
      const def = expandChain(chain, { params: {} });
      const sendIds = new Set(def.nodes.filter((n) => n.typeId === SEND).map((n) => n.nodeId));
      if (!sendIds.size) continue;
      for (const e of def.edges ?? []) {
        if (!sendIds.has(e.targetNodeId)) continue;
        if (e.condition) continue;
        const src = def.nodes.find((n) => n.nodeId === e.sourceNodeId);
        // An unconditional edge is only safe when its SOURCE can itself never
        // complete on a rejection — i.e. the source is transitively gated. The
        // reject leg above is what proves that; this leg names the shape so a
        // regression reads as "you added an ungated sibling", not as a verdict.
        // Node ids are pack-prefixed after expansion, so match on the authored
        // suffix.
        const bare = (id: string): string => id.slice(id.lastIndexOf('_') + 1);
        failures.push(`${chain.chainId}: ${bare(e.sourceNodeId)}(${src?.typeId}) → ${bare(e.targetNodeId)} is unconditional`);
      }
    }
    // `welcome-series.followup` is deliberately fed by an unconditional
    // `gate2.email` edge: `gate2` is the day-2 eligibility re-check, which
    // FAILS (not completes) on revoked consent or a new suppression, and it is
    // itself downstream of the gated `welcome`. The REJECT leg above proves the
    // coverage; this allowance records that it was reasoned about, not missed.
    // SHRINK-ONLY: an entry here must be justified by a green REJECT leg.
    //
    // WF-EM-6 adds the two `recheck` edges for the same reason and with a
    // stronger justification: `recheck` is an eligibility node whose ONLY
    // inbound edge is the gate's `truthy approved` branch, so on a rejection it
    // is `skipped` and its unconditional successor is skipped with it (the
    // REJECT leg proves exactly that). It exists because the ADDRESS must not
    // ride the gate — see the WF-EM-6 block below.
    const allowed = new Set([
      'campaign-journeys.welcome-series: gate2(feature.campaign-journeys.nodes.eligibility) → followup is unconditional',
      'campaign-journeys.welcome-series: recheck(feature.campaign-journeys.nodes.eligibility) → welcome is unconditional',
      'campaign-journeys.re-engage-contact: recheck(feature.campaign-journeys.nodes.eligibility) → send is unconditional',
    ]);
    expect(failures.filter((f) => !allowed.has(f)), failures.join('\n')).toEqual([]);
    // Anti-rot: every allowance must still describe a real edge, so a stale one
    // cannot sit here silently widening the gate.
    for (const a of allowed) expect(failures, `stale allowance: ${a}`).toContain(a);
  });
});

/**
 * WF-EM-6 — the RECIPIENT ADDRESS must never be approver-editable.
 *
 * The vulnerability this closes was INTRODUCED by the WF-EM-1/2/3 fix above, so
 * it is worth stating plainly. To make `truthy approved` control-flow-effective,
 * the first fix routed the send's data through the gate: `gate1.email →
 * signoff.artifact → welcome.to`. On the eight chains that carry the BODY that
 * is fine — edit-then-accept is the INTENDED semantics of an approval gate. On
 * `welcome-series` and `re-engage-contact` the artifact was the RECIPIENT
 * ADDRESS, and the gate emits `resumePayload?.editedArtifact ?? inputs.artifact`
 * while `validateResumeValue` validates ONLY `resumeValue.action` and
 * `routes/reviews.ts` spreads the caller's whole body into the resume payload.
 * So `{action:'approve', editedArtifact:'attacker@example.com'}` bound an
 * arbitrary address to the send — bypassing `checkEligibility`, the only send
 * lane in the corpus that fails closed on BOTH consent and suppression.
 *
 * WHY THE OBVIOUS SHAPE DOES NOT WORK — MEASURED, not reasoned. The candidate
 * cure is to keep `eligibility.email → send.to` and condition BOTH inbound edges
 * on `{truthy approved}`. It fails, because `evaluateCondition` is SOURCE-SCOPED:
 * `evaluateTrigger` calls it with `snapshot.nodeOutputs.get(e.sourceNodeId)`, so
 * `approved` on the eligibility→send edge resolves against ELIGIBILITY's outputs,
 * where it is `undefined` ⇒ falsy ⇒ the edge folds to `skipped` and contributes
 * no input. Probed directly against the real scheduler before the pack was
 * touched: the APPROVE leg returned `verdict=ready, inputs={"gate":true}` — the
 * `to` port MISSING. That shape kills the approve leg silently. (It is not that
 * conditions are frozen at source-completion — they ARE re-evaluated every
 * readiness pass; they are simply always evaluated against their own edge's
 * source.) The `first_leg_below` assertions re-derive that fact from the shipped
 * graph rather than trusting this paragraph.
 *
 * THE SHAPE THAT HOLDS: the address never enters the gate's output at all. The
 * gate still RECEIVES it (`gate1.email → signoff.artifact`) so the approver can
 * see who they are approving, but the send is fed by `recheck` — a second
 * `feature.campaign-journeys.nodes.eligibility` node whose only inbound edge is
 * the gate's `truthy approved` branch. Approve ⇒ `recheck` runs and supplies an
 * eligibility-derived address; reject ⇒ `recheck` skips and the send skips with
 * it. It also closes a TOCTOU gap for free: a gate can sit pending for hours, so
 * consent/suppression are now re-evaluated at the moment of approval.
 */
describe('WF-EM-6 — an approver cannot redirect the mail', () => {
  /** The chains whose gate artifact is an ADDRESS rather than a body. Derived
   *  from the shipped configs (`artifactType: 'email.recipient'`), not hand-kept,
   *  so a third address-gated chain joins this witness automatically. */
  function addressGatedChains(): { chainId: string; sendIds: string[] }[] {
    const out: { chainId: string; sendIds: string[] }[] = [];
    for (const { chain } of listChains()) {
      const hasAddressGate = chain.dag.nodes.some(
        (n) => n.typeId === GATE && (n.config as { artifactType?: unknown } | undefined)?.artifactType === 'email.recipient',
      );
      if (!hasAddressGate) continue;
      const sends = chain.dag.nodes.filter((n) => n.typeId === SEND).map((n) => n.id);
      if (sends.length) out.push({ chainId: chain.chainId, sendIds: sends });
    }
    return out.sort((a, b) => a.chainId.localeCompare(b.chainId));
  }

  it('the corpus still has address-gated chains to witness (anti-vacuity floor)', () => {
    // Without this, deleting `artifactType: 'email.recipient'` from both packs
    // would make every assertion below pass over an empty list.
    expect(addressGatedChains().map((c) => c.chainId)).toEqual([
      'campaign-journeys.re-engage-contact',
      'campaign-journeys.welcome-series',
    ]);
  });

  it('APPROVE — the send is addressed from ELIGIBILITY even when editedArtifact carries another address', async () => {
    // The attack payload, in exactly the shape `routes/reviews.ts` builds: the
    // caller's body is spread alongside the validated `action`.
    const HIJACK = { action: 'approve', decidedBy: 'user:reviewer', editedArtifact: 'attacker@example.com' };
    const failures: string[] = [];
    for (const { chainId } of addressGatedChains()) {
      const verdicts = await sendVerdicts(chainId, HIJACK);
      for (const [nodeId, v] of Object.entries(verdicts)) {
        if (v.state !== 'completed') {
          failures.push(`${chainId}:${nodeId} → ${v.state} (an APPROVED send must still run — a fix that kills the approve leg is not a fix)`);
          continue;
        }
        // HAPPY_OUTPUTS.email is what the eligibility node yields; the hijack
        // address must not appear on ANY input port, not merely not on `to`.
        if (v.inputs.to !== HAPPY_OUTPUTS.email) {
          failures.push(`${chainId}:${nodeId} to=${JSON.stringify(v.inputs.to)} — expected the eligibility-derived ${HAPPY_OUTPUTS.email}`);
        }
        const leaked = Object.entries(v.inputs).filter(([, val]) => JSON.stringify(val).includes('attacker@example.com'));
        if (leaked.length) failures.push(`${chainId}:${nodeId} leaked the approver's address on ports [${leaked.map(([k]) => k).join(', ')}]`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('REJECT — the send does not run at all', async () => {
    // Paired leg. Without it, a chain that never sends would satisfy the
    // address assertion trivially.
    const failures: string[] = [];
    for (const { chainId } of addressGatedChains()) {
      const verdicts = await sendVerdicts(chainId, { ...REJECT, editedArtifact: 'attacker@example.com' });
      for (const [nodeId, v] of Object.entries(verdicts)) {
        if (v.state !== 'skipped') failures.push(`${chainId}:${nodeId} → ${v.state} (a REJECTED review sends)`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the gate artifact reaches NO send input port on these chains (the structural half)', () => {
    // The behavioural legs above depend on `HAPPY_OUTPUTS` differing from the
    // hijack address. This one does not depend on any output value: it asserts
    // on the EXPANDED graph that no edge runs gate → send at all, so the class
    // cannot come back through a port this test did not think to check.
    const failures: string[] = [];
    for (const { chainId } of addressGatedChains()) {
      const entry = listChains().find((c) => c.chain.chainId === chainId)!;
      const def = expandChain(entry.chain, { params: {} });
      const gateIds = new Set(def.nodes.filter((n) => n.typeId === GATE).map((n) => n.nodeId));
      const sendIds = new Set(def.nodes.filter((n) => n.typeId === SEND).map((n) => n.nodeId));
      for (const e of def.edges ?? []) {
        if (gateIds.has(e.sourceNodeId) && sendIds.has(e.targetNodeId)) {
          failures.push(`${chainId}: ${e.sourceNodeId}.${e.sourceOutput ?? 'output'} → ${e.targetNodeId}.${e.targetInput ?? 'input'} — an address gate must not feed a send`);
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/**
 * WF-EM-5 — an UNMADE decision must not be recorded as a decline.
 *
 * `defer` / `escalate` / `request-changes` all fall through `APPROVAL_VERBS` to
 * `refine` ⇒ `approved:false` ⇒ the `falsy approved` edge fires the terminal
 * "Rejected — no email sent" node and the RUN REPORTS COMPLETED. A reviewer who
 * clicked *Escalate* — explicitly declining to decide — had it written down as a
 * decline. Pre-PR those verbs SENT the mail, so the branch was still progress,
 * but "unmade decision ⇒ silent success" is not a state to ship.
 *
 * The cure is not a new union member (that would fabricate a decision the
 * approver did not make). It is `config.actions`, which the gate now forwards
 * into the suspend payload: `validateResumeValue` refuses the verb with a 400 and
 * the run STAYS INTERRUPTED for a real decision, and the approval cards stop
 * offering it (`data.actions`, already honoured by both card implementations).
 */
describe('WF-EM-5 — a gate whose rejection branch is terminal refuses non-decisions', () => {
  /** Every gate in the corpus whose `falsy approved` edge leads somewhere — i.e.
   *  every gate where "not approved" is a RECORDED outcome rather than a stall. */
  function terminalRejectGates(): { chainId: string; nodeId: string; actions: unknown }[] {
    // ADR 0655 D6 (EMWF-7) — the population is EVERY approval gate that sits UPSTREAM
    // of a send node, not only the gates that already carry a `falsy approved` edge.
    // The old definition let the emptiest gate (no falsy leg, no `actions`) fall
    // outside the ratchet: the less a chain declared, the less this asserted — and
    // both `lighthouse` gates were exactly that shape.
    const out: { chainId: string; nodeId: string; actions: unknown }[] = [];
    for (const { chain } of listChains()) {
      const gates = new Map(chain.dag.nodes.filter((n) => n.typeId === GATE).map((n) => [n.id, n]));
      const sends = new Set(chain.dag.nodes.filter((n) => n.typeId === SEND).map((n) => n.id));
      // Upstream walk: a gate is in the population when a path of edges leads from it to a send.
      const adj = new Map<string, Set<string>>();
      for (const e of chain.dag.edges ?? []) {
        const a = e.from.split('.')[0]!; const b = e.to.split('.')[0]!;
        if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b);
      }
      const reachesSend = (start: string): boolean => {
        const seen = new Set<string>(); const stack = [start];
        while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); if (sends.has(n)) return true; for (const nx of adj.get(n) ?? []) stack.push(nx); }
        return false;
      };
      // UNION with the original population (every gate carrying a `falsy approved`
      // edge, send or not — the kicktodo allowance lives there) so the widening only
      // ADDS the empty email gates and the shrink-only allowance keeps its meaning.
      const hasFalsy = new Set<string>();
      for (const e of chain.dag.edges ?? []) {
        const cond = e.condition as { type?: string; left?: string } | undefined;
        if (cond?.type === 'falsy' && cond.left === 'approved') hasFalsy.add(e.from.split('.')[0]!);
      }
      for (const [id, gate] of gates) {
        if (!reachesSend(id) && !hasFalsy.has(id)) continue;
        out.push({ chainId: chain.chainId, nodeId: id, actions: (gate.config as { actions?: unknown } | undefined)?.actions });
      }
    }
    return out;
  }

  /**
   * PRE-EXISTING instances of the same class, OUTSIDE this change's blast radius.
   * SHRINK-ONLY. Enumerated whole rather than filtered out of the population,
   * because a gate that quietly narrows its own denominator is the "ratchet
   * polices a spelling" failure this repo keeps re-learning.
   *
   * All seven predate the email work and none of them mails anyone — csm-ops
   * creates a CRM task, the kicktodo gates advance an authoring pipeline. They
   * are ALSO not a straight copy of the email case: every kicktodo gate sets
   * `maxRequestChangesIterations > 0`, which gives `request-changes` real
   * semantics there (the handler keeps a loopback counter + feedback history for
   * it), so the correct allowlist for those is NOT `['approve','reject']` and
   * picking one is the owning feature's call. `defer`/`escalate` remain
   * meaningless everywhere — that residual is real and is what this list records.
   */
  const UNDECLARED_ALLOWED = new Set([
    'openwop-app.kicktodo.challenge-factory:outline-approve',
    'openwop-app.kicktodo.challenge-factory:gate-0',
    'openwop-app.kicktodo.challenge-factory:gate-1',
    'openwop-app.kicktodo.challenge-factory:gate-2',
    'openwop-app.kicktodo.challenge-factory:gate-3',
    'openwop-app.kicktodo.replan:approve',
  ]);

  it('every such gate declares an allowlist (anti-vacuity: the population is non-empty)', () => {
    const gates = terminalRejectGates();
    expect(gates.length, 'no falsy-approved branches found — the enumeration is broken, not the corpus').toBeGreaterThanOrEqual(17);
    const undeclared = gates
      .filter((g) => !Array.isArray(g.actions) || g.actions.length === 0)
      .map((g) => `${g.chainId}:${g.nodeId}`);
    expect(
      undeclared.filter((k) => !UNDECLARED_ALLOWED.has(k)),
      'A gate whose "not approved" branch is a TERMINAL node must declare `config.actions`, '
      + 'or defer/escalate/request-changes are recorded as a decline the approver never made.',
    ).toEqual([]);
    // Anti-rot, same idiom as WF-EM-2 above: an allowance that no longer names a
    // real undeclared gate is a stale widening sitting in the gate's blind spot.
    for (const k of UNDECLARED_ALLOWED) expect(undeclared, `stale allowance: ${k}`).toContain(k);
  });

  it('the REAL validator refuses defer / escalate / request-changes on those gates', async () => {
    // Behavioural, through the shipped `validateResumeValue` and the REAL
    // interrupt payload the REAL gate handler produces — not a re-read of the
    // pack JSON. Captures `ctx.suspend`'s argument, which is what
    // `makeSuspendFn` persists as `interrupt.data`.
    const gates = terminalRejectGates().filter((g) => !UNDECLARED_ALLOWED.has(`${g.chainId}:${g.nodeId}`));
    // Non-vacuity: the allowance above must not be able to empty the population.
    expect(gates.length, 'the allowance list swallowed every gate — this test would assert nothing').toBeGreaterThanOrEqual(10);
    const failures: string[] = [];
    for (const { chainId, nodeId } of gates) {
      const entry = listChains().find((c) => c.chain.chainId === chainId)!;
      const node = entry.chain.dag.nodes.find((n) => n.id === nodeId)!;
      let captured: unknown;
      await approvalGate({
        nodeId, runId: `run:${nodeId}`, config: node.config ?? {}, inputs: { artifact: 'body' },
        variables: { get: () => undefined, set: () => undefined },
        chat: { emitCard: async () => undefined },
        suspend: async (p: unknown) => { captured = p; return APPROVE; },
        host: { capabilities: { chat: true } },
      } as never);
      const interrupt = { kind: 'approval', data: captured };
      for (const verb of ['defer', 'escalate', 'request-changes']) {
        let threw = false;
        try { validateResumeValue(interrupt, { action: verb }); } catch { threw = true; }
        if (!threw) failures.push(`${chainId}:${nodeId} accepted '${verb}' — an unmade decision would be recorded as a decline`);
      }
      // The paired positive: the two real decisions MUST still pass, or the
      // allowlist has simply broken the gate.
      for (const verb of ['approve', 'reject']) {
        try { validateResumeValue(interrupt, { action: verb }); }
        catch { failures.push(`${chainId}:${nodeId} REFUSED '${verb}' — the allowlist broke a real decision`); }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
