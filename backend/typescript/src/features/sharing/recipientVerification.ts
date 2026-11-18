/**
 * ADR 1141 D3/D5 — the public code lane of a recipient-bound share link: request a
 * code, verify it. The gate itself is in `sharingService.resolveActiveLink`; this
 * module only issues and checks codes, keeps the link's counters, writes the audit
 * entries, and tells the creator about a lock.
 *
 * Both routes answer every token the SAME way unless it is a live, bound link with a
 * correct code: an unknown, revoked, expired or unbound token takes the same limiter
 * steps and one store read, then gets the same `202` (request) or the same
 * `400 share_verification_failed` (verify). The send itself is detached, so the
 * response time does not depend on whether an email went out.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { takeShared } from '../../host/sharedRateLimit.js';
import { getOrg } from '../../host/accessControlService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { recipientEmailOf, updateLinkVerification, verificationTargetFor, type ShareLink } from './sharingService.js';
import { checkCode, issueCode, markVerified, maskEmail } from './verificationStore.js';
import { sendShareCode } from './shareCodeMail.js';

const log = createLogger('sharing.verification');

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ipKey = (ip: string): string => sha(ip || 'unknown').slice(0, 32);
const prefixOf = (tokenHash: string): string => tokenHash.slice(0, 12);

const limited = (retryAfterS: number): OpenwopError =>
  new OpenwopError('rate_limited', 'Too many attempts. Try again in a few minutes.', 429, { retryAfterS });

let lastDelivery: Promise<void> = Promise.resolve();
/** Test seam: the detached send started by the last request. */
export function __lastShareCodeDeliveryForTest(): Promise<void> { return lastDelivery; }

async function audit(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  const { appendAudit } = await import('../../host/auditChainService.js');
  await appendAudit(tenantId, kind, payload).catch(() => { /* audit is best-effort; never block the visitor */ });
}

/**
 * Request a code. Caps requests on their own (per link 3 per 10 minutes and 10 per
 * day, per IP 10 per 10 minutes, all closed), apart from the 5-miss lock, so a link
 * holder cannot email-bomb the recipient. Resolves for every token alike.
 */
export async function requestShareCode(input: { token: string; ip: string }): Promise<void> {
  const ipTake = await takeShared({ scope: 'sharing.verify.send.ip', key: ipKey(input.ip), limit: 10, windowS: 600, failure: 'closed' });
  if (!ipTake.allowed) throw limited(ipTake.retryAfterS);
  const tokenKey = sha(input.token);
  const burst = await takeShared({ scope: 'sharing.verify.send.link', key: tokenKey, limit: 3, windowS: 600, failure: 'closed' });
  if (!burst.allowed) throw limited(burst.retryAfterS);
  const daily = await takeShared({ scope: 'sharing.verify.send.link-day', key: tokenKey, limit: 10, windowS: 86_400, failure: 'closed' });
  if (!daily.allowed) throw limited(daily.retryAfterS);
  const link = await verificationTargetFor(input.token);
  if (!link || link.verify.lockedAt) return; // the same 202; nothing is sent
  lastDelivery = deliver(link).catch((err: unknown) => {
    log.warn('share_code_delivery_failed', { tokenPrefix: prefixOf(link.tokenHash), error: err instanceof Error ? err.message : String(err) });
  });
}

async function deliver(link: ShareLink): Promise<void> {
  const email = await recipientEmailOf(link);
  if (!email) {
    log.info('share_code_no_recipient_address', { tokenPrefix: prefixOf(link.tokenHash) });
    return;
  }
  const now = Date.now();
  const code = await issueCode(link.tokenHash, link.tenantId, now); // a new code voids the previous one
  const org = await getOrg(link.orgId);
  const sent = await sendShareCode({ tenantId: link.tenantId, to: email, orgName: org?.name ?? '', code, idempotencyKey: `share-code:${link.tokenHash}:${now}` });
  if (!sent) {
    log.warn('share_code_not_sent', { tokenPrefix: prefixOf(link.tokenHash) });
    return;
  }
  const at = new Date(now).toISOString();
  await updateLinkVerification(link.tokenHash, (l) => ({ ...l, verification: { ...counters(l), sentCount: counters(l).sentCount + 1, lastSentAt: at } }));
  await audit(link.tenantId, 'share.verification.sent', { tokenPrefix: prefixOf(link.tokenHash), to: maskEmail(email) });
}

