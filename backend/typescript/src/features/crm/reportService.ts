/**
 * The ONE pipeline report (ADR 0210 §3) — funnel + per-stage weighted pipeline
 * + totals/win-rate + aging + trend snapshots + stage conversions, in a single
 * fetch (rate-limit-friendly — no dashboard fan-out).
 */
import { OpenwopError } from '../../types.js';
import { CONTACT_STAGES, listContacts } from './contactsService.js';
import { type CrmSnapshot, getOrCreateDefaultPipeline, getPipeline, listActivities, listCrmSnapshots, listDeals, listStageHistoryForPipeline } from './crmEntitiesService.js';
import type { PipelineKind } from './entities/pipelines.js';

export interface PipelineReport {
  pipelineId: string;
  funnel: Array<{ stage: string; count: number }>;
  // R2 CC-SP-3 — `sum`/`weightedSum` are kept for compat but are BLIND to
  // currency; `sums` groups by the deals' currency (null = unitless) so the
  // UI can render one figure per currency instead of a mixed-currency total.
  /** ADR 0540 D3 — what the amounts on this pipeline mean. `non-revenue` ⇒ every
   *  money figure below is NULL and `sums` is empty; counts are unaffected. */
  kind: PipelineKind;
  // R2 CC-SP-3 — `sum`/`weightedSum` are kept for compat but are BLIND to
  // currency; `sums` groups by the deals' currency (null = unitless) so the
  // UI can render one figure per currency instead of a mixed-currency total.
  //
  // ADR 0540 D3 — `null`, NOT `0`, on a non-revenue pipeline. Zero reads as
  // "this stage holds no money", which is a different (and equally false) claim
  // from "summing money here is meaningless". A renderer must show `—`.
  perStage: Array<{ stageId: string; name: string; probability: number; count: number; sum: number | null; weightedSum: number | null; sums: Array<{ currency: string | null; sum: number; weightedSum: number }> }>;
  /** Distinct currencies across the open deals (null excluded) — >1 means every blind total in this report mixes units. */
  currencies: string[];
  totals: { openCount: number; wonCount: number; lostCount: number; winRate: number | null };
  aging: Array<{ dealId: string; title: string; stageId: string; daysSinceActivity: number }>;
  snapshots: CrmSnapshot[];
  conversions: Array<{ fromStageId: string; toStageId: string; count: number }>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AGING_THRESHOLD_DAYS = 14;
const SNAPSHOT_LOOKBACK = 12;

export async function computePipelineReport(tenantId: string, orgId: string, pipelineId: string | undefined, now: number, viewerSubject?: string): Promise<PipelineReport> {
  const pipeline = pipelineId ? await getPipeline(tenantId, orgId, pipelineId) : await getOrCreateDefaultPipeline(tenantId, orgId);
  if (!pipeline) throw new OpenwopError('not_found', 'Pipeline not found in this org.', 404, { pipelineId });

  // Funnel: tenant contacts (rolodex), excluded tombstones already baked into listContacts.
  const contacts = await listContacts(tenantId);
  const funnel = CONTACT_STAGES.map((stage) => ({ stage, count: contacts.filter((c) => c.stage === stage).length }));

  // ADR 0272 P4 — scope the deal enumeration to the viewer so a territory-scoped
  // rep's report (esp. aging[], which lists dealId/title) never discloses deals
  // outside their territories. A view-all admin (or no viewer) sees the full org.
  const kind: PipelineKind = pipeline.kind ?? 'revenue';
  const pipelineDeals = await listDeals(tenantId, orgId, { pipelineId: pipeline.pipelineId }, viewerSubject);
  const openDeals = pipelineDeals.filter((d) => d.status === 'open');

  const perStage = pipeline.stages.map((stage) => {
    const stageDeals = openDeals.filter((d) => d.stageId === stage.stageId);
    const sum = stageDeals.reduce((acc, d) => acc + (d.amount ?? 0), 0);
    const weightedSum = stageDeals.reduce((acc, d) => acc + (d.amount ?? 0) * (stage.probability / 100), 0);
    const byCurrency = new Map<string | null, { sum: number; weightedSum: number }>();
    for (const d of stageDeals) {
      if (d.amount === undefined) continue;
      const key = d.currency ? d.currency.toUpperCase() : null; // 'usd' and 'USD' are ONE group
      const g = byCurrency.get(key) ?? { sum: 0, weightedSum: 0 };
      g.sum += d.amount;
      g.weightedSum += d.amount * (stage.probability / 100);
      byCurrency.set(key, g);
    }
    const sums = [...byCurrency.entries()]
      .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''))
      .map(([currency, g]) => ({ currency, ...g }));
    // Suppress the ROLLUP, never the record: an individual deal keeps its
    // amount (one application's salary is real and useful), it is only the
    // aggregate that is nonsense (ADR 0540 D3).
    return kind === 'non-revenue'
      ? { stageId: stage.stageId, name: stage.name, probability: stage.probability, count: stageDeals.length, sum: null, weightedSum: null, sums: [] }
      : { stageId: stage.stageId, name: stage.name, probability: stage.probability, count: stageDeals.length, sum, weightedSum, sums };
  });
  // A non-revenue pipeline advertises no currencies: the field exists to warn
  // that blind totals mix units, and there are no blind totals to warn about.
  const currencies = kind === 'non-revenue'
    ? []
    : [...new Set(openDeals.map((d) => d.currency?.toUpperCase()).filter((c): c is string => typeof c === 'string'))].sort();

  const wonCount = pipelineDeals.filter((d) => d.status === 'won').length;
  const lostCount = pipelineDeals.filter((d) => d.status === 'lost').length;
  const winRate = wonCount + lostCount > 0 ? wonCount / (wonCount + lostCount) : null;

  const aging: PipelineReport['aging'] = [];
  // ONE activities fetch for the whole org, grouped in memory — a per-deal
  // listActivities loop would re-scan the collection per open deal (audit
  // CRMGAP-1: up to the 5k cap in sequential scans on a single GET).
  const orgActivities = await listActivities(tenantId, orgId, {});
  const latestTouchByDeal = new Map<string, string>();
  for (const a of orgActivities) {
    // newest-first ordering ⇒ first sighting per dealId is the latest touch.
    if (a.dealId && !latestTouchByDeal.has(a.dealId)) latestTouchByDeal.set(a.dealId, a.createdAt);
  }
  for (const deal of openDeals) {
    const lastTouchIso = latestTouchByDeal.get(deal.dealId) ?? deal.updatedAt;
    const lastTouchMs = Date.parse(lastTouchIso);
    if (!Number.isFinite(lastTouchMs)) continue;
    const daysSinceActivity = Math.floor((now - lastTouchMs) / MS_PER_DAY);
    if (daysSinceActivity >= AGING_THRESHOLD_DAYS) {
      aging.push({ dealId: deal.dealId, title: deal.title, stageId: deal.stageId, daysSinceActivity });
    }
  }

  const snapshots = await listCrmSnapshots(tenantId, orgId, pipeline.pipelineId, SNAPSHOT_LOOKBACK);

  const history = await listStageHistoryForPipeline(tenantId, orgId, pipeline.pipelineId);
  const conversionsByKey = new Map<string, { fromStageId: string; toStageId: string; count: number }>();
  for (const row of history) {
    if (!row.fromStageId) continue; // the creation row (no move) is not a conversion
    const key = `${row.fromStageId}→${row.toStageId}`;
    const existing = conversionsByKey.get(key);
    if (existing) existing.count += 1;
    else conversionsByKey.set(key, { fromStageId: row.fromStageId, toStageId: row.toStageId, count: 1 });
  }

  return {
    pipelineId: pipeline.pipelineId,
    kind,
    currencies,
    funnel,
    perStage,
    totals: { openCount: openDeals.length, wonCount, lostCount, winRate },
    aging,
    snapshots,
    conversions: [...conversionsByKey.values()],
  };
}
