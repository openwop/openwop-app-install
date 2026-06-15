/**
 * Email Marketing API client (ADR 0019). Authed org-scoped templates + campaigns
 * under /v1/host/openwop-app/email/orgs/:orgId. No public surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

export interface EmailTemplate { templateId: string; orgId: string; name: string; subject: string; body: string; createdAt: string; updatedAt: string }
export interface CampaignStats { sent: number; failed: number; skipped: number }
export interface Campaign { campaignId: string; orgId: string; templateId: string; audience: { stage?: ContactStage }; status: 'draft' | 'sending' | 'sent'; stats?: CampaignStats; createdAt: string; updatedAt: string }
export interface SendLog { sendId: string; campaignId: string; contactId: string; status: 'sent' | 'failed' | 'skipped'; error?: string; ts: string }

const root = `${config.baseUrl}/v1/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/email/orgs/${encodeURIComponent(orgId)}`;

export async function listTemplates(orgId: string): Promise<EmailTemplate[]> {
  const res = await fetch(`${base(orgId)}/templates`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ templates: EmailTemplate[] }>(res, 'listTemplates')).templates;
}
export async function createTemplate(orgId: string, input: { name: string; subject: string; body: string }): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<EmailTemplate>(res, 'createTemplate');
}
export async function updateTemplate(orgId: string, templateId: string, patch: { name?: string; subject?: string; body?: string }): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<EmailTemplate>(res, 'updateTemplate');
}
export async function deleteTemplate(orgId: string, templateId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteTemplate returned ${res.status}`);
}

export async function listCampaigns(orgId: string): Promise<Campaign[]> {
  const res = await fetch(`${base(orgId)}/campaigns`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ campaigns: Campaign[] }>(res, 'listCampaigns')).campaigns;
}
export async function createCampaign(orgId: string, input: { templateId: string; stage?: ContactStage }): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Campaign>(res, 'createCampaign');
}
export async function deleteCampaign(orgId: string, campaignId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteCampaign returned ${res.status}`);
}
export async function sendCampaign(orgId: string, campaignId: string, resend = false): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/send`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ resend }) }));
  return asJson<Campaign>(res, 'sendCampaign');
}
export async function listSends(orgId: string, campaignId: string): Promise<SendLog[]> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/sends`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ sends: SendLog[] }>(res, 'listSends')).sends;
}
