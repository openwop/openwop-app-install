/**
 * ADR 0835 D1 — the governed-deploy exit (S1).
 *
 * On `origin/main` a deploy named any lowercase-kebab service: the Cloud Run
 * adapter, acting with the HOST's `run.admin` identity, tried `POST` and on any
 * failure fell back to `PATCH /services/<that name>` with the caller's image —
 * so `openwop-app-backend` (or another tenant's or org's app) could be replaced.
 * The spec set no `serviceAccount`, so the image also ran as the project's
 * default compute identity. And any Editor (`runs:create`) could drive it.
 *
 * The adapter legs stub `fetch` and the egress guard: a refusal must happen
 * BEFORE a token is minted, so "fetch was never called" is the oracle. The
 * surface legs boot the app for real orgs, members and roles.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const egressCalls: { url: string; init: { method?: string; body?: string } }[] = [];
vi.mock('../src/host/webhookEgressGuard.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/webhookEgressGuard.js')>()),
  guardedEgressFetch: async (url: string, init: { method?: string; body?: string }) => {
    egressCalls.push({ url, init });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { makeCloudRunAdapter } from '../src/features/app-builder/deploy/adapter.js';
import { buildAppBuilderSurface } from '../src/features/app-builder/surface.js';

const HASH = 'b'.repeat(64);
const NS = 'owa-0123456789ab-shop';
const ENV_KEYS = ['OPENWOP_APP_DEPLOY_GCP_PROJECT', 'OPENWOP_APP_DEPLOY_IMAGE_PREFIXES', 'OPENWOP_APP_DEPLOY_RUNTIME_SA'] as const;
const saved: Record<string, string | undefined> = {};

describe('ADR 0835 D1 — the Cloud Run adapter refuses before it acts', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.OPENWOP_APP_DEPLOY_GCP_PROJECT = 'operator-project';
    process.env.OPENWOP_APP_DEPLOY_IMAGE_PREFIXES = 'us-docker.pkg.dev/operator/apps/';
    process.env.OPENWOP_APP_DEPLOY_RUNTIME_SA = 'owa-runtime@operator-project.iam.gserviceaccount.com';
    fetchCalls = 0;
    egressCalls.length = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }); }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('refuses to deploy over a service it did not namespace — the host backend included', async () => {
    const adapter = makeCloudRunAdapter();
    await expect(adapter.deploy({ service: 'openwop-app-backend', image: 'us-docker.pkg.dev/operator/apps/x:1', envKeys: [] })).rejects.toMatchObject({ code: 'forbidden' });
    expect(fetchCalls, 'no metadata token may be minted for a refused deploy').toBe(0);
    expect(egressCalls).toHaveLength(0);
  });

  it('refuses rollback and status on a raw service name', async () => {
    const adapter = makeCloudRunAdapter();
    await expect(adapter.rollback({ service: 'openwop-app-backend', toRevision: 'openwop-app-backend-00001' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(adapter.status('openwop-app-backend')).rejects.toMatchObject({ code: 'forbidden' });
    expect(fetchCalls).toBe(0);
  });

  it('refuses an image outside the operator registry prefixes (prefix must end in /)', async () => {
    const adapter = makeCloudRunAdapter();
    for (const image of ['docker.io/attacker/miner:latest', 'us-docker.pkg.dev/operator/apps-evil/x:1', 'us-docker.pkg.dev/operator/apps/']) {
      await expect(adapter.deploy({ service: NS, image, envKeys: [] }), image).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(fetchCalls).toBe(0);
  });

  it('is honest-off without an image policy or a runtime identity (501, never "any image" / the default account)', async () => {
    const adapter = makeCloudRunAdapter();
    delete process.env.OPENWOP_APP_DEPLOY_IMAGE_PREFIXES;
    await expect(adapter.deploy({ service: NS, image: 'us-docker.pkg.dev/operator/apps/x:1', envKeys: [] })).rejects.toMatchObject({ code: 'capability_not_provided' });
    process.env.OPENWOP_APP_DEPLOY_IMAGE_PREFIXES = 'us-docker.pkg.dev/operator/apps/';
    delete process.env.OPENWOP_APP_DEPLOY_RUNTIME_SA;
    await expect(adapter.deploy({ service: NS, image: 'us-docker.pkg.dev/operator/apps/x:1', envKeys: [] })).rejects.toMatchObject({ code: 'capability_not_provided' });
    expect(fetchCalls).toBe(0);
  });

  it('pins the deployed revision to the operator runtime identity', async () => {
    const adapter = makeCloudRunAdapter();
    const out = await adapter.deploy({ service: NS, image: 'us-docker.pkg.dev/operator/apps/x:1', envKeys: ['DATABASE_URL'] });
    expect(out.ok).toBe(true);
    const create = egressCalls.find((c) => c.init.method === 'POST');
    expect(create, 'the create call').toBeTruthy();
    expect(create!.url).toContain(`serviceId=${NS}`);
    const spec = JSON.parse(create!.init.body ?? '{}') as { template?: { serviceAccount?: string } };
    expect(spec.template?.serviceAccount).toBe('owa-runtime@operator-project.iam.gserviceaccount.com');
  });
});

// ── the surface: who may deploy ─────────────────────────────────────────────

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['app-builder', 'app-builder.deploy']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}

const H = '/host/openwop-app';

/** A shared tenant: the OWNER created orgs A and B; ADMIN is `admin` of A only;
 *  EDITOR is `editor` of A (it can run workflows — `runs:create`). */
