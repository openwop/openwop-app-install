/**
 * ADR 0554 P2 — the glue between the executor and the compensation machinery.
 *
 * Two seams, and nothing else:
 *
 *   `recordForwardObligation` — called when a node with an RFC 0151 §B
 *   `compensation` declaration COMPLETES. It mints the durable obligation.
 *
 *   `unwindTerminatedRun` — called at the single terminal-failure choke, before
 *   `run.failed` is appended. It drives `host/compensationUnwind.ts` against the
 *   run tree.
 *
 * This file exists so `executor.ts` gains two calls rather than the node
 * registry, the approvals surface, the sub-run walk and the §D event shapes.
 * The unwind engine itself takes those as injected deps and knows about none of
 * them, which is what makes the adversarial fixtures able to drive it directly.
 *
 * ── WHY THE OBLIGATION IS RECORDED AT NODE COMPLETION ──────────────────────
 *
 * P0 finding 3: two senders' compensability is UNKNOWABLE to the host
 * (`network-egress` via webhook and via the broker — the peer may expose no
 * inverse), so it "must be author-declared per workflow; inferring [it] is how
 * a runtime silently no-ops an unwind the operator believes ran".
 *
 * RFC 0151 §B is exactly that declaration, and it hangs on the NODE. So the
 * obligation is minted where the declaration lives — one row per completed
 * declared node — and a node with no declaration mints nothing. There is no
 * inference step anywhere on this path, which is the point.
 *
 * The effect KIND on the row is still measured rather than declared: it is the
 * set `assertEffectAllowed` filled during that node's execution
 * (`runEffectContext.observedEffectKinds`).
 */

import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { getEventLog } from '../executor/eventLog.js';
import type { NodeContext, NodeOutcome, WorkflowDefinition } from '../executor/types.js';
import type { RunRecord } from '../types.js';
import { isTerminalRunStatus } from './runCancel.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { recordCompensationObligation } from '../observability/metricSeams.js';
import {
  type CompensationShape,
  type CompensationStatus,
  digestOf,
  getObligation,
  WAIVE_APPROVAL_SUFFIX,
  nextCompensationOrdinal,
  obligationsForRunTree,
  recordObligation,
  markPlanRequested,
  type CompensationObligation,
  resolveObligation,
} from './compensationLedger.js';
import {
  type ApprovalOutcome,
  type InverseActionReport,
  reportInverseActions,
  type CompensationDeclaration,
  type CompensationEvent,
  type InverseOutcome,
  type CompensationPolicy,
  type CompensationTrigger,
  type UnwindDeps,
  type UnwindResult,
  declarationKey,
  effectiveWaiveRequiresApproval,
  policyAdmitsTrigger,
  unwindRun,
  compensationTriggerFor,
} from './compensationUnwind.js';
import { type EffectKind, runWithEffectContext } from './runEffectContext.js';
import { logicalInvocationId } from './effectIdentity.js';
import {
  createCompensationApproval,
  getApproval,
  registerApprovalEligibility,
} from './approvalService.js';
import { OpenwopError } from '../types.js';
import { recordAuthorityAction } from './authorityContext.js';

const log = createLogger('host.compensationRuntime');

/** The node shape the executor hands us — the app's `WorkflowDefinition` node
 *  plus RFC 0151 §B's closed `compensation` block. */
type CompensableNode = WorkflowDefinition['nodes'][number];

/** Read the §B declaration off a node, or `undefined`. Defensive rather than a
 *  cast: chain-expanded and pack-loaded definitions reach the executor from
 *  several loaders, and a malformed block must be ABSENT (no obligation) rather
 *  than a half-built one an unwind would later fail on. */
export function compensationDeclarationOf(node: CompensableNode): CompensationDeclaration | undefined {
  const raw = (node as { compensation?: unknown }).compensation;
  if (!raw || typeof raw !== 'object') return undefined;
  const block = raw as Record<string, unknown>;
  const nodeTypeId = block['nodeTypeId'];
  if (typeof nodeTypeId !== 'string' || nodeTypeId.length === 0) return undefined;
  const retry = block['retry'];
  return {
    nodeTypeId,
    ...(retry && typeof retry === 'object'
      ? {
          retry: {
            ...(typeof (retry as Record<string, unknown>)['maxAttempts'] === 'number'
              ? { maxAttempts: (retry as Record<string, number>)['maxAttempts']! }
              : {}),
            ...(typeof (retry as Record<string, unknown>)['backoffMs'] === 'number'
              ? { backoffMs: (retry as Record<string, number>)['backoffMs']! }
              : {}),
          },
        }
      : {}),
    ...(block['inputMapping'] && typeof block['inputMapping'] === 'object'
      ? { inputMapping: block['inputMapping'] as Record<string, unknown> }
      : {}),
    ...(typeof block['requiresApproval'] === 'boolean'
      ? { requiresApproval: block['requiresApproval'] }
      : {}),
    // RFC 0151 §B (S36). Carried RAW — `undefined` is meaningful here ("inherit
    // the effective value"), so it must not be collapsed to `false` on the way
    // through; `effectiveWaiveRequiresApproval` resolves it.
    ...(typeof block['waiveRequiresApproval'] === 'boolean'
      ? { waiveRequiresApproval: block['waiveRequiresApproval'] }
      : {}),
  };
}

/**
 * Every §B declaration in a run tree, keyed `<runId>::<nodeId>`.
 *
 * A sub-run's node ids are only unique within that run, so the key carries the
 * run. Collapsing to a bare nodeId would let a parent's `charge` node shadow a
 * child's and compensate the wrong effect — silently, because both resolve.
 */
