/**
 * ADR 0795 D3 + D4 — what a person may ask for when minting a key.
 *
 * D3: scopes are EXPLICIT and REAL. Omitting `scopes` used to mint a key with
 * its issuer's whole authority, and any non-empty string was accepted, so
 * `runs:write` (a scope no route reads) minted a key refused everything. A
 * request must now name scopes, each one a scope some gate reads; unrestricted
 * is the named choice `["*"]`.
 *
 * D4: lifetime is validated, defaulted and capped. An expiry that does not
 * parse, lies in the past or exceeds the maximum is refused; omitting it
 * applies the default rather than "never"; `null` asks for no expiry, which an
 * operator may allow.
 *
 * This is the ROUTE's policy. The service (`issueApiKey`) stays permissive for
 * the host's own callers (device pairing, the demo seed, the conformance seam),
 * which declare their own scopes and lifetimes.
 */
import { MANAGEMENT_SCOPES, PROTOCOL_SCOPES } from '../../host/accessControlService.js';
import { SCOPES_SUPPORTED } from '../../host/protocolAuthorization.js';
import { OpenwopError } from '../../types.js';

/** Every scope a key may declare: the RBAC vocabulary a resolver can grant, the
 *  protocol and key-lane scopes a route can refuse a key for, and `*`. */
export const MINTABLE_KEY_SCOPES: readonly string[] = [
  ...new Set<string>([...PROTOCOL_SCOPES, ...MANAGEMENT_SCOPES, ...SCOPES_SUPPORTED, '*']),
];

/**
 * A feature whose routes verify a key against a scope grammar of their own
 * (entities: `entities:<type>:read|write`, `entities:admin`) registers it here,
 * so its scopes are mintable and still nothing else is.
 */
const scopePatterns: RegExp[] = [];
export function registerMintableScopePattern(pattern: RegExp): void {
  if (!scopePatterns.some((p) => p.source === pattern.source)) scopePatterns.push(pattern);
}
const isMintable = (s: string): boolean => MINTABLE_KEY_SCOPES.includes(s) || scopePatterns.some((p) => p.test(s));

const DAY_MS = 86_400_000;

function days(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export interface KeyMintPolicy {
  defaultLifetimeDays: number;
  maxLifetimeDays: number;
  allowNoExpiry: boolean;
}

/**
 * `tenantCapDays` (ADR 0798): a workspace may set a TIGHTER cap than the
 * deployment's, never a looser one — and a workspace with a cap of its own does
 * not issue keys without an expiry.
 */
export function keyMintPolicy(tenantCapDays?: number): KeyMintPolicy {
  const deploymentMax = days('OPENWOP_API_KEY_MAX_LIFETIME_DAYS', 366);
  const maxLifetimeDays = tenantCapDays !== undefined ? Math.min(deploymentMax, tenantCapDays) : deploymentMax;
  return {
    maxLifetimeDays,
    defaultLifetimeDays: Math.min(days('OPENWOP_API_KEY_DEFAULT_LIFETIME_DAYS', 90), maxLifetimeDays),
    allowNoExpiry: tenantCapDays === undefined && process.env.OPENWOP_API_KEY_ALLOW_NO_EXPIRY === 'true',
  };
}

export function requireMintableScopes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpenwopError(
      'validation_error',
      'scopes is required: name what this key may do. Use ["*"] for a key with your full authority.',
      400,
      { field: 'scopes', code: 'scopes_required' },
    );
  }
  const unknown = raw.filter((s) => typeof s !== 'string' || !isMintable(s.trim()));
  if (unknown.length > 0) {
    throw new OpenwopError(
      'validation_error',
      `Unknown scope(s): ${unknown.map(String).join(', ')}. A key is limited to exactly the scopes it declares, so a scope nothing checks would mint a key that can do nothing.`,
      400,
      { field: 'scopes', code: 'unknown_scope', unknown: unknown.map(String), allowed: MINTABLE_KEY_SCOPES },
    );
  }
  return [...new Set((raw as string[]).map((s) => s.trim()))];
}

/** The expiry to store: an ISO timestamp, or `undefined` for a key that does not expire. */
export function resolveMintExpiry(raw: unknown, now: number = Date.now(), policy: KeyMintPolicy = keyMintPolicy()): string | undefined {
  if (raw === undefined) return new Date(now + policy.defaultLifetimeDays * DAY_MS).toISOString();
  if (raw === null) {
    if (policy.allowNoExpiry) return undefined;
    throw new OpenwopError(
      'validation_error',
      `This deployment does not issue keys without an expiry. The longest lifetime is ${policy.maxLifetimeDays} days.`,
      400,
      { field: 'expiresAt', code: 'expiry_required', maxLifetimeDays: policy.maxLifetimeDays },
    );
  }
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isNaN(at)) {
    throw new OpenwopError('validation_error', 'expiresAt must be an ISO 8601 timestamp, or null for no expiry.', 400, { field: 'expiresAt', code: 'expiry_unparseable' });
  }
  if (at <= now) {
    throw new OpenwopError('validation_error', 'expiresAt must be in the future.', 400, { field: 'expiresAt', code: 'expiry_in_past' });
  }
  if (at > now + policy.maxLifetimeDays * DAY_MS) {
    throw new OpenwopError(
      'validation_error',
      `expiresAt is more than ${policy.maxLifetimeDays} days away, the longest lifetime this deployment issues.`,
      400,
      { field: 'expiresAt', code: 'expiry_too_far', maxLifetimeDays: policy.maxLifetimeDays },
    );
  }
  return new Date(at).toISOString();
}