async function fixture() {
  const tenantId = `org:deploy835-${Date.now()}-${n++}`;
  const login = async (who: string) => { const c = client(); const id: string = (await c.post(`${H}/test/login`, { email: `d835-${who}-${n++}@acme.test`, tenantId })).body.user.userId; return { c, id }; };
  const owner = await login('o');
  const admin = await login('a');
  const editor = await login('e');
  const orgA: string = (await owner.c.post(`${H}/orgs`, { name: 'Apps' })).body.orgId;
  const orgB: string = (await owner.c.post(`${H}/orgs`, { name: 'Other' })).body.orgId;
  for (const [who, roles] of [[admin, ['admin']], [editor, ['editor']]] as const) {
    const add = await owner.c.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: who.id, roles });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { tenantId, adminId: admin.id, editorId: editor.id, orgA, orgB };
}

type Deploy = (a: Record<string, unknown>) => Promise<{ deployment: { status: string; cloudRunService?: string; orgId: string } }>;
const deployAs = (tenantId: string, actingUserId?: string): Deploy =>
  buildAppBuilderSurface({ tenantId, runId: 'run-835', ...(actingUserId ? { actingUserId } : {}) }).deployApp as Deploy;
const args = (orgId: string, service = 'shop') => ({ orgId, service, image: 'us-docker.pkg.dev/operator/apps/shop:1', exportHash: HASH, envKeys: [], approval: { action: 'approve' } });
/** Record HASH as one of `tenantId`'s exports (the provenance a deploy must cite). */
async function exported(tenantId: string): Promise<void> {
  const { appendExportLineage } = await import('../src/features/app-builder/export/lineage.js');
  await appendExportLineage(tenantId, 'cv-1', { canvasVersion: 1, target: 'html-css', fileCount: 1, sizeBytes: 1, hash: HASH, assetToken: 't', exportedAt: new Date().toISOString(), warningCount: 0 });
}

