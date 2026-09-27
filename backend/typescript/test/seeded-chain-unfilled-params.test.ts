/**
 * ADR 0504 — the RATCHET on seeded chains whose required params never froze.
 *
 * `host/seedWorkflows.ts` expands EVERY chain with `expandChain(chain, {})`, so
 * every tenant's gallery carries the result. A whole-value `{{params.NAME}}`
 * token with no param freezes to `undefined` and the key is then dropped, so the
 * seeded workflow reaches a node with the value simply absent — and fails
 * mid-run naming an INTERNAL NODE rather than the parameter. That is the exact
 * failure reproduced live on 2026-07-29:
 *
 *     core.web.search requires a non-empty `query` input
 *
 * §CORRECTION (ADR 0507) — "seeded" is the wrong word. `seedWorkflows` seeds only
 * ZERO-CONFIG chains: the seeded set is **52**, of which **9** are affected. The 114
 * below counts chains that would break if instantiated WITHOUT PARAMS through
 * `from-chain` — a real, larger population, and the one users drive by hand. The
 * ceiling still ratchets something worth ratcheting; only its label was wrong.
 *
 * Measured here rather than asserted: **114 of 169** loaded chains are in that
 * state. That number is why ADR 0504 did NOT ship a run-start refusal — refusing
 * would have blocked two thirds of the product. The debt is made visible and
 * ratcheted DOWN instead; the structural fix is to seed in RFC 0124 deferred
 * mode so these become run-overridable variables (ADR 0504 §Open-1).
 *
 * This test fails if the count goes UP. Lower it when chains are fixed.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import {
  listChains,
  expandChain,
  findUnfilledExpansionParams,
  reloadWorkflowChainPacks,
} from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/** Ratchet ceiling, measured 2026-07-31 against 169 loaded chains. NEVER raise
 *  this to make a red build green — a new chain shipping unfillable required
 *  params is the defect this exists to catch.
 *
 *  114 → 115 (2026-08-31, WF-KB-3 / KSWF-1): the `knowledge-sync.run` chain carries
 *  a required `sourceId` with no default — but it is the gmail-sync twin: a
 *  SCHEDULER-ONLY chain whose param is supplied programmatically by the per-source
 *  job at `ensureKnowledgeSyncWorkflow` (`expandChain({params:{sourceId}})` freezes
 *  it, RFC 0013 Path A), never from the gallery. That is the same accepted pattern
 *  as `crm-ops.gmail-sync`'s `gmailSyncId`, already counted here — NOT the
 *  gallery-instantiation defect this ratchet catches. A legitimate +1, not a hidden red.
 *
 *  115 → 116 (2026-09-04, ADR 0643 D1b): `kb.reindex` carries required `orgId` +
 *  `collectionId` with no defaults, for the SAME reason and with a STRONGER guarantee
 *  than the two entries above. It is the per-collection reindex driver: `startReindex`
 *  freezes both params through `expandChain({params:{orgId, collectionId}})` (RFC 0013
 *  Path A) when it mints the workflow, and the scheduler job supplies nothing else.
 *  The strengthening: instantiating it FROM THE GALLERY with no params cannot even
 *  misfire, because its only node's surface verb refuses unless (a) a `running`/`paused`
 *  reindex job already exists for the collection AND (b) the executing run's workflowId
 *  is the host-minted `kb.reindex:<tenantId>:<orgId>:<collectionId>` — so a param-less
 *  gallery copy fails CLOSED with a typed error naming the verb, which is the opposite
 *  of the "fails mid-run naming an INTERNAL NODE" symptom this ratchet exists to catch.
 *  Witnessed by `kb-reindex-scheduled-drain.test.ts` ("a run with NO workflowId … is
 *  refused"). A legitimate +1, not a hidden red.
 *
 *  116 → 117 (2026-09-16, ADR 0701): `openwop-app.scheduled-chat.turn` carries required
 *  `agentId` + `task` with no defaults. Same family as the two above — a SCHEDULER-ONLY
 *  chain whose params are supplied programmatically by the recurring tick, never from
 *  the gallery (`scheduledChatService.ts` sets them in the job's `configurable`, and
 *  `agentTools.ts` does the same for the two tool-created lanes).
 *
 *  STATED DIFFERENCE, because it matters and blurring it would be the dishonest move:
 *  the two entries above FREEZE their params via `expandChain({params})` (RFC 0013
 *  Path A). This one does NOT freeze — `registerChainBackedWorkflow` expands with
 *  `deferred: true` (RFC 0124), so the params stay run-overridable variables and the
 *  tick supplies them per FIRE. That is required here: one workflow serves every
 *  schedule, so a frozen agentId/task would need a workflow per schedule.
 *
 *  It qualifies on the kb.reindex GUARANTEE rather than on freezing: a param-less
 *  gallery copy cannot misfire, because the agent-runner refuses with a TYPED error
 *  naming the missing input — `agentRunnerNode.ts:110`,
 *  `{status:'failure', error:{code:'validation_error',
 *  message:'agent-runner node requires an `agentId`.'}}` — which is the opposite of the
 *  "fails mid-run naming an INTERNAL NODE" symptom this ratchet catches. Verified
 *  against that line, not assumed. A legitimate +1, not a hidden red.
 *
 *  117 → 118 (2026-09-16, ADR 0703): `openwop-app.channel.turn`, for EXACTLY the
 *  reasons above — it is the same single-agent-runner shape, its params are supplied
 *  programmatically by `channelAgentDispatch.ts:114`'s `configurable` (never from the
 *  gallery), it cannot freeze them (one workflow serves every channel post), and the
 *  same TYPED `agentRunnerNode.ts:110` refusal makes a param-less gallery copy fail
 *  closed. That refusal is pinned by `scheduled-agent-chats.test.ts`, so this +1
 *  inherits a witnessed guarantee rather than a repeated assertion.
 *
 *  118 → 119 (2026-09-20, ADR 0738 P3): `app-builder.plan-to-kanban` is an
 *  explicitly configured, builder-editable handoff chain. Its `canvasId` and
 *  `boardId` cannot have safe host defaults: selecting either at pack authoring
 *  time would pin a tenant/canvas into a portable chain, and an empty default
 *  would make a copy look runnable while targeting no board. The materializer
 *  instead validates the user-owned board at execution, while the native
 *  approval gate keeps the plan editable before any core WorkItem is written.
 *  This is a declared +1—not an unreviewed excuse to hide an App Builder-local
 *  runner—and the generic core node is independently exercised by
 *  kanban-work-items-pack.test.ts. */
