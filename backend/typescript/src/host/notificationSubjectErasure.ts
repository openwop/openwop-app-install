/**
 * CMNT-11 — per-SUBJECT erasure for the notification inbox.
 *
 * THE RESIDUAL. A notification names a data subject in up to three places:
 * `recipientUserId` (who it was addressed to) and `metadata.actorId` /
 * `metadata.recipientId` (who caused it / who it is about), plus whatever the
 * `title`/`message` quote — the comments emitter writes all three AND the parent
 * resource's title. Found in the Comments grade because
 * `deleteSubjectComments` erased the comment and left a notification naming its
 * author standing, but the residual is NOT comments-specific: every emitter
 * writes the same shape, so the eraser belongs to the store's owning feature.
 * Before this, the only reclamation was `deleteAllTenantNotifications`
 * ("used by account-delete") — tenant-level, never per-subject.
 *
 * ── THE GATE-BLINDNESS MECHANISM, STATED (a FIFTH distinct one) ──
 *
 * The ADR 0464 feature-store erasure gate builds its denominator by walking
 * `src/features/**` for `new DurableCollection<…>` and reading the row type's
 * subject-bearing fields. Notification records satisfy NEITHER half: they live
 * on the `Storage` INTERFACE (a SQL table behind `insertNotification` /
 * `listNotifications`), and the table and its adapters live in `src/storage/`,
 * outside the walked tree. So the store was not covered, not debt and not
 * exempt — it was ABSENT from the census, which reads exactly like a store with
 * nothing to erase.
 *
 * The four mechanisms already on record are: a row type declaring none of the
 * recognised subject field names; `^\s*`-anchored regexes that cannot see a
 * one-line interface; `hasEraser` resolving at feature-DIRECTORY level; and a
 * `hasEraser` regex that counted a COMMENTED-OUT registration. This one differs
 * in kind: the store is not mis-classified, it is not ENUMERABLE.
 *
 * ── WHAT WAS CHOSEN ──
 *
 * FIXED, not merely ledgered. Migrating the notification table onto a
 * `DurableCollection` purely to become visible to the gate would move a
 * SQL-indexed, high-volume, cross-feature table onto the KV seam for a
 * reporting reason — larger, riskier, and worse to serve. So the RECLAMATION is
 * real (this eraser + `Storage.deleteNotificationsForSubject` on both adapters)
 * and the gate's blindness is recorded separately in
 * `test/subject-erasure-feature-stores.test.ts` (`NON_COLLECTION_STORES`), so
 * the limit is visible rather than implied.
 *
 * ── WHY IT LIVES IN `src/host/`, NOT `src/features/notifications/` ──
 *
 * It was written there first, and the gate below immediately caught the fix
 * minting a FALSE COVERAGE claim: `hasEraser` resolves at feature-DIRECTORY
 * level (the third recorded blindness mechanism), so one `registerSubjectEraser`
 * anywhere under `src/features/notifications/` flipped the SIBLING collection
 * `notifications:prefs` — recorded debt, "simply has no eraser yet" — to
 * covered, even though nothing here touches it. That is the "a partial fix can
 * invert a safety property" shape exactly.
 *
 * `src/host/` is also where the store honestly belongs: the notification table
 * is a `Storage`-interface SQL table under `src/storage/`, not a feature-owned
 * `DurableCollection`. The registration is INSTALLED from the notifications
 * feature's `registerRoutes` (one call site, at boot) so ownership stays clear
 * without putting the trigger where it would lie to the gate.
 *
 * WHAT IT STILL DOES NOT REACH, stated rather than implied: free text. A
 * notification `title`/`message` can quote a THIRD PARTY's name (the comment
 * body it summarises, the resource title), and no id-keyed eraser reaches
 * content ABOUT someone written by someone ELSE — the same limit the gate names
 * explicitly for `campaign-brief:voc-evidence`. Rows the subject is NAMED in are
 * reached; rows that merely mention them in prose are not.
 */

import { registerSubjectEraser } from './subjectErasure.js';
import { hostExtStorage } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.notificationSubjectErasure');

/** Remove every notification in this tenant that NAMES the subject. Returns the
 *  count so the caller reports a real number, not a silent void. Fail-closed on
 *  a falsy tenant or subject — a subject eraser that widens to "everything" on
 *  an empty key is far worse than one that misses. */
export async function deleteSubjectNotifications(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  return hostExtStorage().deleteNotificationsForSubject(tenantId, subjectKey);
}

/**
 * The registered eraser. A MODULE-LEVEL NAMED FUNCTION, deliberately — it is the
 * shape that satisfies BOTH contracts `subjectErasure` places on a registration,
 * and the two are separable:
 *
 *  - NAMEABILITY (R2 CN-SP-6). `eraseSubject` reports a failed eraser as
 *    ``erasers[i]?.name || `eraser#${i}` ``. An arrow passed directly to the call
 *    has `.name === ''`, so a Postgres failure on the GDPR audit path reported
 *    `failedFeatures: ["eraser#N"]` — an index that names nothing an operator can
 *    escalate with.
 *  - DEDUPE. `registerSubjectEraser` is idempotent BY REFERENCE
 *    (`erasers.includes(fn)`). This is the half a named function EXPRESSION does
 *    NOT fix: `registerSubjectEraser(async function eraseX(){…})` still
 *    constructs a fresh closure on every call, so a second `installX()` appends a
 *    duplicate and inflates `total`. Only a stable module-level reference — the
 *    shape ~35 sibling registrations already use (`registerSubjectEraser(
 *    eraseSubjectCanvas)`) — makes the re-registration a genuine no-op.
 */
async function eraseNotificationSubject(tenantId: string, subjectKey: string): Promise<void> {
  const removed = await deleteSubjectNotifications(tenantId, subjectKey);
  if (removed > 0) log.info('subject_notifications_erased', { tenantId, removed });
}

export function installNotificationSubjectEraser(): void {
  registerSubjectEraser(eraseNotificationSubject);
}
