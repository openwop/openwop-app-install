/**
 * ADR 0921 D1 — client accounts. A client is a non-root org of the agency
 * workspace plus this record. The org, its members and roles stay owned by
 * `accessControl`; this file adds no second store for any of them.
 *
 * @see docs/adr/0921-campaign-ops-agency-client-accounts.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { randomUUID } from 'node:crypto';
import { createOrg, getOrg, getWorkspace, isWorkspaceRootPair } from '../../host/accessControlService.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import type { ApprovalPolicyMode, ClientAccount, ClientMode, ClientStatus, ExternalAgentsAccess } from './types.js';
import { NEW_CLIENT_PRESET, bindClientPresetIfAbsent, deleteBindingsForOrg } from '../../host/autonomyPolicy/index.js';
import { createLogger } from '../../observability/logger.js';
import { createBrand, listBrands } from '../brand/brandService.js';

const log = createLogger('campaign-ops-clients');

const clients = new DurableCollection<ClientAccount>(
  'campaign-ops:client',
  (c) => `${c.tenantId}::${c.orgId}`,
  undefined,
  (c) => c.tenantId,
);

/**
 * The house-client ADR — the one-house-client-per-workspace claim, keyed by tenant.
 * While `orgId` is absent a creation is in flight under `claimId`; parallel first
 * clicks lose the create-if-absent swap and wait for the winner's org. The
 * `brandKit*` fields make the optional brand-kit copy one-time the same way.
 * Holds ids and times only, no person.
 */
interface HouseClientPointer {
  tenantId: string;
  claimId: string;
  claimedAt: string;
  orgId?: string;
  brandKitClaimId?: string;
  brandKitClaimedAt?: string;
  brandKitBrandId?: string;
}

const housePointers = new DurableCollection<HouseClientPointer>(
  'campaign-ops:house',
  (p) => p.tenantId,
  undefined,
  (p) => p.tenantId,
);

const nowIso = (): string => new Date().toISOString();

export const ROOT_ORG_NOT_CLIENT_MESSAGE = "Your workspace can't be a client itself. Set up your own business as a client instead.";

