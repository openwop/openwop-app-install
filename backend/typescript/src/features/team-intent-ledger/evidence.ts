/**
 * ADR 0831 P5 — the evidence for the protocol tripwire: "the team intent ledger
 * runs in production for 30 days on two real projects, with every bound run
 * stamping the ledger version it acted on". One usage row per (tenant, project)
 * each time a run is STAMPED (the P2 contributor), so the count is of runs that
 * really acted on a ledger version. Counts and dates only.
 *
 * `GET /host/openwop-app/team-ledger/evidence` — superadmin (it reads across tenants).
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { usageEvidenceStore } from '../../host/usageEvidence.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { vendorPath } from '../../middleware/protocolVersion.js';

/** The stamp shape version (`run.metadata.teamLedger = {ledgerId, version}`). */
export const TEAM_LEDGER_STAMP_SHAPE = 1;

export const ledgerEvidence = usageEvidenceStore('team-ledger:evidence');

export function registerLedgerEvidenceRoute(deps: RouteDeps): void {
  deps.app.get(vendorPath('/team-ledger/evidence'), async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Protocol tripwire evidence');
      res.json(await ledgerEvidence.summarize('Second half of the tripwire (another host asks to read the ledger across hosts) is outside this app.'));
    } catch (err) { next(err); }
  });
}
