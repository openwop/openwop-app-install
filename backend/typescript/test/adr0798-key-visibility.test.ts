/**
 * ADR 0798 — API key visibility, rotation and policy (`KEY-7`, 8, 10, 11, 12,
 * 14, 15), over HTTP where a route exists, in the production posture (RFC 0049
 * enforcement OFF, demo mode ON). The caller is an operator env key in the
 * single-principal `default` tenant, which demo mode resolves as its owner.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { API_KEY_SCAN_PATTERN, isWellFormedApiKey, issueApiKey, listApiKeys, purgeDeadKeys, revokeApiKey, verifyApiKey, keyHintOf, inventoryApiKeys } from '../src/features/developer-keys/apiKeyService.js';
import { invalidateTenantKeyPolicyCache } from '../src/features/developer-keys/tenantKeyPolicyCache.js';
import { listChain } from '../src/host/auditChainService.js';

const TENANT = 'default';
const OPERATOR = 'adr0798-operator-key';
const KEYS = '/host/openwop-app/developer-keys';
const DAY = 86_400_000;
const ALL = { callerSubject: 'x', isAdmin: true } as const;
const PER_TEST = ['OPENWOP_RATELIMIT_APIKEY_REQS_PER_MIN', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_API_KEY_ROTATION_OVERLAP_HOURS'] as const;
const BOOT = ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_DEMO_MODE', 'OPENWOP_API_KEYS'] as const;
const saved: Record<string, string | undefined> = {};
let BASE = ''; let server: http.Server;

beforeAll(async () => {
  for (const k of [...PER_TEST, ...BOOT]) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_API_KEYS = `${OPERATOR}:${TENANT}`;
  for (const k of PER_TEST) delete process.env[k];
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0798', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterEach(async () => {
  for (const k of PER_TEST) delete process.env[k];
  // Leave the workspace policy as found: it is shared state across cases.
  await call('PUT', `${KEYS}/policy`, OPERATOR, { disabled: false, maxLifetimeDays: null });
  invalidateTenantKeyPolicyCache();
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

interface Res { status: number; body: any }
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}
const mint = (over: Record<string, unknown> = {}): Promise<Res> => call('POST', KEYS, OPERATOR, { name: 'k', scopes: ['runs:read'], ...over });
const kindsFor = async (keyId: string): Promise<string[]> =>
  (await listChain(TENANT)).filter((e) => (e.payload as { keyId?: string }).keyId === keyId).map((e) => e.kind);

describe('ADR 0798 KEY-10 — a key can be identified without being usable', () => {
  it('the hint is the prefix plus the first and last four characters, stored at mint and listed', async () => {
    const r = await mint({ name: 'hinted' });
    const token = r.body.token as string;
    expect(r.body.key.hint).toBe(keyHintOf(token));
    expect(r.body.key.hint).toBe(`owk_${token.slice(4, 8)}…${token.slice(-4)}`);
    const listed = (await call('GET', KEYS, OPERATOR)).body.keys.find((k: { keyId: string }) => k.keyId === r.body.key.keyId);
    expect(listed.hint).toBe(r.body.key.hint);
    // Never the token, never the hash — in the row or anywhere in the list.
    const raw = JSON.stringify((await call('GET', KEYS, OPERATOR)).body);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('tokenHash');
  });
});

describe('ADR 0798 KEY-7 — a key’s life is on the audit chain', () => {
  it('create, rotate and revoke each append one entry: ids and scopes, never the key’s name', async () => {
    const r = await mint({ name: 'Very Private Name', scopes: ['runs:read', 'runs:create'] });
    const keyId = r.body.key.keyId as string;
    const rotated = await call('POST', `${KEYS}/${encodeURIComponent(keyId)}/rotate`, OPERATOR, {});
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect((await call('DELETE', `${KEYS}/${encodeURIComponent(rotated.body.key.keyId)}`, OPERATOR)).status).toBe(204);

    expect(await kindsFor(keyId)).toEqual(['apikey.created']);
    expect(await kindsFor(rotated.body.key.keyId)).toEqual(['apikey.rotated', 'apikey.revoked']);
    const chain = await listChain(TENANT);
    const created = chain.find((e) => e.kind === 'apikey.created' && (e.payload as { keyId?: string }).keyId === keyId)!;
    expect(created.payload).toMatchObject({ keyId, scopes: ['runs:read', 'runs:create'] });
    expect(JSON.stringify(chain)).not.toContain('Very Private Name');
    expect(JSON.stringify(chain)).not.toContain(r.body.token);
  });
});

describe('ADR 0798 KEY-12 — rotation with a bounded overlap', () => {
  it('the replacement works, the old key keeps working, and the old key’s end is brought forward to the overlap', async () => {
    const first = await mint({ name: 'ci', scopes: ['runs:read'] });
    const oldToken = first.body.token as string;
    const r = await call('POST', `${KEYS}/${encodeURIComponent(first.body.key.keyId)}/rotate`, OPERATOR, {});
    expect(r.status).toBe(201);
    const newToken = r.body.token as string;
    expect(newToken).not.toBe(oldToken);
    expect(r.body.key).toMatchObject({ name: 'ci', scopes: ['runs:read'], rotatedFrom: first.body.key.keyId });
    expect(r.body.previous.rotatedTo).toBe(r.body.key.keyId);

    expect((await call('GET', '/runs', newToken)).status).toBe(200);
    expect((await call('GET', '/runs', oldToken)).status).toBe(200);
    const oldEnd = Date.parse(r.body.previous.expiresAt);
    expect(oldEnd - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(oldEnd - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    // After the overlap the old key is dead and the new one is not.
    expect(await verifyApiKey(oldToken, Date.now() + 25 * 3_600_000)).toBeNull();
    expect(await verifyApiKey(newToken, Date.now() + 25 * 3_600_000)).not.toBeNull();
  });

  it('an expiry that was already sooner than the overlap is never pushed LATER', async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const first = await mint({ expiresAt: soon });
    const r = await call('POST', `${KEYS}/${encodeURIComponent(first.body.key.keyId)}/rotate`, OPERATOR, {});
    expect(r.body.previous.expiresAt).toBe(soon);
  });

  it('a rotated key cannot be rotated again, a revoked one cannot be rotated, an unknown one is 404', async () => {
    const first = await mint();
    const id = encodeURIComponent(first.body.key.keyId);
    expect((await call('POST', `${KEYS}/${id}/rotate`, OPERATOR, {})).status).toBe(201);
    expect((await call('POST', `${KEYS}/${id}/rotate`, OPERATOR, {})).status).toBe(409);
    const dead = await mint();
    await revokeApiKey(TENANT, dead.body.key.keyId, ALL);
    expect((await call('POST', `${KEYS}/${encodeURIComponent(dead.body.key.keyId)}/rotate`, OPERATOR, {})).status).toBe(409);
    expect((await call('POST', `${KEYS}/dk:nope/rotate`, OPERATOR, {})).status).toBe(404);
  });

  it('a key cannot rotate a key (ADR 0800 D1 holds on the new route)', async () => {
    const first = await mint({ scopes: ['*'] });
    const r = await call('POST', `${KEYS}/${encodeURIComponent(first.body.key.keyId)}/rotate`, first.body.token, {});
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe('key_cannot_manage_keys');
  });
});

describe('ADR 0798 KEY-14 — dead keys are kept for a while, then deleted', () => {
  it('a revoked key survives inside the retention window and is purged after it; a live key is never purged', async () => {
    const t = 'adr0798-retention';
    const dead = await issueApiKey({ tenantId: t, name: 'dead', createdBy: 'user:r' });
    const live = await issueApiKey({ tenantId: t, name: 'live', createdBy: 'user:r' });
    await revokeApiKey(t, dead.key.keyId, ALL);
    expect(await purgeDeadKeys(t, Date.now() + 30 * DAY)).toBe(0);
    expect((await listApiKeys(t, ALL)).length).toBe(2);
    expect(await purgeDeadKeys(t, Date.now() + 91 * DAY)).toBe(1);
    expect((await listApiKeys(t, ALL)).map((k) => k.keyId)).toEqual([live.key.keyId]);
    expect(await verifyApiKey(live.token)).not.toBeNull();
  });

  it('an expired key ages from its expiry, not from its creation', async () => {
    const t = 'adr0798-retention-exp';
    const k = await issueApiKey({ tenantId: t, name: 'e', createdBy: 'user:r', expiresAt: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(await purgeDeadKeys(t, Date.now() + 95 * DAY), 'expired 85 days ago: kept').toBe(0);
    expect(await purgeDeadKeys(t, Date.now() + 101 * DAY), 'expired 91 days ago: purged').toBe(1);
    expect((await listApiKeys(t, ALL)).some((x) => x.keyId === k.key.keyId)).toBe(false);
  });
});

describe('ADR 0798 KEY-8 — one rate bucket per key', () => {
  it('a key is throttled as ONE caller; another key and the operator key are not caught in it', async () => {
    process.env.OPENWOP_RATELIMIT_APIKEY_REQS_PER_MIN = '3';
    const a = (await mint()).body.token as string;
    const b = (await mint()).body.token as string;
    for (let i = 0; i < 3; i++) expect((await call('GET', '/runs', a)).status, `request ${i + 1}`).toBe(200);
    const fourth = await call('GET', '/runs', a);
    expect(fourth.status).toBe(429);
    expect(JSON.stringify(fourth.body)).toContain('api_key_rate');
    expect((await call('GET', '/runs', b)).status).toBe(200);
    expect((await call('GET', '/runs', OPERATOR)).status).toBe(200);
  });

  it('0 turns the per-key bucket off', async () => {
    process.env.OPENWOP_RATELIMIT_APIKEY_REQS_PER_MIN = '0';
    const a = (await mint()).body.token as string;
    for (let i = 0; i < 6; i++) expect((await call('GET', '/runs', a)).status).toBe(200);
  });

  it('last-used records where the key was presented from', async () => {
    const r = await mint();
    await fetch(`${BASE}/runs`, { headers: { authorization: `Bearer ${r.body.token}`, 'user-agent': 'adr0798-probe/1.0', connection: 'close' } });
    let row: { lastUsedAgent?: string; lastUsedIp?: string } | undefined;
    for (let i = 0; i < 100 && !row?.lastUsedAgent; i++) {
      await new Promise((res) => setTimeout(res, 10));
      row = (await listApiKeys(TENANT, ALL)).find((k) => k.keyId === r.body.key.keyId);
    }
    expect(row?.lastUsedAgent).toBe('adr0798-probe/1.0');
    expect(row?.lastUsedIp).toBeTruthy();
  });
});

describe('ADR 0798 KEY-15 — the workspace’s own rules', () => {
  it('turning keys off refuses new keys AND stops existing ones; turning them on restores both', async () => {
    const existing = (await mint()).body.token as string;
    expect((await call('GET', '/runs', existing)).status).toBe(200);
    const off = await call('PUT', `${KEYS}/policy`, OPERATOR, { disabled: true });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.effective.disabled).toBe(true);

    const refused = await mint();
    expect(refused.status).toBe(403);
    expect(refused.body.details?.code).toBe('keys_disabled');
    expect((await call('GET', '/runs', existing)).status).toBe(401);
    expect((await call('GET', KEYS, OPERATOR)).body.policy.disabled).toBe(true);

    expect((await call('PUT', `${KEYS}/policy`, OPERATOR, { disabled: false })).status).toBe(200);
    expect((await call('GET', '/runs', existing)).status).toBe(200);
    expect((await mint()).status).toBe(201);
  });

  it('a workspace cap tightens the lifetime: the default follows it and a longer request is refused', async () => {
    expect((await call('PUT', `${KEYS}/policy`, OPERATOR, { maxLifetimeDays: 30 })).status).toBe(200);
    const d = await mint();
    expect(Date.parse(d.body.key.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * DAY + 1000);
    const tooFar = await mint({ expiresAt: new Date(Date.now() + 60 * DAY).toISOString() });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.details?.code).toBe('expiry_too_far');
    expect((await call('GET', KEYS, OPERATOR)).body.policy).toMatchObject({ maxLifetimeDays: 30, defaultLifetimeDays: 30 });
  });

  it('a cap can only tighten: 9999 days is a 400, and a cap above the deployment’s changes nothing', async () => {
    expect((await call('PUT', `${KEYS}/policy`, OPERATOR, { maxLifetimeDays: 9999 })).status).toBe(400);
    expect((await call('PUT', `${KEYS}/policy`, OPERATOR, { maxLifetimeDays: 3000 })).status).toBe(200);
    expect((await call('GET', KEYS, OPERATOR)).body.policy.maxLifetimeDays).toBe(366);
  });

  it('a key cannot read or change the policy; changing it is on the audit chain', async () => {
    const k = (await mint({ scopes: ['*'] })).body.token as string;
    expect((await call('PUT', `${KEYS}/policy`, k, { disabled: true })).status).toBe(403);
    expect((await call('GET', `${KEYS}/policy`, k)).status).toBe(403);
    await call('PUT', `${KEYS}/policy`, OPERATOR, { maxLifetimeDays: 45 });
    expect((await listChain(TENANT)).some((e) => e.kind === 'apikey.policy-changed' && (e.payload as { maxLifetimeDays?: number }).maxLifetimeDays === 45)).toBe(true);
  });
});

describe('ADR 0798 KEY-11 — the host-wide inventory', () => {
  it('needs a superadmin, and reports shapes — no names, hashes, hints or tokens', async () => {
    expect((await call('GET', `${KEYS}/inventory`, OPERATOR)).status).toBe(403);
    process.env.OPENWOP_SUPERADMIN_TENANTS = TENANT;
    await issueApiKey({ tenantId: 'ws:adr0798-inv', name: 'Secret Name', createdBy: 'apikey:dk:parent' });
    const r = await call('GET', `${KEYS}/inventory`, OPERATOR);
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.counts['live.issuer.key'], 'a key issued by a key is what the inventory exists to find').toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(r.body);
    for (const leak of ['Secret Name', 'tokenHash', 'owk_', '"name"', '"hint"']) expect(raw, leak).not.toContain(leak);
  });

  it('counts what matters: undeclared, never-expiring, unparseable', async () => {
    const t = 'adr0798-inv-shapes';
    await issueApiKey({ tenantId: t, name: 'a', createdBy: 'user:i' });
    await issueApiKey({ tenantId: t, name: 'b', createdBy: 'user:i', scopes: ['runs:read'], expiresAt: 'tomorrow' });
    const inv = await inventoryApiKeys();
    const mine = inv.rows.filter((row) => row.tenantShape === 'named');
    expect(mine.some((row) => row.declaration === 'undeclared' && row.expiry === 'none')).toBe(true);
    expect(mine.some((row) => row.expiry === 'unparseable')).toBe(true);
  });
});

describe('ADR 0798 D8 (KEY-9) — a key that can be recognised, and revoked by whoever finds it', () => {
  const LEAKED = `${KEYS}/leaked`;
  const flip = (token: string, at: number): string => token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);

  it('a new key carries a checksum: it matches the scanner pattern, and one changed character is not a key', async () => {
    const token = (await mint()).body.token as string;
    expect(token).toMatch(new RegExp(`^${API_KEY_SCAN_PATTERN}$`));
    expect(token.length).toBe(54);
    expect(isWellFormedApiKey(token)).toBe(true);
    expect(isWellFormedApiKey(flip(token, 10))).toBe(false);
    expect(isWellFormedApiKey(flip(token, token.length - 1))).toBe(false);
    expect(isWellFormedApiKey('owk_bogus')).toBe(false);
    expect(isWellFormedApiKey(42)).toBe(false);
    // A corrupted key does not authenticate (and never reached the store).
    expect((await call('GET', '/runs', flip(token, 10))).status).toBe(401);
  });

  it('a key minted before the checksum (prefix + 43 characters) is still well-formed', () => {
    expect(isWellFormedApiKey(`owk_${'a'.repeat(43)}`)).toBe(true);
    expect(isWellFormedApiKey(`owk_${'a'.repeat(42)}`)).toBe(false);
  });

  it('anyone holding a live key can revoke it, with no credential: it stops working, the chain says why', async () => {
    const m = await mint({ name: 'in-a-public-repo' });
    const token = m.body.token as string;
    expect((await call('GET', '/runs', token)).status).toBe(200);
    const r = await call('POST', LEAKED, undefined, [{ token, type: 'openwop_api_key', url: 'https://example.com/acme/repo/blob/main/.env' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual([{ token_raw: token, token_type: 'openwop_api_key', label: 'true_positive' }]);
    expect((await call('GET', '/runs', token)).status).toBe(401);
    const entry = (await listChain(TENANT)).reverse().find((e) => e.kind === 'apikey.revoked' && (e.payload as { keyId?: string }).keyId === m.body.key.keyId)!;
    expect(entry.payload).toMatchObject({ reason: 'leaked', source: 'https://example.com/acme/repo/blob/main/.env' });
    expect(JSON.stringify(entry.payload)).not.toContain(token);
  });

  it('a look-alike, an unknown key and an already-revoked key are answered without revoking anything', async () => {
    const live = (await mint()).body.token as string;
    const other = (await mint()).body;
    await revokeApiKey(TENANT, other.key.keyId, ALL);
    const unknown = (await issueApiKey({ tenantId: 'adr0798-elsewhere', name: 'x', createdBy: 'user:x' })).token;
    await revokeApiKey('adr0798-elsewhere', (await listApiKeys('adr0798-elsewhere', ALL))[0]!.keyId, ALL);
    const r = await call('POST', LEAKED, undefined, { tokens: ['owk_bogus', flip(live, 12), other.token] });
    expect(r.body.map((x: { label: string }) => x.label)).toEqual(['false_positive', 'false_positive', 'true_positive']);
    expect((await call('GET', '/runs', live)).status, 'a near-miss must not revoke the real key').toBe(200);
    expect(await verifyApiKey(unknown)).toBeNull();
  });

  it('the report is bounded, and the rest of the key routes still need a credential', async () => {
    expect((await call('POST', LEAKED, undefined, [])).status).toBe(400);
    expect((await call('POST', LEAKED, undefined, { tokens: Array.from({ length: 101 }, () => 'owk_x') })).status).toBe(400);
    expect((await call('POST', LEAKED, undefined, [{ token: 'x'.repeat(201) }])).status).toBe(400);
    expect((await call('GET', KEYS)).status).toBe(401);
    expect((await call('POST', KEYS, undefined, { name: 'k', scopes: ['runs:read'] })).status).toBe(401);
    expect((await call('GET', `${KEYS}/inventory`)).status).toBe(401);
  });
});
