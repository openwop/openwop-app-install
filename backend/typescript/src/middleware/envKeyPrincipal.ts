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
}

let cached: EnvKeyIndex | undefined;

/** Built once per distinct key configuration (keyed on the raw env string), so
 *  a per-request issuer check never re-hashes every configured key. */
function envKeyIndex(): EnvKeyIndex {
  const source = keyConfigSource();
  if (cached !== undefined && cached.source === source) return cached;
  const byPrincipal = new Map<string, readonly string[]>();
  for (const [key, tenants] of readKeyTenants()) byPrincipal.set(envKeyPrincipalId(key), tenants);
  cached = { source, byPrincipal };
  return cached;
}

/**
 * ADR 0795 D6 / ADR 0822 D1 (WFAC-17) / ADR 1045 TST-FUD-GC-1 — is `issuer` an
 * env key that is still configured (and, given `tenantId`, configured for that
 * tenant or for `*`)?
 *
 * Only the NEW form (`bearer:` + 16 hex) matches, and only the one key whose
 * {@link envKeyPrincipalId} it is.
 *
 * CORRECTED 2026-11-12 (ADR 1045, CHAN-F14): a LEGACY id (`bearer:` + the
 * key's first 8 raw characters) used to match when exactly one configured key
 * had that prefix. That rule is deleted: it let a same-prefix rotation hand the
 * old key's records to the new one. A legacy id now matches nothing (fails
 * closed). Stored legacy ids are rewritten by the `legacy-bearer-id-rewrite`
 * job (`host/legacyBearerIdRewrite.ts`), which openwop-dev ran on 2026-11-12.
 */
export function isConfiguredEnvKeyIssuer(issuer: string, tenantId?: string): boolean {
  if (!NEW_FORM.test(issuer)) return false;
  const tenants = envKeyIndex().byPrincipal.get(issuer);
  return tenants !== undefined && (tenantId === undefined || tenants.includes(tenantId) || tenants.includes('*'));
}
