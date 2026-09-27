/**
 * ADR 0478 §2 — email approval delivery: the Teams-delivery sibling at the
 * notification seams. Two lanes, both per-recipient OPT-IN and fail-soft:
 *
 *  - INTERRUPT gates (RFC 0093): called from `emitInterruptNotification`
 *    WITH the capability token as an ARGUMENT (the token is never persisted
 *    into notification rows — inbox reads must not hand out decide
 *    capability). The email carries Approve/Reject links to the host-ext
 *    confirm page, which POSTs to the EXISTING `/v1/interrupts/:token`
 *    resolution (decide-by-email, guest-capable, 410 after expiry).
 *  - APPROVAL-STORE reviews: called from the emitter chokepoint (records
 *    WITHOUT an interruptId — the interrupt lane owns those), LINK-OUT to
 *    /inbox (the Teams rule: quorum/RBAC decisions live in-app).
 *
 * Transport = the tenant's TENANT-SCOPE smtp connection via the existing
 * `sendViaSmtp` (SSRF-guarded, idempotency-ledgered). No connection ⇒ the
 * lane is silently absent (the Teams no-pref rule). No secrets and no
 * payload bodies in the mail — title + message + links.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { makeEmailAdapter } from './emailAdapter.js';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { signVoterBinding } from './interruptVoterBinding.js';
import { listTenantMembers } from './accessControlService.js';
import { vendorPublicBase } from '../features/featureRoute.js';

const log = createLogger('host.emailApprovalDelivery');

/* ── the opt-in pref ────────────────────────────────────────────────────── */

export interface EmailApprovalPref {
  /** `${tenantId}:${userId}` */
  key: string;
  tenantId: string;
  userId: string;
  email: string;
  enabled: boolean;
  updatedAt: string;
}

const prefs = new DurableCollection<EmailApprovalPref>(
  'notify:email-approval-pref',
  (p) => p.key,
  undefined,
  (p) => p.tenantId,
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getEmailApprovalPref(tenantId: string, userId: string): Promise<EmailApprovalPref | null> {
  return prefs.get(`${tenantId}:${userId}`);
}

export async function setEmailApprovalPref(input: { tenantId: string; userId: string; email: string; enabled: boolean }): Promise<EmailApprovalPref> {
  const email = input.email.trim();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new OpenwopError('validation_error', 'A valid email address is required.', 400, {});
  }
  const row: EmailApprovalPref = {
    key: `${input.tenantId}:${input.userId}`,
    tenantId: input.tenantId,
    userId: input.userId,
    email,
    enabled: input.enabled === true,
    updatedAt: new Date().toISOString(),
  };
  await prefs.put(row);
  return row;
}

/** ADR 0464 — the pref row IS the subject's PII (their address): DELETE. */
export async function eraseSubjectEmailPrefs(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await prefs.listByPrefix(`${tenantId}:`)) {
    if (forms.has(r.userId)) await prefs.delete(r.key);
  }
}
export function registerEmailPrefErasure(): void {
  registerSubjectEraser(eraseSubjectEmailPrefs);
}

/* ── delivery ───────────────────────────────────────────────────────────── */

