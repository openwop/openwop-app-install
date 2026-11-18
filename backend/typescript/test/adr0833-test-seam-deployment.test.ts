/**
 * ADR 0833 S9 / D8 — the test-login seam mints a session for ANY subject, so it
 * can never run on a deployment (ADR 0754 `deploymentMarker`). No escape hatch.
 *
 * RED on `97baad74b`: the only guard was `OPENWOP_TEST_AUTH_ENABLED`, so a
 * Cloud Run / Kubernetes / Postgres-backed boot with the flag set served it.
 *
 * The local-boot case drives the SAME route to a 201, so the deployment cases'
 * 404 means "refused", not "never registered / wrong path" — without that
 * positive control, a seam that never mounted at all kept every case green.
 *
 * Sabotage that turns it red (`authTestSeam.ts`): `if (deployedError) {` →
 * `if (false) {` ⇒ the deployment cases serve the route; `if (deployedError) {`
 * → `if (true) {` ⇒ the local-boot case 404s; `if (!deployed) return null;` →
 * `if (!deployed) return 'x';` ⇒ the local-boot startup check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { registerAuthTestSeamRoutes, testAuthSeamStartupError } from '../src/routes/authTestSeam.js';
import { protocolVersionMiddleware } from '../src/middleware/protocolVersion.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of ['K_SERVICE', 'KUBERNETES_SERVICE_HOST', 'OPENWOP_STORAGE_DSN', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SESSION_SECRET']) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
  }
});

async function withSeam<T>(probe: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(protocolVersionMiddleware());
  registerAuthTestSeamRoutes(app);
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    return await probe(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const seamStatus = (): Promise<number> => withSeam(async (base) => (await fetch(`${base}/host/openwop-app/test/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'oidc:victim' }),
})).status);

/** #5945 — whether the seam's member routes are MOUNTED. Express's own
 *  "Cannot POST" page means no route; any other answer (the handler's own
 *  refusal, with no auth middleware here) means the route exists. */
const memberSeamMounted = (): Promise<boolean[]> => withSeam(async (base) => Promise.all([
  ['POST', '/host/openwop-app/test/orgs/org-x/members'],
  ['PATCH', '/host/openwop-app/test/orgs/org-x/members/m-x'],
].map(async ([method, path]) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'P', subject: 'user:victim' }) });
  return !(await res.text()).includes(`Cannot ${method} ${path}`);
})));

describe('S9 / D8 — test-login seam vs a deployment', () => {
  it.each([
    ['Cloud Run', { K_SERVICE: 'openwop-app-backend' }],
    ['Kubernetes', { KUBERNETES_SERVICE_HOST: '10.0.0.1' }],
    ['a Postgres control plane', { OPENWOP_STORAGE_DSN: 'postgres://u@h/db' }],
  ])('%s + OPENWOP_TEST_AUTH_ENABLED ⇒ boot refusal AND no route', async (_l, env) => {
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    Object.assign(process.env, env);
    expect(testAuthSeamStartupError()).toMatch(/ADR 0833/);
    expect(await seamStatus()).toBe(404);
    expect(await memberSeamMounted(), 'the #5945 member seam is not mounted either').toEqual([false, false]);
  });

  it('a local / harness boot (memory://, no platform marker) is untouched — the route serves 201', async () => {
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    delete process.env.K_SERVICE;
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    expect(testAuthSeamStartupError()).toBeNull();
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(':memory:'));
    expect(await seamStatus()).toBe(201);
    expect(await memberSeamMounted(), 'the #5945 member seam is mounted beside /test/login').toEqual([true, true]);
  });

  it('a deployment WITHOUT the flag is untouched, and serves neither seam', async () => {
    delete process.env.OPENWOP_TEST_AUTH_ENABLED;
    process.env.K_SERVICE = 'openwop-app-backend';
    expect(testAuthSeamStartupError()).toBeNull();
    expect(await memberSeamMounted()).toEqual([false, false]);
  });
});
