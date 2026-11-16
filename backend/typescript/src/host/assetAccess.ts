/**
 * ADR 1122 — who may read an asset's bytes at `GET /host/openwop-app/assets/:token`.
 *
 * The token used to be the credential: anyone holding a URL could read the bytes
 * for as long as they existed (a ~100-year backstop TTL), so removing a member or
 * unpublishing a page revoked nothing. The URL stays an identifier, because it is
 * stored in drawings, slides, documents and replayed run events. The decision is
 * made here, when the bytes are read.
 *
 * A read passes on one arm:
 *  - `operator`: superadmin, a wildcard bearer, or an env key bound to the asset's tenant;
 *  - `session`: the person is present in the asset's tenant. A personal tenant
 *    (`user:`/`anon:`) admits only its own owner. Any other tenant admits whoever
 *    `resolveTenantLevelScopes` places there (a workspace member, an API key through
 *    its issuer), keyed on the person, not on the active tenant;
 *  - `public`: a public surface holds a grant on the token (D2.2). This is a point
 *    lookup keyed by token, never a scan; providers write and delete grants (P1).
 * The signed arm (`?exp&sig`, D2.3) lands in P2.
 *
 * Staged by `OPENWOP_ASSET_ACCESS` (D5): `off` (default) serves as before, `report`
 * serves and logs each read that would be refused, and `enforce` refuses with the
 * same 404 an unknown token gets.
 */
import { ASSET_SIGNATURE_PARAM, assetSignatureRemaining } from './assetSigning.js';
import { createLogger } from '../observability/logger.js';
import type { Request } from 'express';
import { DurableCollection } from './hostExtPersistence.js';
import { isMembershipRootedWorkspace, resolveEffectiveAccess, resolveTenantLevelScopes } from './accessControlService.js';
import { callerSubject, isPersonalTenantId, personalTenantOf } from './requestSubject.js';
import { isSuperadmin } from './superadmin.js';

const log = createLogger('host.assetAccess');

export type AssetAccessMode = 'off' | 'report' | 'enforce';
export type AssetAccessArm = 'operator' | 'session' | 'public' | 'signed';
/** `remaining` (seconds) is set for a signed read, so its cache lifetime never outlives the signature. */
export type AssetAccessDecision = { allowed: true; arm: AssetAccessArm; remaining?: number } | { allowed: false; arm: null };

export function assetAccessMode(): AssetAccessMode {
  const v = process.env.OPENWOP_ASSET_ACCESS?.trim().toLowerCase();
  return v === 'report' || v === 'enforce' ? v : 'off';
}

/** D2.2 — one row per (tenant, token): which public surfaces of that tenant reference
 *  it. Keyed by BOTH, so a tenant can only ever write its own rows. Keyed by token
 *  alone (P0), a tenant that put another tenant's token on its own page could write
 *  the row first and block the owner's grant for good. */
interface AssetGrant { key: string; token: string; tenantId: string; grantors: string[] }
const grantKey = (tenantId: string, token: string): string => `${tenantId}|${token}`;
const grants = new DurableCollection<AssetGrant>('asset:grant', (g) => g.key, undefined, (g) => g.tenantId);

/** Apply `change` to the (tenant, token) grantor set under compare-and-swap, so two
 *  surfaces granting or revoking at once never drop each other's entry. A revoke
 *  leaves an empty set rather than deleting the row: a delete cannot be made
 *  conditional, and an unconditional one could remove a grant written in between.
 *  An empty set grants nothing (`hasPublicGrant`). */
async function updateGrant(tenantId: string, token: string, create: boolean, change: (grantors: string[]) => string[]): Promise<void> {
  const key = grantKey(tenantId, token);
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await grants.get(key);
    if (!cur && !create) return; // revoking a grant that never existed
    const grantors = change(cur?.grantors ?? []);
    if (cur && grantors.length === cur.grantors.length && grantors.every((g, i) => g === cur.grantors[i])) return;
    if (await grants.compareAndSwap(cur, { key, token, tenantId, grantors })) return;
  }
  throw new Error(`asset grant for a token stayed contended after 8 attempts`);
}

/** A public surface of `tenantId` (`grantor`, e.g. `cms-page:<id>`) now shows `token`.
 *  Idempotent. A token of another tenant is never admitted by it (`hasPublicGrant`
 *  reads the row under the asset's own tenant). */
export async function grantPublicAsset(tenantId: string, token: string, grantor: string): Promise<void> {
  await updateGrant(tenantId, token, true, (g) => (g.includes(grantor) ? g : [...g, grantor]));
}

/** `grantor` of `tenantId` no longer shows `token`. Idempotent. */
export async function revokePublicAsset(tenantId: string, token: string, grantor: string): Promise<void> {
  await updateGrant(tenantId, token, false, (g) => g.filter((x) => x !== grantor));
}

/**
 * The P0 grant shape (`hostext:asset:grant:<token>`, no tenant in the key) must not
 * outlive P1a: such a row is inert under the `<tenantId>|<token>` lookup, but its
 * presence means a store was written by the P0 build with the switch on, which this
 * ADR forbids (P0's key let one tenant block another's grant). Finds them, says so
 * loudly, and deletes them. Bounded: one page of rows per call.
 */
export async function purgeLegacyGrantRows(storage: { kvListPage?: (p: string, o: { after?: string; limit: number }) => Promise<ReadonlyArray<{ key: string; value: string }>> }): Promise<number> {
  if (!storage.kvListPage) return 0;
  const prefix = 'hostext:asset:grant:';
  const legacy = (await storage.kvListPage(prefix, { limit: 500 })).filter((r) => !r.key.slice(prefix.length).includes('|'));
  if (legacy.length === 0) return 0;
  log.error('asset_access_legacy_grant_rows', {
    count: legacy.length,
    note: 'P0 token-only grant rows found: OPENWOP_ASSET_ACCESS was on before P1a deployed. They are inert and are being deleted.',
  });
  for (const r of legacy) await grants.delete(r.key.slice(prefix.length));
  return legacy.length;
}