const CEILING = 119;

/** ADR 0507 — the EMBEDDED family, invisible until the detector was widened. These
 *  freeze to `''` rather than `undefined`, so the node SUCCEEDS on truncated input
 *  (a model asked to summarise a document that is not there). Counted separately on
 *  purpose: folding them into CEILING would let a whole-value regression hide behind
 *  an embedded improvement, and vice versa. */
const EMBEDDED_CEILING = 36;

let affected: Array<{ chainId: string; params: string[] }> = [];
let wholeValue: Array<{ chainId: string; params: string[] }> = [];
let embedded: Array<{ chainId: string; params: string[] }> = [];
let total = 0;

beforeAll(() => {
  reloadWorkflowChainPacks();
  const chains = listChains();
  total = chains.length;
  affected = [];
  for (const { chain } of chains) {
    const def = expandChain(chain, {}) as unknown as WorkflowDefinition;
    const unfilled = findUnfilledExpansionParams(def);
    if (unfilled.length > 0) {
      const row = { chainId: chain.chainId, params: [...new Set(unfilled.map((u) => u.param))].sort() };
      affected.push(row);
      if (unfilled.some((u) => !u.embedded)) wholeValue.push(row);
      if (unfilled.some((u) => u.embedded)) embedded.push(row);
    }
  }
});

describe('from-chain-instantiable chains carrying unfilled required params', () => {
  it('the pack registry actually loaded — a zero count must not read as "clean"', () => {
    // Without this the whole file passes vacuously on an empty registry, which
    // is precisely how a ratchet silently stops ratcheting.
    expect(total).toBeGreaterThan(100);
  });

  it(`whole-value family does not exceed the ${CEILING}-chain ceiling`, () => {
    const detail = wholeValue.map((a) => `${a.chainId} :: ${a.params.join(', ')}`).join('\n');
    expect(wholeValue.length, `chains with a whole-value param that never froze:\n${detail}`).toBeLessThanOrEqual(CEILING);
  });

  it(`embedded family does not exceed the ${EMBEDDED_CEILING}-chain ceiling`, () => {
    // The dangerous half: these do not fail, they fabricate. See ADR 0507.
    const detail = embedded.map((a) => `${a.chainId} :: ${a.params.join(', ')}`).join('\n');
    expect(embedded.length, `chains whose prompt silently loses an embedded param:\n${detail}`).toBeLessThanOrEqual(EMBEDDED_CEILING);
  });

  it('still detects the known-affected chains — the detector has not gone blind', () => {
    // Three independent packs, so a regression in one loader path cannot hide.
    // If a chain here is legitimately FIXED, drop it AND lower CEILING.
    const ids = new Set(affected.map((a) => a.chainId));
    for (const known of ['commerce.low-stock-reorder', 'research.web-brief', 'support.kb-answer']) {
      expect(ids.has(known), `${known} was affected at ADR 0504; if it is fixed, remove it here and lower CEILING`).toBe(true);
    }
  });

  it('a chain with every param supplied records nothing', () => {
    // Guards the detector against the opposite failure: flagging everything.
    const found = listChains().find((c) => c.chain.chainId === 'research.web-brief');
    expect(found, 'research.web-brief must be loaded for this to mean anything').toBeTruthy();
    const def = expandChain(found!.chain, { params: { query: 'walking 20 minutes a day' } }) as unknown as WorkflowDefinition;
    expect(findUnfilledExpansionParams(def)).toHaveLength(0);
  });
});
