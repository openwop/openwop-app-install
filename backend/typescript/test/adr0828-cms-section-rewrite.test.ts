/**
 * ADR 0828 phase 3 — AI section rewrite. The model edits TEXT only: links,
 * media tokens and ids come back as they went in, whatever it returns. Bad
 * output gets one repair, then a typed 502; no provider is a 503; the route is
 * write-gated and validates its input.
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
let cookie = '';
let orgId = '';

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  await call('POST', '/host/openwop-app/test/login', { email: `rewrite-${Date.now()}@x.test` });
  orgId = (await call('POST', '/host/openwop-app/orgs', { name: 'Rewrite Co' })).body.orgId as string;
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
    expect(r.body.data).toMatchObject({ heading: 'Try it today', subheading: 'Signing up is free.', url: '/signup' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('unusable output gets one repair, then a typed 502', async () => {
    const dispatch = vi.fn(async () => 'Sure! Here is a better version.');
    mockResolve.mockResolvedValue(dispatch);
    const r = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'shorten' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('rewrite_invalid');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('no provider is a 503, not a 500', async () => {
    mockResolve.mockResolvedValue(null);
    const r = await call('POST', path(), { sectionType: 'cta', data: cta, action: 'improve' });
    expect(r.status).toBe(503);
  });

  it('validates the action and requires an instruction for a custom rewrite', async () => {
    mockResolve.mockResolvedValue(vi.fn(async () => '{}'));
    expect((await call('POST', path(), { sectionType: 'cta', data: cta, action: 'delete-everything' })).status).toBe(400);
    expect((await call('POST', path(), { sectionType: 'cta', data: cta, action: 'custom' })).status).toBe(400);
    expect((await call('POST', path(), { sectionType: 'cta', data: cta, action: 'custom', instruction: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('keepNonText', () => {
  it('keeps protected keys and non-string values at any depth, and drops keys the original lacks', () => {
    const original = { heading: 'A', items: [{ title: 'T', href: '/a', count: 3 }], token: 'tok' };
    const edited = { heading: 'B', items: [{ title: 'U', href: '/b', count: 9 }], token: 'other', injected: 'x' };
    expect(keepNonText(original, edited)).toEqual({ heading: 'B', items: [{ title: 'U', href: '/a', count: 3 }], token: 'tok' });
  });
});