export async function getClient(tenantId: string, orgId: string): Promise<ClientAccount | null> {
  const c = await clients.get(`${tenantId}::${orgId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** The house client first (the house-client ADR: it leads the switcher), then by name. */
export async function listClients(tenantId: string): Promise<ClientAccount[]> {
  return (await clients.listForTenantIndexed(tenantId))
    .filter((c) => c.tenantId === tenantId)
    .sort((a, b) => Number(b.house === true) - Number(a.house === true) || a.displayName.localeCompare(b.displayName));
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
  /** The house-client ADR: the firm's own business. Honoured only when the org is
   *  created here (no `orgId`), so an adopted org can never be flagged house. */
  house?: boolean;
}): Promise<ClientAccount> {
  const displayName = cleanString(input.name, 120, '').trim();
  if (!displayName) throw new OpenwopError('validation_error', 'A client needs a name.', 400, { field: 'name' });
  let orgId = input.orgId;
  if (orgId) {
    const org = await getOrg(orgId);
    if (!org || org.tenantId !== input.tenantId) throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
    if (isWorkspaceRootPair(orgId, input.tenantId)) {
      // The root stays non-client (ADR 0921 D1, kept by the house-client ADR): with
      // orgId === tenantId every tenant-wide row would read as this client's. The
      // firm's own business is a house client instead, a real sub-org.
      throw new OpenwopError('validation_error', ROOT_ORG_NOT_CLIENT_MESSAGE, 400, { reason: 'root_org_not_client' });
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
    ...(input.house && !input.orgId ? { house: true as const } : {}),
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
  const before = await getClient(tenantId, orgId);
  const deleted = await clients.delete(`${tenantId}::${orgId}`);
  // The house-client ADR — a deleted house client frees the one-per-workspace slot.
  if (deleted && before?.house) {
    const ptr = await housePointers.get(tenantId);
    if (ptr && ptr.orgId === orgId) await housePointers.compareAndDelete(ptr);
  }
  // ADR 0942 — the client's autonomy bindings go with it (deleteOrg refuses a populated org).
  if (deleted) await deleteBindingsForOrg(tenantId, orgId);
  return deleted;
}

// ── The house-client ADR — the firm's own business as a client ──

/** A claim older than this is taken over: its holder crashed mid-create. */
const HOUSE_CLAIM_STALE_MS = 120_000;
/** How long a losing first click waits for the winner's org (50 ms × 100). */
const HOUSE_WAIT_STEP_MS = 50;
const HOUSE_WAIT_STEPS = 100;
/** The name when neither the caller nor the workspace record supplies one. */
const HOUSE_FALLBACK_NAME = 'My business';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const claimIsStale = (at: string | undefined): boolean => {
  const t = at ? Date.parse(at) : Number.NaN;
  return !Number.isFinite(t) || Date.now() - t > HOUSE_CLAIM_STALE_MS;
};

/** The workspace's house client, or null when it has none. */
export async function getHouseClient(tenantId: string): Promise<ClientAccount | null> {
  const ptr = await housePointers.get(tenantId);
  if (!ptr || ptr.tenantId !== tenantId || !ptr.orgId) return null;
  return getClient(tenantId, ptr.orgId);
}

async function houseName(tenantId: string, supplied: string | undefined): Promise<string> {
  const name = cleanString(supplied, 120, '').trim();
  if (name) return name;
  const workspaceName = cleanString((await getWorkspace(tenantId))?.name, 120, '').trim();
  return workspaceName || HOUSE_FALLBACK_NAME;
}

/**
 * "Set up your own business": the house client. A real non-root org created by
 * `createClient` with no `orgId` (so the creator owns it), flagged `house: true`.
 * The root itself is never the client (ADR 0921 D1).
 *
 * One per workspace: the caller first wins a create-if-absent swap on the tenant's
 * pointer, then creates. A caller that loses waits for the winner and returns the
 * winner's client, so two parallel first clicks converge on one org. A repeat
 * returns the existing client with `created: false`.
 */
export async function setUpHouseClient(input: {
  tenantId: string;
  createdBy: string;
  name?: string;
}): Promise<{ client: ClientAccount; created: boolean }> {
  const { tenantId } = input;
  for (let step = 0; step < HOUSE_WAIT_STEPS; step++) {
    const cur = await housePointers.get(tenantId);
    if (cur && cur.tenantId === tenantId && cur.orgId) {
      const existing = await getClient(tenantId, cur.orgId);
      if (existing) return { client: existing, created: false };
      // The house client was deleted: free the slot, then claim it afresh.
      await housePointers.compareAndDelete(cur);
      continue;
    }
    if (cur && !claimIsStale(cur.claimedAt)) {
      await sleep(HOUSE_WAIT_STEP_MS);
      continue;
    }
    const claim: HouseClientPointer = { tenantId, claimId: randomUUID(), claimedAt: nowIso() };
    // Lost: another click holds the slot now. Loop to read and wait for it.
    if (!(await housePointers.compareAndSwap(cur, claim))) continue;
    let client: ClientAccount;
    try {
      client = await createClient({ tenantId, name: await houseName(tenantId, input.name), createdBy: input.createdBy, house: true });
    } catch (err) {
      const mine = await housePointers.get(tenantId);
      if (mine && mine.claimId === claim.claimId && !mine.orgId) await housePointers.compareAndDelete(mine);
      throw err;
    }
    const mine = await housePointers.get(tenantId);
    const settled = mine && mine.claimId === claim.claimId
      && (await housePointers.compareAndSwap(mine, { ...mine, orgId: client.orgId }));
    if (!settled) {
      // Only reachable when a stale-claim takeover raced this create; the other
      // caller's org becomes the house client and this one stays an ordinary row.
      log.warn('house_client_claim_lost', { tenantId, orgId: client.orgId });
    }
    return { client, created: true };
  }
  throw new OpenwopError('conflict', 'Your business is still being set up. Try again in a moment.', 409, { reason: 'house_setup_in_progress' });
}

export type HouseBrandKitOutcome =
  | { copied: true; brandId: string }
  | { copied: false; reason: 'already_copied' | 'house_has_brand' | 'no_workspace_brand' | 'in_progress'; brandId?: string };

function withoutBrandKitClaim(p: HouseClientPointer): HouseClientPointer {
  return {
    tenantId: p.tenantId,
    claimId: p.claimId,
    claimedAt: p.claimedAt,
    ...(p.orgId ? { orgId: p.orgId } : {}),
    ...(p.brandKitBrandId ? { brandKitBrandId: p.brandKitBrandId } : {}),
  };
}

/**
 * "Use your workspace brand kit for it": a ONE-TIME copy of the root org's brand
 * to the house org, written by the brand feature's own `createBrand`. Nothing is
 * linked: later edits to either brand stay separate. Connections are never copied
 * or shared (ADR 0921 D4 pins them per org); the house client connects its own.
 *
 * Refused quietly (`copied: false` with a reason) when it already ran, when the
 * house org has a brand of its own, or when the root has no active brand.
 */
export async function copyWorkspaceBrandKitToHouse(input: { tenantId: string; createdBy: string }): Promise<HouseBrandKitOutcome> {
  const { tenantId } = input;
  const cur = await housePointers.get(tenantId);
  if (!cur || cur.tenantId !== tenantId || !cur.orgId) {
    throw new OpenwopError('not_found', 'Set up your own business first.', 404, { reason: 'no_house_client' });
  }
  const houseOrgId = cur.orgId;
  if (cur.brandKitBrandId) return { copied: false, reason: 'already_copied', brandId: cur.brandKitBrandId };
  if (cur.brandKitClaimId && !claimIsStale(cur.brandKitClaimedAt)) return { copied: false, reason: 'in_progress' };
  if ((await listBrands(tenantId, houseOrgId)).length > 0) return { copied: false, reason: 'house_has_brand' };
  // listBrands sorts newest first, so this is the root's most recently edited active brand.
  const source = (await listBrands(tenantId, tenantId)).find((b) => b.status === 'active');
  if (!source) return { copied: false, reason: 'no_workspace_brand' };
  const claimId = randomUUID();
  if (!(await housePointers.compareAndSwap(cur, { ...cur, brandKitClaimId: claimId, brandKitClaimedAt: nowIso() }))) {
    return { copied: false, reason: 'in_progress' };
  }
  let brandId: string;
  try {
    brandId = (await createBrand(tenantId, houseOrgId, input.createdBy, {
      name: source.name,
      description: source.description,
      voiceProfile: source.voiceProfile,
      positioning: source.positioning,
      keyPhrases: source.keyPhrases,
      channelVoiceRules: source.channelVoiceRules,
      // The root's editor list names root members; the copy starts with none.
      governance: { ...source.governance, allowedEditors: [] },
      ...(source.identity ? { identity: source.identity } : {}),
      ...(source.creativeLocks ? { creativeLocks: source.creativeLocks } : {}),
    })).id;
  } catch (err) {
    const mine = await housePointers.get(tenantId);
    if (mine && mine.brandKitClaimId === claimId) await housePointers.compareAndSwap(mine, withoutBrandKitClaim(mine));
    throw err;
  }
  const mine = await housePointers.get(tenantId);
  if (mine && mine.brandKitClaimId === claimId) {
    await housePointers.compareAndSwap(mine, { ...withoutBrandKitClaim(mine), brandKitBrandId: brandId });
  }
  return { copied: true, brandId };
}
