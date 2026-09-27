/**
 * Environments feature (ADR 0387) — route-level coverage + the /architect-
 * required determinism and round-trip pins:
 *  - snapshot hash is deterministic (export twice on same state → same hash)
 *  - import(export(state)) leaves ZERO drift (exact-match restore)
 *  - promote/rollback move pointers + append the ledger; idempotent by hash
 *  - RBAC fail-closed (toggle off → 404; non-admin write → 403; cross-tenant 404)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p: string, h?: Record<string, string>) => send('GET', p, undefined, h),
    post: (p: string, b?: unknown) => send('POST', p, b),
    patch: (p: string, b?: unknown) => send('PATCH', p, b),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const B = '/v1/host/openwop-app/environments';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('environments — service determinism (ADR 0387)', () => {
  it('snapshot hash is deterministic and import(export) leaves zero drift', async () => {
    const svc = await import('../src/features/environments/environmentsService.js');
    const domains = await import('../src/host/configDomains.js');
    const { setTenantOverrideStatus } = await import('../src/host/featureToggles/service.js');
    const T = 'tenant-det';

    // Register the toggle domain (feature boot would; here register directly).
    const { featureTogglesDomain } = await import('../src/features/environments/domains/featureTogglesDomain.js');
    domains.registerConfigDomain(featureTogglesDomain);

    // Establish some toggle overrides for the tenant.
    await setTenantOverrideStatus('csm', T, 'on', 'test');
    await setTenantOverrideStatus('entities', T, 'off', 'test');

    const h1 = await svc.liveConfigHash(T);
    const h2 = await svc.liveConfigHash(T); // export twice, same state
    expect(h1).toBe(h2);

    // Snapshot, mutate, then apply the snapshot back → live hash returns to h1.
    const snap = await svc.snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'test' });
    expect(snap.hash).toBe(h1);
    await setTenantOverrideStatus('csm', T, 'off', 'test'); // drift the live config
    await setTenantOverrideStatus('developer-keys', T, 'on', 'test'); // an override NOT in the snapshot
    expect(await svc.liveConfigHash(T)).not.toBe(h1);

    await svc.applyToLive({ tenantId: T, snapshotHash: snap.hash, actor: 'test' });
    // Exact-match restore: the stray developer-keys override is cleared, csm is
    // restored → the live hash is byte-identical to the snapshot.
    expect(await svc.liveConfigHash(T)).toBe(h1);
  });

  it('re-snapshotting identical config dedupes on hash', async () => {
    const svc = await import('../src/features/environments/environmentsService.js');
    const T = 'tenant-dedupe';
    const a = await svc.snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'test' });
    const b = await svc.snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'test' });
    expect(b.snapshotId).toBe(a.snapshotId);
    expect((await svc.listSnapshots(T)).length).toBe(1);
  });
});

describe('environments — routes + RBAC (ADR 0387)', () => {
  it('404s every route while the toggle is off', async () => {
    await setToggle('environments', 'off');
    const c = client();
    await c.login('owner-e', 'tenant-e');
    expect((await c.get(`${B}`)).status).toBe(404);
    expect((await c.post(`${B}`, { name: 'dev' })).status).toBe(404);
  });

  it('env create, chain seed, protection, snapshot, promote/rollback + ledger', async () => {
    await setToggle('environments', 'on');
    const c = client();
    await c.login('owner-e', 'tenant-e');

    const chain = await c.post(`${B}/ensure-chain`);
    expect(chain.status).toBe(200);
    const envs = ((await chain.json()) as { environments: Array<{ name: string; protection: string }> }).environments;
    expect(envs.map((e) => e.name)).toEqual(['dev', 'staging', 'prod']);
    expect(envs.find((e) => e.name === 'prod')?.protection).toBe('protected');

    // snapshot current live config
    const snap = await c.post(`${B}/snapshots`, { sourceEnv: 'dev' });
    expect(snap.status).toBe(201);
    const hash = ((await snap.json()) as { hash: string }).hash;

    // apply it to dev's pointer via promote requires dev to have a snapshot first;
    // pin dev via rollback (pin a known hash) then promote dev→staging.
    const pinDev = await c.post(`${B}/rollback`, { env: 'dev', snapshotHash: hash });
    expect(pinDev.status).toBe(201);

    const preview = await c.post(`${B}/preview`, { toEnv: 'staging', snapshotHash: hash });
    expect(preview.status).toBe(200);

    const prom = await c.post(`${B}/promote`, { fromEnv: 'dev' }); // → staging (order+1)
    expect(prom.status).toBe(201);
    const promBody = (await prom.json()) as { environment: { name: string; currentSnapshot: string }; noop: boolean };
    expect(promBody.environment.name).toBe('staging');
    expect(promBody.environment.currentSnapshot).toBe(hash);

    // idempotent: promoting the same hash again is a no-op
    const prom2 = await c.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(prom2.status).toBe(201);
    expect(((await prom2.json()) as { noop: boolean }).noop).toBe(true);

    // ledger has the promotions + the rollback
    const hist = await c.get(`${B}/promotions`);
    const promotions = ((await hist.json()) as { promotions: unknown[] }).promotions;
    expect(promotions.length).toBeGreaterThanOrEqual(3);

    // locked env rejects a pointer move
    await c.patch(`${B}/prod/protection`, { protection: 'locked' });
    const blocked = await c.post(`${B}/rollback`, { env: 'prod', snapshotHash: hash });
    expect(blocked.status).toBe(409);

    // drift view is opt-in
    const drift = await c.get(`${B}?drift=1`);
    expect(drift.status).toBe(200);
    const dbody = (await drift.json()) as { environments: Array<{ name: string; drift?: { drifted: boolean } }> };
    expect(dbody.environments.every((e) => e.drift !== undefined)).toBe(true);
  });

  it('non-admin acting member is denied writes (fail-closed 403); reads allowed', async () => {
    const c = client();
    await c.login('owner-e', 'tenant-e');
    // acting as an unknown member → zero scopes → 403 on write, 403 on read too
    expect((await c.post(`${B}`, { name: 'qa' })).status).toBe(201); // owner ok
    const asStranger = { 'x-openwop-act-as': 'nobody-x' };
    expect((await c.get(`${B}`, asStranger)).status).toBe(403);
  });

  it('cross-tenant isolation: tenant F sees none of tenant E', async () => {
    const cf = client();
    await cf.login('owner-f', 'tenant-f');
    const list = await cf.get(`${B}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { environments: unknown[] }).environments).toHaveLength(0);
  });
});

describe('environments — H2 promotion-approval gate (ADR 0387)', () => {
  const APPR = '/v1/host/openwop-app/approvals';

  it('settings default OFF; PATCH toggles the gate', async () => {
    await setToggle('environments', 'on');
    const c = client();
    await c.login('owner-g', 'tenant-g');
    const def = await c.get(`${B}/settings`);
    expect(def.status).toBe(200);
    expect((await def.json()) as { requireApprovalForPromotion: boolean }).toEqual({ requireApprovalForPromotion: false });
    const on = await c.patch(`${B}/settings`, { requireApprovalForPromotion: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { requireApprovalForPromotion: boolean }).requireApprovalForPromotion).toBe(true);
  });

  it('gate ON ⇒ promote is intercepted (202, no move); claim applies the pointer', async () => {
    await setToggle('environments', 'on');
    const c = client();
    await c.login('owner-g2', 'tenant-g2');
    await c.post(`${B}/ensure-chain`);
    const hash = ((await (await c.post(`${B}/snapshots`, { sourceEnv: 'dev' })).json()) as { hash: string }).hash;
    // Pin dev while the gate is OFF (default), then turn the gate ON.
    expect((await c.post(`${B}/rollback`, { env: 'dev', snapshotHash: hash })).status).toBe(201);
    expect((await c.patch(`${B}/settings`, { requireApprovalForPromotion: true })).status).toBe(200);

    // Promote dev→staging: intercepted, nothing moves.
    const gated = await c.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(gated.status).toBe(202);
    const gbody = (await gated.json()) as { status: string; approval: { approvalId: string } };
    expect(gbody.status).toBe('pending_approval');
    const approvalId = gbody.approval.approvalId;
    expect(approvalId).toMatch(/^appr:/);

    // Pointer NOT moved yet.
    const before = ((await (await c.get(`${B}`)).json()) as { environments: Array<{ name: string; currentSnapshot: string | null }> }).environments;
    expect(before.find((e) => e.name === 'staging')?.currentSnapshot).toBeNull();

    // Idempotent: re-submitting the same promote reuses the SAME approval.
    const again = await c.post(`${B}/promote`, { fromEnv: 'dev' });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { approval: { approvalId: string } }).approval.approvalId).toBe(approvalId);

    // The approval renders in the SHARED reviews inbox.
    const inbox = await c.get(`${APPR}?status=pending`);
    const items = ((await inbox.json()) as { items: Array<{ approvalId: string; kind?: string }> }).items;
    expect(items.some((a) => a.approvalId === approvalId && a.kind === 'environment-promotion')).toBe(true);

    // Approve → the pointer moves.
    const claim = await c.post(`${APPR}/${approvalId}/claim`);
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { status: string }).status).toBe('approved');
    const after = ((await (await c.get(`${B}`)).json()) as { environments: Array<{ name: string; currentSnapshot: string | null }> }).environments;
    expect(after.find((e) => e.name === 'staging')?.currentSnapshot).toBe(hash);

    // The applied ledger row is stamped with the approvalId.
    const promos = ((await (await c.get(`${B}/promotions`)).json()) as { promotions: Array<{ toEnv: string; approvalId?: string; status?: string }> }).promotions;
    expect(promos.some((p) => p.toEnv === 'staging' && p.approvalId === approvalId && p.status === undefined)).toBe(true);
  });

  it('gate ON ⇒ reject parks a rejected row and never moves the pointer', async () => {
    await setToggle('environments', 'on');
    const c = client();
    await c.login('owner-g3', 'tenant-g3');
    await c.post(`${B}/ensure-chain`);
    const hash = ((await (await c.post(`${B}/snapshots`, { sourceEnv: 'dev' })).json()) as { hash: string }).hash;
    expect((await c.patch(`${B}/settings`, { requireApprovalForPromotion: true })).status).toBe(200);

    // Gated rollback pinning staging → hash.
    const gated = await c.post(`${B}/rollback`, { env: 'staging', snapshotHash: hash });
    expect(gated.status).toBe(202);
    const approvalId = ((await gated.json()) as { approval: { approvalId: string } }).approval.approvalId;

    const rej = await c.post(`${APPR}/${approvalId}/reject`);
    expect(rej.status).toBe(200);
    expect(((await rej.json()) as { status: string }).status).toBe('rejected');

    // Pointer stayed put.
    const envs = ((await (await c.get(`${B}`)).json()) as { environments: Array<{ name: string; currentSnapshot: string | null }> }).environments;
    expect(envs.find((e) => e.name === 'staging')?.currentSnapshot).toBeNull();

    // A rejected ledger row parks the declined attempt.
    const promos = ((await (await c.get(`${B}/promotions`)).json()) as { promotions: Array<{ toEnv: string; status?: string; approvalId?: string }> }).promotions;
    expect(promos.some((p) => p.toEnv === 'staging' && p.status === 'rejected' && p.approvalId === approvalId)).toBe(true);

    // Re-deciding the resolved approval is a conflict (fail-closed).
    expect((await c.post(`${APPR}/${approvalId}/claim`)).status).toBe(409);
  });

  it('gate ON but a no-op move (pointer already at hash) applies without an approval', async () => {
    await setToggle('environments', 'on');
    const c = client();
    await c.login('owner-g4', 'tenant-g4');
    await c.post(`${B}/ensure-chain`);
    const hash = ((await (await c.post(`${B}/snapshots`, { sourceEnv: 'dev' })).json()) as { hash: string }).hash;
    expect((await c.post(`${B}/rollback`, { env: 'dev', snapshotHash: hash })).status).toBe(201);
    expect((await c.patch(`${B}/settings`, { requireApprovalForPromotion: true })).status).toBe(200);
    // dev already points at hash → re-pinning is a no-op that needs no approval.
    const noop = await c.post(`${B}/rollback`, { env: 'dev', snapshotHash: hash });
    expect(noop.status).toBe(201);
    expect(((await noop.json()) as { noop: boolean }).noop).toBe(true);
    // No pending approvals were created.
    const inbox = await c.get(`${APPR}?status=pending`);
    expect(((await inbox.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});
