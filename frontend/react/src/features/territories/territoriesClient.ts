/**
 * Sales Territory Management API client (ADR 0272) — the SPA half of the
 * `/host/openwop-app/territories/orgs/:orgId/*` host-extension surface.
 * Reuses the org list + fetch idiom from the CRM org client.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
export { listOrgs, type Org } from '../crm/crmOrgClient.js';

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/territories/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export type ModelState = 'planning' | 'active' | 'archived';
export interface TerritoryModel { modelId: string; name: string; state: ModelState; createdAt: string; activatedAt?: string }
export interface Territory { territoryId: string; modelId: string; name: string; parentTerritoryId: string | null; managerSubjectId?: string; memberSubjectIds: string[]; regionId?: string }
export interface AssignmentRule { ruleId: string; territoryId: string; target: 'company' | 'deal'; priority: number; filter: unknown }
export interface Quota { quotaId: string; territoryId: string; period: string; amount: number; currency?: string; repSplits: Array<{ subjectId: string; amount: number }> }
export interface PreviewSummary { perTerritory: Array<{ territoryId: string; name: string; companies: number; deals: number }>; unassigned: { companies: number; deals: number }; totals: { companies: number; deals: number } }
export interface TerritoryAttainment {
  territoryId: string; name: string; parentTerritoryId: string | null; regionId?: string; quota: number; currency?: string;
  /** TER-G1 — the deals behind this row's figures span more than one currency,
   *  so the sums are not denominated in anything (there is no FX). */
  currencyMixed?: boolean;
  /** R2 TER2-B1 — the currency the SUMS are in (set only when every contributing
   *  deal agreed). `currency` above is the QUOTA's and says nothing about them. */
  valueCurrency?: string;
  /** R2 TER2-B1 — the sums are denominated, but not in the quota's currency. */
  quotaCurrencyMismatch?: boolean;
  /** R2 TER2-B2 — the quota is a sum across periods whose currencies disagree. */
  quotaCurrencyMixed?: boolean;
  direct: { weightedPipeline: number; won: number; openCount: number; wonCount: number };
  rolled: { weightedPipeline: number; won: number };
  attainment: number | null; coverage: number | null;
  /** R2 TER2-B1 — present whenever a ratio is null, so the console can say why instead
   *  of rendering a bare em-dash the reader will read as "no deals yet". It is optional
   *  because the field is ABSENT on the ordinary rows (where the ratio is a number), so
   *  the type cannot express "required exactly when `attainment` is null" — the pairing
   *  is pinned by test instead (`attainmentRatioHonesty`), not by the compiler.
   *  (Review I2: an earlier version of this comment claimed a compile-time guarantee
   *  the `?:` right below it does not provide.) */
  ratioUnavailable?: 'no-quota' | 'mixed-deal-currencies' | 'mixed-quota-currencies' | 'quota-currency-mismatch';
  repSplits: Array<{ subjectId: string; quota: number; won: number; weightedPipeline: number }>;
}

export async function listModels(orgId: string): Promise<{ models: TerritoryModel[]; activeModelId: string | null }> {
  const res = await fetch(`${base(orgId)}/models`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'listModels');
}
export async function createModel(orgId: string, name: string): Promise<TerritoryModel> {
  const res = await fetch(`${base(orgId)}/models`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name }) }));
  return asJson(res, 'createModel');
}
/** CFP-1 (D9): activating/archiving a model (org-wide blast radius) is SUBMITTED
 *  for review, not applied on the click. The route returns a pending review; the
 *  model changes state only when a manager claims it in the shared Reviews inbox. */
export interface PendingModelReview { review: { approvalId: string; status: string } }
export async function activateModel(orgId: string, modelId: string): Promise<PendingModelReview> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/activate`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'activateModel');
}
export async function archiveModel(orgId: string, modelId: string): Promise<PendingModelReview> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/archive`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'archiveModel');
}
/** Purge an ARCHIVED model + all its descendants (ADR 0272 §3.2 purge; TERR-DATA-2).
 *  `removed` = rows deleted (territories + rules + quotas + the model row). */
export async function deleteModel(orgId: string, modelId: string): Promise<{ success: boolean; removed: number }> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson(res, 'deleteModel');
}
export async function listTerritories(orgId: string, modelId: string): Promise<Territory[]> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/territories`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ territories: Territory[] }>(res, 'listTerritories')).territories;
}
export async function createTerritory(orgId: string, modelId: string, input: { name: string; parentTerritoryId?: string | null; managerSubjectId?: string; memberSubjectIds?: string[]; regionId?: string }): Promise<Territory> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/territories`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'createTerritory');
}
/** PATCH one territory (planning models only, mirroring the backend guard).
 *  `regionId: ''` clears the sales-map region mapping (ADR 0282 §8). */
export async function updateTerritory(orgId: string, modelId: string, territoryId: string, patch: { name?: string; parentTerritoryId?: string | null; managerSubjectId?: string; memberSubjectIds?: string[]; regionId?: string }): Promise<Territory> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/territories/${encodeURIComponent(territoryId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson(res, 'updateTerritory');
}
export async function listRules(orgId: string, modelId: string): Promise<AssignmentRule[]> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/rules`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ rules: AssignmentRule[] }>(res, 'listRules')).rules;
}
export async function createRule(orgId: string, modelId: string, input: { territoryId: string; target: 'company' | 'deal'; priority?: number; filter: unknown }): Promise<AssignmentRule> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/rules`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'createRule');
}
export async function previewModel(orgId: string, modelId: string): Promise<PreviewSummary> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/preview`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'previewModel');
}
export async function getAttainment(orgId: string, modelId: string, period?: string): Promise<{ period: string | null; territories: TerritoryAttainment[]; unassigned: { weightedPipeline: number; won: number } }> {
  const qs = period ? `?period=${encodeURIComponent(period)}` : '';
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/attainment${qs}`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getAttainment');
}
export async function setQuota(orgId: string, modelId: string, territoryId: string, input: { period: string; amount: number; currency?: string; repSplits?: Array<{ subjectId: string; amount: number }> }): Promise<Quota> {
  const res = await fetch(`${base(orgId)}/models/${encodeURIComponent(modelId)}/territories/${encodeURIComponent(territoryId)}/quota`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'setQuota');
}
