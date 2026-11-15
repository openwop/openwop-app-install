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
import { createLogger } from '../observability/logger.js';
import type { Request } from 'express';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveTenantLevelScopes } from './accessControlService.js';
import { callerSubject, isPersonalTenantId, personalTenantOf } from './requestSubject.js';
import { isSuperadmin } from './superadmin.js';

const log = createLogger('host.assetAccess');

export type AssetAccessMode = 'off' | 'report' | 'enforce';
export type AssetAccessArm = 'operator' | 'session' | 'public';
export type AssetAccessDecision = { allowed: true; arm: AssetAccessArm } | { allowed: false; arm: null };

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

/** Decide one read of `token`, owned by `tenantId`. Never throws for a refusal; a
 *  store error propagates (an unreadable member store is not "you may not"). */
export async function decideAssetRead(req: Request, token: string, tenantId: string): Promise<AssetAccessDecision> {
  if (isOperatorFor(req, tenantId)) return { allowed: true, arm: 'operator' };
  if (await presentInTenant(req, tenantId)) return { allowed: true, arm: 'session' };
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
  return decision.allowed && decision.arm === 'public' ? 'public, max-age=60' : 'private, max-age=300';
}