function publicBase(): string {
  return (process.env.OPENWOP_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
}
function fromAddress(): string | null {
  return process.env.OPENWOP_NOTIFY_EMAIL_FROM ?? null;
}

export interface ApprovalEmailInput {
  tenantId: string;
  recipientUserId: string;
  notificationId: string;
  title: string;
  message: string;
  /** RFC 0093 capability token — INTERRUPT lane only, passed as an argument,
   *  never read from a persisted record. */
  interruptToken?: string;
}

/** Boot-time storage injection (the setEventLogBackend pattern) so the
 *  emitter chokepoint can deliver without threading Storage through it. */
let storageRef: Storage | null = null;
export function installEmailApprovalDelivery(storage: Storage): void {
  storageRef = storage;
}

/** The emitter-chokepoint sibling: APPROVAL-STORE reviews only (records with
 *  an interruptId belong to the token lane in notify.ts). Link-out only. */
export function deliverEmailForNotificationRecord(record: {
  tenantId: string; recipientUserId?: string; notificationId: string;
  type: string; title: string; message: string; interruptId?: string;
}): void {
  if (!storageRef) return;
  if (record.interruptId) return; // the interrupt lane owns token emails
  if (!record.recipientUserId) return; // addressed only — never email-blast broadcasts
  if (record.type !== 'openwop-app.workflow.approval-needed' && record.type !== 'workflow.input_needed'
    && record.type !== 'approval.sla-reminder' && record.type !== 'approval.sla-escalated') return;
  void deliverApprovalEmail(storageRef, {
    tenantId: record.tenantId,
    recipientUserId: record.recipientUserId,
    notificationId: record.notificationId,
    title: record.title,
    message: record.message,
  });
}

/** Best-effort, opt-in, fail-soft — never throws into the notification path. */
export async function deliverApprovalEmail(storage: Storage, input: ApprovalEmailInput): Promise<void> {
  try {
    const from = fromAddress();
    const base = publicBase();
    if (!from || !base) return; // the lane is env-configured off
    const pref = await getEmailApprovalPref(input.tenantId, input.recipientUserId);
    if (!pref?.enabled) return;

    // Grade-data M9 — the pref row was self-set by an authenticated member,
    // but it outlives membership (offboarding runs no pref cascade). Before
    // mailing a DECIDE-CAPABLE token, re-check membership when the tenant has
    // member rows at all; a former member degrades to the link-out email
    // (the inbox enforces auth). Memberless tenants (demo / anon / solo
    // cookie workspaces) keep the pref-set-time authentication as the gate.
    let tokenAllowed = Boolean(input.interruptToken);
    if (tokenAllowed) {
      try {
        const members = await listTenantMembers(input.tenantId);
        if (members.length > 0) {
          const { forms } = subjectKeyForms(input.recipientUserId);
          tokenAllowed = members.some((m) => (m.subject && forms.has(m.subject)) || forms.has(m.memberId));
        }
      } catch {
        tokenAllowed = false; // fail closed on the decide capability, not the notification
      }
    }

    const inboxUrl = `${base}/inbox`;
    let text: string;
    if (input.interruptToken && tokenAllowed) {
      // Grade-code H1 — each recipient's links are HMAC-bound to THEIR voter
      // id (interruptVoterBinding). The token alone can no longer name other
      // approvers on the confirm page or the quorum lane.
      const sig = encodeURIComponent(signVoterBinding(input.interruptToken, input.recipientUserId));
      const approve = `${vendorPublicBase(base)}/interrupt-action?token=${encodeURIComponent(input.interruptToken)}&action=approve&voter=${encodeURIComponent(input.recipientUserId)}&sig=${sig}`;
      const reject = `${vendorPublicBase(base)}/interrupt-action?token=${encodeURIComponent(input.interruptToken)}&action=reject&voter=${encodeURIComponent(input.recipientUserId)}&sig=${sig}`;
      text = [
        input.message,
        '',
        `Approve: ${approve}`,
        `Reject:  ${reject}`,
        '',
        'The links open a confirmation page (nothing happens until you confirm there).',
        `Or review in the app: ${inboxUrl}`,
        'Links expire with the request.',
      ].join('\n');
    } else {
      text = [input.message, '', `Review in the app: ${inboxUrl}`].join('\n');
    }

    // ADR 0655 D1 (review B1) — this was the FOURTH egress path, calling
    // `sendViaSmtp` directly and bypassing the adapter's floor. It now rides the
    // adapter as a transactional send (a bounced address still gets its approval
    // notice; an erased one does not). A notification send is host-attributed:
    // tenant-scope connection only (no acting user ⇒ the broker withholds user/org
    // connections — the fail-closed default is exactly right here).
    const result = await makeEmailAdapter({ storage, tenantId: input.tenantId, runId: `notify:${input.notificationId}` }).send({
      from, to: pref.email, subject: input.title, text,
      provider: 'smtp', purpose: 'transactional',
      idempotencyKey: `notify-email:${input.notificationId}:${input.recipientUserId}`,
    });
    if (!result.sent) {
      log.debug('approval_email_not_sent', { notificationId: input.notificationId, reason: result.error ?? 'unknown' });
    }
  } catch (err) {
    log.warn('approval_email_delivery_failed', {
      notificationId: input.notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
