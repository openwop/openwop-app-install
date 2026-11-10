/**
 * ADR 1045 (TST-FUD-GC-1) — the principal id of an operator env key
 * (`OPENWOP_API_KEYS` / `OPENWOP_API_KEY`), and the "is this issuer a still-
 * configured env key?" question every operator-issuer reader asks.
 *
 * The id used to be `bearer:<first 8 chars of the key>`. Two keys sharing an
 * 8-char prefix (`openwop-…`, `sk-live-…`) were therefore ONE principal: one
 * A2A/MCP rate budget, indistinguishable audit rows, and — worse — the issuer
 * check matched ANY configured key with that prefix, so removing key A left the
 * delegations A minted owner while some key B shared A's prefix (a revocation
 * bypass), and B's tenant binding answered for A (ADR 0822 WFAC-17 defeated).
 *
 * The id is now `bearer:` + the first 16 hex of SHA-256 over the FULL key:
 * distinct per key, opaque (no key material leaks into audit), stable for the
 * life of the key, and it still changes on rotation exactly as before.
 *
 * Imports only the leaf `apiKeyTenants.ts` and `node:crypto`, so both the auth
 * middleware and any host module can use it without a cycle.
 */
import { createHash } from 'node:crypto';
import { keyConfigSource, readKeyTenants } from './apiKeyTenants.js';

/** The pre-ADR-1045 id took this many raw key characters. */
const LEGACY_PREFIX_LENGTH = 8;
/** `bearer:` + 16 lowercase hex — the only shape {@link envKeyPrincipalId} mints. */
const NEW_FORM = /^bearer:[0-9a-f]{16}$/;

/** The principal id of the env key `key`. The ONE derivation; never slice a key. */
export function envKeyPrincipalId(key: string): string {
  return `bearer:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

interface EnvKeyIndex {
  readonly source: string;
  /** new-form principal id → the tenants that key is configured for. */
  readonly byPrincipal: ReadonlyMap<string, readonly string[]>;
  /** legacy raw prefix → the tenants of EVERY configured key with that prefix. */
  readonly byLegacyPrefix: ReadonlyMap<string, ReadonlyArray<readonly string[]>>;
}

let cached: EnvKeyIndex | undefined;

/** Built once per distinct key configuration (keyed on the raw env string), so
 *  a per-request issuer check never re-hashes every configured key. */
function envKeyIndex(): EnvKeyIndex {
  const source = keyConfigSource();
  if (cached !== undefined && cached.source === source) return cached;
  const byPrincipal = new Map<string, readonly string[]>();
  const byLegacyPrefix = new Map<string, Array<readonly string[]>>();
  for (const [key, tenants] of readKeyTenants()) {
    byPrincipal.set(envKeyPrincipalId(key), tenants);
    const prefix = key.slice(0, LEGACY_PREFIX_LENGTH);
    const bucket = byLegacyPrefix.get(prefix);
    if (bucket) bucket.push(tenants);
    else byLegacyPrefix.set(prefix, [tenants]);
  }
  cached = { source, byPrincipal, byLegacyPrefix };
  return cached;
}

/**
 * ADR 0795 D6 / ADR 0822 D1 (WFAC-17) / ADR 1045 TST-FUD-GC-1 — is `issuer` an
 * env key that is still configured (and, given `tenantId`, configured for that
 * tenant or for `*`)?
 *
 *  - NEW form (`bearer:` + 16 hex): matches only the one key whose
 *    {@link envKeyPrincipalId} it is.
 *  - LEGACY form (`bearer:` + a raw prefix of at most 8 chars): still present in
 *    stored delegations (`createdBy`), run actors and scheduled chats minted
 *    before this change. It matches ONLY when EXACTLY ONE configured key has
 *    that raw prefix, and the tenant binding is checked against that one key.
 *    An ambiguous prefix fails CLOSED: with two candidates there is no way to
 *    tell which key minted the record, and answering "yes" for either is the
 *    defect itself (the survivor would vouch for the removed key's grants). A
 *    legacy record whose prefix became ambiguous loses operator standing until
 *    one of the colliding keys is removed or the record is re-issued.
 */
export function isConfiguredEnvKeyIssuer(issuer: string, tenantId?: string): boolean {
  if (!issuer.startsWith('bearer:')) return false;
  const index = envKeyIndex();
  const admits = (tenants: readonly string[]): boolean =>
    tenantId === undefined || tenants.includes(tenantId) || tenants.includes('*');
  if (NEW_FORM.test(issuer)) {
    const tenants = index.byPrincipal.get(issuer);
    return tenants !== undefined && admits(tenants);
  }
  const prefix = issuer.slice('bearer:'.length);
  if (prefix.length === 0 || prefix.length > LEGACY_PREFIX_LENGTH) return false;
  const candidates = index.byLegacyPrefix.get(prefix);
  return candidates !== undefined && candidates.length === 1 && admits(candidates[0]!);
}
