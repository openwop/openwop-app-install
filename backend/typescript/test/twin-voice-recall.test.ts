/**
 * RCL-2 — the VOICE lane's borrowed recall, previously the only wholly-untested
 * in-scope lane: no test joined voice and twin recall, and the caller
 * attribution is several optional-chains away from silent denial
 * (`features/voice/realtime/routes.ts` — `callerUserId: callerUser?.userId`).
 *
 * Drives the REAL session-mint route (mock provider token via
 * OPENWOP_VOICE_MOCK) with the REAL `resolveBorrowedRecall` installed by the
 * twin feature at boot:
 *   - the OWNER opens a voice session scoped to their granted twin ⇒ the minted
 *     `instructions` carry the fenced owner note + the owner-naming preamble;
 *   - a NON-owner (same tenant, admin) opens the same session ⇒ absent.
 *
 * What this does NOT discriminate: a truly UNRESOLVED caller through the voice
 * ROUTE (the cookie test harness always authenticates; an anonymous request
 * cannot carry the fixture tenant). That deny leg — `audience-no-caller` — is
 * pinned with the real resolver in twin-route.test.ts and at compose level in
 * twin-recall-fence.test.ts; both denials share one deny-by-default gate
 * (`borrowedRecall.ts`), so the non-owner route leg here exercises the same
 * refusal path the unresolved caller takes.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { setRealtimeConfig } from '../src/features/voice/realtime/config.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_VOICE_MOCK = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'twin-recall', 'voice']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_VOICE_MOCK;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const twin = (id: string): string => `/v1/host/openwop-app/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/openwop-app/profiles/me/twin-grants';
const MEM = '/v1/host/openwop-app/profiles/me/memory';
const RT = '/v1/host/openwop-app/voice/realtime';

describe('RCL-2 — voice-mint borrowed recall (granted owner vs non-owner)', () => {
  it('the OWNER gets the fenced owner note in instructions; a NON-owner gets nothing', async () => {
    const tenantId = `org:twv-${Date.now()}-${n++}`;
    const admin = client();
    await admin.post('/v1/host/openwop-app/test/login', { email: `twv-admin-${Date.now()}-${n++}@acme.test`, tenantId });
    const member = client();
    const m = await member.post('/v1/host/openwop-app/test/login', { email: `twv-member-${Date.now()}-${n++}@acme.test`, tenantId });
    const memberId = m.body.user.userId as string;
    // A REGISTERED manifest agent (packs are not mounted in this harness) so
    // the voice mint composes its persona — the borrowed leg only composes for
    // a resolved, tenant-visible agent scaffold (`chatContext.ts`).
    getAgentRegistry().register({
      agentId: 'probe.twin.voice-aide', persona: 'Voice Aide', modelClass: 'chat',
      systemPrompt: 'PERSONA-MARKER-RCL2: you are the voice aide.',
      packName: 'test.twin-voice', packVersion: '0.0.1', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const entry = await createRosterEntry({ tenantId, persona: 'Voice Aide', agentRef: { agentId: 'probe.twin.voice-aide' } });
    const rosterId = entry.rosterId;
    __clearAgentIdentityCache(); // the reverse index is TTL-cached; drop it after mutating the roster

    // The owner's personal memory + link + grant.
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
    expect((await admin.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    // Realtime config for THIS tenant, set at the SERVICE layer (the PUT route
    // is superadmin-gated, and provider wiring is not what this test proves).
    // Mock token mint via OPENWOP_VOICE_MOCK; no network.
    await setSecret('rt-twin-voice', 'gk-test', { tenantId });
    await setRealtimeConfig(tenantId, { provider: 'gemini-live', credentialRef: 'rt-twin-voice' });

    // OWNER opens the voice session scoped to the granted twin.
    const mine = await member.post(`${RT}/session`, { agentId: rosterId });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const myInstructions = (mine.body.realtime?.instructions ?? '') as string;
    expect(myInstructions, 'the owner note must reach the voice instructions').toContain('cc finance on vendor contracts');
    expect(myInstructions, 'borrowed content must be fenced in voice too').toContain('BEGIN UNTRUSTED CONTENT');
    // RCL-6 — the owner-naming preamble rides into the voice mint as well.
    expect(myInstructions).toContain('shared memory');

    // NON-owner (the admin, same tenant, real authenticated caller): denied —
    // the instructions compose normally but carry none of the owner's corpus.
    const theirs = await admin.post(`${RT}/session`, { agentId: rosterId });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const theirInstructions = (theirs.body.realtime?.instructions ?? '') as string;
    expect(theirInstructions).not.toContain('cc finance on vendor contracts');
  });
});
