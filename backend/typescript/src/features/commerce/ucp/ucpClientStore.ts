/**
 * UCP client + token store (ADR 0178 Phase 1) — the UCP-protocol AUTH TRANSLATION.
 *
 * UCP identity is OAuth 2.0. For an AGENT transacting against the merchant, that is the
 * *authorization-server* role (inbound: an agent presents client credentials and receives
 * a scoped bearer token). That is a DIFFERENT OAuth role from Connections' `oauthClientStore`
 * (which is the app-as-OAuth-*client* to EXTERNAL providers — outbound). We deliberately do
 * NOT overload that store: mixing an inbound token issuer into the outbound client-config
 * store would be the "two systems for one concept" smell in reverse (one store, two
 * incompatible roles). This small, UCP-scoped issuer is the protocol-translation layer the
 * UCP feature legitimately owns — client-credentials only, opaque tokens, no refresh, no
 * buyer-delegation (AP2 buyer mandates are Phase 3).
 *
 * Secrets/tokens are stored HASHED (sha256); the plaintext secret is returned ONCE at
 * provision time and never again (the API-key discipline). Tenant is the isolation key.
 *
 * @see docs/adr/0178-ucp-universal-commerce-protocol.md
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hashToken, mintToken } from '../../../host/capabilityToken.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString } from '../../../host/boundedStrings.js';

/** The scopes the UCP surface understands (least-privilege; catalog read is public, so it
 *  is not a token scope). A provisioned client is granted a subset. */
export const UCP_SCOPES = ['cart:write', 'checkout:write', 'orders:read'] as const;
export type UcpScope = (typeof UCP_SCOPES)[number];

export interface UcpClient {
  clientId: string; tenantId: string; orgId: string;
  name: string; secretHash: string; scopes: UcpScope[];
  createdAt: string;
}
/** A client summary safe to return over the API (never the secret hash). */
export interface UcpClientSummary { clientId: string; name: string; scopes: UcpScope[]; createdAt: string }

interface UcpToken {
  tokenHash: string; clientId: string; tenantId: string; orgId: string;
  subject: string; scopes: UcpScope[]; expiresAt: number;
}
/** The verified identity a bearer token resolves to. */
export interface UcpPrincipal { tenantId: string; orgId: string; clientId: string; subject: string; scopes: UcpScope[] }

const clients = new DurableCollection<UcpClient>('commerce:ucp-client', (c) => c.clientId, undefined, (c) => c.tenantId);
const tokens = new DurableCollection<UcpToken>('commerce:ucp-token', (t) => t.tokenHash, undefined, (t) => t.tenantId);

const nowIso = (): string => new Date().toISOString();
const eq = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h agent access token

function cleanScopes(raw: unknown): UcpScope[] {
  // Least privilege: distinguish "didn't specify" (scopes absent → the full set, a usable
  // default) from "specified none" (an explicit [] → grant NOTHING). An explicit empty
  // selection must NOT silently escalate to full access.
  if (!Array.isArray(raw)) return [...UCP_SCOPES];
  return [...new Set(raw.filter((s): s is UcpScope => (UCP_SCOPES as readonly string[]).includes(s as string)))];
}

/** Provision a UCP agent client for a merchant org. Returns the client + the plaintext
 *  secret ONCE (never persisted in the clear). */
export async function provisionClient(input: { tenantId: string; orgId: string; name: unknown; scopes?: unknown }): Promise<{ client: UcpClientSummary; clientSecret: string }> {
  const clientId = `ucpc_${randomBytes(9).toString('hex')}`; // PUBLIC identifier, not a secret
  const { raw: clientSecret, hash: secretHash } = mintToken('ucps'); // ADR 0448 OQ3 — host mint
  const client: UcpClient = {
    clientId, tenantId: input.tenantId, orgId: input.orgId,
    name: cleanString(input.name, 120, 'UCP agent'),
    secretHash, scopes: cleanScopes(input.scopes),
    createdAt: nowIso(),
  };
  await clients.put(client);
  return { client: summarize(client), clientSecret };
}

const summarize = (c: UcpClient): UcpClientSummary => ({ clientId: c.clientId, name: c.name, scopes: c.scopes, createdAt: c.createdAt });

export async function listClients(tenantId: string, orgId: string): Promise<UcpClientSummary[]> {
  return (await clients.listForTenantIndexed(tenantId)).filter((c) => c.orgId === orgId).map(summarize);
}

export async function deleteClient(tenantId: string, orgId: string, clientId: string): Promise<boolean> {
  const c = await clients.get(clientId);
  if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return false;
  return clients.delete(clientId);
}

/**
 * OAuth 2.0 client-credentials grant: exchange (clientId, clientSecret) for a scoped bearer.
 * Fail-closed — an unknown client or a bad secret is a uniform `invalid_client` (no
 * existence leak). The org path binds the client to its merchant (a client from another
 * org's tenant cannot mint a token here).
 */
export async function issueToken(tenantId: string, orgId: string, clientId: unknown, clientSecret: unknown, now: number): Promise<{ token: string; scopes: UcpScope[]; expiresInSec: number }> {
  const id = typeof clientId === 'string' ? clientId : '';
  const secret = typeof clientSecret === 'string' ? clientSecret : '';
  const c = id ? await clients.get(id) : null;
  if (!c || c.tenantId !== tenantId || c.orgId !== orgId || !eq(c.secretHash, hashToken(secret))) {
    throw new OpenwopError('unauthenticated', 'invalid_client', 401, {});
  }
  const { raw: token, hash: tokenHash } = mintToken('ucpt'); // ADR 0448 OQ3 — host mint
  const expiresAt = now + TOKEN_TTL_MS;
  await tokens.put({ tokenHash, clientId: c.clientId, tenantId, orgId, subject: `ucp:${c.clientId}`, scopes: c.scopes, expiresAt });
  // Best-effort GC: prune this tenant's already-expired tokens so the collection can't grow
  // unbounded (verifyToken already rejects them; this reclaims the rows). Bounded per-tenant
  // scan on the low-frequency token endpoint; never blocks issuance.
  try {
    const stale = (await tokens.listForTenantIndexed(tenantId)).filter((t) => t.expiresAt <= now);
    for (const t of stale) await tokens.delete(t.tokenHash);
  } catch { /* GC is best-effort — a failure never blocks a token grant */ }
  return { token, scopes: c.scopes, expiresInSec: Math.floor(TOKEN_TTL_MS / 1000) };
}

/** Resolve a bearer token to its principal, or null (unknown/expired). Bound to the org in
 *  the path — a token minted for another org does not authenticate here (IDOR guard). */
export async function verifyToken(tenantId: string, orgId: string, bearer: string | undefined, now: number): Promise<UcpPrincipal | null> {
  if (!bearer) return null;
  const raw = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : bearer.trim();
  if (!raw) return null;
  const rec = await tokens.get(hashToken(raw));
  if (!rec || rec.tenantId !== tenantId || rec.orgId !== orgId || rec.expiresAt <= now) return null;
  return { tenantId: rec.tenantId, orgId: rec.orgId, clientId: rec.clientId, subject: rec.subject, scopes: rec.scopes };
}

