/**
 * Email Marketing service (host-extension, ADR 0019) — the ENGAGE leg. Templates +
 * campaigns whose audience resolves LIVE from `crm/contactsService` (never a copied
 * list), rendered per contact and dispatched through a pluggable provider adapter
 * (v1: a console/stub sink, honest capability). Every send is gated on `marketing`
 * consent via the ONE `consentService.isAllowed` helper (ADR 0020).
 */

import { createHash, randomUUID } from 'node:crypto';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { insertOwnedOrConflict } from '../../host/ownedInsert.js';
import { OpenwopError } from '../../types.js';
import { assertCampaignRef } from '../../host/campaignRefs.js';
import { smsBodyProblem } from '../../host/smsText.js';
import { listContacts, type Contact, type ContactStage } from '../crm/contactsService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onCrmRecordMerged, onCrmRecordUnmerged } from '../../host/crmRecordLifecycle.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { createActivity, getActivity } from '../crm/crmEntitiesService.js';
import { getSegment, resolveSegmentMembers } from '../crm/segmentsService.js';
import { checkChannelEligibility } from '../crm/channelEligibility.js';
import { noteFirstSend, recordSends, senderPaused, warmupRemaining } from '../crm/senderHealth.js';
import { assertSenderAuthenticated } from './senderAuth.js';
import { instrumentBodyWithUnsubscribe, mintToken, renderHtmlBody, deleteSubjectEngagement } from './engagementService.js';
import { deleteSubjectBounceCounts } from './bounceWebhooks.js';
import { renderMarkdownBody } from './safeMarkdown.js';
import { createLogger } from '../../observability/logger.js';
import { vendorPublicBase } from '../featureRoute.js';
import { resolveApproval } from '../../host/approvalService.js';

const bridgeLog = createLogger('email.activityBridge');
const svcLog = createLogger('email.service');

/** ADR 0256 — how the body authors its HTML part. `text` (default) is the ADR
 *  0242 escape-first plain-text render; `markdown` renders a safe Markdown subset. */
/** ADR 0955 D8 — `'sms'` bodies share the versioned store (versions, hash, approval pin) and
 *  are fixed at creation: an email campaign refuses one, and a template never switches
 *  between SMS and email (`format_locked`). */
export type EmailBodyFormat = 'text' | 'markdown' | 'sms';
const formatField = (f: EmailBodyFormat | undefined): { format?: 'markdown' | 'sms' } =>
  f === 'markdown' ? { format: 'markdown' } : f === 'sms' ? { format: 'sms' } : {};
function assertSmsBody(format: EmailBodyFormat | undefined, body: string): void {
  if (format !== 'sms') return;
  const problem = smsBodyProblem(body);
  if (problem) throw new OpenwopError('validation_error', problem, 400, { field: 'body', reason: 'sms_body_invalid' });
}
export interface EmailTemplate {
  templateId: string; tenantId: string; orgId: string;
  name: string; subject: string; body: string; // body/subject: {{contact.name|email|company}}
  /** ADR 0256 — body authoring mode; absent ⇒ 'text' (back-compat). */
  format?: EmailBodyFormat;
  /** ADR 0905 D1 — the current content version (1-based). Absent on a row written
   *  before versioning; read through `templateVersionOf`, which treats it as 1. */
  version?: number;
  /** ADR 0905 D1 — `templateContentHash` of the current subject/body/format. */
  contentHash?: string;
  /** ADR 0905 follow-up (ADR 0922) — set, by CAS on THIS row, before any campaign pins
   *  the template for a send. `updateTemplate(…, {refuseIfSent})` checks it inside its
   *  own CAS on this row, so an edit and a send start serialise here: exactly one wins.
   *  Never cleared (a sent template stays "sent"); 0905's own edits ignore it and version. */
  sendHold?: { since: string };
  createdBy: string; createdAt: string; updatedAt: string;
}

/** ADR 0905 D1 — one immutable content version of a template. Never updated after
 *  it is written; a restore writes a NEW version copying an old one. */
export interface EmailTemplateVersion {
  templateId: string; tenantId: string; orgId: string;
  version: number;
  subject: string; body: string; format?: EmailBodyFormat;
  contentHash: string;
  /** Set on a restore: the version this one copies. */
  restoredFrom?: number;
  createdBy: string; createdAt: string;
}

/** ADR 0905 D1 — a template's current version; a pre-versioning row is version 1. */
export function templateVersionOf(t: Pick<EmailTemplate, 'version'>): number {
  return typeof t.version === 'number' && t.version >= 1 ? t.version : 1;
}

/** ADR 0905 D3 — `in_review` / `approved` are the send-approval states. "Changes
 *  requested" is a `draft` whose `review.outcome` says so (with the reviewer's note). */
export type CampaignStatus = 'draft' | 'in_review' | 'approved' | 'sending' | 'sent';

/** ADR 0905 D3 — what a send approval binds to. `audienceHash` hashes the audience
 *  DEFINITION (stage, or segment id + the segment's `updatedAt`), never membership. */
export interface CampaignApprovalPin {
  templateId: string;
  templateVersion: number;
  contentHash: string;
  senderAddress: string;
  audienceHash: string;
}

/** ADR 0905 D3 — the campaign's current (or last) send-review cycle. The approval
 *  ROW is the audit record; this mirror is what the send gate and the UI read. */
export interface CampaignReview {
  cycle: number;
  approvalId: string;
  pin: CampaignApprovalPin;
  /** `sent` ⇒ approving this cycle authorises a RESEND (a new send generation). */
  fromStatus: 'draft' | 'sent';
  submittedBy?: string;
  submittedAt: string;
  /** Absent while `in_review`. `closed` = withdrawn, or invalidated by an edit. */
  outcome?: 'approved' | 'changes_requested' | 'closed';
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}
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
  /** ADR 0941 D1 / P2 — the MarketingCampaign this send belongs to (the child
   *  points up). Validated against the campaign owner at create, in this send's
   *  org; a dangling or cross-org id is refused. */
  marketingCampaignId?: string;
  /** ADR 0905 D2 — what this send generation delivers, frozen at send start. Every
   *  batch renders from it, never from the live template, so an edit made while a
   *  campaign is `sending` cannot change the rest of the send. Re-pinned when a resend
   *  opens a new generation. */
  sendPin?: CampaignSendPin;
  /** ADR 0905 D3 — the send-review cycle (absent until first submitted). */
  review?: CampaignReview;
  /** ADR 0905 D7 — the org topic this campaign is about (absent ⇒ the org's general
   *  list). Recipients who opted out of the topic are skipped at send. */
  topicId?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

/** ADR 0905 D2 — the content a send generation is pinned to. It carries the bytes
 *  themselves (P0 predates the immutable version rows of P1), and `contentHash` is the
 *  sha256 of `subject`/`body`/`format`, the same hash a later approval pin compares. */
export interface CampaignSendPin {
  generation: number;
  templateId: string;
  /** ADR 0905 P1 — the template version these bytes are. */
  templateVersion: number;
  templateName: string;
  subject: string; body: string; format?: EmailBodyFormat;
  contentHash: string;
  pinnedAt: string;
}

