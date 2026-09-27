/**
 * Funnels feature client (ADR 0294 / Funnel A). Wraps
 * /host/openwop-app/funnels/*. 404s when the toggle is off. `listOrgs` hits
 * the shared orgs route directly (the promotions/csm convention). CMS pages for
 * the step picker come from the cms feature's own client (one page model).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/funnels`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const FUNNEL_STEP_KINDS = ['landing', 'optin', 'sales', 'checkout', 'upsell', 'downsell', 'thankyou'] as const;
export type FunnelStepKind = (typeof FUNNEL_STEP_KINDS)[number];

export interface StepRule { when?: { outcome?: 'accepted' | 'declined'; utm?: { key: string; value: string } }; goto: string }
export interface StepExperimentVariant { key: string; pageId: string | null; weight: number }
export interface StepExperiment { experimentId: string; status: 'running' | 'stopped'; variants: StepExperimentVariant[]; createdAt: string }
export interface FunnelStep { stepId: string; kind: FunnelStepKind; pageId: string; name?: string; routing?: StepRule[]; experiment?: StepExperiment }
export interface Funnel {
  funnelId: string; orgId: string; name: string; slug: string;
  status: 'draft' | 'published' | 'archived';
  steps: FunnelStep[];
  createdAt: string; updatedAt: string; publishedAt?: string;
  /** VP-R2-3 — the operator-authored complete-state CTA. */
  completionCta?: { label: string; url: string };
}
export interface Org { orgId: string; name: string }

export interface StepStatRow { stepId: string; kind: string; name?: string; views: number; completions: number; revenue: number; orders: number; conversion: number | null; revenueByCurrency?: Record<string, number> }
export interface FunnelStats { funnelId: string; steps: StepStatRow[]; days: Array<{ day: string; steps: Record<string, { views: number; completions: number; revenue: number; orders: number }> }>; eventWindow: number; rebuiltAt: string | null }

export interface VariantResult { key: string; pageId: string | null; weight: number; sessions: number; conversions: number; conversionRate: number; zScore: number | null; significant: boolean | null; insufficientSample: boolean }
export interface ExperimentResults { experimentId: string; status: 'running' | 'stopped'; baselineKey: string; minSessionsPerVariant: number; variants: VariantResult[] }

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, { headers: authedHeaders(), ...fetchOpts });
  const body = await parse<{ orgs?: Org[] }>(res);
  return body.orgs ?? [];
}

const orgBase = (orgId: string): string => `${base}/orgs/${encodeURIComponent(orgId)}/funnels`;

export async function listFunnels(orgId: string): Promise<Funnel[]> {
  const res = await fetch(orgBase(orgId), { headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ funnels: Funnel[] }>(res)).funnels;
}

export interface FunnelDraft { name: string; slug?: string; steps?: Array<Pick<FunnelStep, 'kind' | 'pageId'> & { stepId?: string; name?: string; routing?: StepRule[] }>; completionCta?: { label: string; url: string } | null }

/** ONE funnel by id — what `/funnels/:funnelId` loads (ADR 0522). The editor is
 *  reachable by URL alone (bookmark, shared link, reload), so it must not depend
 *  on the list page having been fetched first. A 404 IS the "no such funnel in
 *  this workspace" answer the page renders. */
export async function getFunnel(orgId: string, funnelId: string): Promise<Funnel> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}`, { headers: authedHeaders(), ...fetchOpts });
  return parse<Funnel>(res);
}

export async function createFunnel(orgId: string, draft: FunnelDraft): Promise<Funnel> {
  const res = await fetch(orgBase(orgId), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(draft), ...fetchOpts });
  return (await parse<{ funnel: Funnel }>(res)).funnel;
}

export async function updateFunnel(orgId: string, funnelId: string, patch: Partial<FunnelDraft>): Promise<Funnel> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch), ...fetchOpts });
  return (await parse<{ funnel: Funnel }>(res)).funnel;
}

export async function deleteFunnel(orgId: string, funnelId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts });
  await parse<{ ok: boolean }>(res);
}

async function lifecycle(orgId: string, funnelId: string, action: 'publish' | 'unpublish' | 'archive'): Promise<Funnel> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/${action}`, { method: 'POST', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ funnel: Funnel }>(res)).funnel;
}
export const publishFunnel = (orgId: string, funnelId: string): Promise<Funnel> => lifecycle(orgId, funnelId, 'publish');
export const unpublishFunnel = (orgId: string, funnelId: string): Promise<Funnel> => lifecycle(orgId, funnelId, 'unpublish');
export const archiveFunnel = (orgId: string, funnelId: string): Promise<Funnel> => lifecycle(orgId, funnelId, 'archive');

export async function getFunnelStats(orgId: string, funnelId: string): Promise<FunnelStats> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/stats`, { headers: authedHeaders(), ...fetchOpts });
  return parse<FunnelStats>(res);
}

export async function rebuildFunnelStats(orgId: string, funnelId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/stats/rebuild`, { method: 'POST', headers: authedHeaders(), ...fetchOpts });
  await parse<{ ok: boolean }>(res);
}

export async function setStepExperiment(orgId: string, funnelId: string, stepId: string, variants: StepExperimentVariant[]): Promise<Funnel> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/steps/${encodeURIComponent(stepId)}/experiment`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ variants }), ...fetchOpts });
  return (await parse<{ funnel: Funnel }>(res)).funnel;
}

export async function stopStepExperiment(orgId: string, funnelId: string, stepId: string): Promise<Funnel> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/steps/${encodeURIComponent(stepId)}/experiment`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ funnel: Funnel }>(res)).funnel;
}

export async function getExperimentResults(orgId: string, funnelId: string, stepId: string): Promise<ExperimentResults> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(funnelId)}/steps/${encodeURIComponent(stepId)}/experiment/results`, { headers: authedHeaders(), ...fetchOpts });
  return parse<ExperimentResults>(res);
}

/** ADR 0339 — the hosted SPA viewer URL (share this); the JSON API URL below
 *  remains the machine contract. */
export function funnelViewerUrl(orgId: string, slug: string): string {
  return `${window.location.origin}/fn/${encodeURIComponent(orgId)}/${encodeURIComponent(slug)}`;
}

/** The public entry URL for a published funnel (shown as copyable). */
export function publicFunnelUrl(orgId: string, slug: string): string {
  return `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels/${encodeURIComponent(slug)}`;
}
