/**
 * ADR 1045 § "Env-key principal collision" (TST-FUD-GC-1) — two operator env
 * keys that share their first 8 characters are two principals, and the
 * operator-issuer check vouches only for the key that minted a record.
 *
 * Before the fix an env key's principal id was `bearer:<first 8 chars>`, so
 * `sk-live-alpha…` and `sk-live-bravo…` were one principal: one A2A budget in a
 * tenant, one MCP budget across tenants, one audit identity — and the issuer
 * check matched ANY configured key with the prefix, so a delegation minted by a
 * removed key stayed OWNER while a sibling key survived.
 *
 * Every key below starts `sk-live-` on purpose. Legs, each against the real path:
 *  - the A2A task record carries a distinct principal per key (auth middleware);
 *  - A2A per-principal budgets are separate inside ONE tenant;
 *  - MCP budgets are separate across tenants (the MCP bucket has no tenant);
 *  - MCP audit rows name each key distinctly;
 *  - the issuer check: a new-form id matches only its own key, and not after
 *    that key is removed even though a sibling shares its prefix; a legacy
 *    8-char id matches nothing, even when exactly one configured key has the
 *    prefix (CHAN-F14 deleted that rule);
 *  - the delegation readers in `accessControlService.ts` are tenant-bound: a
 *    key re-scoped away from the tenant its delegation lives in stops vouching.
 *
 * The expected ids are LITERALS, never `envKeyPrincipalId(...)`: the derivation
 * (`bearer:` + the first 16 hex of SHA-256 over the full key) is a stored-state
 * contract (delegation `createdBy`, run actors, audit rows), so a change to it
 * must red here. Derived independently of the product:
 * `printf %s sk-live-alpha-0001 | shasum -a 256 | cut -c1-16` (and the same for
 * the bravo and xray keys).
 *
 * The LEGACY case pins the CHAN-F14 cure (2026-11-12): the unique-prefix rule
 * ADR 1045 accepted is deleted, because after a same-prefix rotation the unique
 * holder vouched for the rotated-out key's legacy records (review C1). Stored
 * legacy ids were rewritten first (`legacy-bearer-id-rewrite`).
 *
 * Sabotage-witnessed 2026-11-05 (each applied alone, the named legs went red,
 * then restored and `git diff` checked exact): see ADR 1045 § "Env-key principal
 * collision" for the table (S1 principal back to `slice(0, 8)`; S2 legacy
 * uniqueness dropped; S3 legacy tenant binding dropped; S4 issuer check back to
 * the prefix loop; S5 the three delegation readers back to tenant-less).
 * Re-witnessed by /grade-tests wave 91 (TST-GRA-1): S1, S2, S3, S5 at each reader
 * and at the shared `isConfiguredOperatorIssuerFor` wrapper, the new-form tenant
 * binding, the `*` wildcard, the derivation hashing only 8 chars (the audit case
 * now reds on it too) and the audit row's principal truncated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getA2aTask } from '../src/host/a2aTaskStore.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';
import { listChain } from '../src/host/auditChainService.js';
import { AUDIT_KIND_MCP_DECIDED } from '../src/host/mcpAudit.js';
import { envKeyPrincipalId, isConfiguredEnvKeyIssuer } from '../src/middleware/envKeyPrincipal.js';
import { isConfiguredOperatorIssuerFor } from '../src/host/delegatedSubject.js';
import { delegationIssuerIsLive, delegationIssuerScopes, resolveEffectiveAccess } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SUPERVISOR = 'core.openwop.agents.supervisor.default';
const T1 = 'adr1045-envkey-t1';
const T2 = 'adr1045-envkey-t2';
// Same first 8 characters (`sk-live-`), different keys.
const KEY_A = 'sk-live-alpha-0001';
const KEY_B = 'sk-live-bravo-0002';
const KEY_X = 'sk-live-xray-0003';
const LEGACY = 'bearer:sk-live-'; // what all three were before the fix
// sha256(<key>) first 16 hex, computed with shasum outside the product (header).
const ID_A = 'bearer:bf01d5320e77893e';
const ID_B = 'bearer:f13cf3ab7561be6d';
const ID_X = 'bearer:d38aa1fdc1efadd2';
const BOOT_KEYS = `${KEY_A}:${T1},${KEY_B}:${T1},${KEY_X}:${T2}`;
const ENV_KEYS = [
  'OPENWOP_STORAGE_DSN', 'OPENWOP_A2A_SERVER_ENABLED', 'OPENWOP_A2A_DURABLE_TASKS', 'OPENWOP_MCP_SERVER_ENABLED', 'OPENWOP_API_KEYS',
  'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_ANON_ACTOR_ENABLED',
  'OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN', 'OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN', 'OPENWOP_RATELIMIT_IP_REQS_PER_MIN', 'OPENWOP_KEY_AUTHORITY',
];
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let BASE = '';

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = BOOT_KEYS;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '100000';
  process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '100000';
  process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN = '100000';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
  delete process.env.OPENWOP_KEY_AUTHORITY;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** Run `fn` with a different key configuration, then put the boot one back. */
