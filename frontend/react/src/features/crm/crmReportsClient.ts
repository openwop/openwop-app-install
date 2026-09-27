/**
 * CRM reports API client (ADR 0210 §3/§4 — C6). A single read-only endpoint
 * returns the whole pipeline-report shape in one fetch (rate-limit-friendly —
 * no dashboard fan-out). Separate file from `crmOrgClient.ts` on purpose so
 * this feature never edits that shared client.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface FunnelStage {
  stage: string;
  count: number;
}
export interface PerStageReport {
  stageId: string;
  name: string;
  probability: number;
  count: number;
  /** Blind to currency — kept for compat; render `sums` instead (CC-SP-3).
   *  ADR 0540 D3 — `null` on a `non-revenue` pipeline: summing amounts there is
   *  meaningless, and `0` would claim "no money" rather than "not applicable". */
  sum: number | null;
  weightedSum: number | null;
  /** Currency-grouped sums (null currency = unitless deals). */
  sums?: Array<{ currency: string | null; sum: number; weightedSum: number }>;
}
export interface ReportTotals {
  openCount: number;
  wonCount: number;
  lostCount: number;
  winRate: number | null;
}
export interface AgingDeal {
  dealId: string;
  title: string;
  stageId: string;
  daysSinceActivity: number;
}
export interface PipelineSnapshot {
  isoWeek: string;
  at: string;
  perStage: PerStageReport[];
}
export interface StageConversion {
  fromStageId: string;
  toStageId: string;
  count: number;
}
export interface PipelineReport {
  /** ADR 0540 D3 — `non-revenue` suppresses every currency rollup. Absent ⇒ revenue. */
  kind?: 'revenue' | 'non-revenue';
  funnel: FunnelStage[];
  perStage: PerStageReport[];
  totals: ReportTotals;
  aging: AgingDeal[];
  snapshots: PipelineSnapshot[];
  conversions: StageConversion[];
  /** Distinct deal currencies — >1 means blind totals mix units. */
  currencies?: string[];
}

const root = `${config.baseUrl}/host/openwop-app`;
const orgBase = (orgId: string): string => `${root}/crm/orgs/${encodeURIComponent(orgId)}`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getPipelineReport(orgId: string, pipelineId?: string): Promise<PipelineReport> {
  const qs = pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : '';
  const res = await fetch(`${orgBase(orgId)}/reports/pipeline${qs}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<PipelineReport>(res, 'getPipelineReport');
}
