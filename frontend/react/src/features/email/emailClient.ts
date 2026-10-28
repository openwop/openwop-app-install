/**
 * Email Marketing API client (ADR 0019). Authed org-scoped templates + campaigns
 * under /host/openwop-app/email/orgs/:orgId. No public surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { TextDiff } from '../../chat/artifacts/artifactClient.js';

export interface Org { orgId: string; name: string }
export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

export type EmailBodyFormat = 'text' | 'markdown' | 'sms';

/** ADR 0955 D8 — SMS segment count (160/153 GSM-7, 70/67 otherwise); the server re-checks. */
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
export function smsSegments(text: string): number {
  const len = [...text].length;
  if (GSM7.test(text)) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}
export interface EmailTemplate { templateId: string; orgId: string; name: string; subject: string; body: string; format?: EmailBodyFormat; version?: number; contentHash?: string; createdAt: string; updatedAt: string }
/** ADR 0905 D1 — one immutable content version of a template. */
export interface EmailTemplateVersion { templateId: string; version: number; subject: string; body: string; format?: EmailBodyFormat; restoredFrom?: number; createdBy: string; createdAt: string }
/** ADR 0905 D1 — the server-computed comparison of two versions (body via `host/textDiff`). */
export interface EmailTemplateVersionDiff { from: number; to: number; subject: { from: string; to: string; changed: boolean }; body: TextDiff }
/** ADR 0905 D1 — a save from a version someone else has since superseded (409 `version_conflict`). */
export class TemplateVersionConflictError extends Error {
  constructor(readonly currentVersion: number | undefined) { super('version_conflict'); }
}
/** A server refusal carrying its message (and `details.reason`) instead of a bare status. */
async function failWithReason(res: Response, ctx: string): Promise<never> {
  let body: { message?: string; details?: { reason?: string; currentVersion?: number } } = {};
  try { body = (await res.json()) as typeof body; } catch { /* non-JSON */ }
  if (res.status === 409 && body.details?.reason === 'version_conflict') throw new TemplateVersionConflictError(body.details.currentVersion);
  throw new Error(body.message || `${ctx} returned ${res.status}`);
}
export interface CampaignStats { sent: number; failed: number; skipped: number }
/** ADR 0905 D3 — the campaign's send-review cycle (mirrors the approval row). */
export interface CampaignReview {
  cycle: number; approvalId: string; fromStatus: 'draft' | 'sent';
  pin: { templateId: string; templateVersion: number; contentHash: string; senderAddress: string; audienceHash: string };
  submittedBy?: string; submittedAt: string;
  outcome?: 'approved' | 'changes_requested' | 'closed'; decidedBy?: string; decidedAt?: string; note?: string;
}
export type CampaignStatus = 'draft' | 'in_review' | 'approved' | 'sending' | 'sent';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['draft', 'in_review', 'approved', 'sending', 'sent'];
/** ADR 0905 D7 — an org's subscription topic (an opt-out list; it only narrows). */
export interface EmailTopic { topicId: string; orgId: string; name: string; description?: string; createdAt: string; updatedAt: string }
export interface Campaign { campaignId: string; orgId: string; templateId: string; audience: { stage?: ContactStage; segmentId?: string }; topicId?: string; status: CampaignStatus; stats?: CampaignStats; review?: CampaignReview; createdAt: string; updatedAt: string }
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
/** `expectedVersion` (ADR 0905 D1) makes the save fail with `TemplateVersionConflictError`
 *  rather than overwrite a version someone else saved since this editor loaded. */
export async function updateTemplate(orgId: string, templateId: string, patch: { name?: string; subject?: string; body?: string; format?: EmailBodyFormat; expectedVersion?: number }): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  if (!res.ok) return failWithReason(res, 'updateTemplate');
  return (await res.json()) as EmailTemplate;
}
export async function listTemplateVersions(orgId: string, templateId: string): Promise<EmailTemplateVersion[]> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}/versions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ versions: EmailTemplateVersion[] }>(res, 'listTemplateVersions')).versions;
}
export async function diffTemplateVersion(orgId: string, templateId: string, version: number): Promise<EmailTemplateVersionDiff> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}/versions/${version}/diff`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EmailTemplateVersionDiff>(res, 'diffTemplateVersion');
}
export async function restoreTemplateVersion(orgId: string, templateId: string, version: number, expectedVersion: number | undefined): Promise<EmailTemplate> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}/versions/${version}/restore`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(expectedVersion ? { expectedVersion } : {}) }));
  if (!res.ok) return failWithReason(res, 'restoreTemplateVersion');
  return (await res.json()) as EmailTemplate;
}
/** ADR 0256 — server-authoritative safe-markdown preview (the same renderer that
 *  builds the sent HTML part), so the editor preview is what actually sends. */
