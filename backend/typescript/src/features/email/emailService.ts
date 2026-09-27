/**
 * Email Marketing service (host-extension, ADR 0019) — the ENGAGE leg. Templates +
 * campaigns whose audience resolves LIVE from `crm/contactsService` (never a copied
 * list), rendered per contact and dispatched through a pluggable provider adapter
 * (v1: a console/stub sink, honest capability). Every send is gated on `marketing`
 * consent via the ONE `consentService.isAllowed` helper (ADR 0020).
 */

import { randomUUID } from 'node:crypto';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { listContacts, type Contact, type ContactStage } from '../crm/contactsService.js';
import { isAllowed } from '../consent/consentService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onCrmRecordMerged, onCrmRecordUnmerged } from '../../host/crmRecordLifecycle.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createActivity, getActivity } from '../crm/crmEntitiesService.js';
import { getSegment, resolveSegmentMembers } from '../crm/segmentsService.js';
import { suppressionBlocksSend } from '../crm/suppressionService.js';
import { instrumentBody, mintToken, renderHtmlBody, deleteSubjectEngagement } from './engagementService.js';
import { deleteSubjectBounceCounts } from './bounceWebhooks.js';
import { renderMarkdownBody } from './safeMarkdown.js';
import { createLogger } from '../../observability/logger.js';
import { vendorPublicBase } from '../featureRoute.js';

const bridgeLog = createLogger('email.activityBridge');
const svcLog = createLogger('email.service');

/** ADR 0256 — how the body authors its HTML part. `text` (default) is the ADR
 *  0242 escape-first plain-text render; `markdown` renders a safe Markdown subset. */
export type EmailBodyFormat = 'text' | 'markdown';
export interface EmailTemplate {
  templateId: string; tenantId: string; orgId: string;
  name: string; subject: string; body: string; // body/subject: {{contact.name|email|company}}
  /** ADR 0256 — body authoring mode; absent ⇒ 'text' (back-compat). */
  format?: EmailBodyFormat;
  createdBy: string; createdAt: string; updatedAt: string;
}

export type CampaignStatus = 'draft' | 'sending' | 'sent';
export interface CampaignStats { sent: number; failed: number; skipped: number }
export interface Campaign {
  campaignId: string; tenantId: string; orgId: string;
  templateId: string;
  /** `stage` and `segmentId` are mutually exclusive (ADR 0211 §2) — `createCampaign`
   *  400s at create when both are set. */
  audience: { stage?: ContactStage; segmentId?: string };
  status: CampaignStatus; stats?: CampaignStats;
  /** R2 review F2 — the current send GENERATION (0 for a campaign that has
   *  never been resent): incremented when a resend starts; ledger reads (the
   *  exclusion set + derived stats) consider only rows OF this generation, so
   *  prior-generation rows can't poison a resend. A counter, not a timestamp —
   *  ms-resolution timestamps tie within a fast pass and cannot discriminate. */
  sendGeneration?: number;
  /** ADR 0245 — provenance: the campaign brief this email draft was published
   *  FROM (via the channel-publish node). A pure link to the MarketingCampaign
   *  (one per brief, `getCampaignByBrief`) — the email campaign stays its own
   *  honest per-email-engagement row; this just enables a future intel join. */
  sourceBriefId?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

export type SendStatus = 'sent' | 'failed' | 'skipped';
export interface SendLog { sendId: string; tenantId: string; campaignId: string; contactId: string; status: SendStatus; error?: string; ts: string   /** R2 review F2 — which send generation wrote this row (absent = 0). */
  generation?: number;
  /** CRM-5 — set when a CRM contact merge moved this row from that contactId onto
   *  the current one. Additive; absent on every row written by a send. It is what
   *  makes the move REVERSIBLE: an unmerge returns exactly the rows it moved,
   *  never the survivor's own pre-merge deliveries. */
  mergedFrom?: string;
}

const templates = new DurableCollection<EmailTemplate>('email:template', (t) => t.templateId);
const campaigns = new DurableCollection<Campaign>('email:campaign', (c) => c.campaignId);
// CRM-11 fold-in (B4) — `tenantOf` arms the `hostextidx:` TENANT SECONDARY INDEX,
// so every read below is a bounded scan of ONE tenant's ledger instead of
// `list()`'s cross-tenant sweep of the whole collection. The primary rows are not
// re-keyed (no migration, no data-loss risk) and `ensureTenantIndex` backfills the
// markers once, fleet-wide, on first indexed read — the same shape
// `host/accessControlService.ts` used to arm `access-members`.
//
// This was not cosmetic. `relinkSendLogsOnMerge` runs on the CRM merge seam, whose
// contract says outright that handlers "MUST bound their work (indexed/point reads
// — never a cross-tenant scan)", and it was doing exactly the forbidden thing on
// the merge hot path.
const sendLogs = new DurableCollection<SendLog>('email:sendlog', (s) => s.sendId, undefined, (s) => s.tenantId);
// ADR 0655 D9 (EM-18) — a per-contact send ledger is subject-linked behavioural data.
declarePiiFields('email.sendlog', ['contactId'], { maskGloballyByFieldName: false });
// ADR 0655 D9 (EM-17) — the send log ages like the engagement rows (tenant-indexed;
// `ts` is the event time). It was append-only forever.
registerRetentionPurger({
  feature: 'email:sendlog',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('email:sendlog', await sendLogs.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.ts, id: r.sendId }),
      (id) => sendLogs.delete(id));
  },
});

