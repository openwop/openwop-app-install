/**
 * ADR 0119 Phase 2 / 4b — conversation export + import routes
 * (`features/chat-export/routes.ts`), plus the CXC-1 / CONV-4 grade-pass closes.
 *
 * Claims and what turns each red (wave-24 probes): the markdown export's content type
 * (`res.type('text/markdown')` → plain); the `?format=json` branch (forcing markdown);
 * the uniform 404 for an unknown conversation (a non-OpenwopError throw → 500); the
 * openwop-v1 round trip (parsing an empty payload instead of `body.data`); CONV-4's
 * unknown-format 400 (dropping the format guard); CXC-1 ownership (importing with an
 * empty owner, or dropping the `isVisibleToAsync` read check, lets a SAME-TENANT peer
 * principal read the import).
 *
 * The feature is ALWAYS-ON (no `toggleDefault` in `feature.ts`) — every case here runs
 * with no toggle, which is itself the always-on witness.
 *
 * Two API keys scoped to ONE tenant give two principals that share a tenant, so the
 * ownership case is refused by OWNERSHIP — not by the tenant lookup (a cross-tenant
 * reader never reaches the predicate) and not by the 401 auth middleware (an anon
 * reader never reaches the route).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getConversationMeta } from '../src/host/conversationStore.js';

let server: http.Server;
let BASE: string;
const TENANT = 'cx-route';
const OWNER_TOKEN = 'cx-owner-token';
const PEER_TOKEN = 'cx-peer-token';
/** The auth middleware's principal id for an env key: `bearer:<first 8 chars>`. */
const OWNER_PRINCIPAL = `bearer:${OWNER_TOKEN.slice(0, 8)}`;
let sid: string;

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_API_KEYS'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function req(path: string, init: RequestInit = {}, token: string | null = OWNER_TOKEN): Promise<{ status: number; text: string; ct: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') ?? '' };
}
const j = (path: string, init: RequestInit = {}): ReturnType<typeof req> => req(path, init, OWNER_TOKEN);
const asPeer = (path: string, init: RequestInit = {}): ReturnType<typeof req> => req(path, init, PEER_TOKEN);
const anon = (path: string, init: RequestInit = {}): ReturnType<typeof req> => req(path, init, null);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${OWNER_TOKEN}:${TENANT},${PEER_TOKEN}:${TENANT}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // a conversation owned by the caller
  const r = await j('/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'Export me' }) });
  sid = (JSON.parse(r.text) as { sessionId: string }).sessionId;
  await j(`/host/openwop-app/chat/sessions/${sid}/messages`, { method: 'POST', body: JSON.stringify({ messageId: 'm0', role: 'user', content: 'hello export' }) });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('chat-export route', () => {
  it('renders markdown by default (always-on: no toggle is consulted)', async () => {
    const r = await j(`/host/openwop-app/chat-export/${sid}`);
    expect(r.status).toBe(200);
    expect(r.ct).toContain('markdown');
    expect(r.text).toContain('# Export me');
    expect(r.text).toContain('hello export');
  });

  it('renders the openwop-v1 JSON with ?format=json', async () => {
    const r = await j(`/host/openwop-app/chat-export/${sid}?format=json`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { version: string; conversation: { sessionId: string; title: string }; messages: Array<{ role: string; content: string }> };
    expect(body.version).toBe('openwop-v1');
    expect(body.conversation).toMatchObject({ sessionId: sid, title: 'Export me' });
    expect(body.messages).toEqual([expect.objectContaining({ role: 'user', content: 'hello export' })]);
  });

  it('404s a non-existent conversation', async () => {
    const r = await j('/host/openwop-app/chat-export/nope-nope');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'not_found' });
  });

  it('imports an openwop-v1 export into a NEW conversation (round-trip)', async () => {
    const exported = JSON.parse((await j(`/host/openwop-app/chat-export/${sid}?format=json`)).text) as unknown;
    const imp = await j('/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: exported }) });
    expect(imp.status).toBe(201);
    const { sessionId, imported } = JSON.parse(imp.text) as { sessionId: string; imported: number };
    expect(sessionId).not.toBe(sid);
    expect(imported).toBe(1);
    // the imported conversation re-exports with the original turn content.
    const reexport = await j(`/host/openwop-app/chat-export/${sessionId}`);
    expect(reexport.status).toBe(200);
    expect(reexport.text).toContain('hello export');
  });

  it('CONV-4: a present-but-unknown format is 400 (no silent openwop fallback)', async () => {
    const r = await j('/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'chatgtp', data: {} }) });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'validation_error', details: { field: 'format' } });
  });

  // BLOCKED-ON-PRODUCT (wave 24, filed to grade-code): `importParser.ts` throws a plain
  // `Error` with `.code='validation_error'`, not an `OpenwopError`, so the error
  // envelope middleware maps it to `500 internal_error`. The correct outcome is a 400
  // `validation_error`. This case asserts the CORRECT outcome and is `it.fails` until the
  // parser throws an `OpenwopError` (or the route maps it) — then flip it to `it`.
  it.fails('a malformed openwop body is 400 validation_error, not 500 (BLOCKED-ON-PRODUCT)', async () => {
    const r = await j('/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: {} }) });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'validation_error' });
  });
});

/**
 * CXC-1 (ADR 0119 grade pass) — the import write must yield an OWNED conversation.
 *
 * Auth is global for this (non-public) route, so a request always carries a principal
 * (a signed-in user, an API-key principal, or — in the default cookie posture — a
 * minted per-visitor anon session). The route's own `if (!userId) 401` guard is
 * defense-in-depth that a real caller cannot reach; the STRUCTURAL close is
 * `importConversation`'s required owner param. Under this file's disable-cookies
 * posture an anon request is 401'd by the auth middleware. The production cookie
 * posture (anon → 201, confined to its own visitor tenant) is witnessed in
 * `chat-export-import-cookie-posture.test.ts`.
 */
describe('chat-export import — authorization (CXC-1)', () => {
  it('under enforced auth (disable-cookies) an anon import is rejected, never a persisted write', async () => {
    // A well-formed body, so the rejection is the auth gate, not validation.
    const exported = JSON.parse((await j(`/host/openwop-app/chat-export/${sid}?format=json`)).text) as unknown;
    const r = await anon('/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: exported }) });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'unauthenticated' });
    expect(r.text).not.toContain('sessionId');
  });

  it('an authenticated import creates an OWNED conversation — a same-tenant peer cannot read it', async () => {
    const exported = JSON.parse((await j(`/host/openwop-app/chat-export/${sid}?format=json`)).text) as unknown;
    const imp = await j('/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: exported }) });
    expect(imp.status).toBe(201);
    const { sessionId } = JSON.parse(imp.text) as { sessionId: string };
    // The persisted owner is the importing principal ...
    expect((await getConversationMeta(TENANT, sessionId))?.ownerUserId).toBe(OWNER_PRINCIPAL);
    // ... who re-reads it fine (positive control) ...
    expect((await j(`/host/openwop-app/chat-export/${sessionId}`)).status).toBe(200);
    // ... while a DIFFERENT principal in the SAME tenant gets the uniform 404 — an
    // owner-less import would be tenant-visible and answer 200 here.
    const peer = await asPeer(`/host/openwop-app/chat-export/${sessionId}`);
    expect(peer.status).toBe(404);
    expect(JSON.parse(peer.text)).toMatchObject({ error: 'not_found' });
  });
});