export async function collectDeclarations(
  storage: Storage,
  root: { runId: string; definition: WorkflowDefinition },
  resolveDefinition: (run: RunRecord) => Promise<WorkflowDefinition | null>,
): Promise<Map<string, CompensationDeclaration>> {
  const out = new Map<string, CompensationDeclaration>();
  const seen = new Set<string>();

  async function walk(runId: string, definition: WorkflowDefinition): Promise<void> {
    if (seen.has(runId)) return;
    seen.add(runId);
    for (const node of definition.nodes) {
      const decl = compensationDeclarationOf(node);
      if (decl) out.set(declarationKey(runId, node.nodeId), decl);
    }
    // Sub-runs only. A FORK carries `parentRunId` too, and its obligations are
    // its own run's — walking into one would attach a fork's declarations to
    // the source's plan and unwind a run nobody asked about.
    for (const child of await storage.listRunsByParent(runId)) {
      if (child.forkMode !== undefined) continue;
      const childDef = await resolveDefinition(child);
      if (childDef) await walk(child.runId, childDef);
    }
  }

  await walk(root.runId, root.definition);
  return out;
}

/**
 * Mint the durable obligation for one completed node that declared an inverse.
 *
 * Best-effort by design: a ledger write must never fail a run that already
 * succeeded at its work. A failure here is logged loudly because it means the
 * unwind will later under-report — which is the honest failure mode (an
 * operator sees an obligation missing) rather than the dishonest one (an unwind
 * reports `completed` for an effect it never knew about).
 */
export interface RecordForwardObligationInput {
  run: RunRecord;
  node: CompensableNode;
  observedEffectKinds: ReadonlySet<EffectKind>;
  outputs: Record<string, unknown>;
  /** The root of the sub-run tree — the ordinal counter's scope. */
  rootRunId: string;
  /**
   * The workflow's `settings.compensation`, when it has one (RFC 0151 §B S36).
   *
   * Threaded in ONLY because the §B default for `waiveRequiresApproval` is the
   * EFFECTIVE `requiresApproval` — i.e. AFTER the policy's `approvalScope`
   * escalation — and that value has to be resolved at MINT time, since §B stamps
   * it onto the obligation so a mid-flight redefinition cannot change who had to
   * authorize. Stamping the RAW declaration instead would leave a workflow with
   * `approvalScope: 'all'` gating the RUN of an inverse while leaving its WAIVE
   * ungated: the host accepting a document and then under-enforcing it.
   */
  policy?: CompensationPolicy;
}

