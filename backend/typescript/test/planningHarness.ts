/**
 * Shared ROUTE-test harness for the planning features (priority-matrix +
 * strategy) — extracts the boot/cookie-jar/toggle scaffolding that was
 * copy-pasted verbatim across ~9 route suites (STRAT-DEBT1).
 *
 * Scope guard: this owns ONLY the generic scaffolding — booting the app,
 * the cookie-jar HTTP client, toggle flipping, and unique emails. Each suite
 * keeps its OWN feature-specific helpers (signup shape, ownerWithOrg, login)
 * because their signatures legitimately diverge (tenant-scoped vs not, email
 * prefix, extra org/session setup).
 *
 * Isolation contract: every vitest FILE must call `bootPlanningApp()` in its
 * own `beforeAll` and `close()` in `afterAll`. Vitest isolates files into
 * separate workers, so a shared server would break parallel runs AND leak
 * feature-toggle state across suites — boot per file, never module-globally.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

export interface Res<T = any> { status: number; body: T }
export interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}

/**
 * Boot the real app on an ephemeral port with in-memory storage + test auth.
 * Returns the base URL and a `close()` to run in `afterAll`.
 */
export async function bootPlanningApp(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server: http.Server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((res) => server.close(() => res())) };
}

/**
 * A cookie-jar HTTP client bound to the harness base URL. Pass a getter so the
 * client can be constructed before `bootPlanningApp()` resolves the port.
 */
export function makeClient(getBase: () => string): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${getBase()}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

/** Flip a feature toggle on/off by its registry id (no-op if the id is unknown). */
export async function enableToggle(id: string, status: 'on' | 'off' = 'on'): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
}

let seq = 0;
/** A process-unique test email with a caller-chosen prefix. */
export const uniqEmail = (who: string): string => `${who}-${Date.now()}-${seq++}@acme.test`;
