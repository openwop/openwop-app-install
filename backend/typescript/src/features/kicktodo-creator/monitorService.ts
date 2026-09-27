/**
 * Post-publication monitoring + the kill switch (ADR 0415 P4; PRD §7.3 W8).
 *
 * MONITOR: deterministic health checks over a published candidate's dossier
 * sources. The fetcher is INJECTED — production wires the SSRF-guarded egress
 * seam (ADR 0405 `guardedEgressFetch` posture); tests inject fakes. A failing
 * source never edits content — it opens a review finding (PRD: monitoring
 * triggers review, it does not rewrite).
 *
 * KILL SWITCH: unlist = `retireChallenge` on the kicktodo-core owner — new
 * enrollments are refused while ACTIVE and HISTORICAL enrollments keep their
 * pinned version (the PRD §13 retirement contract); the candidate is marked
 * withdrawn with the reason preserved for audit.
 */

import { createLogger } from '../../observability/logger.js';
import { retireChallenge } from '../kicktodo-core/challengeService.js';
import { getCandidate, type FactoryCandidate } from './creatorService.js';
import { getPublication } from './publishService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

const log = createLogger('kicktodo.monitor');

export type SourceHealth = 'ok' | 'redirected' | 'broken' | 'unreachable';

export interface SourceHealthFinding {
  sourceHash: string;
  url: string;
  health: SourceHealth;
  httpStatus?: number;
  checkedAt: string;
}

export interface MonitorReport {
  tenantId: string;
  candidateId: string;
  findings: SourceHealthFinding[];
  broken: number;
  checkedAt: string;
}

const reports = new DurableCollection<MonitorReport>(
  'kicktodo-monitor-reports',
  (r) => `${r.tenantId}::${r.candidateId}`,
);

export type HealthFetcher = (url: string) => Promise<{ status: number; redirected: boolean }>;

/** Check every dossier source's availability with the injected fetcher. */
export async function checkSources(
  tenantId: string,
  candidateId: string,
  fetcher: HealthFetcher,
): Promise<MonitorReport | null> {
  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate?.dossier) return null;
  const now = new Date().toISOString();
  const findings: SourceHealthFinding[] = [];
  for (const s of candidate.dossier.sources) {
    let health: SourceHealth;
    let httpStatus: number | undefined;
    try {
      const res = await fetcher(s.url);
      httpStatus = res.status;
      health = res.status >= 200 && res.status < 300 ? (res.redirected ? 'redirected' : 'ok') : 'broken';
    } catch {
      health = 'unreachable';
    }
    findings.push({ sourceHash: s.hash, url: s.url, health, ...(httpStatus !== undefined ? { httpStatus } : {}), checkedAt: now });
  }
  const report: MonitorReport = {
    tenantId,
    candidateId,
    findings,
    broken: findings.filter((f) => f.health === 'broken' || f.health === 'unreachable').length,
    checkedAt: now,
  };
  await reports.put(report);
  if (report.broken > 0) {
    log.warn('kicktodo_sources_unhealthy', { candidateId, broken: report.broken });
  }
  return report;
}

export async function getMonitorReport(tenantId: string, candidateId: string): Promise<MonitorReport | null> {
  return (await reports.get(`${tenantId}::${candidateId}`)) ?? null;
}

export class KillSwitchError extends Error {}

/**
 * The operator kill switch: retire the published version (kicktodo-core owner
 * refuses NEW enrollments; active/historical enrollments keep their pinned
 * version) and mark the candidate withdrawn with the audited reason.
 */
export async function killSwitch(
  tenantId: string,
  candidateId: string,
  reason: string,
  actor: string,
): Promise<FactoryCandidate> {
  const candidate = await getCandidate(tenantId, candidateId);
  if (!candidate) throw new KillSwitchError('Candidate not found.');
  const publication = await getPublication(tenantId, candidateId);
  if (publication) {
    const retired = await retireChallenge(tenantId, publication.challengeId, publication.challengeVersion);
    if (!retired) throw new KillSwitchError('The published challenge could not be retired.');
  }
  // Candidate projection — CAS via the creator store's own collection (reuse
  // the service seam: mark withdrawn through a bounded read-modify-write).
  const { __setCandidateWithdrawn } = await import('./creatorService.js');
  const next = await __setCandidateWithdrawn(tenantId, candidateId, reason, actor);
  if (!next) throw new KillSwitchError('Candidate not found.');
  log.warn('kicktodo_kill_switch', { candidateId, reason, actor });
  return next;
}
