/**
 * RFC 0199 advertisement predicate (ADR 0753 D11) — the ONE answer to "does this
 * host advertise `oauth` (and its `credentialInterrupt` facet)?".
 *
 * Every behaviour the RFC binds only to an advertiser reads this, never its own
 * copy: the `credential` interrupt (§C), `connector.auth-expired` (which its
 * schema says MUST NOT be emitted unless `oauth` is advertised), and discovery.
 * So the wire claim and the behaviour cannot drift apart.
 *
 * Advertised only when ALL hold:
 *  - the operator opted in (`OPENWOP_OAUTH_ADVERTISE=true`);
 *  - there is an `https` public base, because `connectUrl` MUST be an https URL
 *    on the host's own origin (§C.3) — without one the facet cannot be honoured;
 *  - no built-in MCP-reach provider held out of §B is grantable here. A held
 *    provider this host can actually run a grant for would make the `oauth`
 *    claim false for it (ADR 0753 D6).
 */
import { HELD_BUILTIN_MCP_REACH } from './mcpReachVerifier.js';
import { isOAuthConfigured } from './oauthFlow.js';
import { listProviders } from './providerRegistry.js';
import { SYNTHETIC_OAUTH_PROVIDERS } from './oauthConformanceSeams.js';
import { seamsFloorServed } from '../../routes/conformanceSeams.js';
import { VENDOR_ROOT } from '../../middleware/protocolVersion.js';

/** The https origin + path prefix the host's own OAuth surfaces live under
 *  (the same base the callback's redirect URI uses), or null. */
export function httpsPublicBase(): string | null {
  const base = (process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL ?? process.env.OPENWOP_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(base) ? base : null;
}

export async function oauthAdvertised(): Promise<boolean> {
  if (process.env.OPENWOP_OAUTH_ADVERTISE !== 'true') return false;
  if (httpsPublicBase() === null) return false;
  for (const id of HELD_BUILTIN_MCP_REACH.keys()) {
    if (await isOAuthConfigured(id)) return false;
  }
  return true;
}

/** §C.1 — the facet ships with `oauth` itself on this host (never one without the other). */
export async function credentialInterruptAdvertised(): Promise<boolean> {
  return oauthAdvertised();
}

/**
 * §C.3 — the interrupt's `connectUrl`: deterministic from (run, node), https, on
 * the host's own origin. Neither id is a secret and nothing in it resolves the
 * interrupt; opening it requires the initiating Subject (ADR 0753 D9).
 */
export function connectUrlFor(runId: string, nodeId: string): string | null {
  const base = httpsPublicBase();
  if (base === null) return null;
  // The canonical, version-agnostic vendor root (ADR 0652) — it outlives `/v1`.
  return `${base}${VENDOR_ROOT}/connections/connect/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}`;
}

/** One `oauth.providers[]` member (§E.1). `pkce` is advertised only when it is
 *  `unsupported` — absent means S256, and the weaker posture must be visible. */
export interface OAuthProviderAdvert {
  id: string;
  authUrl?: string;
  tokenUrl?: string;
  scopesSupported?: string[];
  issuer?: string;
  pkce?: 'unsupported';
}

export interface OAuthAdvertisementSnapshot {
  advertised: boolean;
  providers: OAuthProviderAdvert[];
}

const SNAPSHOT_TTL_MS = 30_000;
let snapshot: OAuthAdvertisementSnapshot = { advertised: false, providers: [] };
let snapshotAt = 0;

/**
 * Discovery is built synchronously, so it reads a snapshot this refreshes —
 * awaited by the discovery route before it builds (the `ensureCertificationEvidence`
 * pattern: current inside the request, never a detached continuation). A
 * provider is listed only when this host can actually run its grant (its OAuth
 * client is configured): listing one it cannot start would be a false claim the
 * suite can observe. The suite's synthetic ids are listed only while the seams
 * that configure them are mounted.
 */
export async function refreshOAuthAdvertisement(now: number = Date.now()): Promise<OAuthAdvertisementSnapshot> {
  if (now - snapshotAt < SNAPSHOT_TTL_MS) return snapshot;
  const advertised = await oauthAdvertised();
  const providers: OAuthProviderAdvert[] = [];
  if (advertised) {
    for (const m of listProviders()) {
      if (m.kind !== 'oauth2' || (SYNTHETIC_OAUTH_PROVIDERS as readonly string[]).includes(m.id)) continue;
      if (!(await isOAuthConfigured(m.id))) continue;
      const scopes = [...new Set([...m.scopes.read, ...(m.scopes.write ?? [])].flatMap((g) => g.scopes))];
      providers.push({
        id: m.id,
        ...(m.endpoints?.authorize ? { authUrl: m.endpoints.authorize } : {}),
        ...(m.endpoints?.token ? { tokenUrl: m.endpoints.token } : {}),
        ...(scopes.length > 0 ? { scopesSupported: scopes } : {}),
        ...(m.issuer ? { issuer: m.issuer } : {}),
        ...(m.pkce === 'unsupported' ? { pkce: 'unsupported' as const } : {}),
      });
    }
    if (seamsFloorServed()) for (const id of SYNTHETIC_OAUTH_PROVIDERS) providers.push({ id });
  }
  snapshot = { advertised, providers };
  snapshotAt = now;
  return snapshot;
}

export function oauthAdvertisementSnapshot(): OAuthAdvertisementSnapshot {
  return snapshot;
}

/** Test seam: drop the cached snapshot. */
export function __resetOAuthAdvertisement(): void {
  snapshot = { advertised: false, providers: [] };
  snapshotAt = 0;
}
