/**
 * ADR 0921 D1 — client accounts. A client is a non-root org of the agency
 * workspace plus this record. The org, its members and roles stay owned by
 * `accessControl`; this file adds no second store for any of them.
 *
 * @see docs/adr/0921-campaign-ops-agency-client-accounts.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createOrg, getOrg, isWorkspaceRootPair } from '../../host/accessControlService.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import type { ApprovalPolicyMode, ClientAccount, ClientMode, ClientStatus, ExternalAgentsAccess } from './types.js';
import { NEW_CLIENT_PRESET, bindClientPresetIfAbsent, deleteBindingsForOrg } from '../../host/autonomyPolicy/index.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('campaign-ops-clients');

const clients = new DurableCollection<ClientAccount>(
  'campaign-ops:client',
  (c) => `${c.tenantId}::${c.orgId}`,
  undefined,
  (c) => c.tenantId,
);

const nowIso = (): string => new Date().toISOString();

export async function getClient(tenantId: string, orgId: string): Promise<ClientAccount | null> {
  const c = await clients.get(`${tenantId}::${orgId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function listClients(tenantId: string): Promise<ClientAccount[]> {
  return (await clients.listForTenantIndexed(tenantId))
    .filter((c) => c.tenantId === tenantId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Create a client account. With `orgId`, adopt an existing org of this tenant;
 * without it, create the org. The workspace root can never be a client (it is the
 * agency's own house account, ADR 0921 D1). One record per org.
 */
export async function createClient(input: {
  tenantId: string;
  name: string;
  orgId?: string;
  createdBy: string;
  synthetic?: boolean;
}): Promise<ClientAccount> {
  const displayName = cleanString(input.name, 120, '').trim();
  if (!displayName) throw new OpenwopError('validation_error', 'A client needs a name.', 400, { field: 'name' });
  let orgId = input.orgId;
  if (orgId) {
    const org = await getOrg(orgId);
    if (!org || org.tenantId !== input.tenantId) throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
    if (isWorkspaceRootPair(orgId, input.tenantId)) {
      throw new OpenwopError('validation_error', 'The workspace itself cannot be a client. Create or pick a client organization.', 400, { reason: 'root_org_not_client' });
    }
  } else {
    // The creator owns the new client org, so they can approve its changes and
    // edit its live pages (an exact client-org row; no root fallback is relied on).
    orgId = (await createOrg({ tenantId: input.tenantId, createdBy: input.createdBy, name: displayName, ownerSubject: input.createdBy })).orgId;
  }
  const now = nowIso();
  const row: ClientAccount = {
    tenantId: input.tenantId,
    orgId,
    displayName,
    status: 'active',
    mode: 'preview',
    approvalPolicy: 'agency',
    ...(input.synthetic ? { synthetic: true as const } : {}),
    createdAt: now,
    createdBy: input.createdBy,
    updatedAt: now,
  };
  if (!(await clients.compareAndSwap(null, row))) {
    throw new OpenwopError('conflict', 'This organization is already a client.', 409, { reason: 'client_exists', orgId });
  }
  // ADR 0942 (David, 2026-10-19): a new client starts on Guarded. Written whatever
  // the toggle says (a binding is inert until the autonomy toggle stamps runs), and
  // never over an existing binding. A failed write leaves the client unbound, which
  // resolves to the stricter Review-everything fallback, so it is logged, not thrown.
  try {
    await bindClientPresetIfAbsent(input.tenantId, orgId, NEW_CLIENT_PRESET, input.createdBy);
  } catch (err) {
    log.warn('client_autonomy_default_bind_failed', { orgId, error: err instanceof Error ? err.message : String(err) });
  }
  return row;
}

/** Status / mode / name changes. CAS on the read row; a lost race is a 409. */
export async function updateClient(
  tenantId: string,
  orgId: string,
  patch: { status?: ClientStatus; mode?: ClientMode; name?: string; approvalPolicy?: ApprovalPolicyMode; externalAgents?: ExternalAgentsAccess },
): Promise<ClientAccount | null> {
  const cur = await getClient(tenantId, orgId);
  if (!cur) return null;
  const next: ClientAccount = { ...cur, updatedAt: nowIso() };
  if (patch.status) next.status = patch.status;
  if (patch.mode) next.mode = patch.mode;
  if (patch.approvalPolicy) next.approvalPolicy = patch.approvalPolicy;
  if (patch.externalAgents) next.externalAgents = patch.externalAgents;
  if (patch.name !== undefined) {
    const n = cleanString(patch.name, 120, '').trim();
    if (!n) throw new OpenwopError('validation_error', 'A client needs a name.', 400, { field: 'name' });
    next.displayName = n;
  }
  if (!(await clients.compareAndSwap(cur, next))) {
    throw new OpenwopError('conflict', 'The client changed while you were editing it. Reload and try again.', 409, { reason: 'client_changed' });
  }
  return next;
}

/** ADR 0464 — re-attribute `createdBy` for an erased subject. The account is
 *  the client's configuration, so the row is kept; only the person goes. */
export async function eraseClientCreators(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const c of await listClients(tenantId)) {
    if (!forms.has(c.createdBy)) continue;
    if (await clients.compareAndSwap(c, { ...c, createdBy: tombstone })) n++;
  }
  return n;
}

/** Delete the campaign-ops record of a client (the org itself is accessControl's). */
export async function deleteClient(tenantId: string, orgId: string): Promise<boolean> {
  const deleted = await clients.delete(`${tenantId}::${orgId}`);
  // ADR 0942 — the client's autonomy bindings go with it (deleteOrg refuses a populated org).
  if (deleted) await deleteBindingsForOrg(tenantId, orgId);
  return deleted;
}
