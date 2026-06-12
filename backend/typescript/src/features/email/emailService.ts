/**
 * Email Marketing service (host-extension, ADR 0019) — the ENGAGE leg. Templates +
 * campaigns whose audience resolves LIVE from `crm/contactsService` (never a copied
 * list), rendered per contact and dispatched through a pluggable provider adapter
 * (v1: a console/stub sink, honest capability). Every send is gated on `marketing`
 * consent via the ONE `consentService.isAllowed` helper (ADR 0020).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { listContacts, type ContactStage } from '../crm/contactsService.js';
import { isAllowed } from '../consent/consentService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export interface EmailTemplate {
  templateId: string; tenantId: string; orgId: string;
  name: string; subject: string; body: string; // body/subject: {{contact.name|email|company}}
  createdBy: string; createdAt: string; updatedAt: string;
}

export type CampaignStatus = 'draft' | 'sending' | 'sent';
export interface CampaignStats { sent: number; failed: number; skipped: number }
export interface Campaign {
  campaignId: string; tenantId: string; orgId: string;
  templateId: string; audience: { stage?: ContactStage };
  status: CampaignStatus; stats?: CampaignStats;
  createdBy: string; createdAt: string; updatedAt: string;
}

export type SendStatus = 'sent' | 'failed' | 'skipped';
export interface SendLog { sendId: string; tenantId: string; campaignId: string; contactId: string; status: SendStatus; error?: string; ts: string }

const templates = new DurableCollection<EmailTemplate>('email:template', (t) => t.templateId);
const campaigns = new DurableCollection<Campaign>('email:campaign', (c) => c.campaignId);
const sendLogs = new DurableCollection<SendLog>('email:sendlog', (s) => s.sendId);

// ── provider seam (honest capability: a real provider only when configured) ──
export interface EmailMessage { to: string; subject: string; body: string }
export interface EmailProvider { id: string; send(msg: EmailMessage): Promise<void> }
const stubProvider: EmailProvider = { id: 'console', async send() { /* sample sink — no real delivery */ } };
/** The active provider — v1 always the console stub (no env-configured provider yet). */
export function activeProvider(): EmailProvider { return stubProvider; }

function interpolate(s: string, vars: { name: string; email: string; company: string }): string {
  return s.replace(/\{\{\s*contact\.(name|email|company)\s*\}\}/g, (_m, k: string) => (k === 'name' ? vars.name : k === 'email' ? vars.email : vars.company));
}