async function withKeys<T>(keys: string, fn: () => Promise<T> | T): Promise<T> {
  process.env.OPENWOP_API_KEYS = keys;
  try { return await fn(); } finally { process.env.OPENWOP_API_KEYS = BOOT_KEYS; }
}

interface RpcBody { result?: Record<string, unknown>; error?: { code?: number; message?: string } }
const a2aSend = (token: string): Promise<Response> => fetch(`${BASE}/host/openwop-app/a2a`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { agentId: SUPERVISOR, message: { parts: [{ kind: 'text', text: 'hello' }] } } }),
});
/** A run-starting MCP method under an unserved revision: it spends the
 *  per-principal budget, then is refused (400) and audited. No run starts. */
const mcpCall = (token: string): Promise<Response> => fetch(`${BASE}/host/openwop-app/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'MCP-Protocol-Version': '1999-01-01' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adr1045-none', arguments: {} } }),
});

function str(v: unknown): string {
  expect(typeof v).toBe('string');
  return String(v);
}

/** The principal id the REAL auth path minted for `token`, read off its A2A task. */
async function mintedPrincipal(token: string): Promise<string> {
  const id = str(((await (await a2aSend(token)).json()) as RpcBody).result?.id);
  return str((await getA2aTask(id))?.principalId);
}

describe('TST-FUD-GC-1 — same-prefix env keys are distinct principals', () => {
  it('the auth middleware mints a distinct, full-key-derived id per key', async () => {
    const a = await mintedPrincipal(KEY_A);
    const b = await mintedPrincipal(KEY_B);
    expect(a).not.toBe(b);
    expect(a).toBe(ID_A);
    expect(b).toBe(ID_B);
    expect(envKeyPrincipalId(KEY_X)).toBe(ID_X);
    expect(a).toMatch(/^bearer:[0-9a-f]{16}$/);
    // No raw key material in the id.
    expect(a).not.toContain('sk-live');
  });

  it('A2A per-principal budgets are separate for two same-prefix keys in ONE tenant', async () => {
    _resetRateLimitState();
    process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '2';
    try {
      expect((await a2aSend(KEY_A)).status).toBe(200);
      expect((await a2aSend(KEY_A)).status).toBe(200);
      const third = await a2aSend(KEY_A);
      expect(third.status).toBe(429);
      expect(((await third.json()) as { details?: { reason?: string } }).details?.reason).toBe('a2a_principal_rate');
      // Same tenant, same 8-char prefix, its own bucket.
      expect((await a2aSend(KEY_B)).status).toBe(200);
    } finally {
      process.env.OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN = '100000';
      _resetRateLimitState();
    }
  });

  it('MCP per-principal budgets are separate for two same-prefix keys in DIFFERENT tenants', async () => {
    _resetRateLimitState();
    process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN = '2';
    try {
      expect((await mcpCall(KEY_A)).status).toBe(400);
      expect((await mcpCall(KEY_A)).status).toBe(400);
      const third = await mcpCall(KEY_A);
      expect(third.status).toBe(429);
      expect(((await third.json()) as { details?: { reason?: string } }).details?.reason).toBe('mcp_principal_rate');
      // KEY_X is in another tenant and shares only the prefix: not throttled.
      expect((await mcpCall(KEY_X)).status).toBe(400);
    } finally {
      process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN = '100000';
      _resetRateLimitState();
    }
  });

  it('MCP audit rows name each same-prefix key as its own principal', async () => {
    _resetRateLimitState();
    const principalsOfRefusals = async (): Promise<string[]> => (await listChain(T1))
      .filter((e) => e.kind === AUDIT_KIND_MCP_DECIDED && e.payload.outcome === 'version_refused')
      .map((e) => String(e.payload.principal));
    const before = (await principalsOfRefusals()).length;
    expect((await mcpCall(KEY_A)).status).toBe(400);
    expect((await mcpCall(KEY_B)).status).toBe(400);
    const rows = (await principalsOfRefusals()).slice(before);
    expect(rows).toEqual([ID_A, ID_B]);
    expect(rows).not.toContain(LEGACY);
  });
});

describe('TST-FUD-GC-1 — the operator-issuer check vouches only for the key that minted', () => {
  it('a new-form issuer matches only its own key (and that key\'s tenant binding)', async () => {
    const a = await mintedPrincipal(KEY_A);
    const r = await withKeys(`${KEY_A}:${T1}`, () => ({
      any: isConfiguredEnvKeyIssuer(a),
      t1: isConfiguredOperatorIssuerFor(a, T1),
      t2: isConfiguredOperatorIssuerFor(a, T2),
      // A sibling with the same prefix is not configured, so its id is nobody.
      sibling: isConfiguredEnvKeyIssuer(ID_B),
    }));
    expect(r).toEqual({ any: true, t1: true, t2: false, sibling: false });
  });

  it('removing key A leaves A\'s issuer NOT operator even though B shares A\'s prefix', async () => {
    const a = await mintedPrincipal(KEY_A);
    const r = await withKeys(`${KEY_B}:${T1}`, () => ({
      any: isConfiguredEnvKeyIssuer(a),
      t1: isConfiguredOperatorIssuerFor(a, T1),
      survivor: isConfiguredEnvKeyIssuer(ID_B),
    }));
    expect(r).toEqual({ any: false, t1: false, survivor: true });
  });

  it('a LEGACY 8-char issuer matches nothing, even when exactly one configured key has that prefix (CHAN-F14)', async () => {
    // The case the deleted rule admitted: one configured key holds the prefix.
    const unique = await withKeys(`${KEY_A}:${T1},other-prefix-key:${T2}`, () => ({
      any: isConfiguredEnvKeyIssuer(LEGACY),
      t1: isConfiguredOperatorIssuerFor(LEGACY, T1),
      // The same key's NEW id still matches, so the refusal is the legacy form's.
      current: isConfiguredOperatorIssuerFor(ID_A, T1),
    }));
    expect(unique).toEqual({ any: false, t1: false, current: true });
    // A short key's legacy id was the whole key; it matches nothing either.
    const short = await withKeys(`short:${T1}`, () => isConfiguredOperatorIssuerFor('bearer:short', T1));
    expect(short).toBe(false);
  });
});

describe('TST-FUD-GC-1 follow-up — the delegation readers bind the issuer to the delegation\'s tenant', () => {
  it('a key re-scoped from T1 to T2 stops vouching for the delegations it minted in T1', async () => {
    const { key } = await issueApiKey({ tenantId: T1, name: 'op-minted', createdBy: ID_A, scopes: ['workspace:read'] });
    const subject = `apikey:${key.keyId}`;
    const read = async (): Promise<{ live: boolean; issuerScopes: readonly string[]; effective: readonly string[] }> => ({
      live: await delegationIssuerIsLive(T1, subject),
      issuerScopes: await delegationIssuerScopes(T1, ID_A),
      effective: (await resolveEffectiveAccess(T1, { subject })).scopes,
    });
    const home = await withKeys(`${KEY_A}:${T1}`, read);
    expect(home.live).toBe(true);
    expect(home.issuerScopes).toContain('workspace:write');
    expect(home.effective).toEqual(['workspace:read']);
    const moved = await withKeys(`${KEY_A}:${T2}`, read);
    expect(moved).toEqual({ live: false, issuerScopes: [], effective: [] });
    // A wildcard key still vouches in every tenant.
    const wildcard = await withKeys(`${KEY_A}:*`, read);
    expect(wildcard.live).toBe(true);
  });
});
