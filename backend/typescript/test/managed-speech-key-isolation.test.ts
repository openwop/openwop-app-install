/**
 * ADR 0990 D7 — the free tier's chat provider never decides the managed SPEECH key.
 *
 * Managed TTS is MiniMax-only. Through #5285, `resolveManagedSpeechKey` resolved
 * through the SELECTED chat target, so with `OPENWOP_MANAGED_PROVIDER=anthropic`
 * a managed speech call sent the Anthropic key to MiniMax's T2A endpoint. This
 * drives the real speech route with the tier on Anthropic and both keys set,
 * and reads every outbound request: the T2A call carries the MiniMax key, and
 * the Anthropic key appears in no outbound request at all.
 *
 * Sabotage-witnessed: with `resolveManagedSpeechKey` resolving through the
 * selected chat target (the #5285 shape), both assertions go red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

const MINIMAX_KEY = 'sk-minimax-speech-isolation';
const ANTHROPIC_KEY = 'sk-ant-must-never-reach-t2a';
const WILDCARD_KEY = 'speech-isolation-wildcard-operator-key';
const ENV = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_API_KEYS', 'OPENWOP_BOOT_SECRETS', 'OPENWOP_MANAGED_PROVIDER', 'MINIMAX_API_KEY', 'ANTHROPIC_API_KEY'] as const;

let server: http.Server;
let BASE: string;
const saved: Partial<Record<(typeof ENV)[number], string>> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  for (const k of ENV) { const v = process.env[k]; if (v !== undefined) saved[k] = v; }
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${WILDCARD_KEY}:*`;
  delete process.env.OPENWOP_BOOT_SECRETS;
  process.env.OPENWOP_MANAGED_PROVIDER = 'anthropic';
  process.env.MINIMAX_API_KEY = MINIMAX_KEY;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** Every request the HOST sends out (the test's own calls to BASE pass through). */
interface Outbound { url: string; headers: string; body: string }

describe('managed speech never carries the chat provider\'s key', () => {
  it('with the tier on Anthropic, T2A gets the MiniMax key and the Anthropic key goes nowhere', async () => {
    const outbound: Outbound[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(BASE)) return realFetch(input, init);
      outbound.push({ url, headers: JSON.stringify(init?.headers ?? {}), body: typeof init?.body === 'string' ? init.body : '' });
      // A provider failure is fine: the request already left, which is what is asserted.
      return new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'test stub' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await realFetch(`${BASE}/host/openwop-app/ai/call-speech-synthesizer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WILDCARD_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Key isolation witness.', voiceId: 'male-qn-qingse' }),
    });

    const t2a = outbound.filter((r) => /minimax/i.test(r.url));
    expect(t2a.length, JSON.stringify(outbound.map((r) => r.url))).toBeGreaterThan(0);
    for (const r of t2a) expect(r.headers).toContain(MINIMAX_KEY);
    for (const r of outbound) {
      expect(r.headers, r.url).not.toContain(ANTHROPIC_KEY);
      expect(r.body, r.url).not.toContain(ANTHROPIC_KEY);
    }
  });
});