// ── per-org settings (sender identity) ──────────────────────────────────────
// The campaign `from` address is an OPERATOR-owned property (a SendGrid
// verified sender the host cannot introspect from an api_key Connection), so
// it is explicit per-org configuration — never a hardcoded default (ADR 0193's
// "OpenWOP never silently sends as you" invariant, branch (a)). Keyed
// `${tenantId}::${orgId}` (the cms langSettings precedent).
export interface EmailSettings {
  tenantId: string; orgId: string;
  /** Verified sender address campaigns send from. Empty ⇒ sending unconfigured. */
  senderAddress: string;
  updatedBy: string; updatedAt: string;
}
const settings = new DurableCollection<EmailSettings>('email:settings', (s) => `${s.tenantId}::${s.orgId}`);

export async function getEmailSettings(tenantId: string, orgId: string): Promise<EmailSettings | null> {
  const row = await settings.get(`${tenantId}::${orgId}`);
  return row && row.tenantId === tenantId && row.orgId === orgId ? row : null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function setSenderAddress(tenantId: string, orgId: string, senderAddress: string, updatedBy: string): Promise<EmailSettings> {
  const trimmed = senderAddress.trim();
  if (trimmed !== '' && !EMAIL_SHAPE.test(trimmed)) {
    throw new OpenwopError('validation_error', 'senderAddress must be a valid email address (or empty to unset).', 400, { field: 'senderAddress' });
  }
  const row: EmailSettings = { tenantId, orgId, senderAddress: trimmed, updatedBy, updatedAt: new Date().toISOString() };
  await settings.put(row);
  return row;
}

// ── provider seam (honest capability: a real provider only when configured) ──
export interface EmailMessage {
  to: string; subject: string; body: string;
  /** ADR 0242: the optional HTML part (multipart/alternative). Carries the
   *  tracked links + the open pixel; `body` remains the plain-text part. */
  html?: string;
  /** Sender address (per-org setting). The brokered provider requires it. */
  from?: string;
  /** Deterministic per-recipient key — host-side dedup rides the sendLogs
   *  ledger; providers with native dedup (SES) also get it on the wire (the
   *  ADR 0193 idempotency requirement). The campaign path uses
   *  `cmp:<campaignId>:g<sendGeneration>:<contactId>`: EM-1 — without the
   *  generation the adapter's pre-flight found the prior row and short-circuited
   *  `{sent:true}` WITHOUT calling the provider, so a resend delivered nothing
   *  and reported full success for the whole ledger TTL (default 30 days). */
  idempotencyKey?: string;
  /** ADR 0402 — optional attachments (e.g. a booking's `.ics` calendar invite).
   *  The console stub ignores them; a brokered provider carries them. */
  attachments?: { filename: string; content: string; contentType: string }[];
}
export interface EmailProvider { id: string; send(msg: EmailMessage): Promise<void> }
/** The `'console'` id is the sentinel for "no real transport configured". LEAK-1:
 *  `sendCampaign` refuses to run on it (returns an honest 503) rather than logging
 *  a no-op as `sent`. A real deployment injects a connector-brokered provider —
 *  the SendGrid `ctx.email.send` spine (`host/emailAdapter.ts`) + a verified sender
 *  identity — via `sendCampaign(..., { provider })`, per ADR 0193. */
const CONSOLE_PROVIDER_ID = 'console';
const stubProvider: EmailProvider = { id: CONSOLE_PROVIDER_ID, async send() { /* no real delivery — sendCampaign 503s before reaching this */ } };
/** The active provider — v1 the console stub (no env-configured provider yet). */
export function activeProvider(): EmailProvider { return stubProvider; }

/**
 * Is a REAL email transport configured, or is `activeProvider()` still the
 * no-op console stub?
 *
 * WHY THIS IS EXPORTED. `sendCampaign` already refuses on the stub (LEAK-1
 * above) rather than logging a no-op as `sent` — but three other callers reach
 * `activeProvider().send()` directly and had no way to ask: e-signature
 * invitations (`crm/signService`) and booking confirmations + cancellations
 * (`crm/bookingService`). Each wrapped the call in a `catch` that only warns,
 * and two dispatch it with `void`, so a stub that never throws produced THREE
 * layers of silence: no-op send → swallowed error → discarded promise. A user
 * requested a signature or booked a meeting, the API reported success, and no
 * email existed. Found by a sweep for tests that pin defects — this one had no
 * test at all (`activeProvider` appeared in zero test files).
 *
 * Callers use this to tell the truth in their RESULT rather than only in a log.
 */
export function emailTransportConfigured(): boolean {
  return activeProvider().id !== CONSOLE_PROVIDER_ID;
}

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
export async function createTemplate(input: { tenantId: string; orgId: string; name: string; subject: string; body: string; format?: EmailBodyFormat; createdBy: string; templateId?: string }): Promise<EmailTemplate> {
  // Idempotent on a caller-supplied deterministic id (mirrors cmsService.createPage's
  // pageId short-circuit) so a replay/fork of a publish node never duplicates a template.
  if (input.templateId) {
    const prior = await getTemplate(input.tenantId, input.orgId, input.templateId);
    if (prior) return prior;
  }
  const now = new Date().toISOString();
  const t: EmailTemplate = {
    templateId: input.templateId ?? `tpl:${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId,
    name: input.name, subject: input.subject, body: input.body,
    ...(input.format === 'markdown' ? { format: 'markdown' as const } : {}),
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await templates.put(t);
  return t;
}
export async function updateTemplate(tenantId: string, orgId: string, templateId: string, patch: { name?: string; subject?: string; body?: string; format?: EmailBodyFormat }): Promise<EmailTemplate | null> {
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
export async function createCampaign(input: { tenantId: string; orgId: string; templateId: string; stage?: ContactStage; segmentId?: string; createdBy: string; campaignId?: string; sourceBriefId?: string }): Promise<Campaign> {
  // Idempotent on a caller-supplied deterministic id — a re-run/fork of a publish
  // node returns the existing campaign instead of minting a duplicate (replay-safe).
  if (input.campaignId) {
    const prior = await getCampaign(input.tenantId, input.orgId, input.campaignId);
    if (prior) return prior;
  }
  // `stage` and `segmentId` are mutually exclusive audience filters (ADR 0211 §2) —
  // email remains the audience OWNER, CRM owns the filter definition.
  if (input.stage && input.segmentId) {
    throw new OpenwopError('validation_error', '`stage` and `segmentId` are mutually exclusive audience filters.', 400, { field: 'audience' });
  }
  if (input.segmentId && !(await getSegment(input.tenantId, input.segmentId))) {
    throw new OpenwopError('validation_error', 'Unknown segmentId for this tenant.', 400, { field: 'segmentId', segmentId: input.segmentId });
  }
  const now = new Date().toISOString();
  const c: Campaign = {
    campaignId: input.campaignId ?? `cmp:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, templateId: input.templateId,
    audience: { ...(input.stage ? { stage: input.stage } : {}), ...(input.segmentId ? { segmentId: input.segmentId } : {}) },
    status: 'draft', ...(input.sourceBriefId ? { sourceBriefId: input.sourceBriefId } : {}), createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await campaigns.put(c);
  return c;
}
export async function deleteCampaign(tenantId: string, orgId: string, campaignId: string): Promise<boolean> {
  const existing = await getCampaign(tenantId, orgId, campaignId);
  return existing ? campaigns.delete(campaignId) : false;
}
export async function listSends(tenantId: string, campaignId: string): Promise<SendLog[]> {
  return (await sendLogs.listForTenantIndexed(tenantId)).filter((s) => s.tenantId === tenantId && s.campaignId === campaignId).sort((a, b) => b.ts.localeCompare(a.ts));
}

/** ADR 0243 — the per-contact `sent` count across ALL campaigns since `sinceIso`,
 *  for journey frequency caps. The email feature owns its ledger (the SSoT), so
 *  the journey verb reads THROUGH here. Scans the retention-bounded send ledger;
 *  a per-contact index is a recorded follow-on if this becomes hot. */
export async function contactSendCount(tenantId: string, contactId: string, sinceIso: string): Promise<number> {
  const all = await sendLogs.listForTenantIndexed(tenantId);
  return all.filter((s) => s.tenantId === tenantId && s.contactId === contactId && s.status === 'sent' && s.ts >= sinceIso).length;
}

/** ADR 0267 / CDP-E — the frequency-governor cap from env. `max <= 0` ⇒ OFF (the
 *  default; the send loop then skips the ledger scan entirely, behavior unchanged).
 *  Read at call time (not module load) so it's operator-tunable + testable. */
export function emailFrequencyCap(): { max: number; windowDays: number } {
  const max = Number(process.env.OPENWOP_EMAIL_FREQ_CAP_MAX);
  const windowDays = Number(process.env.OPENWOP_EMAIL_FREQ_CAP_WINDOW_DAYS);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 30,
  };
}

/** Per-invocation recipient cap: the send loop is sequential per-recipient HTTP
 *  through the connection broker, and the route must return inside the ~60s
 *  proxy budget. Remaining recipients leave the campaign `'sending'`; the
 *  client re-invokes to continue (safe + exact via the sendLogs ledger). */
const SEND_BATCH_DEFAULT = 50;

// In-process per-campaign serialization: the sendLogs LEDGER read is not
// transactional with the dispatch loop, so two OVERLAPPING invocations (a
// double-click, a racing continuation) would both see an empty ledger and
// re-dispatch. Serializing per (tenant, campaign) makes the second
// invocation observe the first's ledger.
//
// Cross-instance correction (2026-07-03, PR #1181): DELIVERY is now
// CAS-guarded below this layer — every dispatch carries the fork-stable
// `cmp:<campaign>:<contact>` idempotencyKey, which the email adapter
// atomically RESERVES in the sent-ledger (emailSentLedger.reserveSend,
// DurableCollection.compareAndSwap) before the provider call. Two instances
// racing the same contact resolve to exactly ONE email; the only residual is
// bookkeeping (both may append a 'sent' sendLog → stats can over-count by
// the overlap), never a double delivery.
const sendLocks = new Map<string, Promise<unknown>>();
async function withSendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => gate);
  sendLocks.set(key, chained);
  await prev.catch(() => undefined); // a prior failed send never blocks the next
  try {
    return await fn();
  } finally {
    release();
    if (sendLocks.get(key) === chained) sendLocks.delete(key);
  }
}

