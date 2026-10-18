/**
 * ADR 0879 D1/D3 — the caller's WORKSPACE authority over channels, computed from the
 * request once and passed INTO the service, so every manage/post check (including
 * the scheduled-agent-chats routes that call `assertChannelManage` directly) asks the
 * same two questions:
 *
 *  - `canWrite` — `workspace:write` in the active workspace. Read and post are
 *    different authorities: a Viewer reads, browses, joins and leaves, and writes
 *    nothing (S1 — before this, a Viewer created channels, posted, reacted and started
 *    paid catch-up runs).
 *  - `isAdmin` — `host:members:manage` (admin/owner, or the personal-workspace owner):
 *    the manager of last resort for any channel the admin can see, so a room whose
 *    owner left the workspace (D4) can still be moderated and archived.
 *
 * Both go through `callerHoldsTenantScope`, which reads a credential by provenance and
 * a person by every identity spelling (ADR 0775 D1) — never a raw string compare.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { callerHoldsTenantScope, tenantOf } from '../features/featureRoute.js';

export interface ChannelAuthority {
  canWrite: boolean;
  isAdmin: boolean;
}

export async function channelAuthorityOf(req: Request): Promise<ChannelAuthority> {
  const tenantId = tenantOf(req);
  const [canWrite, isAdmin] = await Promise.all([
    callerHoldsTenantScope(req, tenantId, 'workspace:write'),
    callerHoldsTenantScope(req, tenantId, 'host:members:manage'),
  ]);
  return { canWrite, isAdmin };
}

/** The refusal every gated channel write throws — the same code and body the kanban
 *  and agent-area gates use, so a client renders one message for one problem. */
export function requireChannelWrite(authority: ChannelAuthority): void {
  if (!authority.canWrite) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
}