const counters = (l: ShareLink): NonNullable<ShareLink['verification']> => l.verification ?? { sentCount: 0, verifiedCount: 0, failedAttempts: 0 };

/**
 * Verify a code for the caller's browser session (`sid`). A success makes this
 * session a verified viewer of the link for `verify.sessionHours`. Every failure,
 * for any token, is the same `400 share_verification_failed`. The fifth miss locks
 * the link and tells its creator, never the recipient.
 */
export async function verifyShareCode(input: { token: string; code: unknown; sid: string | undefined; ip: string }): Promise<void> {
  const ipTake = await takeShared({ scope: 'sharing.verify.check.ip', key: ipKey(input.ip), limit: 30, windowS: 600, failure: 'closed' });
  if (!ipTake.allowed) throw limited(ipTake.retryAfterS);
  const linkTake = await takeShared({ scope: 'sharing.verify.check.link', key: sha(input.token), limit: 10, windowS: 600, failure: 'closed' });
  if (!linkTake.allowed) throw limited(linkTake.retryAfterS);
  const failed = (): OpenwopError => new OpenwopError('share_verification_failed', "That code didn't work. Check it, or ask for a new one.", 400, {});
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const link = await verificationTargetFor(input.token);
  // The same store read on every path, so a probe cannot time the difference.
  const result = await checkCode(link && !link.verify.lockedAt && input.sid ? link.tokenHash : sha(`absent:${input.token}`), code);
  if (!link || link.verify.lockedAt || !input.sid) throw failed();
  const prefix = prefixOf(link.tokenHash);
  if (result === 'ok') {
    await markVerified(link.tokenHash, link.tenantId, input.sid, link.verify.sessionHours);
    const at = new Date().toISOString();
    await updateLinkVerification(link.tokenHash, (l) => ({ ...l, verification: { ...counters(l), verifiedCount: counters(l).verifiedCount + 1, lastVerifiedAt: at, failedAttempts: 0 } }));
    await audit(link.tenantId, 'share.verification.verified', { tokenPrefix: prefix });
    return;
  }
  if (result === 'none') throw failed();
  const updated = await updateLinkVerification(link.tokenHash, (l) => ({ ...l, verification: { ...counters(l), failedAttempts: counters(l).failedAttempts + 1 } }));
  await audit(link.tenantId, 'share.verification.failed', { tokenPrefix: prefix, attempt: updated?.verification?.failedAttempts ?? null });
  if (result === 'locked') await lock(link);
  throw failed();
}

async function lock(link: ShareLink): Promise<void> {
  const at = new Date().toISOString();
  await updateLinkVerification(link.tokenHash, (l) => (l.verify ? { ...l, verify: { ...l.verify, lockedAt: at } } : l));
  await audit(link.tenantId, 'share.verification.locked', { tokenPrefix: prefixOf(link.tokenHash) });
  // The creator only. Emailing the recipient about someone else's failed guesses
  // would hand that someone a harassment lane (ADR 1141 D3). A link the host minted
  // for a feature (`system:…`, the visitor lane) has no person as its creator, so
  // the workspace's admins are told instead.
  const toCreator = !link.createdBy.startsWith('system:');
  try {
    await getNotificationEmitter().emit({
      tenantId: link.tenantId,
      ...(toCreator ? { recipientUserId: link.createdBy } : { recipientRole: 'admin' }),
      type: 'openwop-app.sharing.link-locked',
      priority: 'high',
      title: 'A shared link was locked',
      message: `Five wrong codes were entered for "${link.label ?? link.resourceType}". Unlock it or send a new link.`,
      actionUrl: '/sharing',
      metadata: { tokenPrefix: prefixOf(link.tokenHash) },
    });
  } catch (err) {
    log.warn('share_link_lock_notice_failed', { tokenPrefix: prefixOf(link.tokenHash), error: err instanceof Error ? err.message : String(err) });
  }
}