/** ADR 0905 D1/D2 — sha256 over the three fields that decide the delivered bytes. */
export function templateContentHash(t: { subject: string; body: string; format?: EmailBodyFormat }): string {
  return createHash('sha256').update(JSON.stringify([t.subject, t.body, t.format ?? 'text'])).digest('hex');
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

// ADR 0848 D1 — both arm the TENANT SECONDARY INDEX (`tenantOf`), so the list reads
// below are a bounded scan of one tenant instead of `list()`'s sweep of every tenant.
// Rows are NOT re-keyed: still keyed by id alone, which is why every create goes
// through `insertOwnedOrConflict` (an id another workspace holds is a 409, never a put).
// `ensureTenantIndex` backfills legacy rows on the first indexed read — no migration.
const templates = new DurableCollection<EmailTemplate>('email:template', (t) => t.templateId, undefined, (t) => t.tenantId);
// ADR 0905 D1 — immutable template versions, keyed `${templateId}@${version}` so every
// read is a point read (no tenant scan) and a version number can never hold two rows.
const templateVersions = new DurableCollection<EmailTemplateVersion>('email:template-version', (v) => `${v.templateId}@${v.version}`, undefined, (v) => v.tenantId);
const campaigns = new DurableCollection<Campaign>('email:campaign', (c) => c.campaignId, undefined, (c) => c.tenantId);
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
  dryRun: 'rows-by-age',
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
  /** ADR 0905 D3 — who besides the org's admins (`host:members:manage`) may approve a
   *  campaign send: ADR 0075 accessControl role / group refs (the agency → client
   *  review). Stamped onto each approval row at submit. Absent ⇒ admins only. */
  approverRoleRefs?: string[];
  approverGroupRefs?: string[];
  updatedBy: string; updatedAt: string;
}
const settings = new DurableCollection<EmailSettings>('email:settings', (s) => `${s.tenantId}::${s.orgId}`);

// ── ADR 0905 D7 — subscription topics (definitions; opt-outs are consent's) ──
export interface EmailTopic {
  topicId: string; tenantId: string; orgId: string;
  name: string; description?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}
export const MAX_TOPICS_PER_ORG = 20;
const topics = new DurableCollection<EmailTopic>('email:topic', (t) => t.topicId, undefined, (t) => t.tenantId);

