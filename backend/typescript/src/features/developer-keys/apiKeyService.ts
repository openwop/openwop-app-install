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
import { hashToken } from '../../host/capabilityToken.js';
import { OpenwopError } from '../../types.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { appendAudit } from '../../host/auditChainService.js';
import { erasedSubjectIssued, registerDelegationLookup, registerIssuerRemovedHandler, registerSubjectErasedHandler, registerSubjectRekeyedHandler, type ErasedSubject } from '../../host/delegatedSubject.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';

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
  /** ADR 0798 D8 — set when the revocation was not the owner's own act. */
  revokedReason?: 'leaked' | 'issuer-removed' | 'issuer-erased';
  lastUsedAt?: string;
  /** ADR 0795 D4 — when the issuer was told this key is about to expire. */
  expiryNoticeAt?: string;
  /** ADR 0798 — `owk_XXXX…YYYY`: enough to match a found key to its row, never enough to use. */
  hint?: string;
  /** ADR 0798 — where the key was last presented from (five-minute resolution, with `lastUsedAt`). */
  lastUsedIp?: string;
  lastUsedAgent?: string;
  /** ADR 0798 — rotation: the key this one replaced / was replaced by. */
  rotatedFrom?: string;
  rotatedTo?: string;
}

/** Where a key was just presented from. Optional: not every verifier has a request. */
export interface KeyUseContext { ip?: string; userAgent?: string }

/**
 * ADR 0798 D8 — the key format, and why it has a checksum.
 *
 *   owk_<43 base64url chars: 32 CSPRNG bytes>_<6 base64url chars: CRC-32 of everything before it>
 *
 * The checksum is public arithmetic, not a secret. It lets anything that finds a
 * candidate string — a secret scanner, this host's own leak endpoint, the auth
 * path — tell a real key from a look-alike WITHOUT a store lookup, so a scanner
 * reports few false positives and a typo is refused before it costs a read. Keys
 * minted before this (`owk_` + 43 chars, no suffix) stay valid for as long as
 * they live.
 */
const KEY_BODY = '[A-Za-z0-9_-]{43}';
const LEGACY_KEY = new RegExp(`^owk_${KEY_BODY}$`);
const CHECKED_KEY = new RegExp(`^(owk_${KEY_BODY})_([A-Za-z0-9_-]{6})$`);
/** What a secret scanner should match (the checksummed form only). */
export const API_KEY_SCAN_PATTERN = `owk_${KEY_BODY}_[A-Za-z0-9_-]{6}`;

