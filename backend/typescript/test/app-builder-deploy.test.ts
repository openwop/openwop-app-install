/**
 * ADR 0424 — the governed deploy slice (DECIDE-1 ratified: Cloud Run lane,
 * mock-first). Invariants: idempotent deploys (deterministic key — a replay
 * never re-deploys), rollback via revisions, SYMBOLIC env keys only (a
 * value-shaped entry is a typed 422), honest-off without a provider AND
 * without the sub-toggle, tenant isolation on records.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { makeMockDeployAdapter } from '../src/features/app-builder/deploy/adapter.js';
import { startDeploy, rollbackDeploy, getDeployment, parseEnvKeys } from '../src/features/app-builder/deploy/deployService.js';

let server: http.Server;
const T = 'tenant-deploy-1';
const HASH = 'a'.repeat(64);
const BASE = { tenantId: T, orgId: 'org-1', service: 'my-app', image: 'gcr.io/p/my-app:v1', exportHash: HASH, envKeys: ['DATABASE_URL'], createdBy: 'u1' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('env keys — the 0343/0349 invariant', () => {
  it('accepts symbolic keys and rejects value-shaped entries', () => {
    expect(parseEnvKeys(['DATABASE_URL', 'API_BASE'])).toEqual(['DATABASE_URL', 'API_BASE']);
    for (const bad of [['DATABASE_URL=postgres://real:secret@host/db'], ['lower_case'], ['HAS SPACE'], ['sk-live-abc']]) {
      expect(() => parseEnvKeys(bad)).toThrowError(/SYMBOLIC/);
    }
  });
});

describe('deploy records', () => {
  it('deploys once, idempotently — identical inputs resolve the record without a second provider call', async () => {
    const adapter = makeMockDeployAdapter();
    const first = await startDeploy(adapter, BASE);
    expect(first.status).toBe('deployed');
    expect(first.revision).toBe('my-app-rev-1');
    expect(adapter.calls.deploy).toBe(1);
    const again = await startDeploy(adapter, BASE);
    expect(again.deployKey).toBe(first.deployKey);
    expect(adapter.calls.deploy).toBe(1); // NO re-deploy
    // A NEW image = a new deployment (a different deliberate release).
    const v2 = await startDeploy(adapter, { ...BASE, image: 'gcr.io/p/my-app:v2' });
    expect(v2.deployKey).not.toBe(first.deployKey);
    expect(adapter.calls.deploy).toBe(2);
  });

  it('rolls back to a prior revision and records it', async () => {
    const adapter = makeMockDeployAdapter();
    const a = await startDeploy(adapter, { ...BASE, service: 'roll-app', image: 'img:v1' });
    await startDeploy(adapter, { ...BASE, service: 'roll-app', image: 'img:v2' });
    const rolled = await rollbackDeploy(adapter, T, a.deployKey, 'roll-app-rev-1');
    expect(rolled.status).toBe('rolled-back');
    expect(rolled.revision).toBe('roll-app-rev-1');
    await expect(rollbackDeploy(adapter, T, a.deployKey, 'ghost-rev')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('validates service/image/exportHash closed-world', async () => {
    const adapter = makeMockDeployAdapter();
    await expect(startDeploy(adapter, { ...BASE, service: 'Bad_Service!' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(startDeploy(adapter, { ...BASE, image: '' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(startDeploy(adapter, { ...BASE, exportHash: 'nothex' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(startDeploy(adapter, { ...BASE, envKeys: ['X=y'] })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('records are tenant-isolated', async () => {
    const adapter = makeMockDeployAdapter();
    const rec = await startDeploy(adapter, { ...BASE, service: 'iso-app' });
    expect(await getDeployment(T, rec.deployKey)).toBeTruthy();
    expect(await getDeployment('tenant-other', rec.deployKey)).toBeNull();
  });
});

describe('honest-off gates', () => {
  it('the surface refuses without the app-builder.deploy sub-toggle', async () => {
    const { buildAppBuilderSurface } = await import('../src/features/app-builder/surface.js');
    const surface = buildAppBuilderSurface({ tenantId: 'tenant-deploy-toggle', runId: 'run-x' });
    await expect((surface.deployApp as (a: Record<string, unknown>) => Promise<unknown>)({ orgId: 'o', service: 'x-app', image: 'img', exportHash: HASH }))
      .rejects.toMatchObject({ code: 'capability_not_provided' });
  });

  it('the resolver refuses when no provider is configured (outside test opt-in)', async () => {
    const { resolveDeployAdapter } = await import('../src/features/app-builder/deploy/adapter.js');
    const savedVitest = process.env.VITEST;
    const savedEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => resolveDeployAdapter()).toThrowError(/OPENWOP_APP_DEPLOY_PROVIDER/);
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
      if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv; else delete process.env.NODE_ENV;
    }
  });

  it('the pack nodes fail honest without the surface', async () => {
    // @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
    const { nodes } = await import('../../../packs/feature.app-builder.nodes/index.mjs');
    await expect(nodes['feature.app-builder.nodes.deploy-app']({ inputs: {}, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
    await expect(nodes['feature.app-builder.nodes.deployment-status']({ inputs: {}, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

describe('crashed-deploy recovery (architect gate 2026-07-18)', () => {
  it('a stale `deploying` record is re-claimed and settled; a fresh one is never stolen', async () => {
    const adapter = makeMockDeployAdapter();
    const rec = await startDeploy(adapter, { ...BASE, service: 'crash-app' });
    // Simulate a crash: force the record back to `deploying` with a stale timestamp.
    const { deployments } = await import('../src/features/app-builder/deploy/deployService.js');
    await deployments.put({ ...rec, status: 'deploying', updatedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    const recovered = await startDeploy(adapter, { ...BASE, service: 'crash-app' });
    expect(recovered.status).toBe('deployed');
    expect(adapter.calls.deploy).toBe(2); // the re-claim re-drove the provider once
    // FRESH in-flight rows are returned untouched.
    await deployments.put({ ...recovered, status: 'deploying', updatedAt: new Date().toISOString() });
    const untouched = await startDeploy(adapter, { ...BASE, service: 'crash-app' });
    expect(untouched.status).toBe('deploying');
    expect(adapter.calls.deploy).toBe(2); // no steal
  });
});
