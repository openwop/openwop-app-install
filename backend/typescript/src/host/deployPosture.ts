export type DeployPosture = 'bearer-shared' | 'cookie-per-visitor' | 'auth';

export function readDeployPosture(): DeployPosture {
  const raw = process.env.OPENWOP_DEPLOY_POSTURE;
  if (raw === 'bearer-shared' || raw === 'cookie-per-visitor' || raw === 'auth') {
    return raw;
  }
  return process.env.OPENWOP_AUTH_ENFORCE_BEARER === 'true' ? 'auth' : 'cookie-per-visitor';
}

/**
 * Enterprise/production hardening posture — the strongest signal that a deploy is
 * a real, multi-tenant, signed-in install rather than the public demo, local dev,
 * or a test run. It is the SAME threshold that gates BYOK-KMS fail-closed
 * (`index.ts`). The public demo (`cookie-per-visitor`), shared-bearer deploys, and
 * every dev/test run return `false`, so production-hardening gates keyed on this
 * never affect them.
 */
export function enterprisePosture(): boolean {
  return readDeployPosture() === 'auth';
}

export function managedAnonSignInRequired(): boolean {
  const explicit = process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return readDeployPosture() === 'auth';
}

// ── What the enterprise (auth) posture REQUIRES — ADR 0195 ────────────────────
// The full fail-closed contract lives here so it is readable in one file. Each
// requirement has its own loud, explicit escape hatch: an operator can accept a
// named risk, but never drift into it silently. The guards that enforce these
// run at SERVER start (`main()`), never in `createApp()` — the test suite and
// embedded consumers boot apps in-process with test env and must not pay
// server-deployment guards.

/** DUR-5 escape hatch — run the auth posture without NODE_ENV=production
 *  (session-secret guard, Secure cookies, dev-token withdrawal all OFF). */
export function allowInsecureAuthPosture(): boolean {
  return process.env.OPENWOP_ALLOW_INSECURE_AUTH_POSTURE === 'true';
}

/** DUR-1 escape hatch — run the auth posture on an ephemeral control-plane
 *  store (sqlite file on stateless compute, or memory://). */
export function allowEphemeralStorage(): boolean {
  return process.env.OPENWOP_ALLOW_EPHEMERAL_STORAGE === 'true';
}

/** DUR-1 — is this control-plane DSN durable for a multi-instance deployment?
 *  Allowlist, not blocklist: `memory://` is MORE ephemeral than sqlite and must
 *  not slip through a "not sqlite" check. sqlite is single-node + lost on
 *  stateless compute; postgres (any flavor) is the durable path. */
export function isDurableStorageDsn(dsn: string): boolean {
  return dsn.startsWith('postgres://') || dsn.startsWith('postgresql://');
}

/** DUR-5 row: the auth posture without NODE_ENV=production, unless accepted. */
function insecureAuthPostureError(): string | null {
  if (process.env.NODE_ENV === 'production' || allowInsecureAuthPosture()) return null;
  return (
    'OPENWOP_DEPLOY_POSTURE=auth requires NODE_ENV=production — without it the ' +
    'session-secret guard, Secure cookie flag, and dev-token withdrawal are all ' +
    'silently OFF. Set NODE_ENV=production, or accept the risk explicitly with ' +
    'OPENWOP_ALLOW_INSECURE_AUTH_POSTURE=true.'
  );
}

/** DUR-1 row: the auth posture on an ephemeral control-plane DSN, unless accepted. */
function ephemeralStorageError(storageDsn: string): string | null {
  if (isDurableStorageDsn(storageDsn) || allowEphemeralStorage()) return null;
  return (
    `OPENWOP_DEPLOY_POSTURE=auth requires a durable control-plane store, but ` +
    `OPENWOP_STORAGE_DSN is '${storageDsn.split('://')[0]}://…' — runs, chat, BYOK ` +
    `secrets, and approvals would be lost on restart/scale (and the 'durable' host ` +
    `surfaces ride this same store). Point OPENWOP_STORAGE_DSN at Postgres, or accept ` +
    `the risk explicitly with OPENWOP_ALLOW_EPHEMERAL_STORAGE=true.`
  );
}

/** BYOK row: the same condition `createApp` throws on (`bootstrapKmsFromEnv`
 *  returns false exactly when the key is unset). No escape hatch. */
function missingKmsKeyError(): string | null {
  if (process.env.OPENWOP_BYOK_KMS_KEY) return null;
  return (
    'OPENWOP_DEPLOY_POSTURE=auth requires BYOK secret encryption: set OPENWOP_BYOK_KMS_KEY ' +
    '(KMS envelope key). Signed-in tenant secrets would otherwise use the ephemeral in-memory store.'
  );
}

/**
 * Server-start guard (DUR-1 + DUR-5). Returns the first fatal misconfiguration
 * message, or null when the deployment posture is coherent. Called from
 * `main()` only — never `createApp()` (Testability: in-process test apps run
 * NODE_ENV=test + memory:// by design).
 */
export function enterprisePostureStartupError(storageDsn: string): string | null {
  if (!enterprisePosture()) return null;
  return insecureAuthPostureError() ?? ephemeralStorageError(storageDsn);
}

/**
 * ADR 0981 D1 — the profile a deploy runs. `auth` is the strict production
 * profile; the other postures are evaluation profiles and say so.
 */
export type DeployProfile = 'strict' | 'evaluation';

export function deployProfile(): DeployProfile {
  return enterprisePosture() ? 'strict' : 'evaluation';
}

/**
 * ADR 0981 D3 — EVERY strict-profile row this process can check before
 * `createApp()`, not the first one. An operator missing three controls fixes
 * them in one boot instead of three. The rows stay the rules above; this only
 * collects them. Durable surfaces are not here: their adapters register inside
 * `createApp()`, so `assertDurableSurfacesInEnterprise` still reports them there.
 */
export function productionProfileStartupErrors(storageDsn: string): string[] {
  if (!enterprisePosture()) return [];
  return [insecureAuthPostureError(), ephemeralStorageError(storageDsn), missingKmsKeyError()].filter(
    (e): e is string => e !== null,
  );
}
