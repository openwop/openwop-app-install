/**
 * ADR 0893 VOX2-F1b — an anonymous visitor cannot spend the speech seams.
 *
 * VOX2-F1 gated the four RFC 0105/0106 speech seams on `runs:create`. MEASURED on
 * prod 5edc98fe6 right after it shipped: a cookieless POST minted a fresh `anon:`
 * session and the synthesizer answered 200, because authorization enforcement is
 * off there and the scope gate only narrows `owk_` keys. Each fresh anon tenant
 * also gets its own per-org TTS budget, so the budget did not bound it either.
 * This file boots the real cookie posture (anon sessions minted) to reproduce it.
 *
 * (TST-BPD) Red when (sabotage-witnessed, wave 65): `requireNonAnonymousPrincipal`
 * (`middleware/auth.ts`, the gate `speechSeamGate` runs first) admits an anonymous
 * principal ⇒ every seam row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let server: Server;
let base = '';
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_SEAM_ENABLED']) saved[k] = process.env[k];
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // ADR 0900 D1: outside the test-seam mode an anon visitor is refused 404 before this
  // gate (`adr0900-speech-seam-scope.test.ts`), so the 401 is witnessed with it on.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'vox2f1b', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const SEAMS: Array<[string, unknown]> = [
  ['/host/openwop-app/ai/call-speech-synthesizer', { text: 'hi', voiceId: 'v' }],
  ['/host/sample/ai/call-speech-synthesizer', { text: 'hi', voiceId: 'v' }],
  ['/host/openwop-app/ai/call-transcriber', { audio: { url: 'https://example.invalid/a.wav' } }],
  ['/host/sample/ai/call-transcriber', { audio: { url: 'https://example.invalid/a.wav' } }],
];

describe('VOX2-F1b — the speech seams refuse an anonymous principal', () => {
  it('precondition: a credential-less visit mints an anon session cookie', async () => {
    const me = await fetch(`${base}/host/openwop-app/users/me`);
    expect((me.headers.get('set-cookie') ?? '').split(';')[0]).toMatch(/^__session=/);
  });
  for (const [path, body] of SEAMS) {
    it(`${path}: an anon session is refused 401 anonymous_principal_refused`, async () => {
      const me = await fetch(`${base}/host/openwop-app/users/me`);
      const cookie = (me.headers.get('set-cookie') ?? '').split(';')[0];
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('anonymous_principal_refused');
    });
  }
});
