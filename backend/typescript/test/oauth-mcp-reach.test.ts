/**
 * RFC 0199 §B — a provider reached as an MCP server (ADR 0753 P3).
 *
 * The fake network below is the guarded-egress chokepoint: every discovery fetch
 * and token request is recorded, so "refused before X was contacted" is a count,
 * not an inference. Documents mirror Google's LIVE shapes (measured 2026-09-26):
 * a PRM naming `https://accounts.google.com/` with a slash and AS metadata whose
 * issuer has none — the case the RFC owner's single equivalence exists for.
 *
 * Every refusal asserts its exact `reason`: ten different checks return
 * `ok:false`, so a refusal from the wrong check must not pass. The pinning case
 * changes the manifest's issuer, so it is the PIN (not §B.3(c)) that refuses.
 * `canonicalResourceUri`'s lowercasing is also done by the WHATWG URL parser, so
 * dropping its `.toLowerCase()` calls is an equivalent change, not a missed one.
 * The concurrent-registration race is real: both `pins.get` calls resolve before
 * either `putIfAbsent`, so the loser branch runs.
 *
 * Sabotage witnesses (mcpReachVerifier.ts, oauthFlow.ts): each §B.3 check
 * neutralised reds its own case; the pinned-issuer check reds the first pinning
 * case; the tuple compare reds the second; the loser's same-tuple accept reds
 * the concurrent case; dropping `resource` from the authorize or token request,
 * the 422 refusal, or the held-built-in exemption reds its §B.1 case.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hits: string[] = [];
let docs: Record<string, Record<string, unknown>> = {};
vi.mock('../src/host/webhookEgressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    guardedEgressFetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      hits.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${init.body}` : ''}`);
      const doc = docs[String(url)];
      if (doc === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  };
});

import { OpenwopError } from '../src/types.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerProvider, type ProviderManifest } from '../src/features/connections/providerRegistry.js';
import { beginAuthorization, exchangeCodeForTokens, grantResourceOf } from '../src/features/connections/oauthFlow.js';
import {
  __resetMcpReachPins,
  authorizationServerMetadataUrls,
  canonicalResourceUri,
  issuerListed,
  protectedResourceMetadataUrls,
  verifyAndPinMcpReach,
  verifyMcpReach,
} from '../src/features/connections/mcpReachVerifier.js';

const SERVER = 'https://mcp.pack.example/mcp/v1';
const ISSUER = 'https://as.pack.example';
const PRM_URL = 'https://mcp.pack.example/.well-known/oauth-protected-resource/mcp/v1';
const AS_URL = 'https://as.pack.example/.well-known/oauth-authorization-server';
const FOREIGN = 'https://foreign.example';

function provider(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: 'pack-mcp',
    label: 'Pack MCP',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'mcp',
    mcpServer: { url: SERVER, transport: 'http' },
    issuer: ISSUER,
    endpoints: { authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token` },
    scopes: { read: [{ key: 'r', label: 'Read', scopes: ['read'] }] },
    refreshable: true,
    defaultScopes: ['read'],
    consumerNodes: [],
    ...overrides,
  };
}

function goodDocs(): Record<string, Record<string, unknown>> {
  return {
    [PRM_URL]: { resource: SERVER, authorization_servers: [`${ISSUER}/`] },
    [AS_URL]: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      code_challenge_methods_supported: ['S256'],
    },
  };
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  hits.length = 0;
  docs = goodDocs();
  await __resetMcpReachPins();
});

describe('derivations', () => {
  it('canonical resource URI: no fragment, lowercase scheme+host, no trailing slash', () => {
    expect(canonicalResourceUri('HTTPS://MCP.Example.com/mcp/v1/#x')).toBe('https://mcp.example.com/mcp/v1');
    expect(canonicalResourceUri('https://mcp.example.com/')).toBe('https://mcp.example.com');
  });

  it('PRM URLs: path-inserted first, then the root (RFC 9728 §3.1, MCP order)', () => {
    expect(protectedResourceMetadataUrls(SERVER)).toEqual([PRM_URL, 'https://mcp.pack.example/.well-known/oauth-protected-resource']);
  });

  it('AS metadata URLs derive from the issuer only', () => {
    expect(authorizationServerMetadataUrls(ISSUER)).toEqual([AS_URL, `${ISSUER}/.well-known/openid-configuration`]);
    expect(authorizationServerMetadataUrls('https://as.example/tenant1')).toEqual([
      'https://as.example/.well-known/oauth-authorization-server/tenant1',
      'https://as.example/.well-known/openid-configuration/tenant1',
      'https://as.example/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('§B.3(c) — the ONE equivalence (empty path ≡ "/"), and nothing else', () => {
    expect(issuerListed(['https://accounts.google.com/'], 'https://accounts.google.com')).toBe(true);
    expect(issuerListed(['https://accounts.google.com'], 'https://accounts.google.com/')).toBe(true);
    expect(issuerListed(['https://ACCOUNTS.google.com/'], 'https://accounts.google.com')).toBe(false);
    expect(issuerListed(['https://accounts.google.com:443/'], 'https://accounts.google.com')).toBe(false);
    expect(issuerListed(['https://as.example/t1/'], 'https://as.example/t1')).toBe(false);
    expect(issuerListed(['https://as.example/?x'], 'https://as.example')).toBe(false);
    expect(issuerListed('https://as.example', 'https://as.example')).toBe(false);
  });
});

describe('§B.3 — discovery verifies; it never selects', () => {
  it('a manifest that matches its live metadata verifies (the slash-suffixed PRM entry included)', async () => {
    const v = await verifyMcpReach(provider());
    expect(v).toEqual({ ok: true, tuple: { resource: SERVER, issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token` } });
  });

  it('a PRM naming a FOREIGN issuer is refused, and the foreign issuer is never contacted', async () => {
    docs[PRM_URL] = { resource: SERVER, authorization_servers: [FOREIGN] };
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'PRM does not name the configured issuer' });
    expect(hits.some((h) => h.includes('foreign.example'))).toBe(false);
  });

  it('a PRM whose resource is not the server URL is refused (RFC 9728 §3.3)', async () => {
    docs[PRM_URL] = { resource: 'https://mcp.pack.example/other', authorization_servers: [ISSUER] };
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'PRM resource does not match the server URL' });
  });

  it('AS metadata whose issuer is not IDENTICAL is refused (§B.3(d) stays exact)', async () => {
    docs[AS_URL] = { ...docs[AS_URL], issuer: `${ISSUER}/` };
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'AS metadata issuer is not identical to the configured issuer' });
  });

  it('AS metadata naming a different token endpoint is refused (§B.3(e))', async () => {
    docs[AS_URL] = { ...docs[AS_URL], token_endpoint: `${FOREIGN}/token` };
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'AS metadata endpoints differ from the manifest' });
  });

  it('§B.2 — S256 absent (or the member missing) is refused', async () => {
    docs[AS_URL] = { ...docs[AS_URL], code_challenge_methods_supported: ['plain'] };
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'authorization server does not list S256' });
    const { code_challenge_methods_supported: _drop, ...noMember } = goodDocs()[AS_URL]!;
    docs[AS_URL] = noMember;
    expect(await verifyMcpReach(provider())).toEqual({ ok: false, reason: 'authorization server does not list S256' });
  });

  it('§E.2 — an issuer-less or pkce:"unsupported" MCP-reach provider is refused with NO network at all', async () => {
    const { issuer: _i, ...noIssuer } = provider();
    expect(await verifyMcpReach(noIssuer)).toEqual({ ok: false, reason: 'MCP-reach provider declares no issuer' });
    expect(await verifyMcpReach(provider({ pkce: 'unsupported' }))).toEqual({ ok: false, reason: 'MCP-reach provider declares pkce: unsupported' });
    expect(hits).toHaveLength(0);
  });
});

describe('§B.4 — pinning', () => {
  it('pins on first success; a later PRM naming a new issuer is refused and that issuer is contacted nowhere', async () => {
    expect((await verifyAndPinMcpReach(provider())).ok).toBe(true);
    // The server now names a NEW issuer, and that issuer's metadata is fully
    // self-consistent with a manifest that moved to it — so §B.3 alone would
    // ACCEPT it (positive control below). Only the pin can refuse.
    const moved = provider({ issuer: FOREIGN, endpoints: { authorize: `${FOREIGN}/authorize`, token: `${FOREIGN}/token` } });
    docs[PRM_URL] = { resource: SERVER, authorization_servers: [FOREIGN] };
    docs[`${FOREIGN}/.well-known/oauth-authorization-server`] = {
      issuer: FOREIGN,
      authorization_endpoint: `${FOREIGN}/authorize`,
      token_endpoint: `${FOREIGN}/token`,
      code_challenge_methods_supported: ['S256'],
    };
    hits.length = 0;
    expect(await verifyAndPinMcpReach(moved)).toEqual({ ok: false, reason: 'configured issuer differs from the pinned issuer' });
    // Refused before any network: the new issuer (and the server) are contacted nowhere.
    expect(hits).toEqual([]);
    // Positive control: without a pin the same moved manifest verifies.
    expect((await verifyMcpReach(moved)).ok).toBe(true);
  });

  it('a manifest whose endpoints change after pinning is refused, not adopted', async () => {
    expect((await verifyAndPinMcpReach(provider())).ok).toBe(true);
    docs[AS_URL] = { ...docs[AS_URL], token_endpoint: `${ISSUER}/token2` };
    expect(await verifyAndPinMcpReach(provider({ endpoints: { authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token2` } })))
      .toEqual({ ok: false, reason: 'discovery disagrees with the pinned tuple' });
  });

  it('concurrent first registrations of the same tuple both succeed (first writer wins, same tuple agrees)', async () => {
    const [a, b] = await Promise.all([verifyAndPinMcpReach(provider()), verifyAndPinMcpReach(provider())]);
    const tuple = { resource: SERVER, issuer: ISSUER, authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token` };
    // Both callers — the writer AND the loser of putIfAbsent — agree on the one tuple.
    expect(a).toEqual({ ok: true, tuple });
    expect(b).toEqual({ ok: true, tuple });
  });
});

describe('§B.1 — the grant carries `resource`; a refusal issues no authorization URL', () => {
  beforeEach(() => {
    process.env.OPENWOP_OAUTH_PACK_MCP_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_PACK_MCP_CLIENT_SECRET = 'csecret';
    process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://host.example';
  });
  afterEach(() => {
    delete process.env.OPENWOP_OAUTH_PACK_MCP_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_PACK_MCP_CLIENT_SECRET;
    delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
  });

  it('`resource` = the canonical server URI on the authorize AND token requests', async () => {
    registerProvider(provider());
    const { authorizeUrl } = await beginAuthorization({ provider: 'pack-mcp', tenantId: 't', userId: 'u', reqOrigin: 'https://host.example' });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('resource')).toBe(SERVER);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    docs[`${ISSUER}/token`] = { access_token: 'at', expires_in: 60 };
    await exchangeCodeForTokens({ provider: 'pack-mcp', code: 'c', codeVerifier: 'v', scopes: ['read'], reqOrigin: 'https://host.example' });
    const tokenHit = hits.find((h) => h.startsWith(`POST ${ISSUER}/token`)) ?? '';
    expect(new URLSearchParams(tokenHit.split(' ').slice(2).join(' ')).get('resource')).toBe(SERVER);
  });

  it('a metadata mismatch refuses with 422 connection_auth_metadata_mismatch and NO authorization URL', async () => {
    registerProvider(provider());
    docs[PRM_URL] = { resource: SERVER, authorization_servers: [FOREIGN] };
    const err = await beginAuthorization({ provider: 'pack-mcp', tenantId: 't', userId: 'u', reqOrigin: 'https://host.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'connection_auth_metadata_mismatch', httpStatus: 422 });
  });

  it('a built-in held out of §B (google) sends no `resource` and runs no discovery (ADR 0753 D6)', async () => {
    const { getProvider } = await import('../src/features/connections/providerRegistry.js');
    expect(grantResourceOf(getProvider('google')!)).toBeNull();
    expect(grantResourceOf(provider())).toBe(SERVER);
    // "runs no discovery": a real google grant start issues no `resource` and no fetch.
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'gcid';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'gcsecret';
    try {
      hits.length = 0;
      const { authorizeUrl } = await beginAuthorization({ provider: 'google', tenantId: 't', userId: 'u', reqOrigin: 'https://host.example' });
      expect(new URL(authorizeUrl).searchParams.has('resource')).toBe(false);
      expect(hits).toEqual([]);
    } finally {
      delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
      delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
    }
  });
});
