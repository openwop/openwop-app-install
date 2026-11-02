/**
 * ADR 0975 D11 — a participant may chat with KickBot in the shared participant
 * workspace, and that is all the grant admits.
 *
 * MEASURED on kicktodo.com (2026-10-31 13:25:23Z, rev 00065-dmc): a participant
 * sent their first chat message in `host-kicktodo` and got `forbidden: Missing
 * required scope: runs:create`. Every participant there is an auto-join `viewer`
 * (ADR 0684), a chat turn is a run of the conversation workflow, and authorization
 * enforcement has been on since 2026-10-26. D8 opened the Challenge Author chat for
 * the operator only, so the guide the chat welcome offers every participant
 * ("@KickBot") was shut for all of them.
 *
 * The two predicates mirror D8's:
 *  - START: a conversation the caller asks to scope to KickBot
 *    (`metadata.agentScope`), in KickTodo's own declared default workspace, by a
 *    current ROOT member there, with `kicktodo-core` enabled. The host stamps it.
 *  - CONTINUE: a run carrying THIS stamp, owned by the caller, who is still a root
 *    member, and a turn addressed to KickBot (or a non-exchange operation on the
 *    caller's own KickBot conversation, e.g. `close` or an ask-first card). A
 *    `bypass` permission mode is refused.
 * The viewer role is unchanged. Any other agent, an unscoped chat, another
 * workspace, or someone else's run still needs the tenant-wide scopes, and a
 * narrowed `owk_` key is never widened (`grantMayStandIn` refuses the key lane
 * before either predicate is asked).
 */
import type { Request } from 'express';
import type { RunRecord } from '../../types.js';
import { callerSubject } from '../../host/requestSubject.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { declaredDefaultWorkspaceTargets } from '../../host/workspaceJoinLedger.js';
import { RUN_START_GRANT_METADATA_KEY, type RunStartRequest, type RunStartStamp } from '../../host/runStartGrant.js';
import { parseResolveBody } from '../../host/exchange/validateTurn.js';
import { isRunOwnedBy } from '../../host/runOwner.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import { KICKBOT_AGENT_ID } from './kickbotService.js';

export const KICKBOT_CHAT_GRANT = 'kicktodo-kickbot';
const FEATURE_ID = 'kicktodo-core';

/** KickTodo's own declared participant workspace, never any other default. */
function isKicktodoParticipantWorkspace(tenantId: string): boolean {
  return declaredDefaultWorkspaceTargets().some((t) => t.featureId === FEATURE_ID && t.tenantId === tenantId);
}

/** A current ROOT member of the workspace (the auto-join row's shape). */
async function isRootMember(tenantId: string, subject: string): Promise<boolean> {
  return (await resolveEffectiveAccess(tenantId, { subject, orgId: tenantId })).basis === 'member';
}

export async function kickbotChatStartGrant(req: Request, start: RunStartRequest): Promise<RunStartStamp | null> {
  if (start.metadata.agentScope !== KICKBOT_AGENT_ID) return null;
  if (!isKicktodoParticipantWorkspace(start.tenantId)) return null;
  const subject = callerSubject(req);
  if (!subject || !(await isRootMember(start.tenantId, subject))) return null;
  await requireFeatureEnabled(req, FEATURE_ID, 'KickTodo'); // throws → the grant refuses
  return { grant: KICKBOT_CHAT_GRANT, agentId: KICKBOT_AGENT_ID };
}

export async function kickbotChatTurnGrant(req: Request, run: RunRecord): Promise<boolean> {
  const stamp = (run.metadata as Record<string, unknown> | undefined)?.[RUN_START_GRANT_METADATA_KEY] as Partial<RunStartStamp> | undefined;
  if (stamp?.grant !== KICKBOT_CHAT_GRANT || stamp.agentId !== KICKBOT_AGENT_ID) return false;
  if (!isKicktodoParticipantWorkspace(run.tenantId)) return false;
  const subject = callerSubject(req);
  if (!subject || !isRunOwnedBy(run, subject)) return false;
  const turn = parseResolveBody((req.body as { resumeValue?: unknown } | undefined)?.resumeValue);
  if (turn.operation === 'exchange' && (turn.to !== KICKBOT_AGENT_ID || turn.exchangePermissionMode === 'bypass')) return false;
  return isRootMember(run.tenantId, subject);
}