describe('ADR 0835 D1 — the deploy surface needs a person with host:app-deploy:manage', () => {
  it('refuses a run with no acting user (a schedule or webhook cannot publish to the internet)', async () => {
    const f = await fixture();
    await expect(deployAs(f.tenantId)(args(f.orgA))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an Editor — runs:create is not deploy authority', async () => {
    const f = await fixture();
    await expect(deployAs(f.tenantId, f.editorId)(args(f.orgA))).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('refuses an admin of org A deploying as org B, and an empty org', async () => {
    const f = await fixture();
    await expect(deployAs(f.tenantId, f.adminId)(args(f.orgB))).rejects.toMatchObject({ httpStatus: 403 });
    await expect(deployAs(f.tenantId, f.adminId)(args(''))).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses a deploy without an approval decision — enforced by the host, not the pack description', async () => {
    const f = await fixture();
    await exported(f.tenantId);
    for (const approval of [undefined, { action: 'reject' }, { action: 'override' }, 'yes']) {
      await expect(deployAs(f.tenantId, f.adminId)({ ...args(f.orgA), approval }), JSON.stringify(approval)).rejects.toMatchObject({ code: 'approval_required' });
    }
  });

  it("refuses an exportHash this workspace never exported (another tenant's, or invented)", async () => {
    const f = await fixture();
    const g = await fixture();
    await exported(g.tenantId); // the hash exists — in ANOTHER tenant
    await expect(deployAs(f.tenantId, f.adminId)(args(f.orgA))).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('lets the org admin deploy, under a name namespaced to the tenant AND org', async () => {
    const f = await fixture();
    const g = await fixture();
    await exported(f.tenantId);
    await exported(g.tenantId);
    const a = await deployAs(f.tenantId, f.adminId)(args(f.orgA));
    expect(a.deployment.status).toBe('deployed');
    expect(a.deployment.cloudRunService).toMatch(/^owa-[0-9a-f]{12}-shop$/);
    const b = await deployAs(g.tenantId, g.adminId)(args(g.orgA));
    expect(b.deployment.cloudRunService, 'the same name in another tenant is another service').not.toBe(a.deployment.cloudRunService);
    const { namespacedServiceName } = await import('../src/features/app-builder/deploy/deployService.js');
    expect(namespacedServiceName(f.tenantId, f.orgB, 'shop'), 'and in another org of the same tenant').not.toBe(a.deployment.cloudRunService);
  });
});

describe('ADR 0835 AB2-CD-2/5 — a failed deploy is retried; a record is read by its org', () => {
  it('re-drives a deploy the provider refused, once it can succeed (no permanent `failed` for the same inputs)', async () => {
    const { startDeploy } = await import('../src/features/app-builder/deploy/deployService.js');
    const { makeMockDeployAdapter } = await import('../src/features/app-builder/deploy/adapter.js');
    const mock = makeMockDeployAdapter();
    let calls = 0;
    const flaky = { ...mock, deploy: async (i: Parameters<typeof mock.deploy>[0]) => { calls += 1; if (calls === 1) throw Object.assign(new Error('no metadata identity'), { code: 'capability_not_provided' }); return mock.deploy(i); } };
    const input = { tenantId: `t-cd2-${n++}`, orgId: 'o1', service: 'retry-app', image: 'img:1', exportHash: HASH, envKeys: [], createdBy: 'u1' };
    const first = await startDeploy(flaky, input);
    expect(first.status).toBe('failed');
    expect(first.error).toContain('capability_not_provided');
    const second = await startDeploy(flaky, input);
    expect(second.status).toBe('deployed');
    expect(second.deployKey).toBe(first.deployKey);
    const third = await startDeploy(flaky, input);
    expect(calls, 'a succeeded deploy stays idempotent').toBe(2);
    expect(third.status).toBe('deployed');
  });

  it('deploymentStatus refuses a member of another org holding the key', async () => {
    const f = await fixture();
    await exported(f.tenantId);
    const a = await deployAs(f.tenantId, f.adminId)(args(f.orgA, 'stat-app'));
    // The editor is in org A (allowed); a fresh member of NO org is refused.
    const outsider: string = (await client().post(`${H}/test/login`, { email: `d835-x-${n++}@acme.test`, tenantId: f.tenantId })).body.user.userId;
    const status = (actingUserId: string) => (buildAppBuilderSurface({ tenantId: f.tenantId, runId: 'r', actingUserId }).deploymentStatus as (a: Record<string, unknown>) => Promise<unknown>)({ deployKey: (a.deployment as unknown as { deployKey: string }).deployKey });
    await expect(status(f.editorId)).resolves.toMatchObject({ deployment: { orgId: f.orgA } });
    await expect(status(outsider)).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe('ADR 0835 D1 — honest-off and the no-caller-named-service ratchet', () => {
  it('an unset provider is a hard 501 outside tests — there is no fallback adapter', async () => {
    const { resolveDeployAdapter } = await import('../src/features/app-builder/deploy/adapter.js');
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV, P: process.env.OPENWOP_APP_DEPLOY_PROVIDER };
    delete process.env.VITEST; delete process.env.OPENWOP_APP_DEPLOY_PROVIDER; process.env.NODE_ENV = 'production';
    try {
      expect(() => resolveDeployAdapter()).toThrow(expect.objectContaining({ code: 'capability_not_provided', httpStatus: 501 }));
      process.env.OPENWOP_APP_DEPLOY_PROVIDER = 'gcp'; // a typo / unknown provider is not a fallback either
      expect(() => resolveDeployAdapter()).toThrow(expect.objectContaining({ httpStatus: 501 }));
    } finally {
      for (const [k, v] of [['VITEST', saved.VITEST], ['NODE_ENV', saved.NODE_ENV], ['OPENWOP_APP_DEPLOY_PROVIDER', saved.P]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('the Cloud Run Admin API is reached from ONE file, and every verb there asserts the namespace first', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = join(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); continue; }
        if (/\.ts$/.test(e) && readFileSync(p, 'utf8').includes('run.googleapis.com')) hits.push(p.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    // The only OTHER references, each reviewed: the runtime-posture GET of the
    // host's OWN service (K_SERVICE from the platform, read-only — ADR 0742) and
    // a comment. Anything new here is a new Cloud Run caller: review its name source.
    const REVIEWED = ['features/publishing/routes.ts', 'features/runtime-posture/liveRead.ts'];
    expect(hits.filter((h) => !REVIEWED.includes(h)).sort()).toEqual(['features/app-builder/deploy/adapter.ts']);
    const adapter = readFileSync(join(SRC, 'features/app-builder/deploy/adapter.ts'), 'utf8');
    const verbs = adapter.slice(adapter.indexOf('export function makeCloudRunAdapter'));
    for (const verb of ['async deploy(', 'async rollback(', 'async status(']) {
      const body = verbs.slice(verbs.indexOf(verb), verbs.indexOf(verb) + 200);
      expect(body, verb).toContain('assertNamespacedService(service)');
    }
  });
});
