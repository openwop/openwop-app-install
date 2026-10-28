/**
 * ADR 0944 D2 — which CLIENT org a run is for, read for agent memory.
 *
 * Two host-written stamps name a client on a run, and only these two:
 *  - the ADR 0941 D2b run tag, `metadata.campaignOrchestration.orgId`;
 *  - the ADR 0921 campaign-ops stamp, `metadata['openwop-app.campaignOps'].orgId`,
 *    for a client run that belongs to no campaign.
 * Both keys are in `CAMPAIGN_ATTRIBUTION_KEYS` (`runDispatch.ts`), so they are
 * stripped from caller metadata and only feature services write them; `:fork`
 * copies them verbatim, so a replay resolves the same org. Where both are present
 * they must name the same org, or the binding is refused `wrong_client`
 * (ADR 0941 D2b). The keys are read here, not imported from the features that
 * write them, because host code never depends up into a feature.
 *
 * The org is then checked against the person behind the run with
 * `assertRunScopeOrg` (`workspace:read`): the acting user, else the member who
 * caused it. An actorless run (a schedule) carries no person and is trusted on
 * its host-written stamp, as KB and media are (ADR 0832); the org must still
 * exist in this tenant. Authorization is live, never frozen: a fork whose actor
 * lost access to the client reads no client memory.
 *
 * Returns `undefined` when the run is for no client. A failure is a refusal,
 * which the memory resolver turns into the fail-closed sentinel — never another
 * scope.
 */
import { assertOrgScope, assertRunScopeOrg, getOrg } from './accessControlService.js';
import { OpenwopError } from '../types.js';
import { hostExtStorage } from './hostExtPersistence.js';
import type { AgentMemoryScopeContext } from './agentMemoryAdapter.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runClientOrg');

/** The run-metadata keys that can name a client (see the module docblock). */
export const RUN_CLIENT_STAMP_KEYS = ['campaignOrchestration', 'openwop-app.campaignOps'] as const;

function orgIdIn(block: unknown): string | undefined {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const v = (block as Record<string, unknown>)['orgId'];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** The client named by a run's metadata, before any access check. */
export function runClientStamp(metadata: Record<string, unknown> | undefined): { orgId: string } | { refused: 'wrong_client' | 'unreadable' } | undefined {
  if (!metadata) return undefined;
  const named = new Set<string>();
  for (const key of RUN_CLIENT_STAMP_KEYS) {
    if (metadata[key] === undefined) continue;
    const orgId = orgIdIn(metadata[key]);
    if (!orgId) return { refused: 'unreadable' };
    named.add(orgId);
  }
  if (named.size === 0) return undefined;
  if (named.size > 1) return { refused: 'wrong_client' };
  return { orgId: [...named][0]! };
}

/** The client binding for agent memory on one run (ADR 0944 D2, run lane). */
export async function resolveRunMemoryClient(scope: {
  tenantId: string;
  runId: string;
  actingUserId?: string | undefined;
  orgScopeSubject?: string | undefined;
}): Promise<AgentMemoryScopeContext['client']> {
  let metadata: Record<string, unknown> | undefined;
  try {
    const run = await hostExtStorage().getRun(scope.runId);
    if (!run || run.tenantId !== scope.tenantId) return { refused: 'unreadable' };
    metadata = run.metadata as Record<string, unknown> | undefined;
  } catch (err) {
    // An unreadable run might have been a client run: refuse rather than fall
    // through to the profile's own (possibly shared) scope.
    log.warn('run_client_stamp_unreadable', { tenantId: scope.tenantId, runId: scope.runId, error: err instanceof Error ? err.message : String(err) });
    return { refused: 'unreadable' };
  }
  const stamp = runClientStamp(metadata);
  if (!stamp || 'refused' in stamp) return stamp;
  try {
    const org = await getOrg(stamp.orgId);
    if (!org || org.tenantId !== scope.tenantId) return { refused: 'forbidden' };
    await assertRunScopeOrg(scope, stamp.orgId, 'workspace:read');
  } catch (err) {
    log.info('run_client_memory_refused', { tenantId: scope.tenantId, runId: scope.runId, orgId: stamp.orgId, error: err instanceof Error ? err.message : String(err) });
    return { refused: 'forbidden' };
  }
  return stamp;
}

/** The run-metadata block that names a client on a run that belongs to no
 *  campaign (ADR 0941 D2b designates the ADR 0921 campaign-ops key for that).
 *  Host code that starts a client run on someone's behalf — a deep @mention from
 *  a client-bound conversation (ADR 0944 D2) — writes it through this helper so
 *  the key is named in one place. Its readers only narrow: the memory binding
 *  above, and campaign-ops' `wrong_client` check. */
export function clientRunStamp(orgId: string): Record<string, { orgId: string }> {
  return { [RUN_CLIENT_STAMP_KEYS[1]]: { orgId } };
}

/**
 * ADR 0944 D2 — may `userId` bind a conversation to client `orgId`? The org must
 * be a non-root org of this tenant and the person must hold `workspace:read` on
 * it. Throws the canonical 404/403; returns the org's name for the display chip.
 */
export async function assertClientBindable(tenantId: string, userId: string | undefined, orgId: string): Promise<{ name: string }> {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId || orgId === tenantId) {
    throw new OpenwopError('not_found', 'Client not found.', 404, { clientOrgId: orgId });
  }
  if (!userId) throw new OpenwopError('forbidden_scope', 'Binding a conversation to a client needs a signed-in person.', 403, { reason: 'no_acting_user' });
  await assertOrgScope(tenantId, userId, orgId, 'workspace:read');
  return { name: org.name };
}

/**
 * ADR 0944 D2 — the client binding for agent memory on one CHAT turn. The
 * conversation's `client` was checked once at creation; this re-checks it live
 * for the person speaking now (a member may have lost the client since, or a
 * participant may never have had it). No speaker ⇒ refused. Never throws.
 */
export async function resolveConversationMemoryClient(
  tenantId: string,
  clientOrgId: string | undefined,
  callerUserId: string | undefined,
): Promise<AgentMemoryScopeContext['client']> {
  if (!clientOrgId) return undefined;
  if (!callerUserId) return { refused: 'forbidden' };
  try {
    const org = await getOrg(clientOrgId);
    if (!org || org.tenantId !== tenantId) return { refused: 'forbidden' };
    await assertOrgScope(tenantId, callerUserId, clientOrgId, 'workspace:read');
    return { orgId: clientOrgId };
  } catch (err) {
    log.info('conversation_client_memory_refused', { tenantId, orgId: clientOrgId, error: err instanceof Error ? err.message : String(err) });
    return { refused: 'forbidden' };
  }
}
