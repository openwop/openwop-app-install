/**
 * CXC-1 (ADR 0119) — the import write in the PRODUCTION cookie posture.
 *
 * The companion `chat-export-route.test.ts` runs under `OPENWOP_AUTH_DISABLE_COOKIES=true`,
 * where an anonymous import is 401'd. That is NOT the `app.openwop.dev` posture. In the
 * default cookie-per-visitor posture (no `OPENWOP_AUTH_DISABLE_COOKIES`, no
 * `OPENWOP_AUTH_ENFORCE_BEARER`), an anonymous request is minted a per-visitor anon
 * SESSION (`principalId:'session:<sid>'`) in a UNIQUE tenant `anon:<sid>` and DOES reach
 * the route (HTTP 201) — so the protection cannot be "anon is rejected". This file
 * witnesses the guarantee that actually holds: the import is created OWNED and isolated
 * to its visitor, so a DIFFERENT visitor cannot read it. That is what the required
 * `ownerUserId` close (CXC-1) preserves — an owner-less import would fall to
 * `conversationVisibility`'s legacy/tenant-visible branch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

/** First `name=value` pair of a Set-Cookie header (drops Path/HttpOnly/etc.). */
function cookieOf(res: Response): string | undefined {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : undefined;
}

beforeAll(async () => {
  // PRODUCTION posture: cookies ENABLED, bearer NOT enforced. Override any inherited env.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  process.env.OPENWOP_API_KEYS = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('chat-export import — production cookie posture (CXC-1)', () => {
  it('an anon visitor CAN import (201) and the result is OWNED — a DIFFERENT visitor cannot read it', async () => {
    const payload = { format: 'openwop', data: { version: 'openwop-v1', title: 'Anon import', messages: [{ role: 'user', content: 'secret note' }] } };

    // Visitor A (no cookie ⇒ minted a fresh anon session + private tenant).
    const impRes = await fetch(`${BASE}/v1/host/openwop-app/chat-export/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    // Reaches the route in cookie posture — NOT 401. This is the reviewer's finding.
    expect(impRes.status).toBe(201);
    const cookieA = cookieOf(impRes);
    expect(cookieA).toBeTruthy(); // an anon session was minted
    const { sessionId } = await impRes.json() as { sessionId: string };
    expect(sessionId).toBeTruthy();

    // Visitor A re-reads its OWN import (same cookie) — allowed.
    const ownRead = await fetch(`${BASE}/v1/host/openwop-app/chat-export/${sessionId}`, { headers: { cookie: cookieA! } });
    expect(ownRead.status).toBe(200);

    // Visitor B (no cookie ⇒ a DIFFERENT anon session + tenant) cannot read A's import.
    // An owner-less import would instead be tenant-visible; the owned guarantee denies it.
    const otherRead = await fetch(`${BASE}/v1/host/openwop-app/chat-export/${sessionId}`);
    expect(otherRead.status).not.toBe(200);
  });
});
