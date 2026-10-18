/**
 * CXC-1 (ADR 0119) — the import write in the PRODUCTION cookie posture.
 *
 * The companion `chat-export-route.test.ts` runs under `OPENWOP_AUTH_DISABLE_COOKIES=true`,
 * where an anonymous import is 401'd. That is NOT the `app.openwop.dev` posture. In the
 * default cookie-per-visitor posture (no `OPENWOP_AUTH_DISABLE_COOKIES`, no
 * `OPENWOP_AUTH_ENFORCE_BEARER`), an anonymous request is minted a per-visitor anon
 * SESSION (`principalId:'session:<sid>'`) in a UNIQUE tenant `anon:<sid>` and DOES reach
 * the route (HTTP 201) — so the protection cannot be "anon is rejected".
 *
 * What this file witnesses: the import is reachable in this posture and is CONFINED to
 * its visitor — the visitor re-reads it, and a different visitor gets the uniform 404.
 *
 * CORRECTED (wave 24) — this header used to say the different-visitor 404 witnesses
 * OWNERSHIP. It cannot: visitor B lives in a different anon tenant, so the tenant
 * lookup refuses B before the owner predicate is consulted, and an owner-less import
 * would be just as invisible (probes importing with an empty owner, or dropping the
 * route's `isVisibleToAsync` check, stayed green). Ownership is witnessed where a
 * same-tenant reader exists: `chat-export-route.test.ts` ("a same-tenant peer cannot
 * read it") and `import-service.test.ts` ("creates an owned conversation").
 *
 * Sabotage that turns this red: forcing the route's visibility check to deny (the
 * visitor's own re-read 404s).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_API_KEYS'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

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
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('chat-export import — production cookie posture (CXC-1)', () => {
  it('an anon visitor CAN import (201), re-reads its own import, and a DIFFERENT visitor gets the uniform 404', async () => {
    const payload = { format: 'openwop', data: { version: 'openwop-v1', title: 'Anon import', messages: [{ role: 'user', content: 'secret note' }] } };

    // Visitor A (no cookie ⇒ minted a fresh anon session + private tenant).
    const impRes = await fetch(`${BASE}/host/openwop-app/chat-export/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    // Reaches the route in cookie posture — NOT 401. This is the reviewer's finding.
    expect(impRes.status).toBe(201);
    const cookieA = cookieOf(impRes);
    expect(cookieA).toBeTruthy(); // an anon session was minted
    const { sessionId, imported } = await impRes.json() as { sessionId: string; imported: number };
    expect(sessionId).toBeTruthy();
    expect(imported).toBe(1);

    // Visitor A re-reads its OWN import (same cookie) — allowed, with the imported content.
    const ownRead = await fetch(`${BASE}/host/openwop-app/chat-export/${sessionId}`, { headers: { cookie: cookieA! } });
    expect(ownRead.status).toBe(200);
    expect(await ownRead.text()).toContain('secret note');

    // Visitor B (no cookie ⇒ a DIFFERENT anon session + tenant) gets the uniform 404.
    const otherRead = await fetch(`${BASE}/host/openwop-app/chat-export/${sessionId}`);
    expect(otherRead.status).toBe(404);
    const otherBody = await otherRead.text();
    expect(otherBody).not.toContain('secret note');
    expect(JSON.parse(otherBody)).toMatchObject({ error: 'not_found' });
  });
});