export async function previewMarkdown(orgId: string, body: string): Promise<string> {
  const res = await fetch(`${base(orgId)}/preview`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ body }) }));
  return (await asJson<{ html: string }>(res, 'previewMarkdown')).html;
}
export async function deleteTemplate(orgId: string, templateId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // ADR 0905 D1 — a 409 `template_in_use` carries a message the user can act on.
  if (!res.ok) await failWithReason(res, 'deleteTemplate');
}

export async function listCampaigns(orgId: string): Promise<Campaign[]> {
  const res = await fetch(`${base(orgId)}/campaigns`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ campaigns: Campaign[] }>(res, 'listCampaigns')).campaigns;
}
/** ADR 0955 D7 — the org's sending health (the per-sender breaker). */
export interface SendingHealth {
  state: { paused: boolean; pausedAt?: string; reason?: 'complaints' | 'hard_bounces'; resumedAt?: string } | null;
  window: { sent: number; hardBounces: number; complaints: number };
  thresholds: { minSends: number; complaintRate: number; hardBounceRate: number };
  canResume: boolean;
  /** ADR 0955 P4b — present only while the workspace warms up new senders and this one is on the ramp. */
  warmup?: { day: number; cap: number; remaining: number } | null;
}
export async function getSendingHealth(orgId: string): Promise<SendingHealth> {
  const res = await fetch(`${base(orgId)}/deliverability`, fetchOpts({ headers: authedHeaders() }));
  return asJson<SendingHealth>(res, 'getSendingHealth');
}
export async function resumeSending(orgId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/deliverability/resume`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  await asJson<unknown>(res, 'resumeSending');
}

export async function listTopics(orgId: string): Promise<{ topics: EmailTopic[]; max: number }> {
  const res = await fetch(`${base(orgId)}/topics`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ topics: EmailTopic[]; max: number }>(res, 'listTopics');
}
export async function createTopic(orgId: string, input: { name: string; description?: string }): Promise<EmailTopic> {
  const res = await fetch(`${base(orgId)}/topics`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<EmailTopic>(res, 'createTopic');
}
export async function deleteTopic(orgId: string, topicId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/topics/${encodeURIComponent(topicId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `deleteTopic returned ${res.status}`);
  }
}
export async function createCampaign(orgId: string, input: { templateId: string; stage?: ContactStage; segmentId?: string; topicId?: string }): Promise<Campaign> {
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
/** ADR 0848 D5 — test sends are metered per member per hour; the page formats the
 *  wait itself (localized) from `Retry-After` instead of showing the server's English. */
export class TestSendRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) { super('test_send_rate_limited'); }
}
/** R2 EM-G3 — one marked test email to an explicit recipient; 204 on success. */
export async function sendTestEmail(orgId: string, campaignId: string, to: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/test-send`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ to }) }));
  if (res.status === 429) {
    // Only the email meter's 429 is "too many test sends"; the global per-IP budget is not.
    let limit = '';
    try { limit = String(((await res.clone().json()) as { details?: { limit?: unknown } }).details?.limit ?? ''); } catch { /* non-JSON */ }
    if (limit === 'email_test_send') throw new TestSendRateLimitedError(Math.max(1, Number(res.headers.get('retry-after')) || 60));
  }
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

/** Sender identity — the per-org from-address campaigns send with (required before
 *  /send works; ADR 0019 correction note / ADR 0193). ADR 0848 D4 — `canEdit`: may THIS
 *  caller change it (an admin-tier setting)? Absent from an older backend ⇒ treated as
 *  editable (the PUT still decides). */
export interface EmailSettings {
  senderAddress: string; configured: boolean; canEdit?: boolean;
  /** ADR 0905 D4 — sends need an approval in this workspace (`email-approval-gate`). */
  approvalGate?: boolean;
  /** ADR 0905 D3 — the org's extra approvers besides its admins. */
  approverRoleRefs?: string[]; approverGroupRefs?: string[];
}
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
/** ADR 0905 D3 — submit a campaign for send review (or re-pin an open review). */
export async function submitCampaignReview(orgId: string, campaignId: string): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/submit-review`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ campaign: Campaign }>(res, 'submitCampaignReview')).campaign;
}
/** ADR 0905 D3 — withdraw an open review; the campaign returns to draft. */
export async function withdrawCampaignReview(orgId: string, campaignId: string): Promise<Campaign> {
  const res = await fetch(`${base(orgId)}/campaigns/${encodeURIComponent(campaignId)}/withdraw-review`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<Campaign>(res, 'withdrawCampaignReview');
}
export async function putEmailSettings(orgId: string, senderAddress: string): Promise<EmailSettings> {
  const res = await fetch(`${base(orgId)}/settings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ senderAddress }) }));
  return asJson<EmailSettings>(res, 'putEmailSettings');
}
