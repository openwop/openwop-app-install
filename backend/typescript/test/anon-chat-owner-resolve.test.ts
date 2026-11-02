/**
 * Production outage, 2026-10-08: every anonymous chat message on app.openwop.dev
 * failed with `404 interrupt_not_found: no open interrupt for this node`.
 *
 * The SPA creates a chat session first, and `chatSessions` stamps its
 * `ownerUserId` as `req.userId ?? principalId` — for an anonymous visitor, the
 * principal. The conversation-resolve visibility gate compared that owner
 * against the CANONICAL caller id (`resolveCallerUser(req).userId`), which is
 * undefined for an anonymous visitor, so `isVisibleTo` denied the owner their own
 * conversation and masked it as `interrupt_not_found`
 * (`host/exchange/authorizeResolve.ts`). Certification never creates a chat
 * session, so no cut saw it.
 *
 * Driven exactly as the SPA does: anon session cookie → chat session → v2 run
 * create with `metadata.chatSessionId` → resolve the gate on the projected
 * tenant-bound id. Without a model provider configured the reply itself fails
 * (502), which is past the gate under test; the assertion is that the gate does
 * not refuse the owner, and still refuses everyone else.
 *
 * TWO GUARDS stand between a stranger and this conversation, and only one is
 * reachable from here. Every anonymous visitor is its OWN tenant (`anon:<sid>`),
 * so another visitor presenting the owner's tenant-bound id is refused by the
 * v2 id layer (`403 id_tenant_mismatch`, middleware/v2Identity.ts) before the
 * visibility gate in `authorizeConversationResolve` runs. A same-tenant
 * non-owner does not exist for anonymous sessions, so the visibility gate's
 * DENY branch is an honest ceiling here (w66 acr-deny read vacuous); the
 * control asserts the guard that actually answers.
 *
 * TST-BXD-1 (ADR 0839 D1, CS-BE-1; incident 2026-10-08). Red when: the resolve
 * gate keys the owner check on the canonical user id instead of the principal
 * (w66 acr-key), or the id-layer tenant check stops refusing a foreign tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let server: http.Server;
let base = '';
const saved = { cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; // the anon session is the subject under test
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  if (saved.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = saved.cookies;
  await new Promise<void>((r) => server.close(() => r()));
});

async function anonCookie(): Promise<string> {
  const me = await fetch(`${base}/host/openwop-app/users/me`);
  const cookie = (me.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toMatch(/^__session=/);
  return cookie;
}

/** The SPA's chat bootstrap: a chat session, then a conversation run bound to it. Returns the projected run id. */
async function openChat(cookie: string): Promise<string> {
  const v2 = { cookie, 'OpenWOP-Version': '2', 'content-type': 'application/json', accept: 'application/json' };
  const sess = await fetch(`${base}/host/openwop-app/chat/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'hello' }) });
  expect(sess.status).toBe(201);
  const { sessionId } = (await sess.json()) as { sessionId: string };
  const run = await fetch(`${base}/runs`, { method: 'POST', headers: v2, body: JSON.stringify({ workflowId: 'openwop-app.conversation', inputs: {}, metadata: { chatSessionId: sessionId } }) });
  expect(run.status).toBe(201);
  const bound = ((await run.json()) as { runId: string }).runId;
  const bare = bound.slice(bound.lastIndexOf('/') + 1);
  for (let i = 0; i < 100; i++) {
    const l = await fetch(`${base}/host/openwop-app/runs/${encodeURIComponent(bare)}/interrupts`, { headers: { cookie } });
    const body = (await l.json()) as { interrupts?: Array<{ nodeId: string }> } | Array<{ nodeId: string }>;
    const open = Array.isArray(body) ? body : (body.interrupts ?? []);
    if (open.some((x) => x.nodeId === 'gate')) return projectBoundId(bound);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the conversation gate never opened');
}

async function sendTurn(cookie: string, projectedRunId: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${base}/runs/${projectedRunId}/interrupts/gate`, {
    method: 'POST',
    headers: { cookie, 'OpenWOP-Version': '2', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hello' } } }),
  });
  let error: string | undefined;
  try { error = ((await res.json()) as { error?: string }).error; } catch { /* non-JSON */ }
  return { status: res.status, error };
}

describe('anonymous chat: the owner can send a turn on their own conversation', () => {
  it('the anonymous OWNER is not refused by the visibility gate', async () => {
    const cookie = await anonCookie();
    const runId = await openChat(cookie);
    const r = await sendTurn(cookie, runId);
    expect(r.error, `the owner's turn was refused: ${r.status} ${r.error}`).not.toBe('interrupt_not_found');
    // Past the gate: no refusal status at all (without a provider the reply
    // itself fails later, which is not a refusal of the owner).
    expect([401, 403, 404], `the owner's turn was refused: ${r.status} ${r.error}`).not.toContain(r.status);
  });

  it('control: ANOTHER anonymous visitor is still refused (at the id layer: 403 id_tenant_mismatch)', async () => {
    const owner = await anonCookie();
    const runId = await openChat(owner);
    const intruder = await anonCookie();
    const r = await sendTurn(intruder, runId);
    expect(r).toEqual({ status: 403, error: 'id_tenant_mismatch' });
  });
});
