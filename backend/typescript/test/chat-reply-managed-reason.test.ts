/**
 * A chat turn the managed free tier refuses carries the machine-readable cause as
 * `details.reason` (the field the chat keys its error card on — the tool-turn path's
 * ADR 0482 convention), instead of a bare `internal_error`.
 *
 * Found on prod 2026-10-08 right after the anon-chat fix (#4579): with
 * OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED=true an anonymous turn failed "Sign in to use
 * the free tier" but reached the SPA as `internal_error` with no reason, so the card
 * said "Something went wrong" and offered no Sign in button.
 *
 * `aiProvidersHost` folds the managed code into a canonical AiProviderError code and
 * keeps the original in `details.managedCode`, while the chat reply path sees the RAW
 * ManagedProviderError (MEASURED). The first draft read only one shape; the HTTP legs
 * below are what caught it — the unit legs alone passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';
import { managedTierReason } from '../src/host/conversationExchange.js';
import { AiProviderError } from '../src/aiProviders/aiProvidersHost.js';
import { ManagedProviderError } from '../src/providers/managedProvider.js';

describe('managedTierReason (unit)', () => {
  it('reads the managed code from details.managedCode, never the folded err.code', () => {
    expect(managedTierReason(new AiProviderError('byok_required', 'Sign in to use the free tier.', { managedCode: 'sign_in_required' }))).toBe('sign_in_required');
    expect(managedTierReason(new AiProviderError('provider_rate_limited', 'Daily limit', { managedCode: 'daily_limit_reached' }))).toBe('daily_limit_reached');
    expect(managedTierReason(new AiProviderError('provider_unavailable', 'Free tier unavailable', { managedCode: 'managed_unavailable' }))).toBe('managed_unavailable');
  });
  it('also reads a RAW ManagedProviderError (what the chat reply path actually throws)', () => {
    expect(managedTierReason(new ManagedProviderError('sign_in_required', 'Sign in to use the free tier.'))).toBe('sign_in_required');
  });
  it('is undefined for anything else', () => {
    expect(managedTierReason(new AiProviderError('provider_rate_limited', 'minimax 429'))).toBeUndefined();
    expect(managedTierReason(Object.assign(new Error('x'), { code: 'sign_in_required' }))).toBeUndefined();
    expect(managedTierReason(null)).toBeUndefined();
  });
});

let server: http.Server;
let base = '';
const saved = { cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES, signin: process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  if (saved.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = saved.cookies;
  if (saved.signin === undefined) delete process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED; else process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED = saved.signin;
  await new Promise<void>((r) => server.close(() => r()));
});

/** The SPA's anonymous chat turn (see anon-chat-owner-resolve.test.ts); returns the turn's status + body. */
async function anonTurn(): Promise<{ status: number; body: { error?: string; details?: { reason?: string } } }> {
  const me = await fetch(`${base}/host/openwop-app/users/me`);
  const cookie = (me.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const v2 = { cookie, 'OpenWOP-Version': '2', 'content-type': 'application/json', accept: 'application/json' };
  const sess = await fetch(`${base}/host/openwop-app/chat/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 't' }) });
  const { sessionId } = (await sess.json()) as { sessionId: string };
  const run = await fetch(`${base}/runs`, { method: 'POST', headers: v2, body: JSON.stringify({ workflowId: 'openwop-app.conversation', inputs: {}, metadata: { chatSessionId: sessionId } }) });
  const bound = ((await run.json()) as { runId: string }).runId;
  const bare = bound.slice(bound.lastIndexOf('/') + 1);
  for (let i = 0; i < 100; i++) {
    const l = await fetch(`${base}/host/openwop-app/runs/${encodeURIComponent(bare)}/interrupts`, { headers: { cookie } });
    const b = (await l.json()) as { interrupts?: Array<{ nodeId: string }> } | Array<{ nodeId: string }>;
    if ((Array.isArray(b) ? b : (b.interrupts ?? [])).some((x) => x.nodeId === 'gate')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await fetch(`${base}/runs/${projectBoundId(bound)}/interrupts/gate`, { method: 'POST', headers: v2, body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hello' } } }) });
  return { status: res.status, body: (await res.json()) as { error?: string; details?: { reason?: string } } };
}

describe('the chat turn carries the managed refusal as details.reason (HTTP, real managed path)', () => {
  it('sign-in required for anonymous visitors → details.reason sign_in_required', async () => {
    process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED = 'true';
    const r = await anonTurn();
    expect(r.body.details?.reason, JSON.stringify(r.body)).toBe('sign_in_required');
  });

  it('no free tier configured → details.reason managed_unavailable', async () => {
    process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED = 'false';
    const r = await anonTurn();
    expect(r.body.details?.reason, JSON.stringify(r.body)).toBe('managed_unavailable');
  });
});
