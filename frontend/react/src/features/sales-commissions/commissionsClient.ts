/**
 * Sales Commissions API client (ADR 0280) — the SPA half of the
 * `/host/openwop-app/commissions/orgs/:orgId/*` host-extension surface.
 * Reuses the org list + fetch idiom from the CRM/territories clients.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
export { listOrgs, type Org } from '../crm/crmOrgClient.js';

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/commissions/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export type CommissionType = 'percentage' | 'fixed';
export type AssignmentKind = 'territory' | 'role' | 'rep';
export type StatementStatus = 'draft' | 'approved' | 'paid';

export interface CommissionAccelerator { attainmentGte: number; rate: number }
export interface CommissionRule { basis: 'deal-won'; type: CommissionType; rate: number; accelerators?: CommissionAccelerator[]; cap?: number }
export interface PlanAssignment { kind: AssignmentKind; ref: string }
export interface CommissionPlan { planId: string; name: string; currency: string; assignment: PlanAssignment; rules: CommissionRule[]; effectiveFrom: string; effectiveTo?: string; updatedAt: string }

export interface StatementLine { dealId: string; dealAmount: number; rate: number; commission: number }
export interface CommissionStatement {
  statementId: string; subjectId: string; period: string; planId: string; currency: string;
  lines: StatementLine[]; total: number; attainmentPct?: number; status: StatementStatus;
  approvedBy?: string; approvedAt?: string; updatedAt: string;
}

export interface PlanInput {
  name: string; currency: string; assignment: PlanAssignment; effectiveFrom: string; effectiveTo?: string; rules: CommissionRule[];
}

export async function listPlans(orgId: string): Promise<CommissionPlan[]> {
  return (await asJson<{ plans: CommissionPlan[] }>(await fetch(`${base(orgId)}/plans`, fetchOpts({ headers: authedHeaders() })), 'listPlans')).plans;
}
export async function createPlan(orgId: string, input: PlanInput): Promise<CommissionPlan> {
  return asJson(await fetch(`${base(orgId)}/plans`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createPlan');
}
export async function updatePlan(orgId: string, planId: string, patch: Partial<PlanInput>): Promise<CommissionPlan> {
  return asJson(await fetch(`${base(orgId)}/plans/${encodeURIComponent(planId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updatePlan');
}
export async function deletePlan(orgId: string, planId: string): Promise<void> {
  await asJson(await fetch(`${base(orgId)}/plans/${encodeURIComponent(planId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deletePlan');
}

export async function listStatements(orgId: string, filter: { subjectId?: string; period?: string; planId?: string } = {}): Promise<CommissionStatement[]> {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  return (await asJson<{ statements: CommissionStatement[] }>(await fetch(`${base(orgId)}/statements${qs ? `?${qs}` : ''}`, fetchOpts({ headers: authedHeaders() })), 'listStatements')).statements;
}
export async function computeStatement(orgId: string, planId: string, subjectId: string, period: string): Promise<CommissionStatement> {
  return asJson(await fetch(`${base(orgId)}/plans/${encodeURIComponent(planId)}/statements/compute`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ subjectId, period }) })), 'computeStatement');
}
/** CFP-1 (D9): approving a statement (payout-committing) is SUBMITTED for review,
 *  not applied on the click. The route returns a pending review; the statement
 *  transitions draft→approved only when a manager claims it in the Reviews inbox. */
export interface PendingStatementReview { review: { approvalId: string; status: string } }
export async function approveStatement(orgId: string, statementId: string): Promise<PendingStatementReview> {
  return asJson(await fetch(`${base(orgId)}/statements/${encodeURIComponent(statementId)}/approve`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'approveStatement');
}
export async function payStatement(orgId: string, statementId: string): Promise<CommissionStatement> {
  return asJson(await fetch(`${base(orgId)}/statements/${encodeURIComponent(statementId)}/pay`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'payStatement');
}
