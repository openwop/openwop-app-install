/**
 * Production Intelligence API client (ADR 0172) — the Vendor Directory + the
 * generated-plan read/lifecycle surface under
 * /host/openwop-app/production/orgs/:orgId/*. Plan GENERATION is a workflow run
 * (the Production Planner agent, driven through the shared chat) — not a client call.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org {
  orgId: string;
  name: string;
}

export type VendorType = 'contractor' | 'agency';
export const VENDOR_TYPES: readonly VendorType[] = ['contractor', 'agency'];
export type ContractStatus = 'active' | 'inactive' | 'preferred';
export const CONTRACT_STATUSES: readonly ContractStatus[] = ['active', 'inactive', 'preferred'];
export type ProductionCategory = 'design' | 'development' | 'writing' | 'video' | 'photography' | 'audio' | 'strategy' | 'social-media' | 'other';
export const PRODUCTION_CATEGORIES: readonly ProductionCategory[] = ['design', 'development', 'writing', 'video', 'photography', 'audio', 'strategy', 'social-media', 'other'];
/** UX_UPGRADE-production R2 (PROD2-B3) — mirrors `PRICE_UNITS` in
 *  `backend/typescript/src/features/production/productionService.ts`, the SSoT.
 *  The vendor form had no pricing field at all while three separate surfaces
 *  told the user to enter one. */
export const PRICE_UNITS = ['per-hour', 'per-project', 'per-month', 'per-word', 'per-asset'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export interface VendorCapability {
  name: string;
  category: ProductionCategory;
  qualityRating?: number;
}
export interface Vendor {
  vendorId: string;
  orgId: string;
  type: VendorType;
  name: string;
  companyId?: string;
  contactEmail?: string;
  website?: string;
  region?: string;
  capabilities: VendorCapability[];
  priceRanges: { capability: string; min: number; max: number; unit: string }[];
  pastProjects: { projectId: string; name: string; completedAt?: string }[];
  portfolioAssetTokens: string[];
  contractStatus: ContractStatus;
  notes?: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionRoute = 'internal' | 'contractor' | 'agency' | 'hybrid';
export type PlanStatus = 'draft' | 'approved' | 'in_production' | 'completed';
export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'approved', 'in_production', 'completed'];

export interface BudgetEstimate {
  min: number;
  max: number;
  currency: string;
}
export interface ProductionRecommendation {
  assetType: string;
  assetDescription: string;
  executionRoute: ExecutionRoute;
  rationale: string;
  budget: BudgetEstimate;
  timelineEstimate: string;
}
export interface ProductionPlan {
  planId: string;
  orgId: string;
  briefId?: string;
  strategySummary: string;
  recommendations: ProductionRecommendation[];
  totalBudget: BudgetEstimate;
  timeline: { estimatedDeliveryDate?: string; milestones: { date: string; deliverable: string }[] };
  capabilityAssessment: { strengths: string[]; gaps: string[]; overallRecommendation: string; confidence: number };
  status: PlanStatus;
  generatedAt: string;
  updatedAt: string;
}

export interface VendorInput {
  type: VendorType;
  name: string;
  companyId?: string;
  contactEmail?: string;
  website?: string;
  /** PROD2-M3 (R3) — `null` CLEARS the field on the server (`optField` deletes
   *  on null); omission leaves it untouched. The edit form sends null for a
   *  cleared Region/Notes so "Vendor updated" stops lying about a no-op. */
  region?: string | null;
  capabilities?: VendorCapability[];
  priceRanges?: Vendor['priceRanges'];
  contractStatus?: ContractStatus;
  notes?: string | null;
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

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

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const orgBase = (orgId: string): string => `${root}/production/orgs/${encodeURIComponent(orgId)}`;

export async function listVendors(orgId: string, q?: string): Promise<Vendor[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const res = await fetch(`${orgBase(orgId)}/vendors${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ vendors: Vendor[] }>(res, 'listVendors')).vendors;
}
export async function createVendor(orgId: string, input: VendorInput): Promise<Vendor> {
  const res = await fetch(`${orgBase(orgId)}/vendors`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Vendor>(res, 'createVendor');
}
export async function updateVendor(orgId: string, vendorId: string, patch: Partial<VendorInput>): Promise<Vendor> {
  const res = await fetch(`${orgBase(orgId)}/vendors/${encodeURIComponent(vendorId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Vendor>(res, 'updateVendor');
}
export async function deleteVendor(orgId: string, vendorId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/vendors/${encodeURIComponent(vendorId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteVendor');
}

export async function listPlans(orgId: string): Promise<ProductionPlan[]> {
  const res = await fetch(`${orgBase(orgId)}/plans`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ plans: ProductionPlan[] }>(res, 'listPlans')).plans;
}
export async function setPlanStatus(orgId: string, planId: string, status: PlanStatus): Promise<ProductionPlan> {
  const res = await fetch(`${orgBase(orgId)}/plans/${encodeURIComponent(planId)}/status`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson<ProductionPlan>(res, 'setPlanStatus');
}
