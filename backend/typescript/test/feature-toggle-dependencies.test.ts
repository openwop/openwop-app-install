/**
 * Feature dependency graph + disable-lock (ADR 0194).
 *
 * Two layers:
 *  - Unit: the dependency registry (register → dependents/dependencies reverse map).
 *  - Route (createApp): the enforced disable-lock — turning a depended-on feature
 *    OFF while an enabled dependent needs it returns 409 with the blocking ids; the
 *    /admin/dependencies projection reflects the live lock. Backend is the authority
 *    (the lock is observable only through the HTTP boundary), so it is tested there.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  getFeatureDependencies,
  getFeatureDependents,
  registerFeatureDependencies,
  __resetFeatureDependencies,
} from '../src/host/featureToggles/registry.js';

describe('feature dependency registry (unit)', () => {
  beforeEach(() => __resetFeatureDependencies());

  it('reverse-maps dependents from declared dependencies', () => {
    registerFeatureDependencies('email', ['crm']);
    registerFeatureDependencies('forms', ['crm']);
    registerFeatureDependencies('crm', []);
    expect(getFeatureDependencies('email')).toEqual(['crm']);
    expect(getFeatureDependents('crm').sort()).toEqual(['email', 'forms']);
    expect(getFeatureDependents('email')).toEqual([]);
  });

  it('dedupes and last-declaration-wins (hot-reload safe)', () => {
    registerFeatureDependencies('email', ['crm', 'crm']);
    expect(getFeatureDependencies('email')).toEqual(['crm']);
    registerFeatureDependencies('email', []); // a reload that dropped the dep
    expect(getFeatureDependents('crm')).toEqual([]);
  });
});

describe('packPresence tiers (unit, temp pack dir)', () => {
  let dir: string;
  let prevPackDir: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = mkdtempSync(join(tmpdir(), 'owp-packs-'));
    prevPackDir = process.env.OPENWOP_PACK_DIR;
    process.env.OPENWOP_PACK_DIR = dir;
  });

  afterEach(() => {
    if (prevPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
    else process.env.OPENWOP_PACK_DIR = prevPackDir;
  });

  it('reports missing / mounted / installed and the on-disk version', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { packPresence } = await import('../src/packs/registryInstaller.js');

    expect(packPresence('feature.x.nodes')).toEqual({ status: 'missing' });

    // mounted: pack.json present, no trust marker
    mkdirSync(join(dir, 'feature.x.nodes'));
    writeFileSync(join(dir, 'feature.x.nodes', 'pack.json'), JSON.stringify({ name: 'feature.x.nodes', version: '2.0.0' }));
    expect(packPresence('feature.x.nodes')).toEqual({ status: 'mounted', version: '2.0.0' });

    // installed: verified-install trust marker beside the manifest
    writeFileSync(join(dir, 'feature.x.nodes', '.openwop-installed.json'), JSON.stringify({ name: 'feature.x.nodes' }));
    expect(packPresence('feature.x.nodes')).toEqual({ status: 'installed', version: '2.0.0' });
  });
});

describe('feature disable-lock (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> ?? {}),
    };
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  const setStatus = (id: string, status: 'on' | 'off' | 'beta') =>
    jsonFetch(`/v1/host/openwop-app/feature-toggles/admin/configs/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status, bucketUnit: 'tenant', salt: id }),
    });

  it('exposes the email→crm edge (forms decoupled per ADR 0330) + pack presence in the console projection', async () => {
    const { status, body } = await jsonFetch<{
      features: {
        id: string;
        dependsOn: string[];
        dependents: string[];
        blockedByDependents: string[];
        packs: { name: string; version: string; status: string }[];
      }[];
    }>('/v1/host/openwop-app/feature-toggles/admin/features');
    expect(status).toBe(200);
    const email = body.features.find((d) => d.id === 'email');
    expect(email?.dependsOn).toContain('crm');
    const crm = body.features.find((d) => d.id === 'crm');
    expect(crm?.dependents).toContain('email');
    // ADR 0330 — forms is a standalone capture primitive: no forms→crm edge.
    expect(crm?.dependents).not.toContain('forms');
    const forms = body.features.find((d) => d.id === 'forms');
    expect(forms?.dependsOn).toEqual([]);
    // Packs projection (ADR 0194 Phase 2): email pins its packs; presence is one of
    // the three tiers (env-dependent — the pack dir may or may not be populated).
    expect(email?.packs.map((p) => p.name)).toEqual(
      expect.arrayContaining(['feature.email.nodes', 'feature.email.agents']),
    );
    for (const p of email?.packs ?? []) {
      expect(['installed', 'mounted', 'missing']).toContain(p.status);
    }
  });

  it('blocks disabling crm while an enabled dependent (email) needs it', async () => {
    // crm defaults ON (ADR 0191); enable a dependent, then try to disable crm.
    expect((await setStatus('email', 'on')).status).toBe(200);

    const attempt = await setStatus('crm', 'off');
    expect(attempt.status).toBe(409);
    const body = attempt.body as { error: string; details?: { dependents?: string[] } };
    expect(body.error).toBe('conflict');
    expect(body.details?.dependents).toContain('email');

    // The projection reflects the live lock.
    const { body: graph } = await jsonFetch<{
      features: { id: string; blockedByDependents: string[] }[];
    }>('/v1/host/openwop-app/feature-toggles/admin/features');
    expect(graph.features.find((d) => d.id === 'crm')?.blockedByDependents).toContain('email');
  });

  it('allows disabling crm once no enabled dependent needs it', async () => {
    await setStatus('email', 'off');
    const ok = await setStatus('crm', 'off');
    expect(ok.status).toBe(200);
    // Turning crm back on for hygiene (default state).
    await setStatus('crm', 'on');
  });

  it('disabling crm while forms is enabled succeeds — forms no longer disable-locks it (ADR 0330)', async () => {
    expect((await setStatus('forms', 'on')).status).toBe(200);
    const ok = await setStatus('crm', 'off');
    expect(ok.status).toBe(200);
    // Hygiene: restore defaults.
    await setStatus('crm', 'on');
    await setStatus('forms', 'off');
  });

  // ── ADR 0194 Phase 5 — per-tenant coherence ──
  const putConfig = (id: string, body: Record<string, unknown>) =>
    jsonFetch(`/v1/host/openwop-app/feature-toggles/admin/configs/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ bucketUnit: 'tenant', salt: id, ...body }),
    });

  it('blocks a GLOBAL disable that would orphan a tenant-override-enabled dependent', async () => {
    await setStatus('crm', 'on');
    await setStatus('forms', 'off');
    // email is OFF globally but enabled ONLY for workspace t-x via an override.
    expect((await putConfig('email', { status: 'off', tenantOverrides: { 't-x': { status: 'on' } } })).status).toBe(200);

    // Disabling crm globally orphans email in t-x (email on there, crm off there) —
    // the case Phase 1's global-only check missed.
    const attempt = await putConfig('crm', { status: 'off' });
    expect(attempt.status).toBe(409);
    const body = attempt.body as { details?: { dependents?: string[]; blockers?: { dependentId: string; tenantId: string | null }[] } };
    expect(body.details?.dependents).toContain('email');
    expect(body.details?.blockers).toEqual(
      expect.arrayContaining([{ dependentId: 'email', tenantId: 't-x' }]),
    );

    // Cleanup: clear the override + restore crm.
    await putConfig('email', { status: 'off' });
    await setStatus('crm', 'on');
  });

  it('blocks a per-TENANT disable-override that orphans a dependent enabled in that tenant', async () => {
    await setStatus('crm', 'on');       // crm on globally (and thus for t-y)
    await setStatus('email', 'on');     // email on globally → on for t-y
    // Turning crm OFF for t-y (via override) orphans email in t-y.
    const attempt = await putConfig('crm', { status: 'on', tenantOverrides: { 't-y': { status: 'off' } } });
    expect(attempt.status).toBe(409);
    const body = attempt.body as { details?: { blockers?: { dependentId: string; tenantId: string | null }[] } };
    expect(body.details?.blockers).toEqual(
      expect.arrayContaining([{ dependentId: 'email', tenantId: 't-y' }]),
    );
    await setStatus('email', 'off');
    await setStatus('crm', 'on');
  });

  // ── ADR 0194 Phase 5 — soft-dependency suggestions ──
  it('surfaces soft-dep recommendations in the console (analytics → consent)', async () => {
    await setStatus('consent', 'off'); // ensure the recommend target is off ⇒ actionable
    await setStatus('documents', 'off'); // documents now defaults ON (2026-07-09) — set off so the soft-dep is actionable
    const { body } = await jsonFetch<{
      features: { id: string; recommends: string[]; recommendedOff: string[] }[];
    }>('/v1/host/openwop-app/feature-toggles/admin/features');
    const analytics = body.features.find((f) => f.id === 'analytics');
    expect(analytics?.recommends).toContain('consent');
    expect(analytics?.recommendedOff).toContain('consent');
    // Verified graceful-degradation soft-deps (documents set off above ⇒ actionable).
    const pm = body.features.find((f) => f.id === 'priority-matrix');
    expect(pm?.recommends).toContain('documents');
    expect(pm?.recommendedOff).toContain('documents');
    const strategy = body.features.find((f) => f.id === 'strategy');
    expect(strategy?.recommends).toContain('documents');
    // ADR 0200 Phase 1 — the Campaign Studio chain expressed as soft suggestions.
    const orch = body.features.find((f) => f.id === 'campaign-orchestration');
    expect(orch?.recommends).toEqual(expect.arrayContaining(['campaign-brief', 'campaign-channels']));
    const intel = body.features.find((f) => f.id === 'campaign-intel');
    expect(intel?.recommends).toContain('campaign-connectors');
  });
});
