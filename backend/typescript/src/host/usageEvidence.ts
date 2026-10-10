/**
 * Usage evidence for a protocol tripwire (ADR 0829 P5 / ADR 0831 P5).
 *
 * The openwop ROADMAP promotes a host extension to an RFC only when it has been
 * used for real: "stable for 30 days in two real workflows" (the handoff record)
 * and "in production for 30 days on two real projects" (the team ledger). This
 * measures that instead of leaving it to recollection: one row per (tenant,
 * subject), the distinct days it was used, and the record versions seen.
 *
 * Counts and dates only — never content. Recording is fail-soft and idempotent
 * per day, so a retried write does not inflate anything.
 *
 * THE BAR (stated once, used by both features): a subject QUALIFIES when its
 * first and last use are at least `minSpanDays` apart, it was used on at least
 * `minActiveDays` distinct days, and exactly one record version was seen
 * ("without shape changes"). The tripwire is met when `minQualifying` subjects
 * qualify. The second half of each tripwire — another host asking — happens
 * outside this app and is not measured here.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.usageEvidence');

export interface UsageEvidence {
  tenantId: string;
  subject: string;
  firstAt: string;
  lastAt: string;
  /** Distinct UTC days (YYYY-MM-DD), most recent kept when capped. */
  days: string[];
  count: number;
  versions: number[];
}

export const EVIDENCE_BAR = { minSpanDays: 30, minActiveDays: 8, minQualifying: 2 } as const;
const MAX_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EvidenceSummary {
  bar: typeof EVIDENCE_BAR;
  subjects: Array<UsageEvidence & { spanDays: number; activeDays: number; qualifies: boolean }>;
  qualifying: number;
  tripwireMet: boolean;
  note: string;
}

export function usageEvidenceStore(namespace: string) {
  const rows = new DurableCollection<UsageEvidence>(namespace, (r) => `${r.tenantId}:${r.subject}`, undefined, (r) => r.tenantId);

  async function record(tenantId: string, subject: string, at: Date, version: number): Promise<void> {
    try {
      const iso = at.toISOString();
      const day = iso.slice(0, 10);
      const prev = await rows.get(`${tenantId}:${subject}`);
      if (prev && prev.tenantId !== tenantId) return;
      const days = prev ? (prev.days.includes(day) ? prev.days : [...prev.days, day].sort().slice(-MAX_DAYS)) : [day];
      const versions = prev ? (prev.versions.includes(version) ? prev.versions : [...prev.versions, version].sort((a, b) => a - b)) : [version];
      await rows.put({
        tenantId, subject,
        firstAt: prev && prev.firstAt < iso ? prev.firstAt : iso,
        lastAt: prev && prev.lastAt > iso ? prev.lastAt : iso,
        days, count: (prev?.count ?? 0) + 1, versions,
      });
    } catch (err) {
      log.warn('usage_evidence_record_failed', { namespace, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function summarize(note: string): Promise<EvidenceSummary> {
    const subjects = (await rows.list()).map((r) => {
      const spanDays = Math.floor((Date.parse(r.lastAt) - Date.parse(r.firstAt)) / DAY_MS);
      const activeDays = r.days.length;
      const qualifies = spanDays >= EVIDENCE_BAR.minSpanDays && activeDays >= EVIDENCE_BAR.minActiveDays && r.versions.length === 1;
      return { ...r, spanDays, activeDays, qualifies };
    }).sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.activeDays - a.activeDays);
    const qualifying = subjects.filter((s) => s.qualifies).length;
    return { bar: EVIDENCE_BAR, subjects, qualifying, tripwireMet: qualifying >= EVIDENCE_BAR.minQualifying, note };
  }

  return { record, summarize };
}