export async function listTopics(tenantId: string, orgId: string): Promise<EmailTopic[]> {
  return (await topics.listForTenantIndexed(tenantId)).filter((t) => t.tenantId === tenantId && t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}
export async function getTopic(tenantId: string, orgId: string, topicId: string): Promise<EmailTopic | null> {
  const t = await topics.get(topicId);
  return t && t.tenantId === tenantId && t.orgId === orgId ? t : null;
}
const topicName = (v: string): string => {
  const n = v.trim();
  if (!n || n.length > 80) throw new OpenwopError('validation_error', 'A topic name is required (at most 80 characters).', 400, { field: 'name' });
  return n;
};
export async function createTopic(input: { tenantId: string; orgId: string; name: string; description?: string; createdBy: string }): Promise<EmailTopic> {
  if ((await listTopics(input.tenantId, input.orgId)).length >= MAX_TOPICS_PER_ORG) {
    throw new OpenwopError('conflict', `An organization can have at most ${MAX_TOPICS_PER_ORG} email topics.`, 409, { reason: 'topic_limit', max: MAX_TOPICS_PER_ORG });
  }
  const now = new Date().toISOString();
  const row: EmailTopic = {
    topicId: `etopic:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, name: topicName(input.name),
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 280) } : {}),
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await topics.put(row);
  return row;
}
export async function updateTopic(tenantId: string, orgId: string, topicId: string, patch: { name?: string; description?: string }): Promise<EmailTopic | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getTopic(tenantId, orgId, topicId);
    if (!cur) return null;
    const next: EmailTopic = { ...cur, ...(patch.name !== undefined ? { name: topicName(patch.name) } : {}), ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 280) } : {}), updatedAt: new Date().toISOString() };
    if (await topics.compareAndSwap(cur, next)) return next;
  }
  throw new OpenwopError('conflict', 'Could not update the topic (too many concurrent writes).', 409, { topicId });
}
/** Refused (409 `topic_in_use`) while a campaign that is not `sent` targets the topic. */
export async function deleteTopic(tenantId: string, orgId: string, topicId: string): Promise<boolean> {
  if (!(await getTopic(tenantId, orgId, topicId))) return false;
  const holders = (await listCampaigns(tenantId, orgId)).filter((c) => c.topicId === topicId && c.status !== 'sent');
  if (holders.length > 0) throw new OpenwopError('conflict', 'This topic is used by a campaign that has not finished sending.', 409, { reason: 'topic_in_use', topicId, campaignIds: holders.slice(0, 20).map((c) => c.campaignId) });
  return topics.delete(topicId);
}

export async function getEmailSettings(tenantId: string, orgId: string): Promise<EmailSettings | null> {
  const row = await settings.get(`${tenantId}::${orgId}`);
  return row && row.tenantId === tenantId && row.orgId === orgId ? row : null;
}

/** ADR 0895 D1 — the tenant's configured senders (every org), for the chain lane's
 *  sender binding. `root` is the workspace-root org's (`orgId === tenantId`). */
export async function listVerifiedSenders(tenantId: string): Promise<{ all: string[]; root?: string }> {
  const rows = (await settings.listForTenant(tenantId)).filter((r) => r.tenantId === tenantId && r.senderAddress.trim() !== '');
  const root = rows.find((r) => r.orgId === tenantId)?.senderAddress.trim();
  return { all: [...new Set(rows.map((r) => r.senderAddress.trim().toLowerCase()))], ...(root ? { root } : {}) };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function setSenderAddress(tenantId: string, orgId: string, senderAddress: string, updatedBy: string): Promise<EmailSettings> {
  const trimmed = senderAddress.trim();
  if (trimmed !== '' && !EMAIL_SHAPE.test(trimmed)) {
    throw new OpenwopError('validation_error', 'senderAddress must be a valid email address (or empty to unset).', 400, { field: 'senderAddress' });
  }
  const prior = await getEmailSettings(tenantId, orgId);
  const row: EmailSettings = {
    ...(prior?.approverRoleRefs ? { approverRoleRefs: prior.approverRoleRefs } : {}),
    ...(prior?.approverGroupRefs ? { approverGroupRefs: prior.approverGroupRefs } : {}),
    tenantId, orgId, senderAddress: trimmed, updatedBy, updatedAt: new Date().toISOString(),
  };
  await settings.put(row);
  // ADR 0905 D3 — the sender is part of what a send approval binds to.
  if ((prior?.senderAddress ?? '') !== trimmed) await invalidateSendReviews(tenantId, orgId, () => true, 'the sender address changed');
  return row;
}

/** ADR 0905 D3 — set the org's extra email approvers. The caller (the route) has
 *  already required `host:members:manage` and validated that each ref resolves. */
export async function setEmailApprovers(tenantId: string, orgId: string, refs: { roleRefs: string[]; groupRefs: string[] }, updatedBy: string): Promise<EmailSettings> {
  const prior = await getEmailSettings(tenantId, orgId);
  const roles = [...new Set(refs.roleRefs.filter(Boolean))];
  const groups = [...new Set(refs.groupRefs.filter(Boolean))];
  const row: EmailSettings = {
    tenantId, orgId, senderAddress: prior?.senderAddress ?? '',
    ...(roles.length ? { approverRoleRefs: roles } : {}),
    ...(groups.length ? { approverGroupRefs: groups } : {}),
    updatedBy, updatedAt: new Date().toISOString(),
  };
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
  /** ADR 0848 D7 — RFC 8058 one-click unsubscribe: the SAME `/u/:token` URL the
   *  footer carries. A brokered provider turns it into the `List-Unsubscribe` +
   *  `List-Unsubscribe-Post` header pair; absent on test and transactional sends. */
  listUnsubscribe?: { url: string };
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

/**
 * ADR 0848 D6 — contact DATA never becomes a LINK or a header line.
 *
 * `interpolate` runs BEFORE `instrumentBody` mints click tokens and before both HTML
 * renderers autolink, so a contact whose name (or company, or even "email" — CRM does
 * not validate its shape, and the forms regex accepts `https://evil.example/x@a.co`)
 * carried a URL was delivered a tracked `/c` link on the tenant's own domain that
 * 302'd to the attacker; a Markdown template rendered `[Verify](https://evil)` in a
 * name as a disguised anchor. Contacts are minted from PUBLIC form submissions.
 * Escaping was already correct — markup never got through; the defect was promotion
 * from text to link. Applied to every interpolated value (real send, test send's
 * literal tokens aside, the render node); template-authored text is untouched.
 *
 *  - C0 controls (CR/LF included) and DEL are removed: a value can never start a
 *    header line in the subject (providers sanitise today; we no longer rely on it);
 *  - `scheme://` → `scheme:\u200B//` and `mailto:` → `mailto\u200B:` — no linkifier we
 *    own (nor most mail clients') recognises it; the visible text is unchanged;
 *  - `[` / `]` → their full-width forms, so `[text](url)` cannot form a Markdown link.
 * A bare domain (`www.evil.example`) is still autolinked by some mail clients — a
 * stated residue (ADR 0848 M8), not a link this host mints.
 */
export function neutralizeContactValue(v: string, opts: { markdown?: boolean } = {}): string {
  const out = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/([a-z][a-z0-9+.-]*):\/\//gi, '$1:\u200B//')
    .replace(/mailto:/gi, (m) => `${m.slice(0, 6)}\u200B:`);
  // Brackets can only form a link in a MARKDOWN body; elsewhere "Q&A [beta]" stays as typed.
  return opts.markdown ? out.replace(/\[/g, '\uFF3B').replace(/\]/g, '\uFF3D') : out;
}

function interpolate(s: string, raw: { name: string; email: string; company: string }, opts: { markdown?: boolean } = {}): string {
  const vars = { name: neutralizeContactValue(raw.name, opts), email: neutralizeContactValue(raw.email, opts), company: neutralizeContactValue(raw.company, opts) };
  return s.replace(/\{\{\s*contact\.(name|email|company)\s*\}\}/g, (_m, k: string) => (k === 'name' ? vars.name : k === 'email' ? vars.email : vars.company));
}

// ── templates ──
export async function listTemplates(tenantId: string, orgId: string): Promise<EmailTemplate[]> {
  // ADR 0848 D1/H2 — indexed, and STILL filtered: an index marker is not proof of tenancy.
  return (await templates.listForTenantIndexed(tenantId)).filter((t) => t.tenantId === tenantId && t.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getTemplate(tenantId: string, orgId: string, templateId: string): Promise<EmailTemplate | null> {
  const t = await templates.get(templateId);
  return t && t.tenantId === tenantId && t.orgId === orgId ? t : null;
}
/** ADR 0848 D1 — the owner predicate both email stores share: same (tenant, org). */
const ownedBy = (tenantId: string, orgId: string) => (row: { tenantId: string; orgId: string }): boolean =>
  row.tenantId === tenantId && row.orgId === orgId;

export async function createTemplate(input: { tenantId: string; orgId: string; name: string; subject: string; body: string; format?: EmailBodyFormat; createdBy: string; templateId?: string }): Promise<EmailTemplate> {
  // Idempotent on a caller-supplied deterministic id, so a replay/fork of a publish node
  // never duplicates a template — but ONLY onto a row this (tenant, org) owns. #4485:
  // the old short-circuit read through the FILTERED getter, so another workspace's row
  // read as absent and the blind put below took it. ADR 0848 D1.
  assertSmsBody(input.format, input.body);
  const templateId = input.templateId ?? `tpl:${randomUUID()}`;
  const { row } = await insertOwnedOrConflict(templates, templateId, ownedBy(input.tenantId, input.orgId), () => {
    const now = new Date().toISOString();
    return {
      templateId,
      tenantId: input.tenantId, orgId: input.orgId,
      name: input.name, subject: input.subject, body: input.body,
      ...formatField(input.format),
      version: 1, contentHash: templateContentHash({ subject: input.subject, body: input.body, ...formatField(input.format) }),
      createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
  });
  await ensureVersionRow(row, row.createdBy);
  return row;
}

const contentOf = (t: { subject: string; body: string; format?: EmailBodyFormat }): { subject: string; body: string; format?: EmailBodyFormat } =>
  ({ subject: t.subject, body: t.body, ...formatField(t.format) });

/**
 * ADR 0905 D1 — make sure the template's CURRENT version has its immutable row.
 * Called after every version-bumping CAS and, crucially, BEFORE a version is
 * superseded: a crash between the CAS and the row write (or a template from before
 * versioning) is backfilled from the template row itself, so superseded content is
 * never lost from history. `putIfAbsent` — an existing row is never rewritten.
 */
async function ensureVersionRow(t: EmailTemplate, createdBy: string, restoredFrom?: number): Promise<void> {
  const version = templateVersionOf(t);
  await templateVersions.putIfAbsent({
    templateId: t.templateId, tenantId: t.tenantId, orgId: t.orgId, version,
    ...contentOf(t), contentHash: t.contentHash ?? templateContentHash(t),
    ...(restoredFrom ? { restoredFrom } : {}),
    createdBy, createdAt: t.updatedAt,
  });
}

/** ADR 0905 D1 — one version of a template this (tenant, org) owns, or null. The
 *  current version falls back to the template row (see `ensureVersionRow`). */
export async function getTemplateVersion(tenantId: string, orgId: string, templateId: string, version: number): Promise<EmailTemplateVersion | null> {
  const tpl = await getTemplate(tenantId, orgId, templateId);
  if (!tpl || !Number.isInteger(version) || version < 1 || version > templateVersionOf(tpl)) return null;
  const row = await templateVersions.get(`${templateId}@${version}`);
  if (row && row.tenantId === tenantId && row.orgId === orgId) return row;
  if (version === templateVersionOf(tpl)) {
    return { templateId, tenantId, orgId, version, ...contentOf(tpl), contentHash: tpl.contentHash ?? templateContentHash(tpl), createdBy: tpl.createdBy, createdAt: tpl.updatedAt };
  }
  return null;
}

const VERSION_LIST_CAP = 100;
/** ADR 0905 D1 — the template's versions, newest first (point reads, at most 100).
 *  A version with no row (written before versioning) is simply absent. */
export async function listTemplateVersions(tenantId: string, orgId: string, templateId: string): Promise<EmailTemplateVersion[] | null> {
  const tpl = await getTemplate(tenantId, orgId, templateId);
  if (!tpl) return null;
  const out: EmailTemplateVersion[] = [];
  const top = templateVersionOf(tpl);
  for (let v = top; v >= 1 && out.length < VERSION_LIST_CAP; v--) {
    const row = await getTemplateVersion(tenantId, orgId, templateId, v);
    if (row) out.push(row);
  }
  return out;
}
/**
 * ADR 0905 D1 — update a template. A change to the delivered content (subject, body,
 * format) bumps `version` and writes an immutable version row; a rename alone does
 * not (the name is not delivered, and a new version would needlessly stale a review).
 *
 * `expectedVersion` (optional) is the editor's optimistic-concurrency token: a
 * mismatch is 409 `version_conflict`, so of two editors saving from the same version
 * exactly one wins. Without it the write is last-writer-wins (agents, seeds), still
 * versioned.
 */
export async function updateTemplate(
  tenantId: string, orgId: string, templateId: string,
  patch: { name?: string; subject?: string; body?: string; format?: EmailBodyFormat },
  opts: { expectedVersion?: number; actor?: string; restoredFrom?: number; refuseIfSent?: boolean } = {},
): Promise<EmailTemplate | null> {
  // ADR 0848 M6 — a CAS, not a read-then-put: a blind put after a concurrent delete
  // resurrected the row, and an id freed by that delete could be written over.
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await getTemplate(tenantId, orgId, templateId);
    if (!existing) return null;
    const current = templateVersionOf(existing);
    if (opts.refuseIfSent) {
      // ADR 0905 follow-up (ADR 0922) — "a sent email is never altered" for the caller
      // that asks. The hold is on THIS row, so the check and the write are one CAS.
      if (existing.sendHold) throw templateSentError(templateId);
      // A template sent before holds existed: add the hold (it only ever ADDS one, so
      // this one-time read can only refuse, never allow), then refuse.
      if ((await campaignsUsingTemplate(tenantId, orgId, templateId)).some((c) => c.status === 'sending' || c.status === 'sent')) {
        await templates.compareAndSwap(existing, { ...existing, sendHold: { since: new Date().toISOString() } });
        throw templateSentError(templateId);
      }
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) {
      throw new OpenwopError('conflict', 'This template was changed by someone else. Reload it to see the latest version.', 409, {
        reason: 'version_conflict', templateId, expectedVersion: opts.expectedVersion, currentVersion: current,
      });
    }
    // ADR 0955 D8 — SMS and email never trade places (a campaign or journey pinned one kind).
    if (patch.format !== undefined && (patch.format === 'sms') !== (existing.format === 'sms')) {
      throw new OpenwopError('validation_error', 'A template cannot switch between SMS and email. Create a new template instead.', 400, { field: 'format', reason: 'format_locked' });
    }
    const merged: EmailTemplate = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    assertSmsBody(merged.format, merged.body);
    const hash = templateContentHash(merged);
    const contentChanged = hash !== (existing.contentHash ?? templateContentHash(existing));
    // Superseding the current version: its row must exist first (backfill), or a crash
    // after an earlier CAS would lose that content from history.
    if (contentChanged) await ensureVersionRow(existing, existing.createdBy);
    const next: EmailTemplate = { ...merged, version: contentChanged ? current + 1 : current, contentHash: hash };
    if (await templates.compareAndSwap(existing, next)) {
      if (contentChanged) {
        await ensureVersionRow(next, opts.actor ?? existing.createdBy, opts.restoredFrom);
        // ADR 0905 D3 — the content a review approved is gone from the template.
        await invalidateSendReviews(tenantId, orgId, (c) => c.templateId === templateId, 'the template changed');
      }
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Could not update the template (too many concurrent writes).', 409, { templateId });
}

/** ADR 0905 D1 — restore = a NEW version copying an old one's content. History is
 *  never rewritten; a restore of the current content is a no-op. */
export async function restoreTemplateVersion(
  tenantId: string, orgId: string, templateId: string, version: number,
  opts: { expectedVersion?: number; actor: string },
): Promise<EmailTemplate | null> {
  const old = await getTemplateVersion(tenantId, orgId, templateId, version);
  if (!old) return null;
  return updateTemplate(tenantId, orgId, templateId, { subject: old.subject, body: old.body, format: old.format ?? 'text' }, { ...opts, restoredFrom: version });
}
/**
 * ADR 0905 D1 — a template a campaign still needs cannot be deleted: 409
 * `template_in_use` while any campaign that is not `sent` references it (a draft would
 * 400 at send; an approval would point at nothing). A `sent` campaign does not hold the
 * template — its delivered bytes are on its own `sendPin`.
 *
 * Residual, stated: the scan and the delete are not one transaction, so a campaign
 * created in between can reference a deleted template. It then 400s at send
 * (`Campaign template not found`); it can never send the wrong bytes, and a `sending`
 * campaign is unaffected because it renders from its pin.
 */
function templateSentError(templateId: string): OpenwopError {
  return new OpenwopError('conflict', 'Sending has started for this template; create a new draft to edit it.', 409, { reason: 'template_sent', templateId });
}

/** Test-only: run `fn` between the send-time approval check and the pin (the window
 *  an edit must not slip through). Never set in production. */
let beforePinHook: ((campaignId: string) => Promise<void>) | null = null;
export function __setBeforePinHookForTests(fn: ((campaignId: string) => Promise<void>) | null): void { beforePinHook = fn; }

/** ADR 0905 follow-up (ADR 0922) — the ONE in-use lookup: the campaigns in this
 *  (tenant, org) that reference the template, with their status. */
export async function campaignsUsingTemplate(tenantId: string, orgId: string, templateId: string): Promise<Array<{ campaignId: string; status: CampaignStatus }>> {
  return (await listCampaigns(tenantId, orgId)).filter((c) => c.templateId === templateId).map((c) => ({ campaignId: c.campaignId, status: c.status }));
}

/** Set the send hold on the template row (CAS); returns the row as held. A row that
 *  vanished returns null. Content-independent: whatever the row holds is what a
 *  non-approved send then pins. */
async function holdTemplateForSend(tenantId: string, orgId: string, templateId: string, approved?: CampaignApprovalPin): Promise<EmailTemplate | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getTemplate(tenantId, orgId, templateId);
    if (!cur) return null;
    // ADR 0905 follow-up (ADR 0922/0924) — an APPROVED send checks the approval's
    // binding against the row it is about to hold, in the same CAS: an edit that landed
    // after the send-time check (assertSendAllowed) but before this hold makes the CAS
    // below lose or this compare fail — either way it never goes out unapproved.
    if (approved && (templateVersionOf(cur) !== approved.templateVersion || (cur.contentHash ?? templateContentHash(cur)) !== approved.contentHash)) {
      throw new OpenwopError('conflict', 'The template changed after this campaign was approved. Submit it for review again.', 409, { reason: 'approval_stale', templateId });
    }
    if (cur.sendHold) return cur;
    const held: EmailTemplate = { ...cur, sendHold: { since: new Date().toISOString() } };
    if (await templates.compareAndSwap(cur, held)) return held;
  }
  throw new OpenwopError('conflict', 'Could not start the send (the template is being edited); try again.', 409, { templateId });
}

export async function deleteTemplate(tenantId: string, orgId: string, templateId: string): Promise<boolean> {
  const existing = await getTemplate(tenantId, orgId, templateId);
  if (!existing) return false;
  const holders = (await campaignsUsingTemplate(tenantId, orgId, templateId)).filter((c) => c.status !== 'sent');
  if (holders.length > 0) {
    throw new OpenwopError('conflict', 'This template is used by a campaign that has not finished sending. Delete or finish those campaigns first.', 409, {
      reason: 'template_in_use', templateId, campaignIds: holders.slice(0, 20).map((c) => c.campaignId),
    });
  }
  const deleted = await templates.delete(templateId);
  // ADR 0905 D1 — versions go with the template unless a (sent) campaign still
  // references it: what was sent stays auditable. Residual, stated: if that last
  // campaign is deleted later, its template's version rows are left behind.
  if (deleted && (await campaignsUsingTemplate(tenantId, orgId, templateId)).length === 0) {
    for (let v = templateVersionOf(existing); v >= 1; v--) await templateVersions.delete(`${templateId}@${v}`);
  }
  return deleted;
}

/**
 * ADR 0848 D1 — the id a deterministic draft writer (the run surface's
 * `createDraftCampaign`, the copywriter agent's save-draft) should use.
 *
 * Their legacy ids (`tpl:<idemBase>:email-N`, `tpl:agent:<run>:<hash>`) are not
 * tenant-qualified, and `publish-email-sequence`'s `idemBase` hashes only the subject
 * lines — two tenants publishing the same sequence collided with no attacker present.
 * Under D1 the second would now get a 409, so new ids carry a short hash of
 * (tenant, org). The legacy id is still REUSED when — and only when — this workspace
 * already owns it, so a replay of a run from before this change converges on its own
 * rows. The probe is read-only (architect review H3): a legacy id held by someone else,
 * or absent, falls through to the qualified id; it is never created or contested.
 */
export async function draftRowId(kind: 'template' | 'campaign', tenantId: string, orgId: string, prefix: string, rest: string): Promise<string> {
  const legacyId = `${prefix}${rest}`;
  const owned = kind === 'template' ? await getTemplate(tenantId, orgId, legacyId) : await getCampaign(tenantId, orgId, legacyId);
  if (owned) return legacyId;
  const h = createHash('sha256').update(`${tenantId}\u0000${orgId}`).digest('hex').slice(0, 10);
  return `${prefix}${h}:${rest}`;
}

// ── campaigns ──
export async function listCampaigns(tenantId: string, orgId: string): Promise<Campaign[]> {
  return (await campaigns.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId && c.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** ADR 0941 P2 — the email sends of one MarketingCampaign. Legacy rows (before
 *  the back-link) are matched by the campaign's brief (`sourceBriefId`). */
export async function listSendsForMarketingCampaign(tenantId: string, orgId: string, marketingCampaignId: string, briefId?: string): Promise<Campaign[]> {
  return (await listCampaigns(tenantId, orgId)).filter((c) => c.marketingCampaignId === marketingCampaignId
    || (!c.marketingCampaignId && briefId !== undefined && c.sourceBriefId === briefId));
}
export async function getCampaign(tenantId: string, orgId: string, campaignId: string): Promise<Campaign | null> {
  const c = await campaigns.get(campaignId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}
export async function createCampaign(input: { tenantId: string; orgId: string; templateId: string; stage?: ContactStage; segmentId?: string; topicId?: string; createdBy: string; campaignId?: string; sourceBriefId?: string; marketingCampaignId?: string }): Promise<Campaign> {
  // Idempotent on a caller-supplied deterministic id — a re-run/fork of a publish node
  // returns the existing campaign instead of minting a duplicate (replay-safe) — onto a
  // row this (tenant, org) OWNS only (ADR 0848 D1, #4485). The validation below runs on
  // the CREATE branch only, so a replay still converges after its segment was deleted.
  const campaignId = input.campaignId ?? `cmp:${randomUUID()}`;
  const { row } = await insertOwnedOrConflict(campaigns, campaignId, ownedBy(input.tenantId, input.orgId), async () => {
    // `stage` and `segmentId` are mutually exclusive audience filters (ADR 0211 §2) —
    // email remains the audience OWNER, CRM owns the filter definition.
    if (input.stage && input.segmentId) {
      throw new OpenwopError('validation_error', '`stage` and `segmentId` are mutually exclusive audience filters.', 400, { field: 'audience' });
    }
    if (input.segmentId && !(await getSegment(input.tenantId, input.segmentId))) {
      throw new OpenwopError('validation_error', 'Unknown segmentId for this tenant.', 400, { field: 'segmentId', segmentId: input.segmentId });
    }
    // ADR 0848 D1 — the template must be this (tenant, org)'s. The HTTP route checked
    // it; the service — the exit every caller shares — did not.
    const tpl = await getTemplate(input.tenantId, input.orgId, input.templateId);
    if (!tpl) {
      throw new OpenwopError('validation_error', 'Unknown templateId for this workspace.', 400, { field: 'templateId', templateId: input.templateId });
    }
    // ADR 0941 P2 — the back-link is checked here, the exit every caller shares.
    if (input.marketingCampaignId) await assertCampaignRef(input.tenantId, input.orgId, input.marketingCampaignId);
    // ADR 0955 D8 — an SMS template is never sent as an email.
    if (tpl.format === 'sms') {
      throw new OpenwopError('validation_error', 'This is an SMS template; an email campaign needs an email template.', 400, { field: 'templateId', reason: 'template_format' });
    }
    // ADR 0905 D7 — the topic must be this (tenant, org)'s.
    if (input.topicId && !(await getTopic(input.tenantId, input.orgId, input.topicId))) {
      throw new OpenwopError('validation_error', 'Unknown topicId for this workspace.', 400, { field: 'topicId', topicId: input.topicId });
    }
    const now = new Date().toISOString();
    return {
      campaignId, tenantId: input.tenantId, orgId: input.orgId, templateId: input.templateId,
      audience: { ...(input.stage ? { stage: input.stage } : {}), ...(input.segmentId ? { segmentId: input.segmentId } : {}) },
      status: 'draft' as const, ...(input.topicId ? { topicId: input.topicId } : {}), ...(input.sourceBriefId ? { sourceBriefId: input.sourceBriefId } : {}), ...(input.marketingCampaignId ? { marketingCampaignId: input.marketingCampaignId } : {}), createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
  });
  return row;
}
export async function deleteCampaign(tenantId: string, orgId: string, campaignId: string): Promise<boolean> {
  const existing = await getCampaign(tenantId, orgId, campaignId);
  if (!existing) return false;
  const deleted = await campaigns.delete(campaignId);
  // ADR 0905 D3 — an open review of a deleted campaign must not linger in the inbox.
  if (deleted && existing.status === 'in_review' && existing.review) await closeReviewRow(existing.review.approvalId, 'Closed automatically — the campaign was deleted.');
  return deleted;
}

/**
 * ADR 0905 D3 — CAS a campaign row through `mutate` (re-read and re-applied on a lost
 * race). `mutate` returns null to leave the row unchanged. Null when the row is gone.
 */
export async function updateCampaignRow(tenantId: string, orgId: string, campaignId: string, mutate: (c: Campaign) => Campaign | null): Promise<{ before: Campaign; after: Campaign } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getCampaign(tenantId, orgId, campaignId);
    if (!cur) return null;
    const next = mutate(cur);
    if (!next) return { before: cur, after: cur };
    const written = { ...next, updatedAt: new Date().toISOString() };
    // Return the acknowledged CAS result. A later read can fail or observe a
    // legitimate send/withdraw, neither of which undoes this transition.
    if (await campaigns.compareAndSwap(cur, written)) return { before: cur, after: written };
  }
  throw new OpenwopError('conflict', 'Could not update the campaign (too many concurrent writes).', 409, { campaignId });
}

/** Resolve an open review row as overtaken (never as a human's rejection). */
async function closeReviewRow(approvalId: string, note: string): Promise<void> {
  try { await resolveApproval(approvalId, { status: 'rejected', note, chainOutcome: 'superseded' }); }
  catch (e) { svcLog.warn('email_review_close_failed', { approvalId, error: e instanceof Error ? e.message : String(e) }); }
}

/**
 * ADR 0905 D3 — an edit to what a review approved (template content, sender) returns
 * every matching `in_review` / `approved` campaign to `draft` and closes its row. The
 * audience is checked LAZILY instead (decide + send compare the live pin), because
 * segments are CRM-owned and a cross-feature edit hook is not this feature's to add.
 */
export async function invalidateSendReviews(tenantId: string, orgId: string, matches: (c: Campaign) => boolean, why: string): Promise<number> {
  let n = 0;
  for (const c of await listCampaigns(tenantId, orgId)) {
    if ((c.status !== 'in_review' && c.status !== 'approved') || !c.review || !matches(c)) continue;
    if (await returnToDraft(tenantId, orgId, c.campaignId, c.review.approvalId, `Closed automatically — ${why}.`)) n += 1;
  }
  return n;
}

/** Move one reviewed campaign back to `draft` (outcome `closed`) and close its row. */
export async function returnToDraft(tenantId: string, orgId: string, campaignId: string, approvalId: string, note: string, expectedReview?: CampaignReview): Promise<boolean> {
  const moved = await updateCampaignRow(tenantId, orgId, campaignId, (cur) =>
    (cur.status === 'in_review' || cur.status === 'approved') && cur.review?.approvalId === approvalId
      && (!expectedReview || JSON.stringify(cur.review) === JSON.stringify(expectedReview))
      ? { ...cur, status: 'draft', review: { ...cur.review, outcome: 'closed', note, decidedAt: new Date().toISOString() } }
      : null);
  const changed = !!moved && moved.before !== moved.after;
  if (changed) await closeReviewRow(approvalId, note);
  return changed;
}

/** ADR 0905 D4 — THE `email-approval-gate` predicate (one owner, every lane calls it).
 *  Fails CLOSED: an unreadable toggle store refuses the unapproved send. The pure
 *  toggle read (`resolveToggle`, not the `resolveOne` access resolver) is deliberate
 *  and allowlisted in `feature-toggle-access-ratchet.test.ts`: OFF loosens a
 *  restriction, so a paywalled read would fail OPEN on a lapsed plan (ADR 0819 §1). */
/** ADR 0955 D7 (P4b) — the `email.warmup` RESTRICTION (on caps a new sender's daily volume).
 *  Read with `resolveToggle` (ADR 0819 §1: a paywalled read would fail OPEN on a lapsed plan);
 *  an unreadable toggle enforces. */
export async function emailWarmupOn(tenantId: string): Promise<boolean> {
  try { return (await resolveToggle('email.warmup', { tenantId }))?.enabled === true; }
  catch (e) { svcLog.warn('email_warmup_toggle_unreadable', { tenantId, error: e instanceof Error ? e.message : String(e) }); return true; }
}

export async function emailApprovalGateOn(tenantId: string): Promise<boolean> {
  try { return (await resolveToggle('email-approval-gate', { tenantId }))?.enabled === true; }
  catch (e) { svcLog.warn('email_approval_gate_unreadable', { tenantId, error: e instanceof Error ? e.message : String(e) }); return true; }
}

/** ADR 0905 D3 — the audience DEFINITION's hash (never its membership). */
async function audienceHashOf(tenantId: string, campaign: Campaign): Promise<string> {
  let def: Record<string, unknown> = { stage: campaign.audience.stage ?? null };
  if (campaign.audience.segmentId) {
    const seg = await getSegment(tenantId, campaign.audience.segmentId);
    def = { segmentId: campaign.audience.segmentId, segmentUpdatedAt: seg?.updatedAt ?? 'missing' };
  }
  // ADR 0905 D7 — a different topic is a different audience (absent ⇒ unchanged hash).
  if (campaign.topicId) def = { ...def, topicId: campaign.topicId };
  return createHash('sha256').update(JSON.stringify(def)).digest('hex');
}

/** ADR 0905 D3 — the pin the campaign WOULD be approved/sent under right now. Null
 *  when the template is gone. */
export async function liveApprovalPin(tenantId: string, orgId: string, campaign: Campaign): Promise<CampaignApprovalPin | null> {
  const tpl = await getTemplate(tenantId, orgId, campaign.templateId);
  if (!tpl) return null;
  const sender = (await getEmailSettings(tenantId, orgId))?.senderAddress.trim() ?? '';
  return {
    templateId: tpl.templateId, templateVersion: templateVersionOf(tpl), contentHash: tpl.contentHash ?? templateContentHash(tpl),
    senderAddress: sender.toLowerCase(), audienceHash: await audienceHashOf(tenantId, campaign),
  };
}

export function samePin(a: CampaignApprovalPin | null | undefined, b: CampaignApprovalPin | null | undefined): boolean {
  return !!a && !!b && a.templateId === b.templateId && a.templateVersion === b.templateVersion && a.contentHash === b.contentHash
    && a.senderAddress === b.senderAddress && a.audienceHash === b.audienceHash;
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
  const { resend, generation, approvedPin } = await assertSendAllowed(tenantId, orgId, campaign, opts.resend === true);
  // ADR 0905 D2 — a pin for THIS generation already exists on a continuation; only a
  // first pass (or a resend, or a legacy `sending` row from before pins) reads the live
  // template, and it is pinned below before anything is dispatched.
  const existingPin = campaign.sendPin && campaign.sendPin.generation === generation ? campaign.sendPin : undefined;
  // ADR 0905 D3 — an approved send pins from the APPROVED version row, not the live
  // template: "approved bytes = sent bytes" is then structural, not a coincidence.
  const liveTemplate = existingPin ? null : approvedPin ? await approvedTemplateAt(tenantId, orgId, campaign, approvedPin) : await getTemplate(tenantId, orgId, campaign.templateId);
  if (!existingPin && !liveTemplate) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });

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

  // C4 (ADR 0218): engagement instrumentation needs an ABSOLUTE, browser-reachable
  // backend base for the tracked-link + unsubscribe routes.
  //
  // ADR 0848 D7a — and without one there is NO unsubscribe link: `instrumentBody` (and
  // with it the EM-19 refusal) only ran inside `if (linkBase)`, so a deployment with no
  // public base shipped marketing mail with no opt-out at all, and no RFC 8058 header
  // could be built. That used to be called "honest degradation"; a marketing send with
  // no way to leave the list is non-compliant, so it is refused before any dispatch.
  // `||` over trimmed values, not `??`: an EMPTY env var must fall through to the next,
  // or `OPENWOP_EMAIL_LINK_BASE_URL=''` would hide a valid public base and 501 every send.
  const linkBase = [process.env.OPENWOP_EMAIL_LINK_BASE_URL, process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL, process.env.OPENWOP_PUBLIC_BASE_URL]
    .map((v) => (v ?? '').trim()).find((v) => v !== '')?.replace(/\/+$/, '') ?? '';
  if (!linkBase) {
    throw new OpenwopError(
      'capability_not_provided',
      'This deployment has no public base URL, so campaign emails could not carry an unsubscribe link. Set OPENWOP_PUBLIC_BASE_URL (or OPENWOP_EMAIL_LINK_BASE_URL) to send campaigns.',
      501,
      { campaignId, field: 'linkBase' },
    );
  }
  // ADR 0955 D7 — a sender paused by the deliverability breaker sends no marketing email; the
  // whole pass is refused up front (no per-recipient rows: nobody chose to be skipped).
  const paused = await senderPaused(tenantId, campaign.orgId);
  if (paused) {
    throw new OpenwopError('conflict', paused === 'unreadable'
      ? 'Could not read this sender\'s sending health; nothing was sent. Try again shortly.'
      : 'Marketing email from this sender is paused because of bounces or spam complaints. A manager must review and resume it on the Email page.',
    409, { campaignId, reason: paused === 'unreadable' ? 'sending_health_unreadable' : 'sending_paused' });
  }
  // ADR 0955 D7 — the sender-domain authentication precondition (SPF + DMARC), when on.
  await assertSenderAuthenticated(tenantId, from);
  // ADR 0955 D7 (P4b) — a new sender's warm-up ceiling, when on: over it the send DEFERS to the
  // next UTC day (the campaign keeps its state; nothing is dropped or skipped).
  const warmup = (await emailWarmupOn(tenantId)) ? await warmupRemaining(tenantId, campaign.orgId) : null;
  if (warmup && warmup.remaining <= 0) {
    throw new OpenwopError('conflict', `This sender is warming up (day ${warmup.day + 1}: ${warmup.cap} emails a day) and has reached today's ceiling. Sending continues tomorrow; nothing was dropped.`, 409, { campaignId, reason: 'warmup_deferred', resumeAt: warmup.resumeAt, cap: warmup.cap });
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
  const priorTerminal = resend
    ? new Set<string>()
    : new Set((await listSends(tenantId, campaignId))
        .filter((s) => (s.generation ?? 0) === generation && (s.status === 'sent' || s.status === 'skipped'))
        .map((s) => s.contactId));
  const pending = audience.filter((c) => !priorTerminal.has(c.contactId));

  // ADR 0905 D2 — pin BEFORE the first dispatch and AFTER every refusal above, so a
  // refused send leaves the campaign a `draft` rather than a `sending` that sent nothing.
  // A CAS onto the row read at pass start: two instances starting the same draft agree
  // on ONE pin (the loser adopts the winner's), and a pin is never overwritten.
  if (!existingPin && beforePinHook) await beforePinHook(campaign.campaignId);
  const pin = await pinSend(tenantId, orgId, campaign, generation, liveTemplate, approvedPin);
  const template = { name: pin.templateName, subject: pin.subject, body: pin.body, format: pin.format };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? SEND_BATCH_DEFAULT)), warmup ? warmup.remaining : Number.POSITIVE_INFINITY);
  const batch = pending.slice(0, limit);

  // R2 EM-SP-1 — stats are DERIVED from the ledger at pass end (per-contact
  // latest status), never accumulated: accumulation re-counted every re-skip
  // and every retried failure, so the "{{sent}} sent · {{skipped}} skipped"
  // centerpiece could exceed the audience size. The pass below still tallies
  // into `stats` transiently for the per-pass failure check.
  const stats: CampaignStats = { sent: 0, failed: 0, skipped: 0 };

  // ADR 0267 / CDP-E — frequency governor config, read once per invocation.
  const { max: freqCap, windowDays: freqWindowDays } = emailFrequencyCap();
  const freqWindowStartIso = new Date(Date.now() - freqWindowDays * 86_400_000).toISOString();

  let passFailed = 0;
  for (const contact of batch) {
    const log = (status: SendStatus, error?: string): SendLog => ({ sendId: `snd:${randomUUID()}`, tenantId, campaignId, contactId: contact.contactId, status, ts: new Date().toISOString(), ...(generation ? { generation } : {}), ...(error ? { error } : {}) });
    if (!contact.email) { stats.skipped += 1; await sendLogs.put(log('skipped', 'no_email')); continue; }
    // ADR 0955 D2 — the ONE per-channel check the journeys use too (`crm/channelEligibility`),
    // so a broadcast and a journey refuse the same recipient for the same reason. It composes,
    // in order: the address, `marketing.email` through the one consent evaluator (ADR 0227 per
    // channel; ADR 0905 D7 topic narrowing inside it), then the suppression overlay (ADR 0217 /
    // C3), from this campaign's org as the sender. The skip reasons are the ones this loop
    // always wrote: a topic opt-out is a `consent` skip.
    // ADR 0655 D9 (EM-7) / FOLD-IN B5 — an UNREADABLE consent or suppression store is not a
    // decision about the recipient: no ledger row, `passFailed` bumped, the next pass retries
    // (a `suppressed` row is terminal and person-attributed; an outage must never write one).
    {
      const verdict = await checkChannelEligibility(tenantId, campaign.orgId, contact.contactId, 'email', {
        ...(campaign.topicId ? { topicId: campaign.topicId } : {}),
        contact,
      });
      if (!verdict.eligible) {
        if (verdict.reason === 'consent_unreadable' || verdict.reason === 'suppression_unreadable' || verdict.reason === 'deliverability_paused') {
          passFailed += 1;
          if (verdict.reason === 'consent_unreadable') svcLog.warn('consent read failed; recipient retried next pass', { campaignId });
          continue;
        }
        const skip = verdict.reason === 'suppressed' ? 'suppressed'
          : verdict.reason === 'no_address' || verdict.reason === 'contact_not_found' ? 'no_email'
            : 'consent';
        stats.skipped += 1; await sendLogs.put(log('skipped', skip)); continue;
      }
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
      // ADR 0848 D7a — `linkBase` is guaranteed above, so every message is instrumented
      // and carries its unsubscribe link (or the send is refused inside, EM-19).
      const instrumented = await instrumentBodyWithUnsubscribe(interpolate(template.body, vars, { markdown: template.format === 'markdown' }), linkBase, { tenantId, campaignId, orgId: campaign.orgId, contactId: contact.contactId, email: contact.email });
      const body = instrumented.body;
      let html: string | undefined;
      {
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
        // ADR 0848 D7 — RFC 8058 one-click: the footer's own `/u/:token`, as a header.
        listUnsubscribe: { url: instrumented.unsubscribeUrl },
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
  // ADR 0955 D7 — this pass's sends feed the sender's breaker (once per pass; a lost write
  // under-counts sends, which raises the rates — the safe direction).
  if (stats.sent > 0) await noteFirstSend(tenantId, campaign.orgId).catch(() => undefined);
  if (stats.sent > 0) await recordSends(tenantId, campaign.orgId, stats.sent).catch((e) => svcLog.warn('sender_health_send_count_failed', { campaignId, error: e instanceof Error ? e.message : String(e) }));
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
  // ADR 0848 M6 — a CAS onto the CURRENT row, not a blind put of the copy read at the
  // start of the pass: a campaign deleted mid-send was resurrected by that put. A lost
  // race re-reads and re-applies only what this pass owns (status, stats, generation);
  // a row that is gone stays gone.
  let current = await getCampaign(tenantId, orgId, campaignId);
  for (let attempt = 0; attempt < 4 && current; attempt++) {
    // Completion owns only the exact generation/pin/review admitted above. Keep
    // already-dispatched ledger rows, but never overwrite a newer send or review.
    if ((current.sendGeneration ?? 0) !== generation
        || JSON.stringify(current.sendPin) !== JSON.stringify(pin)
        || JSON.stringify(current.review) !== JSON.stringify(campaign.review)
        || (current.status !== 'sending' && current.status !== 'sent')) {
      throw new OpenwopError('conflict', 'The campaign changed while this send was running; dispatched emails remain recorded.', 409, { campaignId, reason: 'send_changed' });
    }
    if (current.status === 'sent') return current;
    const next: Campaign = { ...current, status: exhausted ? 'sent' : 'sending', stats: derived, ...(generation ? { sendGeneration: generation } : {}), updatedAt: new Date().toISOString() };
    if (await campaigns.compareAndSwap(current, next)) return next;
    current = await getCampaign(tenantId, orgId, campaignId);
  }
  if (!current) {
    // The pass DID dispatch (the ledger records it); only the campaign row is gone. A
    // `null` would read as "never existed" (404) after mail went out — say what happened.
    throw new OpenwopError('conflict', 'The campaign was deleted while it was sending; the emails already dispatched in this pass were sent.', 409, { campaignId, reason: 'deleted_during_send' });
  }
  throw new OpenwopError('conflict', 'Could not record the send result (too many concurrent writes); re-run to continue.', 409, { campaignId });
}

/**
 * ADR 0905 D3/D4 — the approval gate, the ONE predicate. `sendCampaign` (the service
 * every caller shares) runs it, so no lane can skip it; the send ROUTE also runs it
 * first so an unapproved send is told "approval required" before any provider or
 * credential question. A `sending` campaign that already holds this generation's pin
 * is a CONTINUATION of a send that was authorised when it started (architect E4):
 * refusing it would strand every in-flight send the moment the gate turns on.
 */
export async function assertSendAllowed(
  tenantId: string, orgId: string, campaign: Campaign, resendRequested: boolean,
): Promise<{ resend: boolean; generation: number; approvedPin?: CampaignApprovalPin }> {
  // Approving a review opened on a SENT campaign authorises a resend.
  const resend = resendRequested || (campaign.status === 'approved' && campaign.review?.fromStatus === 'sent');
  const generation = resend ? (campaign.sendGeneration ?? 0) + 1 : (campaign.sendGeneration ?? 0);
  const continuation = !resend && campaign.status === 'sending' && campaign.sendPin?.generation === generation;
  if (continuation || !(await emailApprovalGateOn(tenantId))) return { resend, generation };
  if (campaign.status !== 'approved' || !campaign.review || campaign.review.outcome !== 'approved') {
    throw new OpenwopError('conflict', 'This workspace requires an approval before a campaign is sent. Submit it for review.', 409, { reason: 'approval_required', campaignId: campaign.campaignId, status: campaign.status });
  }
  const live = await liveApprovalPin(tenantId, orgId, campaign);
  if (!samePin(live, campaign.review.pin)) {
    await returnToDraft(tenantId, orgId, campaign.campaignId, campaign.review.approvalId, 'Closed automatically — the campaign changed after it was approved.');
    throw new OpenwopError('conflict', 'The template, sender or audience changed after this campaign was approved. Submit it for review again.', 409, { reason: 'approval_stale', campaignId: campaign.campaignId });
  }
  return { resend, generation, approvedPin: campaign.review.pin };
}

/** The approved template version as an `EmailTemplate`-shaped row for `pinSend`. */
async function approvedTemplateAt(tenantId: string, orgId: string, campaign: Campaign, pin: CampaignApprovalPin): Promise<EmailTemplate | null> {
  const tpl = await getTemplate(tenantId, orgId, campaign.templateId);
  const v = await getTemplateVersion(tenantId, orgId, campaign.templateId, pin.templateVersion);
  if (!tpl || !v || v.contentHash !== pin.contentHash) return null;
  return { ...tpl, subject: v.subject, body: v.body, ...(v.format ? { format: v.format } : {}), version: v.version, contentHash: v.contentHash };
}

async function pinSend(tenantId: string, orgId: string, campaign: Campaign, generation: number, liveIn: EmailTemplate | null, approvedPin?: CampaignApprovalPin): Promise<CampaignSendPin> {
  // Take the template hold before creating a new campaign pin. Continuations
  // already own frozen bytes, but still pass the fresh campaign fence below.
  let live = liveIn;
  if (liveIn) {
    let held: EmailTemplate | null;
    try { held = await holdTemplateForSend(tenantId, orgId, liveIn.templateId, approvedPin); }
    catch (error) {
      if (error instanceof OpenwopError && error.details?.reason === 'approval_stale' && campaign.review) {
        await returnToDraft(tenantId, orgId, campaign.campaignId, campaign.review.approvalId, 'Closed automatically — the template changed after the campaign was approved.', campaign.review);
      }
      throw error;
    }
    if (!held) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: liveIn.templateId });
    live = approvedPin ? liveIn : held;
  }
  const fresh: CampaignSendPin | null = live ? {
    generation, templateId: live.templateId, templateVersion: templateVersionOf(live), templateName: live.name,
    subject: live.subject, body: live.body, ...(live.format ? { format: live.format } : {}),
    contentHash: templateContentHash(live), pinnedAt: new Date().toISOString(),
  } : null;
  let current = await getCampaign(tenantId, orgId, campaign.campaignId);
  for (let attempt = 0; attempt < 4 && current; attempt++) {
    if (campaign.status === 'sending' && campaign.sendPin?.generation === generation) {
      if (current.status !== 'sending' || (current.sendGeneration ?? 0) !== generation
          || JSON.stringify(current.sendPin) !== JSON.stringify(campaign.sendPin)
          || JSON.stringify(current.review) !== JSON.stringify(campaign.review)
          || current.templateId !== campaign.templateId
          || JSON.stringify(current.audience) !== JSON.stringify(campaign.audience)) {
        throw new OpenwopError('conflict', 'This send generation changed before continuation. Reload the campaign.', 409, { reason: 'send_changed', campaignId: campaign.campaignId });
      }
      return current.sendPin!;
    }
    // A lost CAS is a new authorization boundary, not permission to resurrect the
    // original approval. Check its identity BEFORE adopting a concurrent send pin:
    // a newer review can start the same generation with different audience bytes.
    if (approvedPin) {
      const sameReview = current.review?.outcome === 'approved'
        && JSON.stringify(current.review) === JSON.stringify(campaign.review);
      const sameAudience = current.templateId === campaign.templateId
        && JSON.stringify(current.audience) === JSON.stringify(campaign.audience);
      const started = current.status === 'sending'
        && current.sendPin?.generation === generation && (current.sendGeneration ?? 0) === generation
        && current.sendPin.templateId === approvedPin.templateId
        && current.sendPin.templateVersion === approvedPin.templateVersion
        && current.sendPin.contentHash === approvedPin.contentHash
        && templateContentHash(current.sendPin) === approvedPin.contentHash;
      const mayStart = current.status === 'approved'
        && (current.sendGeneration ?? 0) === (campaign.sendGeneration ?? 0);
      if (!sameReview || !sameAudience || (!started && !mayStart)
          || (!started && !samePin(await liveApprovalPin(tenantId, orgId, current), approvedPin))) {
        // Do not close or rewrite a newer review while refusing this stale attempt.
        throw new OpenwopError('conflict', 'The send approval changed before dispatch. Reload the campaign and submit it for review again.', 409, { reason: 'approval_stale', campaignId: campaign.campaignId });
      }
      if (started) return current.sendPin!;
    } else if (current.sendPin && current.sendPin.generation === generation) {
      if (current.status !== 'sending' || (current.sendGeneration ?? 0) !== generation
          || JSON.stringify(current.review) !== JSON.stringify(campaign.review)
          || current.templateId !== campaign.templateId
          || JSON.stringify(current.audience) !== JSON.stringify(campaign.audience)) {
        throw new OpenwopError('conflict', 'This send changed before dispatch. Reload the campaign.', 409, { reason: 'send_changed', campaignId: campaign.campaignId });
      }
      return current.sendPin;
    }
    if (!approvedPin && ((current.sendGeneration ?? 0) !== (campaign.sendGeneration ?? 0)
        || current.status !== campaign.status
        || JSON.stringify(current.review) !== JSON.stringify(campaign.review)
        || current.templateId !== campaign.templateId
        || JSON.stringify(current.audience) !== JSON.stringify(campaign.audience))) {
      throw new OpenwopError('conflict', 'The campaign changed before this send started. Reload the campaign.', 409, { reason: 'send_changed', campaignId: campaign.campaignId });
    }
    if (!fresh) throw new OpenwopError('conflict', 'The send pin is no longer available. Reload the campaign.', 409, { campaignId: campaign.campaignId });
    const next: Campaign = { ...current, status: 'sending', sendPin: fresh, ...(generation ? { sendGeneration: generation } : {}), updatedAt: new Date().toISOString() };
    if (await campaigns.compareAndSwap(current, next)) {
      // ADR 0905 D3 — a direct send (gate OFF) of a campaign under review overtakes the
      // review: close the row so no card is left asking about a sent campaign.
      if (current.status === 'in_review' && current.review) await closeReviewRow(current.review.approvalId, 'Closed automatically — the campaign was sent without waiting for the review.');
      return fresh;
    }
    current = await getCampaign(tenantId, orgId, campaign.campaignId);
  }
  if (!current) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: campaign.campaignId });
  throw new OpenwopError('conflict', 'Could not start the send (too many concurrent writes); try again.', 409, { campaignId: campaign.campaignId });
}

/** Render a template with a contact's fields (pure — used by the render node). */
export function renderTemplate(template: EmailTemplate, vars: { name?: string; email?: string; company?: string }): { subject: string; body: string } {
  const v = { name: vars.name ?? '', email: vars.email ?? '', company: vars.company ?? '' };
  return { subject: interpolate(template.subject, v), body: interpolate(template.body, v, { markdown: template.format === 'markdown' }) };
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
    // ADR 0819 §1 opt-out — money/compliance truth: this must apply whatever the tenant's plan.
    return (await resolveToggle('email', { tenantId }))?.enabled !== false;
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
/** ADR 0905 D7 — a campaign by id within a tenant (the public preference centre knows
 *  only the token's tenant + campaign). Tenant-filtered; null when absent. */
export async function getCampaignInTenant(tenantId: string, campaignId: string): Promise<Campaign | null> {
  const c = await campaigns.get(campaignId);
  return c && c.tenantId === tenantId ? c : null;
}

export async function __resetEmailStore(): Promise<void> { await topics.__clear(); await templateVersions.__clear(); await templates.__clear(); await campaigns.__clear(); await sendLogs.__clear(); await settings.__clear(); }
