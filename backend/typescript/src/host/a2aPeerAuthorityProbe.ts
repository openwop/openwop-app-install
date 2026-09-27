/**
 * ADR 0552 P2 — the honest witness behind `host-sample-test-seams.md` §22's
 * `peerAuthority` block (invariant `a2a-peer-no-authority-escalation`).
 *
 * The seam is asked to report three booleans: `approvalAdvanced`,
 * `scopesWidened`, `referencedTaskDereferenced`, all of which MUST be `false`.
 * Three hard-coded `false`s would satisfy the suite and prove nothing — the
 * exact "gate that cannot fail" shape. So each is MEASURED against real state:
 *
 *   - `approvalAdvanced` — a genuine run is started and parked at a
 *     `core.approvalGate` BEFORE the peer is called. The flag compares that
 *     run's status and open-interrupt count before and after the peer's reply
 *     goes through the production ingestion (`ingestPeerReply`). A host that
 *     honoured `metadata.openwop.approval` would resolve the interrupt and the
 *     flag would flip.
 *   - `scopesWidened` — the peer names scopes it wants (`runs:cancel`,
 *     `secrets:read`). The flag asks whether any of them can now be found
 *     anywhere on the persisted run record. A host that merged peer-asserted
 *     scopes into `run.configurable` would flip it.
 *   - `referencedTaskDereferenced` — the peer plants a `referenceTaskIds[]`
 *     pointing at a task the caller never created. The flag asks whether any
 *     outbound A2A call this host made afterwards named that id, read off the
 *     client's own call recorder rather than off intent.
 *
 * VACUITY GUARD: if the peer asserted nothing at all, this returns `null` and
 * the seam omits the block. `a2a-peer-authority.test.ts` records a missing
 * block as `blocked`, which is the honest disposition for a check that had
 * nothing to check — reporting `false` there would be the same lie in a
 * quieter voice.
 */

import type { Storage } from '../storage/storage.js';
import type { A2aServiceDeps } from './a2aService.js';
import type { A2aCallRecord } from './a2aSurface.js';
import { startWorkflowRun } from './runStarter.js';
import { extractPeerAssertions, ingestPeerReply } from './a2aPeerIngest.js';
import { a2aInvocableWorkflowId } from './a2aCard.js';

/** The pre-call snapshot the three flags are measured against. */
export interface PeerAuthorityProbe {
  runId: string;
  status: string;
  openInterrupts: number;
}

export interface PeerAuthorityReport {
  approvalAdvanced: boolean;
  scopesWidened: boolean;
  referencedTaskDereferenced: boolean;
}

/** How long to wait for the probe run to reach its approval gate. */
const PROBE_SETTLE_MS = 3_000;
const PROBE_POLL_MS = 25;

/**
 * Start a real approval-gated run and wait for it to park there.
 *
 * Returns null when the run never reaches a gate — an unparked run cannot
 * witness "the approval did not advance", and the seam degrades to `blocked`
 * rather than reporting a flag it could not measure.
 */
export async function startPeerAuthorityProbe(
  deps: A2aServiceDeps,
  tenantId: string,
): Promise<PeerAuthorityProbe | null> {
  const runId = await startWorkflowRun(deps, { tenantId, workflowId: a2aInvocableWorkflowId() });
  if (!runId) return null;
  const deadline = Date.now() + PROBE_SETTLE_MS;
  for (;;) {
    const run = await deps.storage.getRun(runId);
    const open = await deps.storage.listOpenInterrupts(runId);
    if (run && open.length > 0) return { runId, status: run.status, openInterrupts: open.length };
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
  }
}

/**
 * Run the peer's reply through the production ingestion, then measure.
 *
 * The ingestion call is the point of the whole exercise: the flags describe
 * what happened when this host actually processed the reply, not what a
 * reviewer believes the code would do.
 */
export async function settlePeerAuthorityProbe(
  storage: Storage,
  probe: PeerAuthorityProbe,
  reply: unknown,
  calls: readonly A2aCallRecord[],
): Promise<PeerAuthorityReport | null> {
  const asserted = extractPeerAssertions(reply);
  const assertedAnything =
    asserted.approval !== undefined ||
    asserted.interruptResolve !== undefined ||
    asserted.scopes.length > 0 ||
    asserted.referenceTaskIds.length > 0;
  if (!assertedAnything) return null;

  // The production path. Everything below observes its consequences.
  ingestPeerReply(reply);

  const after = await storage.getRun(probe.runId);
  const openAfter = await storage.listOpenInterrupts(probe.runId);
  const approvalAdvanced =
    after === null || after.status !== probe.status || openAfter.length < probe.openInterrupts;

  // Does any scope the peer proposed now appear anywhere on the persisted run?
  // Serialising the whole record deliberately: a host that leaked the peer's
  // scopes into `configurable`, `metadata`, or a field this probe has not heard
  // of yet is caught the same way.
  const runJson = after === null ? '' : JSON.stringify(after);
  const scopesWidened = asserted.scopes.some((s) => runJson.includes(s));

  // Did the host go and fetch what the peer pointed at? Read off the client's
  // own record of what it sent, so a dereference that happened by any route
  // shows up — not off a flag the dereferencing code would have to set.
  const outbound = JSON.stringify(calls);
  const referencedTaskDereferenced = asserted.referenceTaskIds.some((id) => outbound.includes(id));

  return { approvalAdvanced, scopesWidened, referencedTaskDereferenced };
}
