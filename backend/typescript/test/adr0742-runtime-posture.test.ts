/**
 * ADR 0742 — runtime posture admin. Read-only against Cloud Run: live posture
 * read back from the Admin API, and audited change requests that carry commands
 * and apply NOTHING.
 *
 * The two properties the owner required, each pinned so it can go red:
 *  - the change request accepts EXACTLY `{ warm: boolean }`: an extra field
 *    (image, env, scaling) is refused, never passed through;
 *  - a configuration change whose revision is at 0 % traffic is reported as
 *    NOT live, and the posture shown is the SERVING revision's, never the
 *    template's (ADR 0631: a config update lands at 0 % when traffic is pinned).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { changeCommands, derivePosture, revisionPosture, validateChangeRequest } from '../src/features/runtime-posture/service.js';
import { superadminHint } from '../src/host/superadmin.js';

const rev = (name: string, min: number, cpuIdle: boolean) => ({
  name: `projects/p/locations/us-central1/services/svc/revisions/${name}`,
  scaling: { minInstanceCount: min },
  containers: [{ resources: { limits: { cpu: '2', memory: '1Gi' }, cpuIdle } }],
});
/** Pinned to rev-1 by name; rev-2 (the new config) created and Ready at 0 %. */
const pinnedService = {
  latestCreatedRevision: 'projects/p/locations/us-central1/services/svc/revisions/rev-2',
  latestReadyRevision: 'projects/p/locations/us-central1/services/svc/revisions/rev-2',
  trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'rev-1', percent: 100 }],
};

