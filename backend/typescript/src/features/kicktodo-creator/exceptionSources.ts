/**
 * ADR 0460 Phase 2 — the kicktodo-creator MONITOR-FINDINGS exception source.
 *
 * A published challenge whose post-publication source-health monitor found a
 * broken/unreachable citation is a real exception (its evidence rotted). This
 * source reads the monitor reports (tenant-scoped: candidates by prefix, then a
 * point read per candidate) and projects one row per candidate with broken
 * sources. No new store; no mutation.
 */

import { listCandidates } from './creatorService.js';
import { getMonitorReport } from './monitorService.js';
import { registerExceptionSource, type ExceptionRow } from '../../host/exceptionProjection.js';

const SOURCE_KEY = 'kicktodo:monitor';

async function monitorExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const candidates = await listCandidates(tenantId);
  const rows: ExceptionRow[] = [];
  for (const c of candidates) {
    const report = await getMonitorReport(tenantId, c.id);
    if (!report) continue;
    const broken = report.findings.filter((f) => f.health === 'broken' || f.health === 'unreachable');
    if (broken.length === 0) continue;
    rows.push({
      id: `monitor:${c.id}`,
      source: SOURCE_KEY,
      severity: 'attention',
      label: `${c.topic}: ${broken.length} source${broken.length === 1 ? '' : 's'} need attention`,
      owner: { kind: 'user', ref: c.createdBy, label: 'creator' },
      action: { labelKey: 'exceptionActionOpen', href: `/kicktodo/studio/candidates/${encodeURIComponent(c.id)}` },
      audit: { detectedAt: report.checkedAt, tenantId },
    });
  }
  return rows;
}

export function registerKicktodoMonitorExceptionSource(): void {
  registerExceptionSource(SOURCE_KEY, monitorExceptionSource);
}
