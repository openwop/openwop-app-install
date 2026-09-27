/**
 * Email Marketing API client (ADR 0019). Authed org-scoped templates + campaigns
 * under /host/openwop-app/email/orgs/:orgId. No public surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

export type EmailBodyFormat = 'text' | 'markdown';
export interface EmailTemplate { templateId: string; orgId: string; name: string; subject: string; body: string; format?: EmailBodyFormat; createdAt: string; updatedAt: string }
export interface CampaignStats { sent: number; failed: number; skipped: number }
export interface Campaign { campaignId: string; orgId: string; templateId: string; audience: { stage?: ContactStage; segmentId?: string }; status: 'draft' | 'sending' | 'sent'; stats?: CampaignStats; createdAt: string; updatedAt: string }
export interface SendLog { sendId: string; campaignId: string; contactId: string; status: 'sent' | 'failed' | 'skipped'; error?: string; ts: string }

/** Saved segments (ADR 0211 §2) — a minimal read-only shape for the campaign
 *  audience picker. No established cross-feature client-import precedent exists
 *  yet (`crm/crmClient.ts` is not imported by any other feature), so this is an
 *  inline fetch against the tenant-scoped CRM segments endpoint rather than a
 *  new cross-feature dependency. */
export interface EmailSegment { segmentId: string; name: string }

const root = `${config.baseUrl}/host/openwop-app`;
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
/** ONE template by id — what `/email/templates/:templateId` loads (ADR 0520).
 *  The editor is reachable by URL alone (bookmark, shared link, reload), so it
 *  must not depend on the hub page's list having been fetched first. A 404 here
 *  IS the "no such template in this workspace" answer the page renders. */
export async function getTemplate(orgId: string, templateId: string): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EmailTemplate>(res, 'getTemplate');
}
export async function createTemplate(orgId: string, input: { name: string; subject: string; body: string; format?: EmailBodyFormat }): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<EmailTemplate>(res, 'createTemplate');
}
export async function updateTemplate(orgId: string, templateId: string, patch: { name?: string; subject?: string; body?: string; format?: EmailBodyFormat }): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<EmailTemplate>(res, 'updateTemplate');
}
/** ADR 0256 — server-authoritative safe-markdown preview (the same renderer that
 *  builds the sent HTML part), so the editor preview is what actually sends. */
export async function previewMarkdown(orgId: string, body: string): Promise<string> {
  const res = await fetch(`${base(orgId)}/preview`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ body }) }));
  return (await asJson<{ html: string }>(res, 'previewMarkdown')).html;
}
export async function deleteTemplate(orgId: string, templateId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteTemplate returned ${res.status}`);
}

export async function listCampaigns(orgId: string): Promise<Campaign[]> {
  const res = await fetch(`${base(orgId)}/campaigns`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ campaigns: Campaign[] }>(res, 'listCampaigns')).campaigns;
}
export async function createCampaign(orgId: string, input: { templateId: string; stage?: ContactStage; segmentId?: string }): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Campaign>(res, 'createCampaign');
}

/** The tenant's saved CRM segments (ADR 0211 §2) — used only to populate the
 *  campaign audience picker's "By segment" option + resolve a segment's name
 *  for display. Tenant-scoped (no orgId), same as the CRM `/crm/segments` route. */
/** R2 EM-G2 — the live audience-size read for a SEGMENT audience (the CRM
 *  estimate route has existed since ADR 0265; the round-1 deferral's "no
 *  audience-size read" no longer holds). Fetched at confirm-open and shown as
 *  a labelled ESTIMATE — the market convention (Klaviyo/Mailchimp), never a
 *  guaranteed-exact count. */
export async function getSegmentEstimate(segmentId: string): Promise<{ size: number }> {
  const res = await fetch(`${root}/crm/segments/${encodeURIComponent(segmentId)}/estimate`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ size: number }>(res, 'getSegmentEstimate');
}

export async function listSegments(): Promise<EmailSegment[]> {
  const res = await fetch(`${root}/crm/segments`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ segments: EmailSegment[] }>(res, 'listSegments')).segments;
}
export async function deleteCampaign(orgId: string, campaignId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteCampaign returned ${res.status}`);
}
/** R2 EM-G3 — one marked test email to an explicit recipient; 204 on success. */
export async function sendTestEmail(orgId: string, campaignId: string, to: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/test-send`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ to }) }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `sendTestEmail returned ${res.status}`);
  }
}

export async function sendCampaign(orgId: string, campaignId: string, resend = false): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/send`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ resend }) }));
  return asJson<Campaign>(res, 'sendCampaign');
}
/** R3 EM-SP-7 — the engagement read (opens/clicks/unsubs) finally gets a consumer. */
export interface EngagementStats {
  clicks: number; uniqueClicks: number; unsubscribes: number; opens: number; uniqueOpens: number;
  /** EM-UX-1: of `unsubscribes`, how many did NOT persist every send-stopping
   *  write — recipients the next campaign will still reach. */
  unsubscribesUnenforced: number;
}
export interface EngagementEvent { id: string; contactId: string; kind: 'clicked' | 'unsubscribed' | 'opened'; url?: string; at: string }
export async function getEngagement(orgId: string, campaignId: string): Promise<{ stats: EngagementStats; events: EngagementEvent[] }> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/engagement`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ stats: EngagementStats; events: EngagementEvent[] }>(res, 'getEngagement');
}

export async function listSends(orgId: string, campaignId: string): Promise<SendLog[]> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/sends`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ sends: SendLog[] }>(res, 'listSends')).sends;
}

/** Sender identity — the per-org verified from-address campaigns send with
 *  (required before /send works; ADR 0019 correction note / ADR 0193). */
export interface EmailSettings { senderAddress: string; configured: boolean }
export interface ProviderStatus {
  providers: { provider: string; connected: boolean }[];
  defaultProvider: string | null;
  senderAddress: string | null;
}
export async function getProviderStatus(orgId: string): Promise<ProviderStatus> {
  const res = await fetch(`${base(orgId)}/provider-status`, fetchOpts({ headers: authedHeaders() }));
  return asJson<ProviderStatus>(res, 'getProviderStatus');
}
export async function getEmailSettings(orgId: string): Promise<EmailSettings> {
  const res = await fetch(`${base(orgId)}/settings`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EmailSettings>(res, 'getEmailSettings');
}
export async function putEmailSettings(orgId: string, senderAddress: string): Promise<EmailSettings> {
  const res = await fetch(`${base(orgId)}/settings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ senderAddress }) }));
  return asJson<EmailSettings>(res, 'putEmailSettings');
}
