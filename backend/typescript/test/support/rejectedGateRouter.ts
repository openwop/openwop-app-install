/**
 * RFC 0223 — install the timeout sweep's rejected-gate router the way `index.ts`
 * does at boot, for tests that drive `approvalGateTimeout` without `createApp`.
 *
 * The one difference from production is deliberate: this router AWAITS the
 * per-run resume chain, so a test can read the routed outcome (node.failed,
 * the downstream, run.failed) as soon as `timeoutApprovalGateIfDue` returns.
 * Production does not await, because the lazy timeout runs inside HTTP handlers
 * and must not block them on a run's continuation.
 */
import { setRejectedGateRouter } from '../../src/executor/approvalGateTimeout.js';
import { awaitRunResumeChain, dispatchGateResume } from '../../src/routes/interrupts.js';
import type { HostAdapterSuite } from '../../src/host/index.js';
import type { Storage } from '../../src/storage/storage.js';

export function installRejectedGateRouter(storage: Storage, hostSuite: HostAdapterSuite): void {
  setRejectedGateRouter(async (interrupt, rejection) => {
    await dispatchGateResume(storage, hostSuite, interrupt, { action: 'reject', reason: 'timeout' }, rejection);
    await awaitRunResumeChain(interrupt.runId);
  });
}