const CRC_TABLE: readonly number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
function crc32(text: string): number {
  let c = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function checksumOf(prefixAndBody: string): string {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(crc32(prefixAndBody));
  return b.toString('base64url');
}

/** Mint a checksummed key. The whole string is the secret that is hashed and presented. */
function mintApiKeyToken(): { raw: string; hash: string } {
  const head = `owk_${randomBytes(32).toString('base64url')}`;
  const raw = `${head}_${checksumOf(head)}`;
  return { raw, hash: hashToken(raw) };
}

/** Is this string shaped like a key this host could have issued? No store read. */
export function isWellFormedApiKey(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  if (LEGACY_KEY.test(token)) return true;
  const m = CHECKED_KEY.exec(token);
  return m !== null && checksumOf(m[1]!) === m[2];
}

/** ADR 0798 — `owk_` + the first four and last four characters of the secret part. */
export function keyHintOf(token: string): string {
  const body = token.startsWith('owk_') ? token.slice(4) : token;
  return `owk_${body.slice(0, 4)}…${body.slice(-4)}`;
}

/**
 * ADR 0795 D4 — an expiry that does not PARSE is expired. `Date.parse('tomorrow')`
 * is NaN and `NaN <= now` is false, so the old comparison read an unparseable
 * expiry as "never expires".
 */
export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= now;
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
const LAST_USED_RESOLUTION_MS = 5 * 60_000;
const EXPIRY_NOTICE_WINDOW_MS = 14 * 86_400_000;

/**
 * ADR 0795 D4 — a default lifetime only works if expiry is not a surprise. A key
 * that is STILL IN USE inside its last 14 days tells its issuer once, in the
 * inbox. Triggered by use, not by a sweep: the keys worth warning about are
 * exactly the ones something is still calling with. The stable id makes a
 * re-send (a lost swap, a second instance) the same notification.
 */
async function sendExpiryNotice(rec: ApiKeyRecord): Promise<void> {
  // The inbox is keyed by user id. A key issued by an unbound `oidc:` subject
  // or an operator env key has no inbox to reach; the tab still shows the date.
  if (!rec.createdBy.startsWith('user:')) return;
  try {
    await getNotificationEmitter().emit({
      notificationId: `apikey-expiring-${rec.keyId.replace(/[^a-zA-Z0-9]/g, '-')}`,
      tenantId: rec.tenantId,
      recipientUserId: rec.createdBy,
      type: 'apikey.expiring',
      priority: 'normal',
      title: `API key “${rec.name}” expires soon`,
      message: `It expires on ${rec.expiresAt!.slice(0, 10)} and is still in use. Create a replacement before then so nothing that depends on it stops.`,
      actionUrl: '/access?tab=api-keys',
    });
  } catch {
    // No notification backend (a service-level test) or a refused effect: the
    // tab still shows the date, so the notice is a courtesy, never a dependency.
  }
}

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
/**
 * ADR 0833 D2 — a break-glass session is a 10-minute, non-refreshing,
 * single-use emergency grant; an `owk_` key minted under it would outlive the
 * window by months. Refused at the MINT, not at a route: the CLI-login and
 * Claude Code pairing lanes mint at POLL time, with no request whose caller
 * could be asked (review B5). Routes call it too, for a readable early 403.
 */
export function assertMayIssueDurableKey(issuer: string): void {
  if (issuer.startsWith('breakglass:')) {
    throw new OpenwopError(
      'forbidden',
      'A break-glass session cannot create or rotate API keys. Sign in normally to manage keys.',
      403,
      { code: 'break_glass_cannot_mint' },
    );
  }
}

export async function issueApiKey(input: {
  tenantId: string; name: string; createdBy: string; scopes?: unknown; expiresAt?: string;
  rotatedFrom?: string;
}): Promise<{ token: string; key: ApiKeyPublic }> {
  assertMayIssueDurableKey(input.createdBy);
  // ADR 0823 — an `owk_` key resolves to `tenants: [key.tenantId]`, and `'*'` is the
  // operator WILDCARD (cross-tenant launch, read and run access). Only an operator
  // writes that, in OPENWOP_API_KEYS; a self-service key must never carry it.
  if (input.tenantId === '*') throw new OpenwopError('validation_error', 'a self-service key cannot be cross-tenant.', 400, {});
  void purgeDeadKeys(input.tenantId).catch(() => {});
  if ((await keys.listForTenantIndexed(input.tenantId)).filter((k) => !k.revokedAt).length >= MAX.perTenant) {
    throw new OpenwopError('validation_error', `at most ${MAX.perTenant} active keys per tenant.`, 400, {});
  }
  const scopes = normalizeScopes(input.scopes);
  // ADR 0448 OQ3 — the host mint (owk_ format is byte-identical to the prior
  // local mint: base64url of 32 CSPRNG bytes, sha256-hex hash → zero change).
  const { raw: token, hash } = mintApiKeyToken();
  const now = new Date().toISOString();
  const rec: ApiKeyRecord = {
    keyId: `dk:${randomBytes(8).toString('hex')}`,
    tenantId: input.tenantId,
    name: (input.name || 'API key').slice(0, MAX.name),
    scopes,
    tokenHash: hash,
    createdBy: input.createdBy,
    createdAt: now,
    hint: keyHintOf(token),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
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
  if (!isWellFormedApiKey(token)) return false;
  const idx = await hashIndex.get(hashToken(token));
  if (!idx) return false;
  const rec = await keys.get(idx.keyId);
  return Boolean(rec?.revokedAt);
}

/** Resolve a presented token to its record's key id (seam revocation path), or null. */
export async function keyIdOfToken(token: string): Promise<{ keyId: string; tenantId: string } | null> {
  if (!isWellFormedApiKey(token)) return null;
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
export async function verifyApiKey(token: string, now: number = Date.now(), use: KeyUseContext = {}): Promise<ApiKeyPublic | null> {
  if (!isWellFormedApiKey(token)) return null;
  const idx = await hashIndex.get(hashToken(token));
  if (!idx) return null;
  const rec = await keys.get(idx.keyId);
  if (!rec || rec.revokedAt) return null;
  if (isExpired(rec.expiresAt, now)) return null;
  // ADR 0823 — belt to the mint's braces: a stored `'*'` row (however it got
  // there) never authenticates, so an `owk_` key can never be a wildcard principal.
  if (rec.tenantId === '*') return null;
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
  //
  // ADR 0795 — throttled: a store write on EVERY authenticated request bought
  // nothing a five-minute resolution does not. And the same swap carries the
  // one-time expiry notice, so the two never race each other from one base.
  const stale = !rec.lastUsedAt || now - Date.parse(rec.lastUsedAt) >= LAST_USED_RESOLUTION_MS;
  const noticeDue = rec.expiresAt !== undefined && rec.expiryNoticeAt === undefined
    && Date.parse(rec.expiresAt) - now <= EXPIRY_NOTICE_WINDOW_MS;
  if (stale || noticeDue) {
    const stamp = new Date(now).toISOString();
    const next: ApiKeyRecord = {
      ...rec,
      lastUsedAt: stamp,
      ...(use.ip ? { lastUsedIp: use.ip } : {}),
      ...(use.userAgent ? { lastUsedAgent: use.userAgent.slice(0, 120) } : {}),
      ...(noticeDue ? { expiryNoticeAt: stamp } : {}),
    };
    void keys.compareAndSwap(rec, next)
      .then((swapped) => (swapped && noticeDue ? sendExpiryNotice(next) : undefined))
      .catch(() => {});
  }
  return project(rec);
}

/**
 * ADR 0795 D1 — the delegation behind `apikey:<keyId>`, for the feature-free
 * authority resolvers. A revoked, expired or unknown key has none. Registered at
 * module load: anything that can mint or verify a key has imported this file.
 */
registerDelegationLookup(async (keyId) => {
  const rec = await keys.get(keyId);
  if (!rec || rec.revokedAt || isExpired(rec.expiresAt, Date.now())) return null;
  return { id: rec.keyId, issuer: rec.createdBy, tenantId: rec.tenantId, declaredScopes: rec.scopes };
});

/**
 * ADR 0795 D6 — revoke every live key `subject` issued in `tenantId`. Called
 * when the subject loses its last membership there. Revoked, not suspended: a
 * credential that comes back to life when someone is re-added is a surprise.
 */
export async function revokeKeysIssuedBy(tenantId: string, subject: string): Promise<number> {
  let n = 0;
  for (const rec of await keys.listForTenantIndexed(tenantId)) {
    if (rec.createdBy !== subject || rec.revokedAt) continue;
    await keys.put({ ...rec, revokedAt: new Date().toISOString(), revokedReason: 'issuer-removed' });
    n += 1;
  }
  return n;
}
registerIssuerRemovedHandler(async (tenantId, subject) => {
  const n = await revokeKeysIssuedBy(tenantId, subject);
  // ADR 0798 — on the audit chain: keys that stop because their owner left are
  // the ones somebody will ask about later.
  if (n > 0) await appendAudit(tenantId, 'apikey.revoked', { reason: 'issuer-removed', issuer: subject, count: n }).catch(() => undefined);
});

/**
 * ADR 0795 D6 — a subject was rekeyed (`oidc:<sub>` → `user:<id>`). Move the
 * keys it issued to the new spelling so they still resolve to the same person.
 * A full list: this runs once per account, at bind, not on a request path.
 */
export async function rekeyIssuedKeys(fromSubject: string, toSubject: string, tenantId?: string): Promise<number> {
  let n = 0;
  // CE-15 — scoped like the membership rekey that triggers it: a tenant-resolved
  // rekey must not reassign another tenant's keys issued under the same string.
  for (const rec of tenantId === undefined ? await keys.list() : await keys.listForTenantIndexed(tenantId)) {
    if (rec.createdBy !== fromSubject) continue;
    if (tenantId !== undefined && rec.tenantId !== tenantId) continue;
    await keys.put({ ...rec, createdBy: toSubject });
    n += 1;
  }
  return n;
}
registerSubjectRekeyedHandler(async (from, to, scope) => { await rekeyIssuedKeys(from, to, scope.tenantId); });

/**
 * ADR 0833 D7 — a deleted account's keys are revoked in EVERY tenant, under
 * every spelling it issued as. One global scan (the `rekeyIssuedKeys` shape):
 * it runs once per account deletion, never on a request path. Matched by
 * `erasedSubjectIssued` (the bare principal only in the home tenant). Revoked, not
 * deleted — the deleting tenant's DSAR eraser already deletes its own rows;
 * another tenant's audit trail keeps the record of a key that existed.
 */
export async function revokeKeysIssuedByAnyTenant(subject: ErasedSubject): Promise<number> {
  let n = 0;
  for (const rec of await keys.list()) {
    if (rec.revokedAt || !erasedSubjectIssued(subject, rec.createdBy, rec.tenantId)) continue;
    await keys.put({ ...rec, revokedAt: new Date().toISOString(), revokedReason: 'issuer-erased' });
    n += 1;
    await appendAudit(rec.tenantId, 'apikey.revoked', { reason: 'issuer-erased', keyId: rec.keyId }).catch(() => undefined);
  }
  return n;
}
registerSubjectErasedHandler(async (subject) => { await revokeKeysIssuedByAnyTenant(subject); });

/**
 * ADR 0464 / ADR 0795 D6 — the DSAR eraser. An erased subject's keys are
 * DELETED, record and hash pointer both: a revoked row would keep `createdBy`
 * and the key's name, which are the subject's.
 */
export async function eraseDeveloperKeysForSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const rec of await keys.listForTenantIndexed(tenantId)) {
    if (!forms.has(rec.createdBy)) continue;
    await hashIndex.delete(rec.tokenHash).catch(() => false);
    await keys.delete(rec.keyId);
  }
}

// ── ADR 0798 — rotation, retention, inventory, workspace policy ──────────────

const DAY_MS = 86_400_000;
function envInt(name: string, fallback: number, min = 0): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Rotate: issue a replacement with the SAME name and scopes, and
 * give the old key a bounded overlap (`OPENWOP_API_KEY_ROTATION_OVERLAP_HOURS`,
 * default 24) instead of ending it at once — so a deployment can be switched
 * over without a gap, and cannot be left on the old key indefinitely. The old
 * key's expiry is only ever brought FORWARD. Same authz as revoke: yours, or
 * you are an admin; anything else is `null` (the route's 404).
 */
export async function rotateApiKey(
  tenantId: string,
  keyId: string,
  scope: KeyScope,
  opts: { expiresAt?: string; rotatedBy: string; now?: number } ,
): Promise<{ token: string; key: ApiKeyPublic; previous: ApiKeyPublic } | null> {
  const now = opts.now ?? Date.now();
  const rec = await keys.get(keyId);
  if (!rec || rec.tenantId !== tenantId) return null;
  if (!scope.isAdmin && rec.createdBy !== scope.callerSubject) return null;
  if (rec.revokedAt || isExpired(rec.expiresAt, now)) {
    throw new OpenwopError('conflict', 'This key is no longer active; create a new one instead of rotating it.', 409, { keyId });
  }
  if (rec.rotatedTo) {
    throw new OpenwopError('conflict', 'This key was already rotated; rotate its replacement.', 409, { keyId, rotatedTo: rec.rotatedTo });
  }
  const issued = await issueApiKey({
    tenantId,
    name: rec.name,
    // The replacement belongs to whoever owned the original, not to an admin
    // who rotated it on their behalf.
    createdBy: rec.createdBy,
    scopes: rec.scopes,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    rotatedFrom: rec.keyId,
  });
  const overlapEnd = now + envInt('OPENWOP_API_KEY_ROTATION_OVERLAP_HOURS', 24) * 3_600_000;
  const oldEnd = rec.expiresAt !== undefined ? Math.min(Date.parse(rec.expiresAt), overlapEnd) : overlapEnd;
  const previous: ApiKeyRecord = { ...rec, expiresAt: new Date(oldEnd).toISOString(), rotatedTo: issued.key.keyId };
  // CAS against the row we read: a revoke that landed meanwhile must not be undone.
  if (!(await keys.compareAndSwap(rec, previous))) {
    await keys.delete(issued.key.keyId);
    throw new OpenwopError('conflict', 'This key changed while it was being rotated. Try again.', 409, { keyId });
  }
  return { token: issued.token, key: issued.key, previous: project(previous) };
}

/**
 * Retention: a revoked or expired key is kept for
 * `OPENWOP_API_KEY_RETENTION_DAYS` (default 90) — long enough to answer "what
 * was that key?" after an incident — and then deleted, record and hash pointer.
 * Called opportunistically at mint; never on the authentication path.
 */
export async function purgeDeadKeys(tenantId: string, now: number = Date.now()): Promise<number> {
  const cutoff = now - envInt('OPENWOP_API_KEY_RETENTION_DAYS', 90, 1) * DAY_MS;
  let n = 0;
  for (const rec of await keys.listForTenantIndexed(tenantId)) {
    const deadAt = rec.revokedAt !== undefined ? Date.parse(rec.revokedAt)
      : rec.expiresAt !== undefined && isExpired(rec.expiresAt, now) ? Date.parse(rec.expiresAt) : NaN;
    // An unparseable expiry has no date to age from: fall back to creation.
    const since = Number.isNaN(deadAt) ? (rec.revokedAt !== undefined || isExpired(rec.expiresAt, now) ? Date.parse(rec.createdAt) : NaN) : deadAt;
    if (Number.isNaN(since) || since > cutoff) continue;
    await hashIndex.delete(rec.tokenHash).catch(() => false);
    await keys.delete(rec.keyId);
    n += 1;
  }
  return n;
}

/** One row of the host-wide inventory: shapes only — no names, no hashes, no hints. */
export interface KeyInventoryRow {
  keyId: string;
  tenantShape: 'personal' | 'anon' | 'shared' | 'default' | 'named';
  issuerShape: 'user' | 'oidc' | 'operator' | 'key' | 'other';
  declaration: 'undeclared' | 'wildcard' | 'narrowed';
  expiry: 'none' | 'valid' | 'expired' | 'unparseable';
  revoked: boolean;
  usedInLast30Days: boolean;
}

/**
 * ADR 0798 (`KEY-11`) — every key on the host, by SHAPE. For a superadmin
 * auditing what exists: how many keys declare nothing, never expire, or were
 * issued by another key (the ADR 0800 hole). A full scan by design; this is an
 * operator's read, never a request-path one.
 */
export async function inventoryApiKeys(now: number = Date.now()): Promise<{ total: number; rows: KeyInventoryRow[]; counts: Record<string, number> }> {
  const rows: KeyInventoryRow[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };
  for (const rec of await keys.list()) {
    const t = rec.tenantId;
    const row: KeyInventoryRow = {
      keyId: rec.keyId,
      tenantShape: t.startsWith('user:') ? 'personal' : t.startsWith('anon:') ? 'anon' : t.startsWith('ws:') ? 'shared' : t === 'default' ? 'default' : 'named',
      issuerShape: rec.createdBy.startsWith('user:') ? 'user' : rec.createdBy.startsWith('oidc:') ? 'oidc'
        : rec.createdBy.startsWith('bearer:') ? 'operator' : rec.createdBy.startsWith('apikey:') ? 'key' : 'other',
      declaration: rec.scopes.length === 0 ? 'undeclared' : rec.scopes.includes('*') ? 'wildcard' : 'narrowed',
      expiry: rec.expiresAt === undefined ? 'none' : Number.isNaN(Date.parse(rec.expiresAt)) ? 'unparseable' : isExpired(rec.expiresAt, now) ? 'expired' : 'valid',
      revoked: rec.revokedAt !== undefined,
      usedInLast30Days: rec.lastUsedAt !== undefined && now - Date.parse(rec.lastUsedAt) <= 30 * DAY_MS,
    };
    rows.push(row);
    if (!row.revoked && row.expiry !== 'expired' && row.expiry !== 'unparseable') {
      bump('live');
      bump(`live.declaration.${row.declaration}`);
      bump(`live.issuer.${row.issuerShape}`);
      bump(`live.expiry.${row.expiry}`);
      bump(`live.tenant.${row.tenantShape}`);
    }
  }
  return { total: rows.length, rows, counts };
}

/** ADR 0798 — what a workspace's admins have decided about keys in it. */
export interface TenantKeyPolicy {
  tenantId: string;
  /** Kill switch: no key authenticates in this workspace and none can be created. */
  disabled?: boolean;
  /** A tighter lifetime cap than the deployment's (never a looser one). */
  maxLifetimeDays?: number;
  updatedBy?: string;
  updatedAt?: string;
}
const tenantPolicies = new DurableCollection<TenantKeyPolicy>('devkey:policy', (p) => p.tenantId, undefined, (p) => p.tenantId);

export async function getTenantKeyPolicy(tenantId: string): Promise<TenantKeyPolicy> {
  return (await tenantPolicies.get(tenantId)) ?? { tenantId };
}

export async function setTenantKeyPolicy(tenantId: string, patch: { disabled?: boolean; maxLifetimeDays?: number | null }, updatedBy: string): Promise<TenantKeyPolicy> {
  const prev = await getTenantKeyPolicy(tenantId);
  const next: TenantKeyPolicy = { tenantId, updatedBy, updatedAt: new Date().toISOString() };
  const disabled = patch.disabled ?? prev.disabled;
  if (disabled) next.disabled = true;
  const max = patch.maxLifetimeDays === null ? undefined : patch.maxLifetimeDays ?? prev.maxLifetimeDays;
  if (max !== undefined) next.maxLifetimeDays = max;
  await tenantPolicies.put(next);
  return next;
}

// ── ADR 0798 D8 — a key reported as leaked ───────────────────────────────────

/**
 * Revoke every LIVE key among `tokens`, and say which strings were keys at all.
 *
 * Callable without authentication, deliberately: holding the full secret is the
 * only thing this needs, and anyone holding it could use the key — letting them
 * revoke it instead can only help. It is not a validity oracle beyond that: the
 * caller already has the string and could present it to any route. A malformed
 * string is answered without a store read.
 */
export async function reportLeakedApiKeys(
  tokens: readonly string[],
  source?: string,
): Promise<Array<{ token: string; known: boolean; revoked: boolean }>> {
  const out: Array<{ token: string; known: boolean; revoked: boolean }> = [];
  for (const token of tokens) {
    if (!isWellFormedApiKey(token)) { out.push({ token, known: false, revoked: false }); continue; }
    const idx = await hashIndex.get(hashToken(token));
    const rec = idx ? await keys.get(idx.keyId) : null;
    if (!rec) { out.push({ token, known: false, revoked: false }); continue; }
    if (rec.revokedAt) { out.push({ token, known: true, revoked: false }); continue; }
    const at = new Date().toISOString();
    await keys.put({ ...rec, revokedAt: at, revokedReason: 'leaked' });
    out.push({ token, known: true, revoked: true });
    await appendAudit(rec.tenantId, 'apikey.revoked', {
      keyId: rec.keyId,
      reason: 'leaked',
      ...(source ? { source: source.slice(0, 300) } : {}),
    }).catch(() => undefined);
    if (rec.createdBy.startsWith('user:')) {
      try {
        await getNotificationEmitter().emit({
          notificationId: `apikey-leaked-${rec.keyId.replace(/[^a-zA-Z0-9]/g, '-')}`,
          tenantId: rec.tenantId,
          recipientUserId: rec.createdBy,
          type: 'apikey.leaked',
          priority: 'high',
          title: `API key “${rec.name}” was found exposed and has been revoked`,
          message: `${rec.hint ? `${rec.hint} ` : ''}was reported as publicly visible${source ? ` (${source.slice(0, 120)})` : ''}. It no longer works. Create a replacement, and check where the old one was stored.`,
          actionUrl: '/access?tab=api-keys',
        });
      } catch {
        // The key is revoked either way; the notice is a courtesy.
      }
    }
  }
  return out;
}