// ── templates ──
export async function listTemplates(tenantId: string, orgId: string): Promise<EmailTemplate[]> {
  return (await templates.list()).filter((t) => t.tenantId === tenantId && t.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getTemplate(tenantId: string, orgId: string, templateId: string): Promise<EmailTemplate | null> {
  const t = await templates.get(templateId);
  return t && t.tenantId === tenantId && t.orgId === orgId ? t : null;
}
export async function createTemplate(input: { tenantId: string; orgId: string; name: string; subject: string; body: string; createdBy: string }): Promise<EmailTemplate> {
  const now = new Date().toISOString();
  const t: EmailTemplate = { templateId: `tpl:${randomUUID()}`, ...input, createdAt: now, updatedAt: now };
  await templates.put(t);
  return t;
}
export async function updateTemplate(tenantId: string, orgId: string, templateId: string, patch: { name?: string; subject?: string; body?: string }): Promise<EmailTemplate | null> {
  const existing = await getTemplate(tenantId, orgId, templateId);
  if (!existing) return null;
  const next: EmailTemplate = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await templates.put(next);
  return next;
}
export async function deleteTemplate(tenantId: string, orgId: string, templateId: string): Promise<boolean> {
  const existing = await getTemplate(tenantId, orgId, templateId);
  return existing ? templates.delete(templateId) : false;
}

// ── campaigns ──
export async function listCampaigns(tenantId: string, orgId: string): Promise<Campaign[]> {
  return (await campaigns.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getCampaign(tenantId: string, orgId: string, campaignId: string): Promise<Campaign | null> {
  const c = await campaigns.get(campaignId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}
export async function createCampaign(input: { tenantId: string; orgId: string; templateId: string; stage?: ContactStage; createdBy: string }): Promise<Campaign> {
  const now = new Date().toISOString();
  const c: Campaign = {
    campaignId: `cmp:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, templateId: input.templateId,
    audience: { ...(input.stage ? { stage: input.stage } : {}) }, status: 'draft', createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await campaigns.put(c);
  return c;
}
export async function deleteCampaign(tenantId: string, orgId: string, campaignId: string): Promise<boolean> {
  const existing = await getCampaign(tenantId, orgId, campaignId);
  return existing ? campaigns.delete(campaignId) : false;
}
export async function listSends(tenantId: string, campaignId: string): Promise<SendLog[]> {
  return (await sendLogs.list()).filter((s) => s.tenantId === tenantId && s.campaignId === campaignId).sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * Send a campaign: resolve the audience LIVE from contactsService, render per
 * contact, **consent-gate on `marketing`** (skip non-consenting), dispatch via the
 * provider, append a SendLog per recipient (append-only), and roll up stats.
 * Partial-failure isolation: one recipient never aborts the batch.
 */
export async function sendCampaign(tenantId: string, orgId: string, campaignId: string, opts: { resend?: boolean } = {}): Promise<Campaign | null> {
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign) return null;
  // Re-send guard: a 'sent' campaign re-sends to EVERYONE — require explicit intent
  // (each send is a real dispatch; duplicates are worse than for analytics).
  if (campaign.status === 'sent' && !opts.resend) {
    throw new OpenwopError('conflict', 'Campaign already sent — pass `resend: true` to send it again.', 409, { campaignId, status: campaign.status });
  }
  const template = await getTemplate(tenantId, orgId, campaign.templateId);
  if (!template) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });

  const provider = activeProvider();
  const audience = (await listContacts(tenantId)).filter((c) => !campaign.audience.stage || c.stage === campaign.audience.stage);
  const stats: CampaignStats = { sent: 0, failed: 0, skipped: 0 };

  for (const contact of audience) {
    const log = (status: SendStatus, error?: string): SendLog => ({ sendId: `snd:${randomUUID()}`, tenantId, campaignId, contactId: contact.contactId, status, ts: new Date().toISOString(), ...(error ? { error } : {}) });
    if (!contact.email) { stats.skipped += 1; await sendLogs.put(log('skipped', 'no_email')); continue; }
    if (!(await isAllowed(tenantId, contact.contactId, 'marketing'))) { stats.skipped += 1; await sendLogs.put(log('skipped', 'consent')); continue; }
    const vars = { name: contact.name, email: contact.email, company: contact.company ?? '' };
    try {
      await provider.send({ to: contact.email, subject: interpolate(template.subject, vars), body: interpolate(template.body, vars) });
      stats.sent += 1; await sendLogs.put(log('sent'));
    } catch (e) {
      stats.failed += 1; await sendLogs.put(log('failed', e instanceof Error ? e.message : 'send_failed'));
    }
  }

  const next: Campaign = { ...campaign, status: 'sent', stats, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  return next;
}

/** Render a template with a contact's fields (pure — used by the render node). */
export function renderTemplate(template: EmailTemplate, vars: { name?: string; email?: string; company?: string }): { subject: string; body: string } {
  const v = { name: vars.name ?? '', email: vars.email ?? '', company: vars.company ?? '' };
  return { subject: interpolate(template.subject, v), body: interpolate(template.body, v) };
}

/** GDPR data-subject erasure: delete every send-log for a (tenant, subjectKey). A
 *  send-log keys on the recipient's `contactId` — the same id the marketing consent
 *  gate checks — so a consent data-subject delete must purge these too. */
export async function deleteSubjectSends(tenantId: string, subjectKey: string): Promise<number> {
  if (!subjectKey) return 0;
  const all = await sendLogs.list();
  let removed = 0;
  for (const s of all) {
    if (s.tenantId === tenantId && s.contactId === subjectKey) { await sendLogs.delete(s.sendId); removed += 1; }
  }
  return removed;
}

// Register the email purge handler so Consent's data-subject delete cascades to
// send-logs (the subject-erasure seam — ADR 0020 / 0019). Module-load once.
const emailEraser = async (tenantId: string, subjectKey: string): Promise<void> => { await deleteSubjectSends(tenantId, subjectKey); };
registerSubjectEraser(emailEraser);

/** Test-only: clear all email stores. */
export async function __resetEmailStore(): Promise<void> { await templates.__clear(); await campaigns.__clear(); await sendLogs.__clear(); }