/**
 * Email→activity bridge (ADR 0211 §1): append a CRM activity for a contact whose
 * send just landed `status: 'sent'`. Deterministic `activityId` (`act:email:
 * <campaignId>:<contactId>`) makes it idempotent — a resend/retry short-circuits
 * onto the same row via `createActivity`'s own dedup, never a duplicate timeline
 * entry. Never stores rendered content or the subject line — only the template
 * name (PII discipline; the timeline is org-visible). Best-effort: ANY failure
 * here is caught and logged, never surfaced to the caller — a bridge outage must
 * never fail a send.
 *
 * CRMGAP-13/EM-1: a point-read existence check runs BEFORE the append. Before
 * this, `createActivity`'s OWN dedup already skipped the duplicate row on a
 * resend, but the code still ran to the end and re-emitted `crmMutated` (a
 * fresh `host.crm.activity.logged` host event + audit row) for a row that was
 * NOT actually new — a resend of the same campaign re-fired the event every
 * time. Checking existence first skips BOTH the append and the emit.
 */
async function appendEmailActivity(tenantId: string, orgId: string, campaignId: string, templateName: string, contactId: string): Promise<void> {
  try {
    const activityId = `act:email:${campaignId}:${contactId}`;
    if (await getActivity(tenantId, orgId, activityId)) return; // already logged for this campaign+contact — a resend, not a new event.
    await createActivity({
      tenantId,
      orgId,
      kind: 'email',
      body: `Campaign email: ${templateName}`,
      contactId,
      createdBy: `email:${campaignId}`,
      activityId,
      skipCapCheck: true,
      // The contact was just resolved live off `listContacts`/`resolveSegmentMembers`
      // for this same tenant, so its existence is already established — a real
      // lookup here would be redundant work on the hot send path (mirrors
      // `convertService.ts`'s `validateContact: async () => true` precedent).
      // No deal/company link is ever attached, so those validators never fire.
      validators: { validateDeal: async () => true, validateCompany: async () => true, validateContact: async () => true },
    });
    // ADR 0627 D2 — `host.crm.activity.logged` now fires INSIDE `createActivity`
    // on its created branch only (the CRMGAP-13 point-read above still skips the
    // append itself); no second emit site here.
  } catch (e) {
    bridgeLog.warn('email→activity bridge append failed', {
      campaignId, contactId, error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Send a campaign: resolve the audience LIVE from contactsService, render per
 * contact, **consent-gate on `marketing`** (skip non-consenting), dispatch via the
 * provider, append a SendLog per recipient (append-only), and roll up stats.
 * Partial-failure isolation: one recipient never aborts the batch.
 *
 * Idempotent + resumable (ADR 0193's double-send requirement): contacts with an
 * existing `sent` log for this campaign are SKIPPED (the sendLogs ledger), so a
 * crash/timeout/re-invoke never re-delivers; `resend: true` explicitly bypasses
 * the ledger. Batched: at most `opts.limit` (default 50) dispatches per call;
 * remaining audience ⇒ status `'sending'` + accumulated stats, exhausted ⇒ `'sent'`.
 */
/**
 * R2 EM-G3 (promoted) — a TEST send: one email to an explicit recipient,
 * riding the same template/sender/provider spine as a real dispatch, with the
 * differences that make it a test:
 *  - subject carries an explicit "[Test]" marker (the HubSpot distinct-
 *    identity convention);
 *  - personalization tokens are NOT fabricated — they render as their literal
 *    `{{name}}` form so the tester SEES what is unresolved (the Mailchimp
 *    honesty note: merge tags don't render in test sends);
 *  - it NEVER touches the campaign's ledger, stats, or status — stats derive
 *    from the ledger (EM-SP-1), so a test row would corrupt the counts.
 */
export async function sendTestEmail(
  tenantId: string, orgId: string, campaignId: string, to: string,
  opts: { provider?: EmailProvider } = {},
): Promise<void> {
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId });
  const template = await getTemplate(tenantId, orgId, campaign.templateId);
  if (!template) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new OpenwopError('validation_error', '`to` must be a valid email address.', 400, { field: 'to' });
  }
  // Review F4 — the sender check comes FIRST: with no sender configured the
  // route can't build the brokered provider, and the provider error ("wire a
  // provider") would mask the real cause ("configure the sender").
  const emailSettings = await getEmailSettings(tenantId, orgId);
  const from = emailSettings?.senderAddress ?? '';
  if (!from) {
    throw new OpenwopError('capability_not_provided', 'Configure the sender address before test-sending.', 501, { campaignId, field: 'senderAddress' });
  }
  const provider = opts.provider ?? activeProvider();
  if (provider.id === CONSOLE_PROVIDER_ID) {
    throw new OpenwopError('capability_not_provided', 'No email provider is configured — wire one before test-sending.', 501, { campaignId });
  }
  // Review F6 — tokens stay TRULY literal: each `{{contact.*}}` maps to
  // itself, so the tester sees exactly what they authored (the first cut
  // mapped them to different literals, and contact.email to the tester's
  // real address — contradicting the modal's own hint copy).
  const vars = { name: '{{contact.name}}', email: '{{contact.email}}', company: '{{contact.company}}' };
  const body = interpolate(template.body, vars);
  // Review F3 — a markdown template's REAL send delivers rendered HTML; the
  // test must too (minus tracking: no pixel, no tracked links).
  const html = template.format === 'markdown' ? renderMarkdownBody(body, '') : undefined;
  await provider.send({
    to,
    subject: `[Test] ${interpolate(template.subject, vars)}`,
    body,
    ...(html ? { html } : {}),
    from,
    idempotencyKey: `test:${campaignId}:${to}:${Date.now()}`,
  });
}

export async function sendCampaign(
  tenantId: string, orgId: string, campaignId: string,
  opts: { resend?: boolean; provider?: EmailProvider; limit?: number } = {},
): Promise<Campaign | null> {
  return withSendLock(`${tenantId}::${campaignId}`, () => sendCampaignSerialized(tenantId, orgId, campaignId, opts));
}

async function sendCampaignSerialized(
  tenantId: string, orgId: string, campaignId: string,
  opts: { resend?: boolean; provider?: EmailProvider; limit?: number } = {},
): Promise<Campaign | null> {
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign) return null;
  // Re-send guard: a 'sent' campaign re-sends to EVERYONE — require explicit intent
  // (each send is a real dispatch; duplicates are worse than for analytics).
  // A 'sending' campaign is a CONTINUATION and proceeds without the flag.
  if (campaign.status === 'sent' && !opts.resend) {
    throw new OpenwopError('conflict', 'Campaign already sent — pass `resend: true` to send it again.', 409, { campaignId, status: campaign.status });
  }
  const template = await getTemplate(tenantId, orgId, campaign.templateId);
  if (!template) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });

  const provider = opts.provider ?? activeProvider();
  // LEAK-1: NEVER report a campaign `sent` when no real email transport is wired.
  // The console stub delivers nothing; before this guard, campaigns rolled up
  // `status:'sent'` / `stats.sent` while zero emails left the building. Fail
  // honestly instead — the operator wires a provider (ADR 0193) to actually send.
  if (provider.id === CONSOLE_PROVIDER_ID) {
    throw new OpenwopError(
      'capability_not_provided',
      'Email delivery is not configured on this deployment. Connect an email provider to send campaigns — templates and drafts still work.',
      501,
      { campaignId },
    );
  }
  // Sender identity is explicit per-org configuration — required before any
  // campaign dispatch (no hardcoded default from-address).
  const emailSettings = await getEmailSettings(tenantId, orgId);
  const from = emailSettings?.senderAddress ?? '';
  if (!from) {
    throw new OpenwopError(
      'capability_not_provided',
      'No sender address is configured for this workspace. Set one in Email Marketing settings before sending campaigns.',
      501,
      { campaignId, field: 'senderAddress' },
    );
  }

  let audience: Contact[];
  if (campaign.audience.segmentId) {
    try {
      audience = await resolveSegmentMembers(tenantId, campaign.audience.segmentId);
    } catch (e) {
      // A segment deleted between campaign-create and send must fail the send
      // honestly (ADR 0211 §2) rather than silently resolving to nobody — the
      // evaluator's own `not_found` (404, "the id doesn't exist") is recast as a
      // `409 conflict` here ("it existed, now it doesn't" — a send-time state
      // conflict, not a bad request).
      if (e instanceof OpenwopError && e.code === 'not_found') {
        throw new OpenwopError('validation_error', 'Campaign segment no longer exists.', 409, { campaignId, segmentId: campaign.audience.segmentId });
      }
      throw e;
    }
  } else {
    audience = (await listContacts(tenantId)).filter((c) => !campaign.audience.stage || c.stage === campaign.audience.stage);
  }
  // The sendLogs ledger: contacts this campaign has TERMINALLY handled. On a
  // resend, prior logs are ignored (explicit full re-dispatch).
  // R2 EM-SP-1/2 — 'skipped' is terminal by design (the completion comment
  // below has said so all along) and MUST therefore enter this ledger: the old
  // sent-only set re-entered every skipped contact into `pending` on each
  // continuation, re-skipping them (stats grew past the audience size) and —
  // with more unsendable contacts than one batch — keeping `pending` pinned
  // above the batch limit so "Continue sending" LOOPED FOREVER. 'failed' rows
  // deliberately stay out: a failure is retryable.
  // Review F2 — a RESEND starts a new send GENERATION (`generation` on the campaign —
  // EM-26: this used to cite a `sendEpochAt` field that exists nowhere), and every ledger read (this exclusion set AND the derived
  // stats) considers only rows at/after the epoch. Without it, pre-resend
  // 'skipped' rows poisoned resend continuations (a contact whose consent was
  // granted since round 1 stayed excluded forever), and pre-resend 'sent'
  // rows truncated any >1-batch resend (the first continuation saw an empty
  // pending and declared the campaign 'sent').
  const generation = opts.resend ? (campaign.sendGeneration ?? 0) + 1 : (campaign.sendGeneration ?? 0);
  const priorTerminal = opts.resend
    ? new Set<string>()
    : new Set((await listSends(tenantId, campaignId))
        .filter((s) => (s.generation ?? 0) === generation && (s.status === 'sent' || s.status === 'skipped'))
        .map((s) => s.contactId));
  const pending = audience.filter((c) => !priorTerminal.has(c.contactId));
  const limit = Math.max(1, Math.floor(opts.limit ?? SEND_BATCH_DEFAULT));
  const batch = pending.slice(0, limit);

  // R2 EM-SP-1 — stats are DERIVED from the ledger at pass end (per-contact
  // latest status), never accumulated: accumulation re-counted every re-skip
  // and every retried failure, so the "{{sent}} sent · {{skipped}} skipped"
  // centerpiece could exceed the audience size. The pass below still tallies
  // into `stats` transiently for the per-pass failure check.
  const stats: CampaignStats = { sent: 0, failed: 0, skipped: 0 };

  // C4 (ADR 0218): engagement instrumentation needs an ABSOLUTE, browser-
  // reachable backend base for the tracked-link + unsubscribe routes. Resolve
  // once per pass; absent ⇒ send untracked (delivery beats tracking — honest
  // degradation, logged).
  const linkBase = (process.env.OPENWOP_EMAIL_LINK_BASE_URL ?? process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL ?? process.env.OPENWOP_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');

  // ADR 0267 / CDP-E — frequency governor config, read once per invocation.
  const { max: freqCap, windowDays: freqWindowDays } = emailFrequencyCap();
  const freqWindowStartIso = new Date(Date.now() - freqWindowDays * 86_400_000).toISOString();

  let passFailed = 0;
  for (const contact of batch) {
    const log = (status: SendStatus, error?: string): SendLog => ({ sendId: `snd:${randomUUID()}`, tenantId, campaignId, contactId: contact.contactId, status, ts: new Date().toISOString(), ...(generation ? { generation } : {}), ...(error ? { error } : {}) });
    if (!contact.email) { stats.skipped += 1; await sendLogs.put(log('skipped', 'no_email')); continue; }
    // ADR 0227: a campaign send is an EMAIL-channel send — the per-channel
    // specific governs when the contact's record carries one; otherwise the
    // `marketing` umbrella falls through inside `isAllowed` (old records are
    // untouched and keep behaving exactly as before).
    // ADR 0655 D9 (EM-7) — a consent READ error is per-recipient `passFailed` (the same
    // posture as an unreadable suppression store below), never a batch abort that
    // leaves the campaign half-written.
    let allowed: boolean;
    try { allowed = await isAllowed(tenantId, contact.contactId, 'marketing.email'); }
    catch (e) { passFailed += 1; svcLog.warn('consent read failed; recipient retried next pass', { campaignId, error: e instanceof Error ? e.message : String(e) }); continue; }
    if (!allowed) { stats.skipped += 1; await sendLogs.put(log('skipped', 'consent')); continue; }
    // C3 (ADR 0217): the suppression overlay — bounces/complaints/unsubscribes/
    // manual holds — is subtracted from EVERY marketing send, independent of the
    // consent toggle (fail-closed for known-bad addresses).
    // FOLD-IN B5 — three outcomes, not two. `suppressed` is a TERMINAL, durable,
    // person-attributed claim: it enters `priorTerminal`, so no continuation pass
    // ever retries the recipient, and the stored `reason` says the person asked us
    // to stop. An UNREADABLE store justifies neither. Writing that row turned a
    // transient KV blip into a permanent exclusion from this campaign generation
    // AND a false consent record. So the refusal now writes NO ledger row at all:
    // the recipient stays out of `priorTerminal`, `pending` still contains them,
    // and the next pass retries. `passFailed` is bumped so the campaign stays
    // `sending` rather than declaring itself exhaustively `sent` over recipients it
    // never decided about.
    {
      const check = await suppressionBlocksSend(tenantId, contact.email);
      if (check === 'suppressed') { stats.skipped += 1; await sendLogs.put(log('skipped', 'suppressed')); continue; }
      if (check === 'unreadable') { passFailed += 1; continue; }
    }
    // ADR 0267 / CDP-E — frequency governor: an automatic per-recipient send cap
    // over a rolling window. Opt-in (env; default off ⇒ behavior unchanged, no
    // ledger scan), keyed on the same `contactSendCount` ledger the journey
    // frequency verb reads.
    if (freqCap > 0 && (await contactSendCount(tenantId, contact.contactId, freqWindowStartIso)) >= freqCap) {
      stats.skipped += 1; await sendLogs.put(log('skipped', 'frequency')); continue;
    }
    const vars = { name: contact.name, email: contact.email, company: contact.company ?? '' };
    try {
      let body = interpolate(template.body, vars);
      let html: string | undefined;
      if (linkBase) {
        body = await instrumentBody(body, linkBase, { tenantId, campaignId, contactId: contact.contactId, email: contact.email });
        // ADR 0242: multipart — render the instrumented body as the HTML part
        // with an open-tracking pixel. Best-effort: a mint/render failure leaves
        // a text-only send (delivery beats tracking).
        try {
          const openTok = await mintToken({ tenantId, campaignId, contactId: contact.contactId, kind: 'open' });
          const pixelUrl = `${vendorPublicBase(linkBase)}/public-email/o/${encodeURIComponent(openTok)}`;
          // ADR 0256 — markdown templates render the safe-subset HTML part; the
          // instrumented body already carries tracked `/c` links + unsub/prefs
          // lines (the renderer autolinks those host-owned URLs). Default 'text'
          // keeps the ADR 0242 escape-first render.
          html = template.format === 'markdown' ? renderMarkdownBody(body, pixelUrl) : renderHtmlBody(body, pixelUrl);
        } catch { /* text-only fallback */ }
      }
      await provider.send({
        to: contact.email,
        subject: interpolate(template.subject, vars),
        body,
        ...(html ? { html } : {}),
        from,
        // EM-1/EM-UX-3 — the GENERATION is load-bearing, and its absence made a
        // resend deliver NOTHING while reporting full success for the whole
        // ledger TTL (`OPENWOP_EMAIL_LEDGER_TTL_DAYS`, default 30 days).
        // `emailAdapter.send` dedups on this key BEFORE calling the provider and
        // returns `{sent:true}` from the prior row; `brokeredProvider` only
        // throws on `!out.sent`, so the loop below counted `stats.sent += 1` and
        // wrote a `'sent'` ledger row over zero delivery, and the UI showed a
        // green `sent` chip under a confirm promising "Every recipient is
        // contacted again".
        //
        // The rest of this file already assumes the opposite: `generation` is
        // incremented precisely so a resend re-dispatches (see the epoch comment
        // above), and the 409 guard forces the operator to ask for it
        // explicitly. Stamping it here makes the two halves agree. The key stays
        // fork-stable and cross-instance-CAS-safe — `(campaign, generation,
        // contact)` is deterministic and carries no `runId`.
        idempotencyKey: `cmp:${campaignId}:g${generation}:${contact.contactId}`,
      });
      stats.sent += 1; await sendLogs.put(log('sent'));
      await appendEmailActivity(tenantId, campaign.orgId, campaignId, template.name, contact.contactId);
    } catch (e) {
      passFailed += 1;
      stats.failed += 1; await sendLogs.put(log('failed', e instanceof Error ? e.message : 'send_failed'));
    }
  }

  // 'sent' requires a CLEAN exhaustive pass. Failures keep the campaign
  // 'sending' so a re-invoke retries ONLY the failed contacts (they are not in
  // the ledger) — never a terminal state that forces a full `resend` (which
  // would double-deliver the already-sent). Skips (no email / consent) are
  // terminal by design and do not block completion.
  const exhausted = batch.length === pending.length && passFailed === 0;
  // Derive honest stats: each contact counts ONCE, by its latest ledger row
  // (a retried failure that eventually sends is 'sent', not 'failed'+'sent').
  const latestByContact = new Map<string, SendLog>();
  // Review F1 — ms-resolution timestamps TIE (a failed row and its retry's
  // sent row can share a millisecond), and `>=` then let storage iteration
  // order pick the winner — observed publishing status:'sent' beside
  // failed:1. On a tie a TERMINAL state wins ('sent'/'skipped' rows are never
  // retried, so they are always the later truth); 'failed' loses ties.
  const rank = (st: SendStatus): number => (st === 'failed' ? 0 : 1);
  for (const row of await listSends(tenantId, campaignId)) {
    if ((row.generation ?? 0) !== generation) continue; // prior generation (review F2)
    const prev = latestByContact.get(row.contactId);
    if (!prev || row.ts > prev.ts || (row.ts === prev.ts && rank(row.status) >= rank(prev.status))) {
      latestByContact.set(row.contactId, row);
    }
  }
  const derived: CampaignStats = { sent: 0, failed: 0, skipped: 0 };
  for (const row of latestByContact.values()) {
    if (row.status === 'sent') derived.sent += 1;
    else if (row.status === 'skipped') derived.skipped += 1;
    else derived.failed += 1;
  }
  const next: Campaign = { ...campaign, status: exhausted ? 'sent' : 'sending', stats: derived, ...(generation ? { sendGeneration: generation } : {}), updatedAt: new Date().toISOString() };
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
export async function deleteSubjectSends(tenantId: string, subjectKey: string): Promise<{ removed: number; failed: number }> {
  if (!subjectKey) return { removed: 0, failed: 0 };
  const all = await sendLogs.listForTenantIndexed(tenantId);
  let removed = 0; let failed = 0;
  for (const s of all) {
    if (s.tenantId !== tenantId || s.contactId !== subjectKey) continue;
    // ADR 0655 D9 (EM-24) — outcome, never a throw mid-loop: this leg used to abort the
    // whole fan-out on its first bad row, pinning the address-bearing token store behind it.
    try { await sendLogs.delete(s.sendId); removed += 1; }
    catch (e) { failed += 1; svcLog.error('sendlog_erase_failed', { tenantId, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { removed, failed };
}

/**
 * EM-3 — the email feature's ONE registered subject eraser, fanning out to every
 * store the feature owns that holds subject-linked data.
 *
 * WHAT WAS WRONG. This eraser's entire body was `deleteSubjectSends`, which
 * touches `email:sendlog` and nothing else — ONE of the feature's stores. Not
 * reached by any eraser: `email:engagement-token` (the recipient's raw
 * lower-cased address, and its unsubscribe/preferences kinds are explicitly
 * EXEMPT from the retention purger, i.e. kept forever), `email:engagement`, and
 * `email:soft-bounce-count` (the raw address in both the row and the key, with
 * no purger and no age-out either). Because `SubjectEraser` returns `void`,
 * `eraseSubject` reported `{failed: 0}` and consent wrote `erasure_complete`:
 * success rendered over data that was still there.
 *
 * Worse, the retention docblock in `engagementService.ts` asserted the opposite
 * in words — "a data-subject ERASURE still removes them via the emailEraser" —
 * the past-tense-claim-outlives-the-code family. The claim is true now because
 * the fan-out below exists.
 *
 * NOT ERASED, DELIBERATELY: the `crm:suppression` row an unsubscribe or a
 * hard bounce writes. It is CRM-owned and `crm/erasure.ts` retains it (redacted)
 * on purpose — the address IS the mechanism that honours the refusal, so
 * deleting it would make the person mailable again. Stated here rather than left
 * as a silent omission, and recorded in the coverage ratchet.
 *
 * `email:sent` (the host dispatch ledger) is NOT erased here and NOT claimed as
 * covered: it is host-owned, keyed opaquely, TTL-swept within 30 days by
 * default, and its campaign-path key embeds a contactId — which is why its
 * "no recipient PII stored" exemption was corrected rather than kept (EM-4c).
 *
 * Best-effort per store, and a failure is SURFACED rather than swallowed — the
 * ANL-2 lesson: an ignored delete result is a green DSAR receipt over live data.
 * The seam's `SubjectEraser` returns `void`, so the only way a failure reaches
 * `eraseSubject`'s `failed` count is to THROW, which is what this does after
 * doing all the work it can.
 */
const emailEraser = async (tenantId: string, subjectKey: string): Promise<void> => {
  const sends = await deleteSubjectSends(tenantId, subjectKey);
  const engagement = await deleteSubjectEngagement(tenantId, subjectKey);
  const bounces = await deleteSubjectBounceCounts(tenantId, subjectKey);
  const failed = sends.failed + engagement.failed + bounces.failed;
  if (failed > 0) {
    throw new Error(`email subject erasure incomplete: ${failed} row(s) could not be deleted (removed ${sends.removed + engagement.removed + bounces.removed})`);
  }
};
registerSubjectEraser(emailEraser);

/**
 * CRM-5 — move the source contact's send ledger onto the survivor.
 *
 * `sendCampaign` computes `priorTerminal` from send-log rows by `contactId`, and
 * the provider idempotency key is `cmp:<campaignId>:g<generation>:<contactId>`
 * (EM-1 — the generation is what makes a resend re-dispatch). So after a CRM
 * merge the survivor was absent from every ledger the source had filled: it could
 * be RE-SENT a campaign the source already received (a duplicate to the same human
 * at the very address the merge just absorbed), and `contactSendCount` — the
 * ADR 0267 frequency governor, which reads the same rows — reset to zero.
 *
 * Re-keying is the right cure rather than deleting: the rows are the delivery
 * record for a real send that really happened, and it is the survivor who
 * received it.
 *
 * Idempotent (a second run finds no source rows). Bounded to THIS TENANT's ledger
 * slice via the `email:sendlog` tenant secondary index — `email:sendlog` is keyed on
 * a random `sendId` with no contact index, so a per-contact point read is not
 * available, but a cross-tenant `list()` is forbidden here (the merge seam's own
 * contract) and was the B4 defect this fold-in closes.
 */
async function relinkSendLogsOnMerge(tenantId: string, sourceContactId: string, survivorContactId: string): Promise<number> {
  if (!tenantId || !sourceContactId || !survivorContactId || sourceContactId === survivorContactId) return 0;
  let moved = 0;
  for (const s of await sendLogs.listForTenantIndexed(tenantId)) {
    if (s.tenantId !== tenantId || s.contactId !== sourceContactId) continue;
    await sendLogs.put({ ...s, contactId: survivorContactId, mergedFrom: sourceContactId });
    moved += 1;
  }
  return moved;
}

/** The exact inverse: return ONLY the rows a merge moved (stamped `mergedFrom`),
 *  clearing the stamp. A naive "move everything back" would hand the survivor's
 *  OWN pre-merge deliveries to the source — a second silent-loss defect wearing
 *  the first one's clothes. */
async function restoreSendLogsOnUnmerge(tenantId: string, sourceContactId: string, survivorContactId: string): Promise<number> {
  if (!tenantId || !sourceContactId || !survivorContactId || sourceContactId === survivorContactId) return 0;
  let restored = 0;
  for (const s of await sendLogs.listForTenantIndexed(tenantId)) {
    if (s.tenantId !== tenantId || s.contactId !== survivorContactId || s.mergedFrom !== sourceContactId) continue;
    const { mergedFrom: _dropped, ...rest } = s;
    await sendLogs.put({ ...rest, contactId: sourceContactId });
    restored += 1;
  }
  return restored;
}

/**
 * Fold-in B4 — the send ledger only exists for a tenant that HAS the email feature,
 * so a merge in a tenant with email off should not touch this store at all.
 *
 * Fail-OPEN on a toggle-read error, deliberately and narrowly: the gate is a work
 * avoidance, not an authorization boundary (the read it guards is already scoped to
 * the merging tenant's own ledger). Skipping the relink on a transient toggle-store
 * blip would leave a send ledger pointing at a tombstone — the exact compliance
 * defect CRM-5 exists to close — so an unreadable toggle must not be able to cause
 * it. Stated here rather than left to be inferred from a `?? true`.
 */
async function emailFeatureLive(tenantId: string): Promise<boolean> {
  try {
    return (await resolveOne('email', { tenantId }))?.enabled !== false;
  } catch {
    return true;
  }
}

onCrmRecordMerged('email-sendlog-relink', async ({ tenantId, entity, sourceId, survivorId }) => {
  if (entity !== 'contact') return; // send-logs are keyed on the contact
  if (!(await emailFeatureLive(tenantId))) return;
  await relinkSendLogsOnMerge(tenantId, sourceId, survivorId);
});

// A contact merge is REVERSIBLE and this handler MOVES rows, so without the
// reverse leg the fix would trade a duplicate-send defect for a lost delivery
// record — the same family, one step downstream.
onCrmRecordUnmerged('email-sendlog-relink', async ({ tenantId, entity, sourceId, survivorId }) => {
  if (entity !== 'contact') return;
  if (!(await emailFeatureLive(tenantId))) return;
  await restoreSendLogsOnUnmerge(tenantId, sourceId, survivorId);
});

/** Test-only: clear all email stores. */
export async function __resetEmailStore(): Promise<void> { await templates.__clear(); await campaigns.__clear(); await sendLogs.__clear(); await settings.__clear(); }
