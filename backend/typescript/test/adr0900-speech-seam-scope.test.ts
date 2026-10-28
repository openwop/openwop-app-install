/**
 * ADR 0900 D1 — the RFC 0105/0106 speech seams admit only the test-seam mode or a
 * CONFIGURED wildcard principal. Everyone else gets the 404 a flag-gated seam answers
 * when its flag is off.
 *
 * RED on 65346ee0f (VOX2-F1 + F1b only): an ordinary signed-in member reached the seam
 * with the test seam off, and with no managed key the synthesizer spent the platform's
 * MiniMax tier. Every refusal below is paired with an ACCEPT by the same caller or on
 * the same route, so a 404 here means "refused by the gate", not "never mounted".
 *
 * The flag is read per request (by the gate and by the handler's mock arm), so one boot
 * serves both postures: `OPENWOP_TEST_SEAM_ENABLED` is flipped per case.
 *
 * Tracker TST-BJH. Red when (probe-witnessed, w65): admission is granted to anyone
 * (the 404 legs and the not-admitted log), the scope gate asks `runs:read` instead of
 * `runs:create`, or the anonymous refusal stops logging its reasonCode. Each seam's
 * cases nest under `describe(path)` so their titles stay short enough to key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';

const WILDCARD_KEY = 'adr0900-wildcard-operator-key';
const SCOPED_ENV_KEY = 'adr0900-scoped-env-key';
const TENANT = 'adr0900-tenant';
const NOT_ENABLED = 'The conformance seam surface is not enabled on this host.';

const SEAMS: Array<[string, Record<string, unknown>]> = [
  ['/host/openwop-app/ai/call-speech-synthesizer', { text: 'hi', voiceId: 'v' }],
  ['/host/sample/ai/call-speech-synthesizer', { text: 'hi', voiceId: 'v' }],
  ['/host/openwop-app/ai/call-transcriber', { audio: { url: 'https://example.invalid/a.wav' } }],
  ['/host/sample/ai/call-transcriber', { audio: { url: 'https://example.invalid/a.wav' } }],
];

let BASE = '';
let server: http.Server;
let n = 0;
const ENV_KEYS = ['OPENWOP_API_KEYS', 'OPENWOP_API_KEY', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_MOCK_PROVIDER_ENABLED'];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // A CONFIGURED wildcard (`<key>:*`, the corpus's credential shape) and a scoped env key.
  process.env.OPENWOP_API_KEYS = `${WILDCARD_KEY}:*,${SCOPED_ENV_KEY}:${TENANT}`;
  delete process.env.OPENWOP_API_KEY;
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0900', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);
afterEach(() => { delete process.env.OPENWOP_TEST_SEAM_ENABLED; });
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const seamOn = (): void => { process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; };

interface SeamReply { error?: unknown; message?: unknown; details?: { reason?: unknown } }
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: SeamReply }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as SeamReply; // JSON body, read as the declared reply shape
  return { status: res.status, json };
}

/** A real signed-in member: a cookie session minted by the test-login seam. */
async function signedInCookie(): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `adr0900-${Date.now()}-${n++}@a.test`, tenantId: `org:adr0900-${n}` }),
  });
  expect(res.status).toBe(201);
  const cookie = getSetCookies(res.headers).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean);
  expect(cookie).toBeTruthy();
  return cookie!;
}
async function anonCookie(): Promise<string> {
  const me = await fetch(`${BASE}/host/openwop-app/users/me`);
  return (me.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function memberKey(scopes: string[]): Promise<string> {
  const { token } = await issueApiKey({ tenantId: TENANT, name: 'adr0900', createdBy: 'user:adr0900', scopes });
  return token;
}
const expectNotEnabled = (r: { status: number; json: { error?: unknown; message?: unknown } }): void => {
  expect(r.status).toBe(404);
  // `/host/sample/*` answers in the host-prefixed code space (`openwop-app.not_found`).
  expect(String(r.json.error)).toMatch(/(^|\.)not_found$/);
  expect(r.json.message).toBe(NOT_ENABLED);
};

describe('ADR 0900 D1 — test seam OFF: only a configured wildcard is admitted', () => {
  for (const [path, body] of SEAMS) describe(path, () => {
    it(`a signed-in member (cookie) is refused 404, and served 200 once the test seam is on`, async () => {
      const cookie = await signedInCookie();
      expectNotEnabled(await post(path, body, { cookie }));
      seamOn();
      expect((await post(path, body, { cookie })).status).toBeLessThan(300);
    });
    it(`a member owk_ key WITH runs:create is refused 404, and served 200 once the test seam is on`, async () => {
      const auth = { authorization: `Bearer ${await memberKey(['runs:create', 'workspace:write'])}` };
      expectNotEnabled(await post(path, body, auth));
      seamOn();
      expect((await post(path, body, auth)).status).toBeLessThan(300);
    });
    it(`a SCOPED env key is refused 404 (the prod cut's credential shape is not the wildcard)`, async () => {
      expectNotEnabled(await post(path, body, { authorization: `Bearer ${SCOPED_ENV_KEY}` }));
    });
    it(`the PUBLIC dev-token fallback wildcard is refused 404 (/architect M1, the ADR 0771 rule)`, async () => {
      // No keys configured + auth not enforced ⇒ `readKeyTenants` serves `dev-token:*`.
      const keys = process.env.OPENWOP_API_KEYS;
      delete process.env.OPENWOP_API_KEYS;
      try {
        expectNotEnabled(await post(path, body, { authorization: 'Bearer dev-token' }));
      } finally {
        process.env.OPENWOP_API_KEYS = keys;
      }
    });
    it(`an anonymous visitor gets the same 404 as everyone else outside the two cases`, async () => {
      expectNotEnabled(await post(path, body, { cookie: await anonCookie() }));
    });
    it(`the configured wildcard is ADMITTED — the handler runs (400 on an empty body, not the gate's 404)`, async () => {
      // With the flag off the handler routes to the real managed provider, which this
      // offline suite cannot reach, so admission is witnessed by the handler's own
      // validation answer. The <300 accept for the wildcard is the test-seam case below.
      const r = await post(path, {}, { authorization: `Bearer ${WILDCARD_KEY}` });
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toMatch(/(^|\.)invalid_request$/);
    });
  });
});

describe('ADR 0900 D1 — test seam ON: the VOX2-F1/F1b gates still bite behind admission', () => {
  for (const [path, body] of SEAMS) describe(path, () => {
    it(`the configured wildcard is served 200`, async () => {
      seamOn();
      expect((await post(path, body, { authorization: `Bearer ${WILDCARD_KEY}` })).status).toBeLessThan(300);
    });
    it(`an anonymous visitor is refused 401 anonymous_principal_refused (VOX2-F1b)`, async () => {
      seamOn();
      const r = await post(path, body, { cookie: await anonCookie() });
      expect(r.status).toBe(401);
      expect(r.json.details?.reason).toBe('anonymous_principal_refused');
    });
    it(`a member key WITHOUT runs:create is refused 403 (VOX2-F1)`, async () => {
      seamOn();
      const r = await post(path, body, { authorization: `Bearer ${await memberKey(['runs:read', 'workspace:write'])}` });
      expect(r.status).toBe(403);
      expect(String(r.json.error)).toMatch(/forbidden/);
    });
  });
});

describe('ADR 0900 D2 — each seam refusal logs a countable reasonCode', () => {
  async function refusalLines(send: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const lines: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (real as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    try { await send(); } finally { spy.mockRestore(); }
    return lines.filter((l) => l.includes('"msg":"speech_seam_refused"')).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const [path, body] = SEAMS[0]!;
  it('not admitted ⇒ reasonCode speech_seam_not_admitted, with the route literal', async () => {
    const cookie = await signedInCookie();
    const got = await refusalLines(() => post(path, body, { cookie }));
    expect(got).toEqual([expect.objectContaining({ reasonCode: 'speech_seam_not_admitted', route: path })]);
  });
  it('test seam on: anonymous ⇒ speech_seam_anonymous; missing runs:create ⇒ speech_seam_insufficient_scope', async () => {
    seamOn();
    const cookie = await anonCookie();
    expect(await refusalLines(() => post(path, body, { cookie }))).toEqual([expect.objectContaining({ reasonCode: 'speech_seam_anonymous' })]);
    const auth = { authorization: `Bearer ${await memberKey(['runs:read', 'workspace:write'])}` };
    expect(await refusalLines(() => post(path, body, auth))).toEqual([expect.objectContaining({ reasonCode: 'speech_seam_insufficient_scope' })]);
  });
  it('control: an admitted call logs no refusal', async () => {
    seamOn();
    expect(await refusalLines(() => post(path, body, { authorization: `Bearer ${WILDCARD_KEY}` }))).toEqual([]);
  });
});
