/**
 * API-key → tenant parsing, and the two pure env predicates around it.
 *
 * A LEAF module on purpose (no imports): `host/superadmin.ts` needs
 * `wildcardApiKeyConfigured()` for its 403 hint, and it is imported by most
 * feature modules — while `middleware/auth.ts` imports a feature module
 * (`features/developer-keys/apiKeyService.js`). Reaching for it there closed a
 * cycle that left `BACKEND_FEATURES` holding an `undefined` entry and took
 * `strategy-cross-org` down with "Cannot read properties of undefined (reading
 * 'requiredPacks')" — a parse owner moved here so BOTH sides can import it
 * without a second read of the env.
 */

/** The tenant a bare (un-suffixed) API key acts as. */
export const DEFAULT_API_KEY_TENANT = 'default';

/** True in any posture that enforces real authentication. */
export function authIsEnforced(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.OPENWOP_AUTH_ENFORCE_BEARER === 'true';
}


/** True when the operator configured the key map (`OPENWOP_API_KEYS` or
 *  `OPENWOP_API_KEY`). False means `readKeyTenants` is serving the built-in
 *  `dev-token` fallback, a PUBLIC string, which ADR 0771 must not reward. */
export function apiKeysConfigured(): boolean {
  return Boolean(process.env.OPENWOP_API_KEYS ?? process.env.OPENWOP_API_KEY);
}

const warnedTenants = new Set<string>();

/**
 * ADR 0814's configuration rule, restated here because this module is a leaf (see
 * the header): the canonical one is `host/v2Ids.ts` `wireTenantViolation`, and
 * `adr0814-wire-tenant.test.ts` pins that the two agree. A tenant parsed here can
 * never contain `:` (the key splits on the last colon), so the only failures are
 * a reserved prefix and a non-clean value too long to hex-encode within 128.
 */
export function configuredTenantViolation(tenant: string): string | null {
  if (tenant === '*') return null;
  if (/^[uwox]-/.test(tenant)) {
    return `tenant '${tenant}' starts with a prefix reserved for the wire tenantId (u-/w-/o-/x-, ADR 0814)`;
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(tenant) && 2 + 2 * Buffer.byteLength(tenant, 'utf8') > 128) {
    return `tenant '${tenant}' has no grammar-clean wire tenantId (over 128 characters once mapped, ADR 0814)`;
  }
  return null;
}

export function readKeyTenants(): ReadonlyMap<string, readonly string[]> {
  const multi = process.env.OPENWOP_API_KEYS;
  const single = process.env.OPENWOP_API_KEY;
  // Fail closed under enforced auth: do NOT honor the built-in `dev-token`
  // (which maps to a wildcard-tenant admin principal) when no real key is
  // configured. The OIDC/cookie bearer paths still work; only the guessable
  // default is withdrawn (SEC-2).
  // The built-in `dev-token` fallback keeps the WILDCARD, and that is a
  // deliberate line rather than an oversight.
  //
  // This ADR scopes keys an operator CONFIGURES. `dev-token` is not configured
  // by anyone — it is the local-development default, and it is already withdrawn
  // in production by `authIsEnforced()` (SEC-2), so it cannot be the thing that
  // hands a real deployment cross-tenant access. Scoping it would change no
  // production posture while breaking the local/admin affordance that 166 test
  // files and every `curl` smoke depend on.
  //
  // MEASURED: scoping it too failed 181 tests across 59 files. That is the cost
  // of narrowing a DEV default; the security change is narrowing the CONFIGURED
  // ones, which cost 2 conformance assertions. Writing `OPENWOP_API_KEYS=dev-token`
  // explicitly gets you the scoped principal like any other configured key.
  const raw = multi ?? single ?? (authIsEnforced() ? '' : 'dev-token:*');
  const out = new Map<string, readonly string[]>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    // Split on the LAST colon so a key containing one still parses; a bare key
    // keeps its whole value.
    const sep = trimmed.lastIndexOf(':');
    if (sep <= 0) {
      out.set(trimmed, [DEFAULT_API_KEY_TENANT]);
      continue;
    }
    const key = trimmed.slice(0, sep).trim();
    const tenant = trimmed.slice(sep + 1).trim();
    if (key.length === 0) continue;
    // ADR 0814 — a configured tenant must have a grammar-clean, unambiguous wire
    // tenantId. A key whose tenant would collide with the reserved wire prefixes
    // is REFUSED (fail closed: that key authenticates nothing), never silently
    // re-mapped onto another tenant's id space.
    const violation = tenant.length > 0 ? configuredTenantViolation(tenant) : null;
    if (violation !== null) {
      if (!warnedTenants.has(tenant)) {
        warnedTenants.add(tenant);
        console.error(`[apiKeyTenants] OPENWOP_API_KEYS entry refused: ${violation}`);
      }
      continue;
    }
    // An empty tenant (`"k1:"`) is a configuration mistake, not a request for
    // the wildcard — scope it rather than silently widening it.
    out.set(key, [tenant.length > 0 ? tenant : DEFAULT_API_KEY_TENANT]);
  }
  return out;
}


/**
 * Is any CONFIGURED api key cross-tenant (`<key>:*`)? The superadmin gate's hint
 * needs it: the wildcard-bearer door only exists when an operator wrote it down
 * (ADR 0561 made scoped the default), and a hint naming a door this deployment
 * does not have costs real debugging time — MEASURED on rev 00737-vkq, where
 * both configured keys are tenant-scoped and the hint sent a peer session to a
 * bricked-up door. Derived from the SAME parse the auth path uses, never a
 * second read of the env.
 */
export function wildcardApiKeyConfigured(): boolean {
  for (const tenants of readKeyTenants().values()) {
    if (tenants.includes('*')) return true;
  }
  return false;
}