async function hasPublicGrant(token: string, tenantId: string): Promise<boolean> {
  const g = await grants.get(grantKey(tenantId, token));
  return g !== null && g.grantors.length > 0;
}

function isOperatorFor(req: Request, tenantId: string): boolean {
  if (isSuperadmin(req) || req.principal?.tenants?.includes('*') === true) return true;
  return req.principal?.auth?.kind === 'env-key' && req.principal.tenants?.includes(tenantId) === true;
}

async function presentInTenant(req: Request, tenantId: string): Promise<boolean> {
  if (isPersonalTenantId(tenantId)) return personalTenantOf(req) === tenantId;
  const subject = callerSubject(req);
  if (!subject) return false;
  return (await resolveTenantLevelScopes(tenantId, subject)).basis !== 'none';
}

/**
 * ADR 1122 D2.1 / P1c — the org that owns an asset, when the asset is a media-library
 * row that names one. A host seam (the host never imports a feature): the media
 * feature registers a point lookup over its own token index, plus one bounded step of
 * a backfill that fills index rows for assets created before the index existed. The
 * asset-grant reconcile drives that backfill.
 */
export interface AssetOrgResolver {
  /** The owning org, or undefined when the token is not a library asset (or is not
   *  indexed yet). A point read only: never a scan on the serve path. */
  orgOf(tenantId: string, token: string): Promise<string | undefined>;
  /** One bounded backfill step. `next` absent means the walk is complete. */
  backfillStep(cursor: string | undefined): Promise<{ next?: string }>;
}
let orgResolver: AssetOrgResolver | null = null;
export function registerAssetOrgResolver(r: AssetOrgResolver): void { orgResolver = r; }
export function assetOrgResolver(): AssetOrgResolver | null { return orgResolver; }

/**
 * D2.1 — a session read of an org-owned library asset also needs the caller's access
 * in that org (`workspace:read`), so a workspace member outside client org X does not
 * see org X's library. These pass without it:
 *  - a personal tenant (one principal);
 *  - an asset that is not a library row, or that belongs to the workspace root;
 *  - a workspace admin (`host:members:manage` on the root of a membership-rooted
 *    workspace, the #5930 org-list exit).
 * A failed index read is retried once, then FAILS CLOSED (the uniform 404) and is
 * logged. Falling back to the tenant floor would reopen, on every store blip, the
 * cross-client read this floor closes. Public-grant reads are unaffected, so
 * published pages keep loading.
 */
async function passesOrgFloor(req: Request, tenantId: string, token: string): Promise<boolean> {
  if (isPersonalTenantId(tenantId) || !orgResolver) return true;
  let orgId: string | undefined;
  try {
    orgId = await orgResolver.orgOf(tenantId, token);
  } catch {
    try {
      orgId = await orgResolver.orgOf(tenantId, token); // one quick retry
    } catch (err) {
      log.error('asset_org_floor_lookup_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  if (!orgId || orgId === tenantId) return true;
  const subject = callerSubject(req);
  if (!subject) return false;
  if (isMembershipRootedWorkspace(tenantId) && (await resolveTenantLevelScopes(tenantId, subject)).scopes.includes('host:members:manage')) return true;
  return (await resolveEffectiveAccess(tenantId, { subject, orgId })).scopes.includes('workspace:read');
}

/** Decide one read of `token`, owned by `tenantId`. Never throws for a refusal; a
 *  store error propagates (an unreadable member store is not "you may not"). */
export async function decideAssetRead(req: Request, token: string, tenantId: string): Promise<AssetAccessDecision> {
  // D2.3 / P2 — a valid signature for exactly this token admits, with no session and no
  // store read. A bad one is ignored here, never an error: the other arms still decide.
  const remaining = assetSignatureRemaining(token, req.query[ASSET_SIGNATURE_PARAM]);
  if (remaining !== null) return { allowed: true, arm: 'signed', remaining };
  if (isOperatorFor(req, tenantId)) return { allowed: true, arm: 'operator' };
  if (await presentInTenant(req, tenantId) && (await passesOrgFloor(req, tenantId, token))) return { allowed: true, arm: 'session' };
  if (await hasPublicGrant(token, tenantId)) return { allowed: true, arm: 'public' };
  return { allowed: false, arm: null };
}

/** Where a refused read came from, for the report log: the referring origin and the
 *  fetch destination. Never the token, the path or a query. */
export function assetReadConsumer(req: Request): { referrerOrigin?: string; dest?: string } {
  const out: { referrerOrigin?: string; dest?: string } = {};
  const ref = req.header('referer');
  if (ref) { try { out.referrerOrigin = new URL(ref).origin; } catch { out.referrerOrigin = 'invalid'; } }
  const dest = req.header('sec-fetch-dest');
  if (dest) out.dest = dest;
  return out;
}

/** D4 — the Cache-Control a served read carries, by the arm that admitted it. */
export function assetCacheControl(decision: AssetAccessDecision): string {
  if (decision.allowed && decision.arm === 'public') return 'public, max-age=60';
  // A signed read is cached no longer than its signature lives.
  if (decision.allowed && decision.arm === 'signed') return `private, max-age=${Math.min(300, decision.remaining ?? 0)}`;
  return 'private, max-age=300';
}
