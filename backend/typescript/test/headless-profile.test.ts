/**
 * ADR 0168 Part A — the headless capability profile (`OPENWOP_PROFILE`).
 *
 * Two layers:
 *  1. Unit — `presentationEnabled()` is the single gate all four sites consume
 *     (discovery uiPlugins + realtimeVoice, the uiPlugins route module, the voice
 *     feature, the chat-widget public gateway). Covers all three presentation
 *     capabilities × full/headless/override deterministically — including
 *     `chatWidget`, whose public gateway returns a uniform fail-closed 404 by
 *     design (no existence oracle) and so can't be black-box HTTP-probed.
 *  2. Integration — a booted host: `headless` withholds uiPlugins + realtimeVoice
 *     from `/.well-known/openwop` AND unmounts their routes; `full` (default) is
 *     exactly today's behavior; the per-capability override wins.
 *
 * @see docs/adr/0168-headless-profile-and-first-party-cli.md
 * @see src/host/hostProfile.ts
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { voiceFeature } from '../src/features/voice/feature.js';
import { hostProfile, presentationEnabled, type PresentationCapability } from '../src/host/hostProfile.js';

const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const CAPS: PresentationCapability[] = ['uiPlugins', 'realtimeVoice', 'chatWidget'];

describe('ADR 0168 — presentationEnabled gate (unit)', () => {
  const clearEnv = () => {
    delete process.env.OPENWOP_PROFILE;
    for (const s of ['UIPLUGINS', 'REALTIMEVOICE', 'CHATWIDGET']) delete process.env[`OPENWOP_PRESENTATION_${s}`];
  };
  afterEach(clearEnv);

  it('full (default) — every presentation surface is presented', () => {
    expect(hostProfile()).toBe('full');
    for (const c of CAPS) expect(presentationEnabled(c), c).toBe(true);
  });

  it('headless — every presentation surface is withheld', () => {
    process.env.OPENWOP_PROFILE = 'headless';
    expect(hostProfile()).toBe('headless');
    for (const c of CAPS) expect(presentationEnabled(c), c).toBe(false);
  });

  it('per-capability override beats the profile both ways', () => {
    process.env.OPENWOP_PROFILE = 'headless';
    process.env.OPENWOP_PRESENTATION_UIPLUGINS = 'on';
    expect(presentationEnabled('uiPlugins'), 'headless + UIPLUGINS=on → on').toBe(true);
    expect(presentationEnabled('realtimeVoice'), 'other caps stay off in headless').toBe(false);

    clearEnv(); // full profile, but force one cap off
    process.env.OPENWOP_PRESENTATION_CHATWIDGET = 'off';
    expect(presentationEnabled('chatWidget'), 'full + CHATWIDGET=off → off').toBe(false);
    expect(presentationEnabled('uiPlugins'), 'other caps stay on in full').toBe(true);
  });

  it('an unrecognized OPENWOP_PROFILE falls back to full (fail-open to today\'s behavior)', () => {
    process.env.OPENWOP_PROFILE = 'banana';
    expect(hostProfile()).toBe('full');
    for (const c of CAPS) expect(presentationEnabled(c), c).toBe(true);
  });
});

// ───────────────────────── integration (booted host) ─────────────────────────

async function boot(env: Record<string, string | undefined>): Promise<{ base: string; server: http.Server }> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Force the `voice` toggle ON so a MOUNTED voice route answers non-404 — otherwise
  // the default-off toggle 404s the handler and HTTP can't tell mounted-but-off from
  // unmounted. With the toggle ON, headless's 404 is unambiguously the route gate.
  await saveConfig({ ...voiceFeature.toggleDefault!, status: 'on' }, 'test');
  const server = await new Promise<http.Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const close = (s: http.Server) => new Promise<void>((res) => s.close(() => res()));

interface Advert { uiPlugins?: unknown; aiProviders?: { realtimeVoice?: unknown }; realtimeVoice?: unknown; agents?: unknown }
const discover = async (base: string): Promise<Advert> => (await (await fetch(`${base}/.well-known/openwop`, { headers: H })).json()) as Advert;
const status = (base: string, method: string, path: string) =>
  fetch(`${base}${path}`, { method, headers: H, ...(method === 'POST' ? { body: '{}' } : {}) }).then((r) => r.status);

// uiPlugins RPC → 400 for a bad body when mounted (cleanly ≠ 404). voice/session →
// non-404 when mounted+toggle-on. (The widget public gateway is uniform-404 by design,
// so it has no clean HTTP mount signal — covered by the unit gate test above.)
const UIPLUGIN_RPC = '/v1/host/openwop-app/ui-plugin/rpc';
const VOICE_SESSION = '/v1/host/openwop-app/voice/session';

describe('ADR 0168 — full profile (default) presents uiPlugins + realtimeVoice', () => {
  let base: string; let server: http.Server;
  beforeAll(async () => { ({ base, server } = await boot({ OPENWOP_PROFILE: undefined, OPENWOP_PRESENTATION_UIPLUGINS: undefined, OPENWOP_PRESENTATION_REALTIMEVOICE: undefined, OPENWOP_PRESENTATION_CHATWIDGET: undefined })); });
  afterAll(async () => { await close(server); __clearToggleStore(); });

  it('advertises uiPlugins + realtimeVoice (and non-presentational surfaces unaffected)', async () => {
    const d = await discover(base);
    expect(d.uiPlugins, 'uiPlugins advertised at the discovery root').toBeTruthy();
    expect(d.aiProviders?.realtimeVoice ?? d.realtimeVoice, 'realtimeVoice advertised').toBeTruthy();
    expect(d.agents, 'agents capability unaffected by profile').toBeTruthy();
  });

  it('mounts the uiPlugins RPC + voice routes (non-404)', async () => {
    expect(await status(base, 'POST', UIPLUGIN_RPC), 'ui-plugin RPC mounted').not.toBe(404);
    expect(await status(base, 'POST', VOICE_SESSION), 'voice session mounted (toggle on)').not.toBe(404);
  });
});

describe('ADR 0168 — headless profile withholds advert + unmounts routes', () => {
  let base: string; let server: http.Server;
  beforeAll(async () => { ({ base, server } = await boot({ OPENWOP_PROFILE: 'headless', OPENWOP_PRESENTATION_UIPLUGINS: undefined, OPENWOP_PRESENTATION_REALTIMEVOICE: undefined, OPENWOP_PRESENTATION_CHATWIDGET: undefined })); });
  afterAll(async () => { await close(server); __clearToggleStore(); delete process.env.OPENWOP_PROFILE; });

  it('omits uiPlugins + realtimeVoice from discovery; keeps non-presentational surfaces', async () => {
    const d = await discover(base);
    expect(d.uiPlugins, 'uiPlugins withheld in headless').toBeUndefined();
    expect(d.aiProviders?.realtimeVoice, 'realtimeVoice withheld in headless').toBeUndefined();
    expect(d.realtimeVoice, 'realtimeVoice root mirror withheld too').toBeUndefined();
    expect(d.agents, 'agents capability still present in headless').toBeTruthy();
  });

  it('unmounts the uiPlugins RPC + voice routes (404 even with the voice toggle ON)', async () => {
    expect(await status(base, 'POST', UIPLUGIN_RPC), 'ui-plugin RPC unmounted').toBe(404);
    expect(await status(base, 'POST', VOICE_SESSION), 'voice session unmounted despite toggle on').toBe(404);
  });
});

describe('ADR 0168 — per-capability override wins over the profile (integration)', () => {
  let base: string; let server: http.Server;
  beforeAll(async () => { ({ base, server } = await boot({ OPENWOP_PROFILE: 'headless', OPENWOP_PRESENTATION_UIPLUGINS: 'on' })); });
  afterAll(async () => { await close(server); __clearToggleStore(); delete process.env.OPENWOP_PROFILE; delete process.env.OPENWOP_PRESENTATION_UIPLUGINS; });

  it('headless + OPENWOP_PRESENTATION_UIPLUGINS=on → uiPlugins back (advert + route), voice stays off', async () => {
    const d = await discover(base);
    expect(d.uiPlugins, 'override re-presents uiPlugins advert').toBeTruthy();
    expect(d.aiProviders?.realtimeVoice, 'realtimeVoice still withheld').toBeUndefined();
    expect(await status(base, 'POST', UIPLUGIN_RPC), 'override re-mounts ui-plugin RPC').not.toBe(404);
    expect(await status(base, 'POST', VOICE_SESSION), 'voice still unmounted').toBe(404);
  });
});
