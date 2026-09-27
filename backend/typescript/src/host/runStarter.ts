/**
 * Shared run-starter for host-extension trigger surfaces (best-effort).
 *
 * The scheduler "Run now" + the agent heartbeat "Check now" both need to start
 * a workflow run the same way `POST /v1/runs` does — resolve the workflow via
 * the catalog, insert a pending run, dispatch it — but with a small attribution
 * block stamped onto the run's metadata so the run-detail UI can show where the
 * run came from (a schedule, a heartbeat pick-up, …). This centralizes that
 * recipe so replay/fork/observability are inherited unchanged.
 *
 * The Kanban card→run path does NOT use this — it routes through the RFC 0083
 * durable trigger bridge (dedup/retry/dead-letter) in routes/kanban.ts, a
 * stronger guarantee that the simple schedule/heartbeat triggers don't need.
 *
 * @see src/routes/runs.ts — the POST /v1/runs recipe this mirrors
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../types.js';
import type { RunRecord } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import type { Storage } from '../storage/storage.js';
import { definitionHashOf } from './definitionHash.js';
import { resolveLaunchWorkflow } from './resolveLaunchDefinition.js';
import { executeRun } from '../executor/executor.js';
import { recordRunAttribution } from './agentRunActivityIndex.js';
import { insertRunWithStartContext } from './runInsert.js';
import { stripReservedRunMetadata } from './runDispatch.js';
import { workflowBudgetExhausted } from './workflowBudgets.js';
import { seedRunVariables } from './variablesRuntime.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runStarter');

export interface StartRunDeps {
  storage: Storage;
  /** Only the two members startWorkflowRun actually uses, narrowed from the
   *  full 15-slot HostAdapterSuite (interface segregation). A full HostAdapterSuite
   *  is structurally assignable, so production callers pass it unchanged; tests
   *  can supply a minimal, fully-typed stub without casting the whole suite. */
  hostSuite: Pick<HostAdapterSuite, 'workflowCatalog' | 'providerPolicyResolver'>;
}

/** Resolve `workflowId`, insert a pending run, and dispatch it. Returns the new
 *  runId, or null when the workflow id does not resolve (the caller treats a
 *  null as "nothing fired" rather than an error — mirrors the Kanban posture). */
