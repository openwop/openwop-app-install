/**
 * Code Export (ADR 0173) — generator UNIT tests (pure, no boot) + a ROUTE harness
 * (toggle gate, RBAC, IDOR/404, target validation, export → capability-token download,
 * unmapped-component → warning). Extends app-builder; output is a Media asset token.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __putCanvasForTest } from '../src/host/canvasSurface.js';
import { generate, EXPORT_TARGETS } from '../src/features/app-builder/export/generators.js';
import { buildAppBuilderSurface } from '../src/features/app-builder/surface.js';

// ── pure generator unit tests (no app boot needed) ──────────────────────────
const SAMPLE = {
  name: 'Demo App',
  theme: 'light' as const,
  screens: [
    { id: 'home', name: 'Home', isInitial: true, components: [
      { type: 'heading', props: { text: 'Welcome <script>', level: 1 } },
      { type: 'stack', props: { gap: 'md' }, children: [
        { type: 'text', props: { text: 'Hello world' } },
        { type: 'button', props: { label: 'Go', variant: 'primary' } },
      ] },
      { type: 'mysteryWidget', props: {} },
    ] },
    { id: 'about', name: 'About Us', components: [{ type: 'text', props: { text: 'About' } }] },
  ],
};

describe('generate() — all targets', () => {
  it('produces files for every target + escapes text (no raw <script>)', () => {
    for (const target of EXPORT_TARGETS) {
      const { files, warnings } = generate(target, SAMPLE);
      expect(files.length, target).toBeGreaterThan(0);
      const all = files.map((f) => f.content).join('\n');
      // No raw `<script>W…` element injection in ANY target (HTML-family escapes to
      // markup entities; RN escapes; Flutter puts text in a Dart string literal).
      expect(all, target).not.toContain('<script>W');
      // HTML-family targets HTML-escape text; Flutter (Dart string literal) does not.
      if (target !== 'flutter') expect(all, target).toContain('&lt;script&gt;');
      // unmapped component → a warning, never a throw
      expect(warnings.some((w) => w.includes('mysteryWidget')), target).toBe(true);
    }
  });
  it('react-tailwind emits a screen component per screen + an App router', () => {
    const { files } = generate('react-tailwind', SAMPLE);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/screens/Home.jsx');
    expect(paths).toContain('src/screens/AboutUs.jsx');
    expect(paths).toContain('src/App.jsx');
    expect(paths).toContain('package.json');
  });
  it('html-css emits one html per screen + shared css', () => {
    const { files } = generate('html-css', SAMPLE);
    expect(files.some((f) => f.path === 'styles.css')).toBe(true);
    expect(files.filter((f) => f.path.endsWith('.html')).length).toBe(2);
  });
});

// ── route harness ────────────────────────────────────────────────────────────
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
const enable = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function ownerWithMember(role: string): Promise<{ owner: ReturnType<typeof client>; member: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  const or = await owner.post('/v1/host/openwop-app/test/login', { email: `ce-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(or.status, JSON.stringify(or.body)).toBe(201);
  const member = client();
  const mr = await member.post('/v1/host/openwop-app/test/login', { email: `ce-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId;
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: mr.body.user.userId, roles: [role] });
  return { owner, member, orgId, tenantId };
}
const ep = (orgId: string, canvasId: string) => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/export`;

async function seedCanvas(tenantId: string, canvasId: string): Promise<void> {
  await __putCanvasForTest({ canvasId, tenantId, canvasTypeId: 'canvas.app-builder', name: 'Demo', state: SAMPLE, version: 1 });
}

describe('code-export route', () => {
  it('404s when the code-export toggle is off', async () => {
    await enable('code-export', 'off');
    const { owner, orgId, tenantId } = await ownerWithMember('owner');
    await seedCanvas(tenantId, 'cv-off');
    expect((await owner.post(ep(orgId, 'cv-off'), { target: 'html-css' })).status).toBe(404);
    await enable('code-export', 'on');
  });

  it('owner exports → a capability token that downloads a zip', async () => {
    await enable('code-export', 'on');
    const { owner, orgId, tenantId } = await ownerWithMember('owner');
    await seedCanvas(tenantId, 'cv1');
    const r = await owner.post(ep(orgId, 'cv1'), { target: 'react-tailwind' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.assetToken).toBeTruthy();
    expect(r.body.fileCount).toBeGreaterThan(0);
    expect(r.body.fileName).toMatch(/\.zip$/);
    expect(r.body.warnings).toContain('component \'mysteryWidget\' has no react-tailwind mapping — skipped');
    // the token downloads the zip via the existing assets route
    const dl = await fetch(`${BASE}${r.body.serveUrl}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('zip');
  });

  it('rejects an invalid target (400) and an unknown canvas (404)', async () => {
    await enable('code-export', 'on');
    const { owner, orgId, tenantId } = await ownerWithMember('owner');
    await seedCanvas(tenantId, 'cv2');
    expect((await owner.post(ep(orgId, 'cv2'), { target: 'svelte' })).status).toBe(400);
    expect((await owner.post(ep(orgId, 'nope'), { target: 'html-css' })).status).toBe(404);
  });

  it('viewer cannot export (403)', async () => {
    await enable('code-export', 'on');
    const { member, orgId, tenantId } = await ownerWithMember('viewer');
    await seedCanvas(tenantId, 'cv3');
    expect((await member.post(ep(orgId, 'cv3'), { target: 'html-css' })).status).toBe(403);
  });
});

describe('ctx.features[app-builder].export surface (ADR 0173 Phase 2)', () => {
  it('exports an inline app model → a token, with warnings', async () => {
    const surface = buildAppBuilderSurface({ tenantId: 'default' } as Parameters<typeof buildAppBuilderSurface>[0]);
    const out = (await surface.export({ target: 'html-css', app: SAMPLE })) as { assetToken: string; fileCount: number; warnings: string[] };
    expect(out.assetToken).toBeTruthy();
    expect(out.fileCount).toBeGreaterThan(0);
    expect(out.warnings.some((w) => w.includes('mysteryWidget'))).toBe(true);
  });
  it('rejects an unknown target', async () => {
    const surface = buildAppBuilderSurface({ tenantId: 'default' } as Parameters<typeof buildAppBuilderSurface>[0]);
    await expect(surface.export({ target: 'cobol', app: SAMPLE })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
