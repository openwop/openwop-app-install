/**
 * ADR 0949 D4 / P1b (E-2) — daily rollup cells, `experiments:daily`. A DERIVED
 * cache (the ADR 0211 doctrine): a rebuild recomputes one experiment's cells from
 * its source and deletes the cells it no longer produces, so it is idempotent and
 * self-correcting.
 *
 * A cell is (experiment × arm × day × metric). The day is the unit's FIRST
 * exposure day (its cohort), so summing `n` over days counts each unit once.
 * For a binary metric, `sum` = units with the outcome and `sumSq = sum`. The
 * primary metric is `conversion`; a guardrail metric (ADR 0949 P3) is any name
 * the surface's adapter reports per unit (`UnitObservation.metrics`).
 *
 * Every rebuild records the source's coverage: whether events the experiment
 * needs may have been purged. A partial source withholds the verdict.
 */
import { DurableCollection } from '../hostExtPersistence.js';

export interface ExperimentDailyCell {
  cellId: string;
  tenantId: string;
  orgId: string;
  experimentId: string;
  arm: string;
  /** UTC day, YYYY-MM-DD: the units' first exposure day. */
  day: string;
  /** `conversion` (the primary) or a guardrail metric name. */
  metric: string;
  n: number;
  sum: number;
  sumSq: number;
}

export interface ExperimentRollupHeader {
  key: string;
  tenantId: string;
  orgId: string;
  experimentId: string;
  /** `complete`: no event the experiment could have produced was purged. */
  coverage: 'complete' | 'partial';
  /** The source's retention watermark at rebuild time (events before it are gone). */
  sourceRetainedSince: string | null;
  rebuiltAt: string;
}

export interface UnitObservation {
  arm: string;
  /** ISO timestamp of the unit's first exposure. */
  firstExposureAt: string;
  converted: boolean;
  /** ADR 0949 P3 — binary guardrail outcomes for this unit (e.g. `{ unsubscribe: 1 }`). */
  metrics?: Record<string, 0 | 1>;
}

const prefix = (tenantId: string, orgId: string, experimentId: string): string => `${tenantId}::${orgId}::${experimentId}::`;

const cells = new DurableCollection<ExperimentDailyCell>('experiments:daily', (c) => c.cellId, undefined, (c) => c.tenantId);
const headers = new DurableCollection<ExperimentRollupHeader>('experiments:rollup', (h) => h.key, undefined, (h) => h.tenantId);

/** Fold per-unit observations into cells (pure). */
export function foldDailyCells(tenantId: string, orgId: string, experimentId: string, units: Iterable<UnitObservation>): ExperimentDailyCell[] {
  const out = new Map<string, ExperimentDailyCell>();
  for (const u of units) {
    const day = u.firstExposureAt.slice(0, 10);
    const add = (metric: string, hit: boolean): void => {
      const cellId = `${prefix(tenantId, orgId, experimentId)}${u.arm}::${day}::${metric}`;
      let c = out.get(cellId);
      if (!c) { c = { cellId, tenantId, orgId, experimentId, arm: u.arm, day, metric, n: 0, sum: 0, sumSq: 0 }; out.set(cellId, c); }
      c.n += 1;
      if (hit) { c.sum += 1; c.sumSq += 1; }
    };
    add('conversion', u.converted);
    for (const [metric, v] of Object.entries(u.metrics ?? {})) if (metric !== 'conversion') add(metric, v === 1);
  }
  return [...out.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
}

/** Replace one experiment's cells and header. */
export async function writeExperimentRollup(
  tenantId: string, orgId: string, experimentId: string,
  next: ExperimentDailyCell[], coverage: { coverage: 'complete' | 'partial'; sourceRetainedSince: string | null },
  rebuiltAt: string,
): Promise<void> {
  const keep = new Set(next.map((c) => c.cellId));
  for (const c of next) await cells.put(c);
  for (const old of await cells.listByPrefix(prefix(tenantId, orgId, experimentId))) {
    if (!keep.has(old.cellId)) await cells.delete(old.cellId);
  }
  const key = `${tenantId}::${orgId}::${experimentId}`;
  await headers.put({ key, tenantId, orgId, experimentId, ...coverage, rebuiltAt });
}

export async function readExperimentRollup(tenantId: string, orgId: string, experimentId: string): Promise<{ cells: ExperimentDailyCell[]; header: ExperimentRollupHeader | null }> {
  const list = (await cells.listByPrefix(prefix(tenantId, orgId, experimentId))).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
  const header = await headers.get(`${tenantId}::${orgId}::${experimentId}`);
  return { cells: list, header: header && header.tenantId === tenantId && header.orgId === orgId ? header : null };
}

/** Per-arm totals of one metric over every day (distinct units, by construction). */
export function totalsByArm(list: readonly ExperimentDailyCell[], metric = 'conversion'): Map<string, { n: number; sum: number }> {
  const out = new Map<string, { n: number; sum: number }>();
  for (const c of list) {
    if ((c.metric ?? 'conversion') !== metric) continue;
    const t = out.get(c.arm) ?? { n: 0, sum: 0 };
    t.n += c.n; t.sum += c.sum;
    out.set(c.arm, t);
  }
  return out;
}

export async function deleteExperimentRollup(tenantId: string, orgId: string, experimentId: string): Promise<void> {
  for (const c of await cells.listByPrefix(prefix(tenantId, orgId, experimentId))) await cells.delete(c.cellId);
  await headers.delete(`${tenantId}::${orgId}::${experimentId}`);
}