describe('validateChangeRequest — exactly { warm: boolean }', () => {
  it('accepts the two legal bodies', () => {
    expect(validateChangeRequest({ warm: true })).toEqual({ warm: true });
    expect(validateChangeRequest({ warm: false })).toEqual({ warm: false });
  });
  it('refuses any extra field, a wrong type, an empty body, an array', () => {
    for (const bad of [{ warm: true, image: 'gcr.io/evil' }, { warm: true, env: { A: '1' } }, { warm: true, maxInstances: 99 }, {}, { warm: 'yes' }, [true], null, 'warm']) {
      expect(() => validateChangeRequest(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('derivePosture — the serving revision, never a 0 %-traffic one', () => {
  it('a change whose revision is at 0 % is NOT live, and the posture shown is the serving one', () => {
    const p = derivePosture({ service: pinnedService, servingRevision: rev('rev-1', 0, true), serviceName: 'svc', project: 'p', region: 'us-central1', now: new Date(0) });
    expect(p.rollout).toBe('not-live');
    expect(p.pendingRevision).toBe('rev-2');
    expect(p.servingRevision).toBe('rev-1');
    expect(p.serving?.posture, 'rev-2 carries the warm config, but it serves nothing').toBe('cold');
  });
  it('settled once the newest revision serves 100 %', () => {
    const svc = { ...pinnedService, trafficStatuses: [{ revision: 'rev-2', percent: 100 }] };
    const p = derivePosture({ service: svc, servingRevision: rev('rev-2', 1, false), serviceName: 'svc', project: 'p', region: 'us-central1', now: new Date(0) });
    expect(p.rollout).toBe('settled');
    expect(p.pendingRevision).toBeNull();
    expect(p.serving?.posture).toBe('warm');
  });
  it('split traffic has no serving revision and is never "settled"', () => {
    const svc = { ...pinnedService, trafficStatuses: [{ revision: 'rev-1', percent: 50 }, { revision: 'rev-2', percent: 50 }] };
    expect(derivePosture({ service: svc, servingRevision: null, serviceName: 'svc', project: 'p', region: 'us-central1', now: new Date(0) }).rollout).toBe('not-live');
  });
  it('maps the named postures, and anything else is custom', () => {
    expect(revisionPosture(rev('a', 1, false)).posture).toBe('warm');
    expect(revisionPosture(rev('b', 0, true)).posture).toBe('cold');
    expect(revisionPosture(rev('c', 1, true)).posture).toBe('custom');
  });
  it('costs the warm posture from the serving revision’s own resources', () => {
    const p = derivePosture({ service: pinnedService, servingRevision: rev('rev-1', 0, true), serviceName: 'svc', project: 'p', region: 'us-central1', now: new Date(0) });
    // (2 vCPU × 0.000018 + 1 GiB × 0.000002) × 30 days
    expect(p.monthlyCostUsd.warm).toBeCloseTo(98.5, 1);
    expect(p.monthlyCostUsd.cold).toBe(0);
  });
});

describe('changeCommands — built from the two named postures only', () => {
  it('warm and cold map to min-instances + CPU allocation, and shift traffic by name', () => {
    const where = { service: 'svc', project: 'p', region: 'us-central1' };
    const w = changeCommands(true, where).join('\n');
    const c = changeCommands(false, where).join('\n');
    expect(w).toContain('--min-instances 1 --no-cpu-throttling');
    expect(c).toContain('--min-instances 0 --cpu-throttling');
    for (const s of [w, c]) {
      expect(s).toContain('--to-revisions "$REV=100"');
      expect(s).not.toMatch(/--to-latest|--image|--set-env|--update-env|--set-secrets/);
    }
  });
});

describe('routes (superadmin, HTTP)', () => {
  let server: http.Server;
  let BASE: string;
  let storage: Storage;
  const PATH = '/v1/host/openwop-app/runtime-posture';
  const admin = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.K_SERVICE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage as Storage;
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.K_SERVICE; });

  /** Cloud Run as seen from inside: metadata server + Admin API v2, pinned to rev-1. */
  function stubCloudRun(): void {
    process.env.K_SERVICE = 'svc';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith('/project/project-id')) return new Response('p');
      if (url.endsWith('/instance/region')) return new Response('projects/1/regions/us-central1');
      if (url.includes('/service-accounts/default/token')) return json({ access_token: 't' });
      if (url === 'https://run.googleapis.com/v2/projects/p/locations/us-central1/services/svc') return json(pinnedService);
      if (url.endsWith('/revisions/rev-1')) return json(rev('rev-1', 0, true));
      return realFetch(input, init);
    });
  }

  it('denies a non-superadmin (anon session) — 403', async () => {
    expect((await realFetch(`${BASE}${PATH}`)).status).toBe(403);
  });

  it('off Cloud Run: GET says unavailable (never an invented posture), POST issues nothing (409)', async () => {
    const g = await realFetch(`${BASE}${PATH}`, { headers: admin });
    expect(await g.json()).toMatchObject({ available: false });
    const p = await realFetch(`${BASE}${PATH}/change-requests`, { method: 'POST', headers: admin, body: JSON.stringify({ warm: true }) });
    expect(p.status).toBe(409);
  });

  it('an EXTRA FIELD is refused 400 even when the posture is readable (nothing passes through)', async () => {
    stubCloudRun();
    const p = await realFetch(`${BASE}${PATH}/change-requests`, { method: 'POST', headers: admin, body: JSON.stringify({ warm: true, image: 'gcr.io/evil/x' }) });
    expect(p.status).toBe(400);
    expect((await storage.listAudit({ actionPrefix: 'runtime_posture.' })).length, 'a refused request writes no audit row').toBe(0);
  });

  it('GET reports a 0 %-traffic config change as NOT live, with the serving revision’s posture', async () => {
    stubCloudRun();
    const body = await (await realFetch(`${BASE}${PATH}`, { headers: admin })).json();
    expect(body).toMatchObject({ available: true, rollout: 'not-live', pendingRevision: 'rev-2', servingRevision: 'rev-1', serving: { posture: 'cold' } });
  });

  it('POST { warm: true } issues an audited change request with commands, and applies nothing', async () => {
    stubCloudRun();
    const calls: string[] = [];
    const spy = vi.mocked(globalThis.fetch);
    const p = await realFetch(`${BASE}${PATH}/change-requests`, { method: 'POST', headers: admin, body: JSON.stringify({ warm: true }) });
    expect(p.status).toBe(201);
    const body = (await p.json()) as { commands: string[] };
    expect(body).toMatchObject({ from: 'cold', to: 'warm', servingRevision: 'rev-1' });
    expect(body.commands.join('\n')).toContain('--min-instances 1 --no-cpu-throttling');
    for (const c of spy.mock.calls) calls.push(`${(c[1] as any)?.method ?? 'GET'} ${String(c[0])}`);
    expect(calls.filter((c) => c.includes('run.googleapis.com') && !c.startsWith('GET')), 'no write ever reaches Cloud Run').toEqual([]);
    const audit = await storage.listAudit({ actionPrefix: 'runtime_posture.' });
    expect(audit[0]).toMatchObject({ action: 'runtime_posture.change_requested', resource: 'p/us-central1/svc' });
    expect(audit[0]!.payload).toMatchObject({ from: 'cold', to: 'warm', servingRevision: 'rev-1', pendingRevision: 'rev-2' });
  });
});

describe('ADR 0742 defect 2 — the 403 hint names only doors this deployment HAS', () => {
  // MEASURED on rev 00737-vkq by a peer session: the old hint offered "the admin
  // bearer key". OPENWOP_ADMIN_TOKEN bypasses session auth only under
  // /v1/host/openwop-app/admin, so it 401s here, and every configured key is
  // tenant-scoped (ADR 0561), so each 403s. The allowlist was the only real door.
  const keys = process.env.OPENWOP_API_KEYS;
  const single = process.env.OPENWOP_API_KEY;
  afterEach(() => {
    if (keys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = keys;
    if (single === undefined) delete process.env.OPENWOP_API_KEY; else process.env.OPENWOP_API_KEY = single;
  });

  it('tenant-scoped keys only: the hint names the allowlist and NOTHING else', () => {
    process.env.OPENWOP_API_KEYS = 'k1:conformance-prod,k2:tenant-b';
    delete process.env.OPENWOP_API_KEY;
    const hint = superadminHint();
    expect(hint).toContain('OPENWOP_SUPERADMIN_TENANTS');
    expect(hint, 'the admin token cannot authenticate this surface').not.toMatch(/admin bearer|admin token|OPENWOP_ADMIN_TOKEN/i);
    expect(hint, 'no wildcard key is configured, so that door does not exist here').not.toMatch(/API key/i);
  });

  it('a cross-tenant key IS configured: the hint may name it', () => {
    process.env.OPENWOP_API_KEYS = 'k1:conformance-prod,kop:*';
    delete process.env.OPENWOP_API_KEY;
    const hint = superadminHint();
    expect(hint).toContain('OPENWOP_SUPERADMIN_TENANTS');
    expect(hint).toMatch(/API key/i);
  });
});
