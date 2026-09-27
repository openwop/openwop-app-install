/**
 * RFC 0199 §B — a provider the host reaches as an MCP server with an OAuth grant
 * (ADR 0753 D4–D6).
 *
 * DISCOVERY VERIFIES; IT NEVER SELECTS. The MCP server publishes Protected
 * Resource Metadata (RFC 9728), and that document is third-party input: if it
 * could choose the authorization server, an attacker-controlled PRM would choose
 * where this host sends codes and client credentials. So every request still goes
 * to the MANIFEST's endpoints; discovery can only refuse a manifest, never
 * redirect one (`connection-packs.md` clause 3 stays intact).
 *
 * The verified `(resource, issuer, authorize, token)` tuple is PINNED on first
 * success (§B.4) and every later discovery must agree with it — a changed PRM is
 * refused, never adopted.
 *
 * One exception to exact comparison, by the RFC owner's ruling (2026-09-26, made
 * against Google's live PRM `["https://accounts.google.com/"]` vs its metadata
 * issuer `"https://accounts.google.com"`): §B.3(c)'s membership test treats an
 * `https` issuer with an EMPTY path as equal to the same issuer with path `/`
 * (RFC 3986 §6.2.3). Nothing else is normalized, and §B.3(d) stays exact.
 */
import { guardedEgressFetch } from '../../host/webhookEgressGuard.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { ProviderManifest } from './providerRegistry.js';

const log = createLogger('connections.mcp-reach');

const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_METADATA_BYTES = 256 * 1024;

/**
 * Built-in MCP-reach providers held OUT of §B, with the reason. A provider listed
 * here keeps today's grant path, and the host MUST NOT advertise `oauth` while
 * this set is non-empty (ADR 0753 D6/D11) — the exemption is honest only because
 * nothing on the wire claims §B for it.
 *
 * google: the trailing-slash conflict is ruled (see above), but whether Google
 * accepts an RFC 8707 `resource` parameter on a real grant is not yet verified.
 * If it rejects it (`invalid_target`), Google is recorded as a provider
 * non-conformance in ADR 0753 — never carved out of §B.1.
 */
export const HELD_BUILTIN_MCP_REACH: ReadonlyMap<string, string> = new Map([
  ['google', 'RFC 8707 `resource` acceptance unverified on a live grant (ADR 0753 D6)'],
]);

export interface McpReachTuple {
  resource: string;
  issuer: string;
  authorize: string;
  token: string;
}

export type McpReachVerdict = { ok: true; tuple: McpReachTuple } | { ok: false; reason: string };

interface PinRecord extends McpReachTuple {
  key: string;
  providerId: string;
  pinnedAt: string;
}

const pins = new DurableCollection<PinRecord>('connections:mcp-reach-pin', (r) => r.key);

/** True when §B binds this provider's grant (ADR 0753 D6). */
export function isMcpReachOAuth(manifest: ProviderManifest): boolean {
  return manifest.kind === 'oauth2' && manifest.reach === 'mcp' && typeof manifest.mcpServer?.url === 'string';
}

/**
 * RFC 8707 / MCP §Canonical Server URI: no fragment, lowercase scheme and host,
 * and no trailing slash unless the path requires it.
 */
export function canonicalResourceUri(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = '';
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  const pathPart = path === '/' ? '' : path;
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathPart}${u.search}`;
}

/** RFC 9728 §3.1 — the well-known URIs derived from the resource, in MCP's order:
 *  the path-inserted form first, then the origin root. */
export function protectedResourceMetadataUrls(resource: string): string[] {
  const u = new URL(resource);
  const root = `${u.protocol}//${u.host}/.well-known/oauth-protected-resource`;
  const path = u.pathname === '/' ? '' : u.pathname;
  return path ? [`${root}${path}`, root] : [root];
}

/** MCP Authorization Server Discovery §Authorization Server Metadata Discovery. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const origin = `${u.protocol}//${u.host}`;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  if (!path) return [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/** §B.3(c) membership, under the owner's single equivalence: an `https` issuer
 *  with an empty path equals the same issuer with path `/`. Exact otherwise. */