export async function recordForwardObligation(input: RecordForwardObligationInput): Promise<void> {
  const declaration = compensationDeclarationOf(input.node);
  // RFC 0151 UQ4 — a node may instead declare that its effect HAS NO INVERSE.
  // The two are mutually exclusive (`validateWorkflowDefinition` refuses a node
  // carrying both), so this is an either/or, not a fallthrough.
  const irreversible = (input.node as { irreversibleEffect?: unknown }).irreversibleEffect === true;
  if (!declaration && !irreversible) return;
  // RFC 0151 §F — a replay MUST NOT mint new obligations. The forward effect it
  // is reproducing was already recorded against the SOURCE run; minting a
  // second row here would give the replay its own unwind to fire, which is the
  // "recovery becomes a second outage" case §F exists to forbid.
  if (input.run.forkMode === 'replay') return;

  if (irreversible) {
    // WHY AN IRREVERSIBLE EFFECT GETS A PLAN ENTRY AT ALL.
    //
    // It has nothing to invoke, so the intuitive move is to record nothing —
    // and that is precisely the wire lie UQ4 closes. A plan that omits it
    // reaches `completed` once its compensable siblings unwind, and a reader
    // "can infer a full unwind" for a run that permanently could not have one.
    // The entry exists to be the thing that CANNOT complete, which is what caps
    // the §D rollup at `partial`.
    //
    // Only when the node actually COMMITTED something: `irreversibleEffect` on a
    // node that emitted no effect this run describes a hypothetical, and capping
    // a rollup on a hypothetical would under-report every clean unwind that
    // happened to pass through such a node.
    if (input.observedEffectKinds.size === 0) return;
    try {
      const kinds = [...input.observedEffectKinds].sort();
      await recordObligation({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        rootRunId: input.rootRunId,
        nodeId: input.node.nodeId,
        // No `compensationNodeTypeId`: there is no inverse action to name, and
        // inventing one would make the row look invokable to a future reader.
        forwardLogicalInvocationId: logicalInvocationId({
          tenantId: input.run.tenantId,
          runId: input.run.runId,
          nodeId: input.node.nodeId,
          logicalInvocationOrdinal: 0,
          // Namespaced like the declared lane below, so an irreversible row can
          // never collide with an AI-dispatch identity minted from the same
          // (run, node) pair.
          providerKey: 'compensation:irreversible',
        }),
        compensationOrdinal: await nextCompensationOrdinal(input.run.tenantId, input.rootRunId),
        effectKind: kinds[0] ?? 'dispatch',
        shape: 'irreversible',
        resultDigest: digestOf(input.outputs),
        contractDigest: digestOf({ irreversibleEffect: true }),
      });
      log.info('compensation_irreversible_recorded', {
        runId: input.run.runId, nodeId: input.node.nodeId,
      });
    } catch (err) {
      log.error('compensation_irreversible_record_failed', {
        runId: input.run.runId,
        nodeId: input.node.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Narrowed for the compiler AND for the reader: past the `irreversible`
  // return above, a declaration is the only remaining reason to be here.
  if (!declaration) return;

  try {
    const kinds = [...input.observedEffectKinds];
    // Deterministic pick so a node touching two seams classifies the same way on
    // every run: the union is sorted and the first member wins.
    const effectKind: EffectKind = kinds.sort()[0] ?? 'dispatch';
    // A DECLARED inverse is always a `forward-effect` shape: RFC 0151 §B's
    // `nodeTypeId` names a node, and running a node is a new effect that can
    // itself fail (P0 finding 2). `author-declared` is reserved for the case the
    // host could not observe an effect at all — the author's word is then the
    // only evidence, and the row says so instead of implying the host verified
    // anything. `irreversible` never appears here, because an irreversible
    // effect has no `nodeTypeId` to declare.
    const shape: CompensationShape = kinds.length > 0 ? 'forward-effect' : 'author-declared';
    const ordinal = await nextCompensationOrdinal(input.run.tenantId, input.rootRunId);
    await recordObligation({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      rootRunId: input.rootRunId,
      nodeId: input.node.nodeId,
      compensationNodeTypeId: declaration.nodeTypeId,
      ...(declaration.requiresApproval !== undefined
        ? { requiresApproval: declaration.requiresApproval }
        : {}),
      // RFC 0151 §B (S36) — the EFFECTIVE value, resolved once, here. Not the
      // raw declaration: §B's default is the post-escalation `requiresApproval`,
      // and the policy is only in scope at mint.
      waiveRequiresApproval: effectiveWaiveRequiresApproval(declaration, input.policy),
      // §B/§F — RECORD the inverse input now, at the moment the forward effect
      // committed, rather than re-reading the declaration when the unwind runs.
      // A workflow redefined in between would otherwise hand the compensator a
      // mapping the original effect never saw.
      ...(declaration.inputMapping !== undefined
        ? {
            compensationInput: resolveCompensationInput(declaration.inputMapping, {
              nodeId: input.node.nodeId,
              outputs: input.outputs,
              runInputs: (input.run.inputs ?? {}) as Record<string, unknown>,
            }),
          }
        : {}),
      // RFC 0151 §C's forward slot, composed from RFC 0150 §B's Layer-2 logical
      // effect identity — the ONE owner of that composition
      // (`host/effectIdentity.ts`, ADR 0549 P3), not a second recipe beside it.
      //
      // ATTEMPT-INDEPENDENCE is the property that carries: §B retired the v1
      // composition precisely because an identity that varies per attempt is
      // not an identity, and the input type has no field for an attempt, so a
      // node that succeeded on its third try owes exactly ONE inverse. Ordinal
      // 0 because a node owes one inverse for its declared compensation
      // regardless of how many provider calls it made along the way; the
      // `providerKey` names the compensation lane so this can never collide
      // with the AI-dispatch identities minted from the same (run, node).
      forwardLogicalInvocationId: logicalInvocationId({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        nodeId: input.node.nodeId,
        logicalInvocationOrdinal: 0,
        providerKey: `compensation:${declaration.nodeTypeId}`,
      }),
      compensationOrdinal: ordinal,
      effectKind,
      shape,
      resultDigest: digestOf(input.outputs),
      contractDigest: digestOf(declaration),
    });
  } catch (err) {
    log.error('compensation_obligation_record_failed', {
      runId: input.run.runId,
      nodeId: input.node.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markMintFailureIrreversible(input, declaration, err);
  }
}

/**
 * A forward effect COMMITTED and its obligation could not be recorded.
 *
 * Until now this was caught, logged and dropped, which is the worst of the
 * available answers: the effect happened, the plan does not contain it, and the
 * rollup therefore reports `completed` (or `none`) for a run that still owes an
 * inverse. A wrong answer that looks right — and silent, because a log line at
 * ERROR is not a status anyone reads during an incident.
 *
 * WHY NOT RETHROW. The obvious fix is to fail the node. It is not safe here:
 * `markCompleted` has already run, so throwing hands the executor a failed node
 * whose effect committed, and a retry re-runs the forward action — turning a
 * bookkeeping failure into a DUPLICATE PAYMENT. The one thing worse than an
 * unrecorded inverse is a second charge while recording it.
 *
 * So instead the ledger is told the truth in its own vocabulary. RFC 0151 §B's
 * `irreversible` entry exists, in `compensation.md`'s words, "so the plan, and
 * therefore the rollup, tells the truth about what was not undone" — which is
 * exactly this run's situation: an effect this host committed and cannot undo,
 * because it no longer knows how. `foldCompensationStatus` caps a plan holding
 * one at `partial`/`failed` and can never reach `completed`, so the lie is
 * unreachable rather than merely unlikely.
 *
 * Best-effort by construction: if THIS write fails too, the metric and the error
 * log are all that is left, and the counter is what an operator alerts on.
 */
async function markMintFailureIrreversible(
  input: RecordForwardObligationInput,
  declaration: CompensationDeclaration | undefined,
  cause: unknown,
): Promise<void> {
  const mintKinds = [...input.observedEffectKinds];
  recordCompensationObligation(mintKinds[0] ?? 'dispatch', 'irreversible');
  try {
    const marker = await recordObligation({
      tenantId: input.run.tenantId,
      runId: input.run.runId,
      rootRunId: input.rootRunId,
      nodeId: input.node.nodeId,
      forwardLogicalInvocationId: logicalInvocationId({
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        nodeId: input.node.nodeId,
        logicalInvocationOrdinal: 0,
        providerKey: `compensation:mint-failed:${declaration?.nodeTypeId ?? 'unknown'}`,
      }),
      compensationOrdinal: await nextCompensationOrdinal(input.run.tenantId, input.rootRunId),
      effectKind: mintKinds[0] ?? 'dispatch',
      shape: 'irreversible',
      resultDigest: digestOf(input.outputs),
      contractDigest: digestOf({ mintFailed: true, cause: cause instanceof Error ? cause.name : 'unknown' }),
    });
    // …and immediately park it at `manual_intervention_required`.
    //
    // Necessary, not decorative: §D's rollup answers `none` for a plan nobody
    // requested, which is right for a healthy run and wrong here — the marker
    // would be durable and still invisible. Moving it off `requested` both
    // makes the row count as progress and states the honest operational fact:
    // this run committed an effect whose inverse the host can no longer
    // perform, and a human has to decide what happens next. `manual` outranks
    // every other value in the fold, which is the correct precedence.
    await resolveObligation({
      tenantId: input.run.tenantId,
      inverseActionId: marker.inverseActionId,
      to: 'manual_intervention_required',
      reason: 'the forward effect committed but its obligation could not be recorded',
    });
    log.error('compensation_mint_failure_marked_irreversible', {
      runId: input.run.runId, nodeId: input.node.nodeId,
    });
  } catch (markErr) {
    // Nothing durable is left to say it with; the counter above already fired.
    log.error('compensation_mint_failure_unmarked', {
      runId: input.run.runId,
      nodeId: input.node.nodeId,
      error: markErr instanceof Error ? markErr.message : String(markErr),
    });
  }
}

/**
 * RFC 0151 §B — resolve an `inputMapping` AT PLAN TIME, from recorded facts.
 *
 * Grammar (SP-11a): `${inputs.<name>}` and `${nodes.<nodeId>.output.<port>}`.
 * A value that is EXACTLY one token resolves to the RAW TYPED value; a token
 * embedded in a larger string is substituted textually. Objects and arrays are
 * walked. Anything unresolvable FAILS THE MINT.
 *
 * Before this, the mapping was recorded and later handed to the compensator
 * VERBATIM — so a compensator declared as `{ chargeId: '${nodes.charge.output.id}' }`
 * received that literal string and refunded a charge id that never existed.
 * RFC 0151 §B's own example did not work on this host. The failure surfaced at
 * unwind time, during an incident, as a compensator doing something absurd
 * rather than as an error anyone could act on.
 *
 * Failing the mint is deliberate and is why this pairs with H58c: an
 * unresolvable mapping means the declared inverse CANNOT be built from what was
 * recorded, so the effect is un-undoable by this host. That is exactly the state
 * H58c marks `manual_intervention_required` — visible, human-owned, and unable
 * to report a clean unwind. Silently recording a mapping nobody can execute
 * would be the worse half of both worlds.
 *
 * Scope note: only THIS node's outputs are in hand at mint. A reference to a
 * different node is therefore unresolvable here and fails — correctly, because
 * the value would have to come from somewhere this function cannot see, and
 * guessing is what produced the literal-string behaviour being fixed.
 */
export class UnresolvableCompensationInputError extends Error {}

const TOKEN = /\$\{([^}]+)\}/g;
const WHOLE = /^\$\{([^}]+)\}$/;

function lookupToken(path: string, ctx: { nodeId: string; outputs: Record<string, unknown>; runInputs: Record<string, unknown> }): unknown {
  const inputs = /^inputs\.(.+)$/.exec(path);
  if (inputs) {
    const key = inputs[1]!;
    if (!(key in ctx.runInputs)) {
      throw new UnresolvableCompensationInputError(`\`\${inputs.${key}}\` is not among the run's inputs`);
    }
    return ctx.runInputs[key];
  }
  const node = /^nodes\.([^.]+)\.output\.(.+)$/.exec(path);
  if (node) {
    const [, nodeId, port] = node as unknown as [string, string, string];
    if (nodeId !== ctx.nodeId) {
      throw new UnresolvableCompensationInputError(
        `\`\${nodes.${nodeId}.output.${port}}\` refers to another node; only the committing node's outputs are recorded at mint`,
      );
    }
    if (!(port in ctx.outputs)) {
      throw new UnresolvableCompensationInputError(`\`\${nodes.${nodeId}.output.${port}}\` is not among that node's outputs`);
    }
    return ctx.outputs[port];
  }
  throw new UnresolvableCompensationInputError(`\`\${${path}}\` is not a recognised reference`);
}

export function resolveCompensationInput(
  mapping: Record<string, unknown>,
  ctx: { nodeId: string; outputs: Record<string, unknown>; runInputs: Record<string, unknown> },
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = WHOLE.exec(v);
      // Whole-value: the RAW typed value, not its string form. A number stays a
      // number; an object stays an object. Coercing here is how a compensator
      // ends up comparing "42" to 42 downstream.
      if (whole) return lookupToken(whole[1]!.trim(), ctx);
      return v.replace(TOKEN, (_m, p: string) => String(lookupToken(p.trim(), ctx)));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(mapping) as Record<string, unknown>;
}

/**
 * Unwind a run that a DISPATCH path is about to mark terminal.
 *
 * The sweeper's `dispatch_abandoned` and the inline `dispatch_failed` both call
 * `emitTerminalFailure` directly, so neither ever reached the executor's single
 * unwind call. For a run that never started that is harmless — nothing is
 * minted. For a RESUMED run that had already committed effects it stranded
 * every obligation at `requested` forever, which the §D rollup then reported as
 * a plan about to start.
 *
 * Best-effort and non-fatal: these paths exist to stop a run that is already
 * going wrong, and failing them because an inverse could not run would replace
 * a stranded plan with a stuck one. The ledger records what happened either way.
 */
export async function unwindOnDispatchTerminal(
  storage: Storage,
  runId: string,
  cause: 'dispatch-abandoned' | 'dispatch-failed',
): Promise<void> {
  try {
    const run = await storage.getRun(runId);
    if (!run) return;
    // Cheap exit for the common case: no obligations, nothing to unwind. Saves
    // resolving a definition for every swept orphan.
    if ((await obligationsForRunTree(run.tenantId, run.runId)).length === 0) return;
    const definition = await resolveDefinitionForRun(run);
    if (!definition) return;
    await unwindTerminatedRun({ storage, run, definition, trigger: compensationTriggerFor(cause) });
  } catch (err) {
    log.error('compensation_unwind_on_dispatch_terminal_failed', {
      runId, cause, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Resolve a sub-run's workflow definition, so the unwind can read its §B
 *  declarations. */
export type CompensationDefinitionResolver = (run: RunRecord) => Promise<WorkflowDefinition | null>;

let definitionResolver: CompensationDefinitionResolver | null = null;

/**
 * Late-bound at boot (`src/index.ts`, beside `setSubWorkflowDispatcher`) and
 * for the same reason: the workflow CATALOG lives on the host adapter suite,
 * which the executor does not hold, and threading it through `executeRun` would
 * widen a signature every caller pins for one optional read.
 *
 * Unset ⇒ sub-run declarations are not resolved, so a child's obligations fall
 * through to `manual_intervention_required` with the reason recorded, rather
 * than being silently dropped from the plan. Fail-visible, not fail-quiet.
 */
export function setCompensationDefinitionResolver(fn: CompensationDefinitionResolver | null): void {
  definitionResolver = fn;
}

/**
 * ADR 0554 P3 — resolve a run's own definition through the BOOT-REGISTERED
 * resolver above.
 *
 * The Operations recovery route needs the run's `WorkflowDefinition` to resume
 * an unwind, and `Storage` has no workflow catalog (`index.ts` binds the suite's
 * catalog into the resolver at boot for exactly this reason). Exposing the
 * existing resolver is the alternative to the route reaching for a second
 * catalog handle and the two disagreeing about which revision a run ran.
 *
 * `null` when nothing is registered (a test boot) or the workflow is gone. The
 * caller must treat that as "cannot resume", never as "nothing to resume" — the
 * obligations are still owed and still durable.
 */
export async function resolveDefinitionForRun(run: RunRecord): Promise<WorkflowDefinition | null> {
  return definitionResolver ? definitionResolver(run) : null;
}

export interface UnwindTerminatedRunInput {
  storage: Storage;
  run: RunRecord;
  definition: WorkflowDefinition;
  /** Override the boot-registered sub-run definition resolver (tests). */
  resolveDefinition?: CompensationDefinitionResolver;
  /** RFC 0051 approval gate for a `requiresApproval` inverse. Absent ⇒ the
   *  unwind records `manual_intervention_required` rather than executing an
   *  approval-gated effect ungated. */
  requestApproval?: UnwindDeps['requestApproval'];
  /** What started the unwind. RFC 0151 §B `triggers` decides whether this one
   *  qualifies; defaults to the only trigger P2 implements. */
  trigger?: CompensationTrigger;
}

/**
 * Drive the unwind for a terminally-failed (or cancelled) run.
 *
 * Called BEFORE the terminal event is appended: `observability.md` §"Terminal
 * events" requires `run.failed` to be the LAST event in the stream, so every
 * `compensation.*` event has to precede it. That is also the honest order — the
 * unwind genuinely happens while the run is dying, not after it is filed.
 *
 * Returns `null` when the run owed nothing, so the caller can tell "no
 * compensation contract applied" from "an unwind ran and reported `none`".
 */
export async function unwindTerminatedRun(
  input: UnwindTerminatedRunInput,
): Promise<UnwindResult | null> {
  const { storage, run, definition } = input;
  // A sub-run does NOT unwind on its own. Its obligations belong to the root's
  // plan, and unwinding them here would compensate a child's effects while the
  // parent is still running — out of order, and possibly for a parent that goes
  // on to succeed.
  if (typeof run.parentRunId === 'string' && run.forkMode === undefined) return null;

  // RFC 0151 §B `triggers` — WHICH FAILURES QUALIFY is read from the authored
  // policy, never from a host heuristic. "A trigger not listed here does NOT
  // start an unwind; the run ends with its committed effects in place and
  // `compensationStatus: none`, which is the honest shape — no generic rollback
  // is inferred from an undeclared trigger."
  const policy = definition.settings?.compensation;
  const trigger: CompensationTrigger = input.trigger ?? 'node-failure';
  if (!policyAdmitsTrigger(policy, trigger)) {
    log.info('compensation_unwind_trigger_not_declared', { runId: run.runId, trigger });
    return null;
  }

  try {
    const resolve = input.resolveDefinition ?? definitionResolver ?? (async () => null);
    const declarations = await collectDeclarations(storage, { runId: run.runId, definition }, resolve);
    if (declarations.size === 0) return null;

    const deps: UnwindDeps = {
      appendEvent: (event) => appendCompensationEvent(run.runId, event),
      markPlanRequested,
      invoke: (step) =>
        invokeInverseAction(run, step.obligation, step.declaration, step.attempt),
      requestApproval: input.requestApproval ?? ((step) => gateCompensationApproval(run, step.obligation, step.declaration)),
    };

    // RFC 0151 §F — WHICH RUN'S PLAN a replay reads.
    //
    // A replay mints NO obligations (`recordForwardObligation` returns early for
    // `forkMode: 'replay'`), so reading the replay's own tree finds an EMPTY
    // plan and reports nothing. That is not "uses recorded compensation
    // outcomes"; it is "has no outcomes to use", and the two are only
    // indistinguishable until someone asks the replay what it compensated.
    //
    // §F's rule is that a replay uses the RECORDED plan of the run it is
    // reproducing, so the plan is read from the SOURCE run. Nothing can fire off
    // it: `replaying: true` makes `unwindRun` report and invoke nothing, and the
    // two fences are independent on purpose.
    const planRunId = compensationPlanRunId(run);

    return await unwindRun({
      tenantId: run.tenantId,
      runId: planRunId,
      declarations,
      ...(policy ? { policy } : {}),
      // RFC 0151 §F. A replay fork reads the recorded outcomes and fires
      // nothing; a `branch` fork is a genuinely new run and unwinds its own.
      replaying: run.forkMode === 'replay',
      deps,
    });
  } catch (err) {
    // An unwind that throws must not swallow the run's own failure — the
    // terminal event still has to land. Log and let the caller finish.
    log.error('compensation_unwind_failed', {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * RFC 0151 §E — RESUME a held plan on an authorized operator's instruction.
 *
 * Separate from `unwindTerminatedRun`, and the difference is one line of policy:
 * this path does NOT consult `policyAdmitsTrigger`. That gate answers "may an
 * unwind START for this failure kind", and here the unwind already started — the
 * plan exists, its rows are durable, and an operator with authority is asking
 * the host to continue it. Running the trigger gate would refuse to resume a
 * plan the same policy authorized into existence, which is why `operator-request`
 * being absent from a workflow's `triggers` must not strip an operator's ability
 * to finish an unwind already in flight.
 *
 * Everything else is the SAME machinery: the same `unwindRun`, the same deps,
 * the same ledger. `unwindRun` only advances non-terminal rows, so a completed
 * inverse is never re-fired by a resume — the property that makes this safe to
 * call twice is the same one that makes crash-resume safe.
 */
export async function resumeUnwindForOperator(input: {
  storage: Storage;
  run: RunRecord;
  definition: WorkflowDefinition;
  /** §21 `substitute` — replace the inverse node type for the held entries. */
  substituteNodeTypeId?: string;
}): Promise<UnwindResult | null> {
  const { storage, run, definition } = input;
  try {
    const resolve = definitionResolver ?? (async () => null);
    const declarations = await collectDeclarations(storage, { runId: run.runId, definition }, resolve);
    if (declarations.size === 0) return null;

    // RESUME vs START — the distinction the trigger-gate bypass above depends on.
    //
    // The bypass is sound for a plan that EXISTS: the same policy authorized it
    // into being, so refusing to finish it would be perverse. But obligations
    // are minted when a forward effect COMMITS, so every run that ever ran a
    // compensable node owns `requested` rows whether or not an unwind was asked
    // for. Reaching this function with only those rows is not a resume at all —
    // it is a START wearing a resume's clothes, and it bypassed both the run's
    // state and the workflow's `triggers`.
    //
    // Concretely, before this guard an operator with `host:compensation:start`
    // could fire every inverse of a RUNNING run — undoing effects underneath a
    // run still producing them — or of a healthy COMPLETED one, and a policy
    // that deliberately omitted `operator-request` could not prevent either.
    // RBAC bounded who could do it; nothing bounded what it applied to.
    //
    // So: if no plan was ever requested, this is a start, and it obeys the same
    // two conditions any other trigger does.
    const rowsNow = await obligationsForRunTree(run.tenantId, run.runId);
    const planExists = rowsNow.some((r) => r.planRequestedAt !== undefined || r.state !== 'requested');
    if (!planExists) {
      if (!isTerminalRunStatus(run.status)) {
        log.info('compensation_operator_start_refused', { runId: run.runId, reason: 'run_not_terminal', status: run.status });
        return null;
      }
      const policy = definition.settings?.compensation;
      if (!policyAdmitsTrigger(policy, 'operator-request')) {
        log.info('compensation_operator_start_refused', { runId: run.runId, reason: 'trigger_not_declared' });
        return null;
      }
    }

    // §21 `substitute`: the operator names a different inverse node type. It is
    // applied to the DECLARATION map rather than rewritten onto the ledger rows,
    // so the obligation's §C identity is untouched — a substituted compensator
    // presents the SAME idempotency key downstream, which is what stops a
    // substitution from becoming a second refund.
    const effective = input.substituteNodeTypeId
      ? new Map([...declarations].map(([k, d]) => [k, { ...d, nodeTypeId: input.substituteNodeTypeId! }]))
      : declarations;

    const policy = definition.settings?.compensation;
    const deps: UnwindDeps = {
      appendEvent: (event) => appendCompensationEvent(run.runId, event),
      markPlanRequested,
      invoke: (step) =>
        invokeInverseAction(run, step.obligation, step.declaration, step.attempt),
      requestApproval: (step) => gateCompensationApproval(run, step.obligation, step.declaration),
    };

    return await unwindRun({
      tenantId: run.tenantId,
      runId: run.runId,
      declarations: effective,
      ...(policy ? { policy } : {}),
      deps,
    });
  } catch (err) {
    log.error('compensation_operator_resume_failed', {
      runId: run.runId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * RFC 0151 §E — the approval gate for one `requiresApproval` inverse action,
 * composed onto the EXISTING approvals surface rather than beside it.
 *
 * The gate is RE-ENTRANT on the obligation's own §C identity: if the ledger row
 * already points at an approval, that row is read rather than a second one
 * raised. Without this, every unwind retry (and every crash-resume) would mint
 * another card for the same inverse, and an operator approving one of them
 * would leave the others open — the approval equivalent of a double
 * compensation.
 */
async function gateCompensationApproval(
  run: RunRecord,
  obligation: { inverseActionId: string; nodeId?: string; approvalId?: string; compensationNodeTypeId?: string },
  declaration: CompensationDeclaration,
): Promise<ApprovalOutcome> {
  const existing = obligation.approvalId ? await getApproval(obligation.approvalId) : null;
  const approval = existing ?? (await createCompensationApproval({
    tenantId: run.tenantId,
    runId: run.runId,
    workflowId: run.workflowId,
    compensationId: obligation.inverseActionId,
    ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
    compensationNodeTypeId: declaration.nodeTypeId,
    ...(typeof run.metadata?.['actingUserId'] === 'string'
      ? { requestedBy: run.metadata['actingUserId'] }
      : {}),
    proposal:
      `Undo the effect committed by node '${obligation.nodeId ?? '(unknown)'}' of run ${run.runId} ` +
      `by running '${declaration.nodeTypeId}'. This is itself a real effect and can fail.`,
  }));

  if (approval.status === 'approved') return { decision: 'approved' };
  if (approval.status === 'rejected') {
    return { decision: 'denied', detail: `approval ${approval.approvalId} was rejected` };
  }
  return { decision: 'pending', approvalId: approval.approvalId };
}

/**
 * RFC 0151 §E separation of duties, enforced at the ONE decision choke every
 * decide path funnels through (`assertApprovalEligibility`).
 *
 * The rule: the human whose run committed the effect MAY NOT be the human who
 * authorizes undoing it. §G's audit scope names "authority escalation" and
 * "manual override" explicitly, and the failure this closes is concrete — an
 * operator whose payment run failed approving their own refund, with the
 * approval card as the only record that anyone reviewed it.
 *
 * The wildcard-operator escape the ROUTES already grant is honoured (threaded,
 * never re-derived — an eligibility check never sees a Request), because
 * revoking admin tooling's access here would be a different bug in the opposite
 * direction. `isPersonalOwner` is deliberately NOT honoured: a personal
 * workspace has exactly one human, so accepting it would make the rule vacuous
 * precisely where it is the only control.
 */
export function registerCompensationApprovalEligibility(): void {
  registerApprovalEligibility('compensation-action', async (tenantId, decidedBy, approval, opts) => {
    if (opts?.isOperator) return;
    const requestedBy = approval.compensationAction?.requestedBy;
    const compensationId = approval.compensationAction?.compensationId;
    if (!decidedBy) {
      throw new OpenwopError(
        'forbidden_scope',
        'Deciding a compensation action requires an identified approver — an inverse effect is a real effect.',
        403,
        { compensationId },
      );
    }
    if (requestedBy !== undefined && requestedBy === decidedBy) {
      throw new OpenwopError(
        'forbidden_scope',
        'Separation of duties: the person whose run committed this effect cannot approve undoing it (RFC 0151 §E).',
        403,
        { compensationId },
      );
    }

    // ── ADR 0554 P3 — the SECOND excluded principal, for a WAIVE ─────────────
    //
    // A waive approval's `requestedBy` is the operator ASKING to waive. That
    // leaves the operator who STARTED the compensation free to approve
    // abandoning the unwind they themselves set running — the same
    // mark-your-own-homework failure the rule above closes, one hop over.
    //
    // Enforced HERE rather than in a second check because this is the ONE choke
    // every decide path funnels through; a sibling check would be a second
    // authorization owner that drifts.
    if (compensationId?.endsWith(WAIVE_APPROVAL_SUFFIX)) {
      const obligationId = compensationId.slice(0, -WAIVE_APPROVAL_SUFFIX.length);
      let startedBy: string | undefined;
      try {
        const row = await getObligation(tenantId, obligationId);
        // FAIL CLOSED. A missing row means SoD cannot be evaluated at all, and
        // permitting the decision there would make the control vacuous in
        // exactly the case where something has already gone wrong.
        if (!row) {
          throw new OpenwopError(
            'forbidden_scope',
            'Separation of duties cannot be evaluated: this waive references an obligation this host cannot read.',
            403,
            { compensationId },
          );
        }
        startedBy = row.startedBy;
      } catch (err) {
        if (err instanceof OpenwopError) throw err;
        throw new OpenwopError(
          'forbidden_scope',
          'Separation of duties cannot be evaluated: the compensation ledger is unreadable.',
          403,
          { compensationId },
        );
      }
      if (startedBy !== undefined && startedBy === decidedBy) {
        throw new OpenwopError(
          'forbidden_scope',
          'Separation of duties: the operator who started this compensation cannot approve waiving it (RFC 0151 §E).',
          403,
          { compensationId },
        );
      }
    }
  });
}

/** Append one §D event. `type` is a plain string on the way to storage
 *  (`executor/eventLog.ts` takes `type: string`) and is validated against the
 *  corpus `run-event.schema.json`; the pinned SDK carries no typed union for
 *  these six and this phase does not wait for one. */
/**
 * RFC 0151 §F — WHICH RUN'S compensation plan a given run reads.
 *
 * THE ONE OWNER of this rule, and it has to be, because two callers need it: the
 * unwind (to resolve the plan it reports) and the §21 replay seam (to report
 * what the replay resolved). A seam that re-derived the rule would report the
 * source plan even on a host whose unwind had regressed to reading the replay's
 * own empty tree — the report would look right while the behaviour was wrong,
 * which is precisely the vacuity §21's non-vacuity rule is about.
 *
 * MEASURED, not hypothesised: the seam DID carry its own copy of this rule for
 * one round, and sabotaging the runtime's version left every test green.
 */
export function compensationPlanRunId(run: RunRecord): string {
  return run.forkMode === 'replay' && typeof run.parentRunId === 'string' ? run.parentRunId : run.runId;
}

/**
 * The §21 `inverseActions[]` projection for a run, read from the LEDGER.
 *
 * Exported so the seam reports the host's own record rather than assembling one
 * of its own — §21's non-vacuity rule reaches the report as much as the events:
 * a seam that built this array from what it observed would be describing the
 * seam, not the unwind.
 *
 * `executionOrder` is the seam's observed inverse order, used only to RANK the
 * rows (§21 asks for execution order); every field in each row comes from the
 * durable obligation.
 */
export async function compensationPlanReport(
  tenantId: string,
  runId: string,
  executionOrder: readonly number[],
): Promise<InverseActionReport[]> {
  return reportInverseActions(await obligationsForRunTree(tenantId, runId), executionOrder);
}

async function appendCompensationEvent(runId: string, event: CompensationEvent): Promise<void> {
  await getEventLog().append({
    runId,
    type: event.type,
    ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
    payload: event.payload,
  });
}

/**
 * Execute one declared inverse action.
 *
 * The compensator runs INSIDE `runWithEffectContext`, so it crosses the same
 * ADR 0531 guard a forward effect does: P0 finding 2 — "compensation is itself
 * an effect" — is structural here rather than a comment. It also means a
 * compensator reached during a replay fails closed exactly like a forward
 * effect would.
 *
 * `inputMapping` is passed through as the node's inputs unchanged. RFC 0151 §B
 * requires it to derive from RECORDED FACTS, and passing the author's mapping
 * verbatim is the only shape that cannot re-infer anything: there is no
 * template evaluation on this path, so no prompt or model output can be
 * substituted into an inverse during replay.
 */
async function invokeInverseAction(
  run: RunRecord,
  obligation: CompensationObligation,
  declaration: CompensationDeclaration,
  attempt: number,
): Promise<InverseOutcome> {
  const forwardNodeId = obligation.nodeId;
  const inverseActionId = obligation.inverseActionId;

  // RFC 0151 §C — INVOKE FROM THE RECORDED ROW, not from the live definition.
  //
  // "A host MUST NOT rebuild the plan from the workflow definition on resume"
  // (`compensation.md:212-215`). This function was handed `declaration`, which
  // `collectDeclarations` resolves from the CURRENT definition at unwind time,
  // and it invoked `declaration.nodeTypeId` with `declaration.inputMapping`.
  // The row's mint-time `compensationNodeTypeId` / `compensationInput` were
  // carried alongside and only ever REPORTED in the §21 projection — so a
  // workflow edited between the forward commit and the unwind would undo
  // something other than what was recorded, while the report said otherwise.
  // The invariant the report witnessed and the behaviour it described had come
  // apart, which is worse than either being wrong on its own.
  //
  // Fall back to the declaration only for rows minted before those fields
  // existed; a fresh row always carries them.
  const nodeTypeId = obligation.compensationNodeTypeId ?? declaration.nodeTypeId;
  const inputs = obligation.compensationInput ?? declaration.inputMapping ?? {};
  // ADR 0556 P3 / RFC 0154 §D — a compensation action is a side effect taken
  // long after the request that authorized it returned, which makes it exactly
  // the case where "which identities is this running under" stops being
  // obvious. Recorded before the inverse runs so a compensator that throws
  // still leaves the fact behind.
  recordAuthorityAction('compensation', 'attempt');
  const module = await getNodeRegistry().resolve(nodeTypeId);
  if (!module) {
    // §B says `nodeTypeId` MUST resolve at REGISTRATION so an unwind never
    // fails on a typo discovered at the worst possible moment. Reaching here
    // means it did anyway; no retry can fix it.
    return {
      ok: false,
      retryable: false,
      detail: `compensation node type '${nodeTypeId}' is not registered`,
    };
  }

  const ctx: NodeContext = {
    runId: run.runId,
    nodeId: `${forwardNodeId ?? 'compensation'}::compensation`,
    tenantId: run.tenantId,
    inputs,
    config: {},
    configurable: {},
    // The REAL attempt, not a constant. It was pinned at `1` while nothing read
    // it; a compensator that logs or backs off per attempt was silently told
    // every try was the first.
    attempt,
    // RFC 0151 §C — the retry-stable identity, handed to the compensator so it
    // can present it as the downstream idempotency key. `inverseActionId` is
    // CONSTANT across retries and `attempt` is not; a compensator that composed
    // the two would mint a second obligation on every retry, which is the exact
    // double-refund §C's "attempt is outside the identity" rule forbids.
    compensation: { inverseActionId, attempt },
    secrets: {},
    // The inverse action does not write the run's event log directly — its
    // observable record is the §D events, which are content-free. A compensator
    // that emitted freely would put provider detail in the durable log, which
    // §G names as the least revocable place a credential can reach.
    emit: async () => ({ eventId: '', sequence: 0 }),
  };

  let outcome: NodeOutcome;
  try {
    outcome = await runWithEffectContext(
      { runId: run.runId, replaying: run.forkMode === 'replay' },
      () => module.execute(ctx),
    );
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (outcome.status === 'success') {
    log.info('compensation_inverse_completed', {
      runId: run.runId,
      inverseActionId,
      nodeTypeId: declaration.nodeTypeId,
    });
    return { ok: true };
  }
  if (outcome.status === 'failure') {
    // The node's own `retryable` flag decides. A node that says nothing is
    // treated as retryable: re-running an idempotent inverse is safe (the §C
    // identity is stable across attempts), whereas giving up on a transient
    // refund failure strands money.
    return {
      ok: false,
      retryable: outcome.retryable !== false,
      detail: `${outcome.error.code}: ${outcome.error.message}`,
    };
  }
  // A compensator that suspends is asking a human a question mid-unwind. The
  // host has no resume path for that in this phase, and quietly discarding the
  // suspension would report a compensation that never ran.
  return {
    ok: false,
    retryable: false,
    detail: 'compensation node suspended; an inverse action cannot interrupt in this phase',
  };
}

export type { CompensationStatus };
