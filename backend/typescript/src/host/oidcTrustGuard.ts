/**
 * ADR 0745 D4 — a deployed service never trusts a conformance-harness issuer.
 *
 * RFC 0200 §D and RFC 0210's exp-only rows can only be witnessed by a host that
 * trusts the SUITE's synthetic issuer as its `oidc` trust root: the suite mints the
 * tokens. A host that trusts an issuer whose signing key lives on a test runner has
 * handed every holder of that runner an identity of their choosing — an auth bypass,
 * not a test posture. Those rows are therefore witnessed on a colocated boot of the
 * release image (`docs/steward/CERTIFY-RUNBOOK.md` § "Harness-issuer rows"), and this
 * guard makes the other arrangement impossible to deploy by accident.
 *
 * Not keyed on `NODE_ENV=production`, because the release-image conformance lane
 * (`scripts/release-conformance.sh`) IS production-mode and legitimately trusts
 * `http://host.docker.internal:<port>`. A deployed service with a harness issuer is
 * refused whatever it is called: a "conformance" service reachable from the internet
 * is exactly the exposure this exists to prevent.
 *
 * > **CORRECTED 2026-09-26 (ADR 0754).** This used to fire on `K_SERVICE` alone, so it
 * > protected the one deployment this repo operates (Cloud Run) and no white-label
 * > adopter's: Kubernetes, Fly, ECS, App Service, Heroku, Render and Railway deploys
 * > booted a harness issuer unchallenged. "Deployed" is now `deploymentMarker()`: any
 * > managed-platform marker, the enterprise `auth` posture, or a durable (Postgres)
 * > control-plane store — every local and harness boot this repo runs uses
 * > `memory://` (`release-conformance.sh`, `e2e-routes.sh`, `ci.sh`,
 * > `test-shutdown.sh`), so none of them is a deployment by this test.
 *
 * NO ESCAPE HATCH, deliberately, unlike the ADR 0195 guards beside it: those accept a
 * named durability risk; this one would accept a forged identity.
 *
 * What it cannot see, stated rather than implied: an `https` issuer on a public host
 * that happens to be a tunnel to a test runner passes the URL checks. The env-name and
 * audience checks catch the harness's own recipe; a determined operator can still
 * configure any issuer they like, which is what configuring an issuer means.
 */

const HARNESS_ENV = [
  'OPENWOP_TEST_OIDC_ISSUER_URL',
  'OPENWOP_TEST_OIDC_AUDIENCE',
  'OPENWOP_CONFORMANCE_HARNESS_HOST',
  'OPENWOP_CONFORMANCE_OIDC_PORT',
] as const;

/** The suite's default audience (`v2-oidc-id-token-audience`, `OPENWOP_TEST_OIDC_AUDIENCE ?? …`). */
const HARNESS_AUDIENCE = 'openwop-conformance';

function privateV4(a: number, b: number): boolean {
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // last: CGNAT 100.64/10
}

/**
 * `hostname` as `new URL()` normalises it: IPv6 in brackets, IPv4-mapped IPv6 in HEX
 * (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`, so a dotted-prefix check never matches —
 * found in review), a trailing dot kept.
 */
function privateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const hi = Number.parseInt(mapped[1]!, 16);
      return privateV4(hi >> 8, hi & 0xff);
    }
    // loopback, unspecified, ULA fc00::/7, link-local fe80::/10 + deprecated site-local fec0::/10
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89a-f]/.test(h);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  // A single-label name (`https://metadata/`) resolves only on a private network.
  return !h.includes('.');
}

function untrustworthyUrl(name: string, raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `${name}=${raw} is not a URL`; }
  if (u.protocol !== 'https:') return `${name}=${raw} is not https — a deployed trust root is fetched over TLS or not at all`;
  if (privateOrLocalHost(u.hostname)) return `${name}=${raw} names a loopback/private/internal host — that is a test double, not an issuer`;
  return null;
}

/**
 * Server-start guard. Returns the fatal message, or null when the deployment's OIDC
 * trust root is not a harness issuer. Called from `main()` only — never `createApp()`,
 * because the in-process conformance boot trusts the harness issuer by design.
 */
/** Managed-platform markers — each set by its platform on every instance and by no local tool this repo runs. */
const PLATFORM_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['K_SERVICE', 'Cloud Run'],
  ['KUBERNETES_SERVICE_HOST', 'Kubernetes'],
  ['FLY_APP_NAME', 'Fly.io'],
  ['ECS_CONTAINER_METADATA_URI_V4', 'AWS ECS'],
  ['ECS_CONTAINER_METADATA_URI', 'AWS ECS'],
  ['AWS_LAMBDA_FUNCTION_NAME', 'AWS Lambda'],
  ['WEBSITE_SITE_NAME', 'Azure App Service'],
  ['DYNO', 'Heroku'],
  ['RENDER_SERVICE_ID', 'Render'],
  ['RAILWAY_ENVIRONMENT', 'Railway'],
];

/**
 * ADR 0754 — why this process is a DEPLOYMENT (a description for the refusal), or
 * null when it is a local / harness boot.
 */
export function deploymentMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const [key, platform] of PLATFORM_MARKERS) {
    const v = (env[key] ?? '').trim();
    if (v) return `a ${platform} deployment (${key}=${v})`;
  }
  if (env.OPENWOP_DEPLOY_POSTURE === 'auth') return 'the enterprise deploy posture (OPENWOP_DEPLOY_POSTURE=auth)';
  const dsn = (env.OPENWOP_STORAGE_DSN ?? '').trim();
  if (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://')) return 'a durable Postgres control-plane store';
  return null;
}

export function oidcTrustRootStartupError(env: NodeJS.ProcessEnv = process.env): string | null {
  const deployed = deploymentMarker(env);
  if (!deployed) return null;
  const present = HARNESS_ENV.filter((k) => (env[k] ?? '').trim() !== '');
  if (present.length > 0) {
    return `ADR 0745 D4 — ${deployed} must never be configured with the conformance harness's OIDC env (${present.join(', ')}). Harness-issuer rows are witnessed on a colocated release-image boot, never on a deployed service.`;
  }
  const issuer = env.OPENWOP_OIDC_ISSUER?.trim();
  if (issuer) {
    const bad = untrustworthyUrl('OPENWOP_OIDC_ISSUER', issuer);
    if (bad) return `ADR 0745 D4 — ${bad}.`;
  }
  const jwks = env.OPENWOP_OIDC_JWKS_URL?.trim();
  if (jwks) {
    const bad = untrustworthyUrl('OPENWOP_OIDC_JWKS_URL', jwks);
    if (bad) return `ADR 0745 D4 — ${bad}.`;
  }
  if (issuer && env.OPENWOP_OIDC_AUDIENCE?.trim() === HARNESS_AUDIENCE) {
    return `ADR 0745 D4 — OPENWOP_OIDC_AUDIENCE=${HARNESS_AUDIENCE} is the conformance suite's audience; a deployed service trusting it is trusting harness-minted tokens.`;
  }
  return null;
}
