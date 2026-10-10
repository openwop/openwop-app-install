/**
 * ADR 0829 P5 — the evidence for the protocol tripwire: "openwop-app's handoff
 * record is stable for 30 days in two real workflows". One usage row per
 * (tenant, workflow) whose runs WRITE a record (a `core.dispatch` handoff or an
 * escalation), with the record version seen. Card notes are a person's handoff,
 * not a workflow's, and are not counted. Counts and dates only.
 *
 * `GET /host/openwop-app/structured-handoffs/evidence` — superadmin (it reads
 * across tenants).
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { HandoffRecorded } from '../../host/handoff/handoffObservers.js';
import { usageEvidenceStore } from '../../host/usageEvidence.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { vendorPath } from '../../middleware/protocolVersion.js';

export const handoffEvidence = usageEvidenceStore('structured-handoffs:evidence');

export function handoffEvidenceObserver(storage: RouteDeps['storage']) {
  return async (e: HandoffRecorded): Promise<void> => {
    if (e.origin.kind !== 'run') return;
    const run = await storage.getRun(e.origin.runId);
    if (!run || run.tenantId !== e.tenantId) return;
    await handoffEvidence.record(e.tenantId, `workflow:${run.workflowId}`, new Date(), e.record.v);
  };
}

export function registerHandoffEvidenceRoute(deps: RouteDeps): void {
  deps.app.get(vendorPath('/structured-handoffs/evidence'), async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Protocol tripwire evidence');
      res.json(await handoffEvidence.summarize('Second half of the tripwire (another host asks for the record) is outside this app.'));
    } catch (err) { next(err); }
  });
}
