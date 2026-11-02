/**
 * ADR 1022 D8 — a client org's campaign alert reaches that client's people.
 *
 * Pacing and spend-cap alerts carry a campaign's name, spend and budget. They
 * used to be emitted with no recipient, which is a TENANT-wide broadcast
 * (`notifications/emitter.ts`), so in an agency workspace every member saw every
 * client's spend. The audience is now:
 *
 * - the workspace-root org (`isWorkspaceRootPair`): as before — the tenant
 *   audience IS the root org's;
 * - any other org: each member of that org who may act on its campaigns
 *   (`workspace:write`, the route's own predicate `orgScopeGranted`), addressed
 *   by `recipientUserId` — the service-desk SLA precedent;
 * - plus, in a shared workspace, its root admins (they act on every client org,
 *   CP71CD-5), and any `extraSubjects` the caller names (a cap's creator) who
 *   still hold `workspace:write` in the org — each once;
 * - nobody qualifying: the workspace admins (`recipientRole:'admin'`), who can
 *   act on every org, so a spend alert is never silently dropped.
 *
 * A shared `org:` audience in the notifications seam (ADR 0816) would replace
 * this; it is filed, not built here.
 */

import { getNotificationEmitter } from '../../notifications/emitter.js';
import { isWorkspaceRootPair, listMembers } from '../../host/accessControlService.js';
import { orgScopeGranted } from './orgScope.js';
import { materialiseRecipients } from '../../notifications/audience.js';

type Notice = Omit<Parameters<ReturnType<typeof getNotificationEmitter>['emit']>[0], 'tenantId' | 'recipientUserId' | 'recipientRole'>;

/** Emit `notice` to org `orgId`'s audience. Resolves with how many emits
 *  landed; REJECTS only when every emit failed, so a caller that rolls back a
 *  claim on failure (the pacing memo) does so only when nobody was told. */
export async function emitToOrg(tenantId: string, orgId: string, notice: Notice, opts: { extraSubjects?: readonly string[] } = {}): Promise<{ sent: number; failed: number }> {
  const emitter = getNotificationEmitter();
  const metadata = { ...(notice.metadata ?? {}), orgId };
  if (isWorkspaceRootPair(orgId, tenantId)) {
    await emitter.emit({ ...notice, tenantId, metadata });
    return { sent: 1, failed: 0 };
  }
  const recipients = new Set<string>();
  const candidates = [
    ...(await listMembers(tenantId, orgId)).map((m) => m.subject),
    ...((await materialiseRecipients(tenantId, 'admin')) ?? []),
    ...(opts.extraSubjects ?? []),
  ];
  for (const subject of candidates) {
    if (subject && !recipients.has(subject) && (await orgScopeGranted(tenantId, subject, orgId, 'workspace:write'))) recipients.add(subject);
  }
  if (recipients.size === 0) {
    await emitter.emit({ ...notice, tenantId, recipientRole: 'admin', metadata });
    return { sent: 1, failed: 0 };
  }
  let sent = 0;
  let lastError: unknown;
  for (const recipientUserId of [...recipients].sort()) {
    try {
      await emitter.emit({ ...notice, tenantId, recipientUserId, metadata });
      sent += 1;
    } catch (e) {
      lastError = e;
    }
  }
  if (sent === 0) throw lastError instanceof Error ? lastError : new Error('every org alert emit failed');
  return { sent, failed: recipients.size - sent };
}