export async function startWorkflowRun(
  deps: StartRunDeps,
  input: {
    tenantId: string;
    workflowId: string;
    /** Optional caller-owned deterministic id. This is intentionally a narrow
     * internal idempotency seam for durable trigger/outbox consumers: a retry
     * returns the already-created matching run and never schedules a second
     * executor wakeup. Public HTTP callers continue to use their ledger-backed
     * Idempotency-Key contract instead. */
    runId?: string;
    /** Attribution block stamped onto `run.metadata` (e.g. `{ schedule: {...} }`). */
    metadata?: Record<string, unknown>;
    /** Run-level `configurable` (e.g. the ADR 0024 §4 / Option C
     *  `connections: [...]` credential opt-in). */
    configurable?: Record<string, unknown>;
    inputs?: Record<string, unknown> | null;
    /** ADR 0473 — approve-what-you-see closes at the LAST read: when set, the
     *  definition THIS dispatch resolved must hash to exactly this value (a
     *  racing edit, or a catalog source shadowing the registry, refuses). The
     *  caller treats null as "nothing fired" and compensates. */
    expectedDefinitionHash?: string;
    /** ADR 0474 P1b — 'draft' runs the head (the composed-proposal approve:
     *  the hash it verified IS the head's); default resolves published-when-present. */
    launch?: 'draft' | 'published';
  },
): Promise<string | null> {
  const { storage, hostSuite } = deps;
  if (input.runId !== undefined) {
    const existing = await storage.getRun(input.runId);
    if (existing) {
      if (existing.tenantId !== input.tenantId || existing.workflowId !== input.workflowId) {
        throw new OpenwopError('conflict', 'A deterministic workflow run id is already bound to different work.', 409, {
          runId: input.runId,
        });
      }
      return existing.runId;
    }
  }
  // ADR 0474 P1b — every starter-driven launch (schedules, heartbeats, agent
  // dispatch, approved proposals) is a PRODUCTION launch: published-when-present.
  const wf = await resolveLaunchWorkflow(hostSuite.workflowCatalog, input.tenantId, input.workflowId, { launch: input.launch ?? 'published' });
  if (!wf) {
    log.warn('run_starter_workflow_not_found', { workflowId: input.workflowId });
    return null;
  }
  if (input.expectedDefinitionHash !== undefined && definitionHashOf(wf.definition) !== input.expectedDefinitionHash) {
    log.warn('run_starter_definition_hash_mismatch', { workflowId: input.workflowId });
    return null;
  }
  // ADR 0482 §5 — daily hard cap: every starter-driven launch (schedules,
  // triggers, kanban, MCP, CRM, approved proposals) is refused while a
  // hard-capped budget is exhausted. Review H1 — a NULL return here was
  // indistinguishable from "definition missing" for ~30 callers (bricking
  // approvals with a false diagnosis and telling agents the workflow was
  // gone): the refusal is now a TYPED throw every lane can relay honestly.
  // FAIL-OPEN on read errors; debug/eval/redrive lanes never route through
  // here (their own routes, by design).
  if (await workflowBudgetExhausted(input.tenantId, input.workflowId)) {
    log.warn('run_starter_budget_exhausted', { workflowId: input.workflowId });
    throw new OpenwopError(
      'rate_limited',
      "This workflow's daily budget is spent and its hard cap is on — new runs are paused until tomorrow (UTC). Raise or remove the budget to continue.",
      429,
      { workflowId: input.workflowId, reason: 'workflow_budget_exhausted' },
    );
  }
  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId,
    workflowId: input.workflowId,
    tenantId: input.tenantId,
    status: 'pending',
    inputs: input.inputs ?? null,
    // ADR 0474 P1b (review F5) — the launch resolution is stamped, not implied.
    // ADR 0476 (review L1) — the reserved-key spoof guard was anchored only
    // at buildRunRecord; every current startWorkflowRun caller host-composes
    // metadata, but the strip HERE keeps that true for future callers.
    metadata: { ...stripReservedRunMetadata(input.metadata), launchResolved: wf.launchResolved },
    configurable: input.configurable ?? {},
    createdAt: now,
    updatedAt: now,
  };
  // ADR 0099 — the single run-insert seam freezes cross-cutting run-start
  // decisions (tool-output compaction) into run.metadata at creation. Covers
  // every startWorkflowRun caller (scheduled / trigger / heartbeat / approval /
  // agent / webhook).
  // ADR 0551 P1 — `enqueueDispatch`: every caller of this helper (scheduled /
  // trigger / heartbeat / approval / agent / webhook) ends in the same
  // `setImmediate(executeRun)` below, so they inherit the same durability gap
  // and the same fix. The definition came from the catalog, so the durable
  // worker can re-resolve it.
  try {
    await insertRunWithStartContext(storage, run, { definition: wf.definition, enqueueDispatch: true });
  } catch (err) {
    // Two workers can observe an expired Kanban/work-source lease at the same
    // time. The deterministic primary key is the final arbiter: when another
    // worker won the insert race, return its run without emitting a second
    // wakeup. Any other insert failure is real and must remain visible.
    if (input.runId !== undefined) {
      const existing = await storage.getRun(input.runId);
      if (existing && existing.tenantId === input.tenantId && existing.workflowId === input.workflowId) {
        return existing.runId;
      }
    }
    throw err;
  }
  // CRMGAP-12 fix: seed the per-run variable bag from the workflow's declared
  // `variables[].defaultValue` (+ `input.inputs` overrides by name) — the SAME
  // seeding `routes/runs.ts`'s `POST /v1/runs` does before dispatch. Without
  // this, every `startWorkflowRun` caller (schedule "Run now", heartbeat
  // "Check now", AND the host-event dispatcher — this function is the ONE
  // shared recipe, per the file header) executed a chain-instantiated
  // workflow with its variable bag never seeded, so any `{{inputs.X}}`
  // config token (the mechanism `expandChain`'s `params` → `variables[].
  // defaultValue` relies on — see `workflowChainPackLoader.ts`) leaked
  // through LITERALLY instead of resolving. Found via CRMGAP-12's real-
  // executor chain test (`crm-ops.route-new-lead` bound to `host.crm.
  // contact.created`): `{{inputs.ownerId}}` landed on the contact's `owner`
  // field verbatim. Not CRM-specific — this seeds variables for every
  // startWorkflowRun caller, closing the same latent gap for scheduled/
  // heartbeat-triggered templated workflows too.
  seedRunVariables(runId, wf.definition.variables, input.inputs);
  // Index the agent attribution (if any) so fleet/per-agent activity queries
  // hit an index instead of scanning recent runs. Best-effort — never blocks.
  await recordRunAttribution(storage, run);
  setImmediate(() => {
    executeRun(storage, run, wf.definition, { policyResolver: hostSuite.providerPolicyResolver }).catch((err) => {
      log.error('run_starter_dispatch_failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  return runId;
}