export function issuerListed(authorizationServers: unknown, issuer: string): boolean {
  if (!Array.isArray(authorizationServers)) return false;
  const withSlash = /^https:\/\/[^/?#]+$/i.test(issuer) ? `${issuer}/` : null;
  const withoutSlash = /^https:\/\/[^/?#]+\/$/i.test(issuer) ? issuer.slice(0, -1) : null;
  return authorizationServers.some((a) => a === issuer || (withSlash !== null && a === withSlash) || (withoutSlash !== null && a === withoutSlash));
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await guardedEgressFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const text = await res.text();
    if (text.length > MAX_METADATA_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * §B.2–§B.3 against the live server + authorization server. Pure verification:
 * it returns the tuple the MANIFEST already declares, or a refusal. `pinnedIssuer`
 * (when a pin exists) is the issuer (c) must find — so a PRM that names a new
 * authorization server is refused before that server is ever contacted.
 */
export async function verifyMcpReach(manifest: ProviderManifest, pinnedIssuer?: string): Promise<McpReachVerdict> {
  const serverUrl = manifest.mcpServer?.url;
  if (!serverUrl) return { ok: false, reason: 'no MCP server url' };
  const issuer = manifest.issuer;
  // §E.2 host-side rule: an MCP-reach provider without an issuer, or one that
  // declares it cannot do PKCE, is refused the GRANT (the document stays valid).
  if (!issuer) return { ok: false, reason: 'MCP-reach provider declares no issuer' };
  if (manifest.pkce === 'unsupported') return { ok: false, reason: 'MCP-reach provider declares pkce: unsupported' };
  const authorize = manifest.endpoints?.authorize;
  const token = manifest.endpoints?.token;
  if (!authorize || !token) return { ok: false, reason: 'manifest endpoints incomplete' };
  if (pinnedIssuer !== undefined && pinnedIssuer !== issuer) return { ok: false, reason: 'configured issuer differs from the pinned issuer' };

  const resource = canonicalResourceUri(serverUrl);

  // (a) + (b): PRM only from the derived well-known URIs; its `resource` must be
  // identical to the identifier the URL was formed from.
  let prm: Record<string, unknown> | null = null;
  for (const url of protectedResourceMetadataUrls(resource)) {
    prm = await fetchJson(url);
    if (prm) break;
  }
  if (!prm) return { ok: false, reason: 'protected resource metadata unavailable' };
  if (prm.resource !== resource) return { ok: false, reason: 'PRM resource does not match the server URL' };

  // (c): the manifest's issuer must be one the server names.
  if (!issuerListed(prm.authorization_servers, issuer)) return { ok: false, reason: 'PRM does not name the configured issuer' };

  // (d): AS metadata only from URIs derived from THAT issuer; its `issuer` exact.
  let asMeta: Record<string, unknown> | null = null;
  for (const url of authorizationServerMetadataUrls(issuer)) {
    asMeta = await fetchJson(url);
    if (asMeta) break;
  }
  if (!asMeta) return { ok: false, reason: 'authorization server metadata unavailable' };
  if (asMeta.issuer !== issuer) return { ok: false, reason: 'AS metadata issuer is not identical to the configured issuer' };

  // §B.2: S256 must be listed; an absent member means no PKCE (RFC 8414 §2).
  const methods = asMeta.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) return { ok: false, reason: 'authorization server does not list S256' };

  // (e): the manifest's endpoints are the ones the authorization server names.
  if (asMeta.authorization_endpoint !== authorize || asMeta.token_endpoint !== token) {
    return { ok: false, reason: 'AS metadata endpoints differ from the manifest' };
  }
  return { ok: true, tuple: { resource, issuer, authorize, token } };
}

function pinKey(providerId: string, resource: string): string {
  return `${providerId}|${resource}`;
}

function sameTuple(a: McpReachTuple, b: McpReachTuple): boolean {
  return a.resource === b.resource && a.issuer === b.issuer && a.authorize === b.authorize && a.token === b.token;
}

/**
 * §B.3 + §B.4 for one grant (and for registration): verify, then pin on first
 * success (first writer wins across instances) or require agreement with the pin.
 * The only thing a caller may do with a refusal is refuse the grant.
 */
export async function verifyAndPinMcpReach(manifest: ProviderManifest): Promise<McpReachVerdict> {
  const serverUrl = manifest.mcpServer?.url;
  if (!serverUrl) return { ok: false, reason: 'no MCP server url' };
  const key = pinKey(manifest.id, canonicalResourceUri(serverUrl));
  const pinned = await pins.get(key);
  const verdict = await verifyMcpReach(manifest, pinned?.issuer);
  if (!verdict.ok) {
    log.warn('mcp reach refused', { provider: manifest.id, reason: verdict.reason });
    return verdict;
  }
  if (!pinned) {
    const won = await pins.putIfAbsent({ key, providerId: manifest.id, ...verdict.tuple, pinnedAt: new Date().toISOString() });
    if (won) return verdict;
    const winner = await pins.get(key);
    if (winner && sameTuple(winner, verdict.tuple)) return verdict;
    return { ok: false, reason: 'a concurrent registration pinned a different tuple' };
  }
  if (!sameTuple(pinned, verdict.tuple)) {
    log.warn('mcp reach refused', { provider: manifest.id, reason: 'discovery disagrees with the pinned tuple' });
    return { ok: false, reason: 'discovery disagrees with the pinned tuple' };
  }
  return verdict;
}

/** Test seam: forget every pin. */
export async function __resetMcpReachPins(): Promise<void> {
  for (const p of await pins.list()) await pins.delete(p.key);
}
