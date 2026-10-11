/**
 * ADR 0828 phase 3 — AI section rewrite. The model edits TEXT only: links,
 * media tokens and ids come back as they went in, whatever it returns. Bad
 * output gets one repair, then a typed 502; no provider is a 503; the route is
 * write-gated and validates its input.
 *
 * Sabotage (w16 probes): dropping `url` from `PROTECTED_KEY` reds case 1; skipping
 * the repair dispatch or answering 500 reds case 2; a 500 for "no provider" reds
 * case 3; dropping any of the three input checks reds case 4; asking only
 * `workspace:read` reds the viewer case; letting non-strings or extra keys
 * through `keepNonText` reds the unit case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { keepNonText } from '../src/features/cms/rewrite.js';

const mockResolve = vi.mocked(resolveHeadlessAi);
let BASE: string;
let server: http.Server;
let orgId = '';

interface Body {
  data?: Record<string, unknown>;
  error?: string;
  details?: { field?: string; max?: number; requiredScope?: string };
  orgId?: string;
  user?: { userId: string };
}
interface Jar { cookie: string }
const owner: Jar = { cookie: '' };
const viewer: Jar = { cookie: '' };

const as = (jar: Jar) => async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body | undefined }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) jar.cookie = m[1]!; }
  return { status: res.status, body: await res.json().catch(() => undefined) as Body | undefined };
};
const call = as(owner);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  const tenantId = `org:rewrite-${Date.now()}`;
  expect((await call('POST', '/host/openwop-app/test/login', { email: `rewrite-${Date.now()}@x.test`, tenantId })).status).toBe(201);
  orgId = (await call('POST', '/host/openwop-app/orgs', { name: 'Rewrite Co' })).body!.orgId!;
  const v = await as(viewer)('POST', '/host/openwop-app/test/login', { email: `rewrite-viewer-${Date.now()}@x.test`, tenantId });
  expect(v.status).toBe(201);
  const add = await call('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: v.body!.user!.userId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { mockResolve.mockReset(); });

const path = (): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/rewrite-section`;
const cta = { heading: 'Try it', subheading: 'it is free to sign up', label: 'Open the app', url: '/signup' };

describe('ADR 0828 — rewrite one section', () => {
  it('returns the edited text and keeps the link, even when the model changes it', async () => {
    const dispatch = vi.fn(async () => JSON.stringify({ heading: 'Try it today', subheading: 'Signing up is free.', label: 'Open the app', url: 'https://evil.example' }));
    mockResolve.mockResolvedValue(dispatch);
    const r = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'improve' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.data).toMatchObject({ heading: 'Try it today', subheading: 'Signing up is free.', url: '/signup' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('unusable output gets one repair, then a typed 502', async () => {
    const dispatch = vi.fn(async () => 'Sure! Here is a better version.');
    mockResolve.mockResolvedValue(dispatch);
    const r = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'shorten' });
    expect(r.status).toBe(502);
    expect(r.body?.error).toBe('rewrite_invalid');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('no provider is a 503, not a 500', async () => {
    mockResolve.mockResolvedValue(null);
    const r = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'improve' });
    expect(r.status).toBe(503);
    expect(r.body?.error).toBe('internal_error');
  });

  it('validates the action and requires an instruction for a custom rewrite', async () => {
    mockResolve.mockResolvedValue(vi.fn(async () => '{}'));
    const bad = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'delete-everything' });
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toBe('validation_error');
    const noInstruction = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'custom' });
    expect(noInstruction.status).toBe(400);
    expect(noInstruction.body?.details?.field).toBe('instruction');
    const tooLong = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'custom', instruction: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body?.details).toMatchObject({ field: 'instruction', max: 500 });
  });

  it('is write-gated: a viewer is refused before any model call', async () => {
    const dispatch = vi.fn(async () => '{}');
    mockResolve.mockResolvedValue(dispatch);
    const r = await as(viewer)('POST', path(), { sectionType: 'cta', data: cta, action: 'improve' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body?.details?.requiredScope).toBe('workspace:write');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('keepNonText', () => {
  it('keeps protected keys and non-string values at any depth, and drops keys the original lacks', () => {
    const original = { heading: 'A', items: [{ title: 'T', href: '/a', count: 3 }], token: 'tok' };
    const edited = { heading: 'B', items: [{ title: 'U', href: '/b', count: 9 }], token: 'other', injected: 'x' };
    expect(keepNonText(original, edited)).toEqual({ heading: 'B', items: [{ title: 'U', href: '/a', count: 3 }], token: 'tok' });
  });
});
