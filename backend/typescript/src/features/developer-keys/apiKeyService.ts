/**
 * Self-service scoped API keys (ADR 0270 / CDP-H) — issuance + verification store.
 *
 * Issues per-tenant, scoped, revocable bearer tokens. The plaintext token is shown
 * ONCE at issuance; only its SHA-256 hash is stored (nothing to leak at rest).
 * `verifyApiKey` is the seam the auth middleware will later call (fail-closed:
 * unknown/revoked/expired ⇒ null). This phase ships the store + management +
 * verification PRIMITIVE only; wiring it into `middleware/auth.ts` is a distinct,
 * security-reviewed step (an auth-path change) and is deliberately NOT done here.
 */
import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { OpenwopError } from '../../types.js';

export interface ApiKeyRecord {
  keyId: string;
  tenantId: string;
  name: string;
  scopes: string[];
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** Public projection — never exposes the hash. */
export type ApiKeyPublic = Omit<ApiKeyRecord, 'tokenHash'>;

const keys = new DurableCollection<ApiKeyRecord>('devkey:record', (k) => k.keyId, undefined, (k) => k.tenantId);
// grade-data (ADR 0448 OQ3): tenantId in content + a tenantOf secondary index
// so a tenant purge reclaims these pointers (parity with orgs:invite-hashidx;
// closes the orphan-on-tenant-delete property this index had pre-OQ3). Legacy
// rows written before this carry no tenantId — a harmless dangling pointer
// (verify resolves it to a purged record → null); a backfill is tracked as a
// follow-up rather than run here (disproportionate for fail-closed pointers).
const hashIndex = new DurableCollection<{ key: string; keyId: string; tenantId?: string }>('devkey:hashidx', (r) => r.key, undefined, (r) => r.tenantId ?? '');
const MAX = { name: 120, scopes: 40, perTenant: 100 } as const;

const project = (k: ApiKeyRecord): ApiKeyPublic => {
  const { tokenHash: _omit, ...pub } = k;
  return pub;
};

/** Authz scope for a management call. A self-service caller sees/manages only the
 *  keys they created; an admin|owner sees/manages every key in the tenant. Resolved at
 *  the route boundary (accessControl stays out of this service — coupling). */
export interface KeyScope { callerSubject: string; isAdmin: boolean }

export async function listApiKeys(tenantId: string, scope: KeyScope): Promise<ApiKeyPublic[]> {
  const all = (await keys.listForTenantIndexed(tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // self-service: a non-admin sees only their OWN keys; admin|owner sees all (oversight).
  const visible = scope.isAdmin ? all : all.filter((k) => k.createdBy === scope.callerSubject);
  return visible.map(project);
}

/** Issue a new key. Returns the PLAINTEXT token (shown once) + the public record. */
export async function issueApiKey(input: {
  tenantId: string; name: string; createdBy: string; scopes?: unknown; expiresAt?: string;
}): Promise<{ token: string; key: ApiKeyPublic }> {
  if ((await keys.listForTenantIndexed(input.tenantId)).filter((k) => !k.revokedAt).length >= MAX.perTenant) {
    throw new OpenwopError('validation_error', `at most ${MAX.perTenant} active keys per tenant.`, 400, {});
  }
  const scopes = normalizeScopes(input.scopes);
  // ADR 0448 OQ3 — the host mint (owk_ format is byte-identical to the prior
  // local mint: base64url of 32 CSPRNG bytes, sha256-hex hash → zero change).
  const { raw: token, hash } = mintToken('owk');
  const now = new Date().toISOString();
  const rec: ApiKeyRecord = {
    keyId: `dk:${randomBytes(8).toString('hex')}`,
    tenantId: input.tenantId,
    name: (input.name || 'API key').slice(0, MAX.name),
    scopes,
    tokenHash: hash,
    createdBy: input.createdBy,
    createdAt: now,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  await keys.put(rec);
  await hashIndex.put({ key: rec.tokenHash, keyId: rec.keyId, tenantId: rec.tenantId });
  return { token, key: project(rec) };
}

function normalizeScopes(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'scopes must be an array of strings.', 400, {});
  if (raw.length > MAX.scopes) throw new OpenwopError('validation_error', `at most ${MAX.scopes} scopes.`, 400, {});
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s.trim()) throw new OpenwopError('validation_error', 'each scope must be a non-empty string.', 400, {});
    out.push(s.trim());
  }
  return [...new Set(out)];
}

/**
 * Revoke a key. Scoped: succeeds only if the key is in the caller's tenant AND the
 * caller either created it (self-service) or is an admin|owner (oversight). A key
 * outside that scope returns false → the route maps it to 404 (no existence leak —
 * IDOR-safe, same shape as the cross-tenant miss).
 */
export async function revokeApiKey(tenantId: string, keyId: string, scope: KeyScope): Promise<boolean> {
  const rec = await keys.get(keyId);
  if (!rec || rec.tenantId !== tenantId) return false;
  if (!scope.isAdmin && rec.createdBy !== scope.callerSubject) return false; // not yours + not admin ⇒ 404
  if (rec.revokedAt) return true;
  await keys.put({ ...rec, revokedAt: new Date().toISOString() });
  return true;
}

/**
 * RFC 0170 / `identity.md` §2.2 — was this token a key that has since been
 * REVOKED? The `api-key` lane advertises `revocation: next-request`, so the very
 * next request presenting it must be refused as `credential_revoked`, not as an
 * unknown bearer. Only a revoked record answers true: an unknown, expired or
 * malformed token stays the generic refusal (no existence oracle beyond what the
 * holder of the token already knows).
 */
export async function isRevokedApiKey(token: string): Promise<boolean> {
  if (typeof token !== 'string' || !token.startsWith('owk_')) return false;
  const idx = await hashIndex.get(hashToken(token));
  if (!idx) return false;
  const rec = await keys.get(idx.keyId);
  return Boolean(rec?.revokedAt);
}

/** Resolve a presented token to its record's key id (seam revocation path), or null. */
export async function keyIdOfToken(token: string): Promise<{ keyId: string; tenantId: string } | null> {
  if (typeof token !== 'string' || !token.startsWith('owk_')) return null;
  const idx = await hashIndex.get(hashToken(token));
  if (!idx) return null;
  const rec = await keys.get(idx.keyId);
  return rec ? { keyId: rec.keyId, tenantId: rec.tenantId } : null;
}

/**
 * Verify a presented token (the auth-middleware seam). Fail-closed: returns null
 * for an unknown, revoked, or expired token. On success stamps `lastUsedAt`
 * (best-effort) and returns the public record (tenant + scopes) — NEVER the hash.
 */
export async function verifyApiKey(token: string, now: number = Date.now()): Promise<ApiKeyPublic | null> {
  if (typeof token !== 'string' || !token.startsWith('owk_')) return null;
  const idx = await hashIndex.get(hashToken(token));
  if (!idx) return null;
  const rec = await keys.get(idx.keyId);
  if (!rec || rec.revokedAt) return null;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= now) return null;
  // TOK-D-2 (ADR 0448) — lazy heal: a legacy hashidx pointer written before the
  // tenantId/tenantOf fix carries no tenantId, so a tenant purge can't reclaim
  // it. We already hold `rec` (which has the tenantId) on this hot path, so
  // heal the pointer in place — fire-and-forget, only for the keys actually
  // used, no boot-time full scan. (A pointer whose record was already purged is
  // never reached here; it stays a harmless fail-closed dangling row.)
  if (idx.tenantId === undefined) void hashIndex.put({ ...idx, tenantId: rec.tenantId }).catch(() => {});
  // best-effort last-used stamp (never blocks auth). CAS-guarded against the read:
  // a plain get→put would re-persist this pre-read record and SILENTLY UNDO a
  // concurrent revoke (architect CRITICAL). compareAndSwap no-ops if the stored
  // record changed (e.g. a revoke landed) since `rec` was read.
  void keys.compareAndSwap(rec, { ...rec, lastUsedAt: new Date(now).toISOString() }).catch(() => {});
  return project(rec);
}
