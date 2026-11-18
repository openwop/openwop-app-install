/**
 * ADR 1136 P2a-2 — the browser executor over the paired-device channel, and the
 * release manager's conditions 1–3 (ADR 1136 "P2 conditions"):
 *
 *  - pairing grants ONE capability. A browser pairing binds to the browser
 *    consent, mints a key that declares only `device:browser`, and can never host
 *    a terminal or a workflow task; a terminal device can never drive a browser;
 *  - condition 1: an attach is written from the socket's verified identity, and
 *    a frame that tries to name a device or a person is refused;
 *  - condition 2: a result reaches only the request it belongs to: across
 *    instances, chunked, and never after its timeout;
 *  - condition 3: a frame type belongs to one capability, checked on receipt and
 *    on send.
 *
 * Sabotage witnesses (each red, then restored):
 *  - accept extra keys on browser-attach → "a forged attach";
 *  - drop the binding check in `settle` → "a result for another binding";
 *  - send browser ops to a terminal device → "the send side refuses";
 *  - mint browser keys with DEVICE_KEY_SCOPES → "a browser pairing".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { keyDeclarationPermits } from '../src/host/delegatedSubject.js';
import { BROWSER_CONSENT_TEXT, CLAUDE_CODE_OPERATOR_ENV, CONSENT_TEXT, consentHash } from '../src/features/claude-code/constants.js';
import { decidePairing, getPendingPairing, ownedDevice, pollPairing, setWorkflowTasks, startPairing, type DeviceRecord } from '../src/features/claude-code/pairingService.js';
import { markPresent } from '../src/features/claude-code/terminalStore.js';
import { dispatchDeviceFrame, identityOf, sendDeviceMessage, type DeviceIdentity } from '../src/features/claude-code/deviceChannel.js';
import { browserPresenceFor } from '../src/features/computer-use/browserPresence.js';
import { RemoteExecutorHub, RESULT_CHUNK_CHARS, _setRemoteExecutorHub, remoteExecutorFor, registerBrowserDeviceHandlers } from '../src/features/computer-use/remoteExecutor.js';

let server: http.Server;
const T = 'tenant-cu-p2a2';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env[CLAUDE_CODE_OPERATOR_ENV] = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  for (const id of ['claude-code', 'computer-use']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  registerBrowserDeviceHandlers();
}, 120_000);
afterAll(async () => { delete process.env[CLAUDE_CODE_OPERATOR_ENV]; await new Promise<void>((res) => server.close(() => res())); });

let k = 0;
/** Pair a device through the real service: start, approve, poll. */
async function pair(subject: string, capability: 'terminal' | 'browser'): Promise<{ device: DeviceRecord; token: string }> {
  const started = await startPairing({ label: `dev ${++k}`, platform: 'test', capability });
  const consent = capability === 'browser' ? BROWSER_CONSENT_TEXT : CONSENT_TEXT;
  await decidePairing(started.userCode, { approve: true, subject, tenantId: T, consentHash: consentHash(consent) });
  const polled = await pollPairing(started.deviceCode);
  if (!polled || polled.status !== 'approved') throw new Error(`pairing did not complete: ${JSON.stringify(polled)}`);
  const device = await ownedDevice(T, polled.deviceId, subject);
  if (!device) throw new Error('no device');
  return { device, token: polled.token };
}

describe('ADR 1136 P2a — a pairing grants one capability', () => {
  it('a browser pairing binds to the browser consent and mints a key that can read nothing', async () => {
    const started = await startPairing({ label: 'browser box', platform: 'test', capability: 'browser' });
    expect(started.capability).toBe('browser'); // echoed: the companion refuses a browser pairing without it
    expect((await getPendingPairing(started.userCode))?.capability).toBe('browser');
    // The terminal consent does not approve a browser pairing.
    await expect(decidePairing(started.userCode, { approve: true, subject: 'oidc:p2a2-a', tenantId: T, consentHash: consentHash(CONSENT_TEXT) }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await decidePairing(started.userCode, { approve: true, subject: 'oidc:p2a2-a', tenantId: T, consentHash: consentHash(BROWSER_CONSENT_TEXT) });
    const polled = await pollPairing(started.deviceCode);
    expect(polled?.status).toBe('approved');
    const key = await verifyApiKey((polled as { token: string }).token);
    expect(key?.scopes).toEqual(['device:browser']);
    for (const scope of ['workspace:read', 'workspace:write', 'runs:create']) expect(keyDeclarationPermits(key!.scopes, scope)).toBe(false);
    const device = await ownedDevice(T, (polled as { deviceId: string }).deviceId, 'oidc:p2a2-a');
    expect([device?.capability, device?.consentVersion]).toEqual(['browser', BROWSER_CONSENT_TEXT.version]);
  });

  it('an unknown capability is refused; none means terminal', async () => {
    await expect(startPairing({ capability: 'both' })).rejects.toMatchObject({ httpStatus: 400 });
    const t = await pair('oidc:p2a2-term', 'terminal');
    expect(t.device.capability).toBe('terminal');
    expect((await verifyApiKey(t.token))?.scopes).toEqual(['workspace:read', 'workspace:write']);
  });

  it('a browser device cannot accept workflow tasks; a terminal device still can', async () => {
    const b = await pair('oidc:p2a2-b', 'browser');
    await expect(setWorkflowTasks(T, b.device.deviceId, 'oidc:p2a2-b', true)).rejects.toMatchObject({ httpStatus: 409 });
    const t = await pair('oidc:p2a2-b', 'terminal');
    expect((await setWorkflowTasks(T, t.device.deviceId, 'oidc:p2a2-b', true))?.workflowTasks).toBeTruthy();
  });
});

describe('ADR 1136 P2 conditions 1 and 3 — the attach and the frame types', () => {
  it('an attach is written from the socket identity; a frame naming a device or a person is refused', async () => {
    const a = await pair('oidc:p2a2-alice', 'browser');
    const m = await pair('oidc:p2a2-mallory', 'browser');
    const mallory = identityOf(m.device);
    // Mallory's socket names Alice's device and person in the body: refused.
    await dispatchDeviceFrame({ type: 'browser-attach', executorId: 'ex-forged', protocolVersion: 1, deviceId: a.device.deviceId, subject: 'oidc:p2a2-alice' }, mallory);
    expect(await browserPresenceFor(T, 'oidc:p2a2-alice')).toBeNull();
    expect(await browserPresenceFor(T, 'oidc:p2a2-mallory')).toBeNull();
    // A well-formed attach lands on Mallory's own row and nobody else's.
    await dispatchDeviceFrame({ type: 'browser-attach', executorId: 'ex-m1', protocolVersion: 1 }, mallory);
    expect(await browserPresenceFor(T, 'oidc:p2a2-mallory')).toMatchObject({ deviceId: m.device.deviceId, executorId: 'ex-m1' });
    expect(await browserPresenceFor(T, 'oidc:p2a2-alice')).toBeNull();
  });

  it('a terminal device cannot attach a browser (the receive side)', async () => {
    const t = await pair('oidc:p2a2-tonly', 'terminal');
    await dispatchDeviceFrame({ type: 'browser-attach', executorId: 'ex-t1', protocolVersion: 1 }, identityOf(t.device));
    expect(await browserPresenceFor(T, 'oidc:p2a2-tonly')).toBeNull();
  });

  it('the send side refuses a terminal device, a revoked one and an untyped message', async () => {
    const t = await pair('oidc:p2a2-send', 'terminal');
    expect(await sendDeviceMessage(t.device, 'browser', { type: 'browser-op' })).toBe(false);
    const b = await pair('oidc:p2a2-send', 'browser');
    expect(await sendDeviceMessage({ ...b.device, revokedAt: new Date().toISOString() }, 'browser', { type: 'browser-op' })).toBe(false);
    expect(await sendDeviceMessage(b.device, 'browser', { type: 'op' })).toBe(false);
  });
});

/** Two "instances" on one in-memory bus. The device's socket is held by B. */
function twoInstances() {
  const subs = new Map<string, Set<(p: string) => void>>();
  const publish = async (ch: string, p: string) => { for (const h of subs.get(ch) ?? []) h(p); };
  const subscribe = async (ch: string, h: (p: string) => void) => {
    const set = subs.get(ch) ?? new Set(); set.add(h); subs.set(ch, set);
    return async () => { set.delete(h); };
  };
  let deviceReply: ((msg: Record<string, unknown>) => Promise<void>) | null = null;
  const b = new RemoteExecutorHub(publish, subscribe, async () => true);
  const a = new RemoteExecutorHub(publish, subscribe, async (_d, _c, msg) => { await deviceReply?.(msg); return true; });
  return { a, b, setDevice: (fn: (msg: Record<string, unknown>) => Promise<void>) => { deviceReply = fn; } };
}

describe('ADR 1136 P2 condition 2 — a result reaches only its own request', () => {
  const who: DeviceIdentity = { deviceId: 'ccd_x', tenantId: T, subject: 'oidc:p2a2-r', capability: 'browser' };
  const req = (hub: RemoteExecutorHub, timeoutMs = 200) => hub.request({
    device: { deviceId: 'ccd_x', capability: 'browser' }, tenantId: T, executorId: 'ex-r', bindingId: 'bind-1', op: { op: 'snapshot' }, timeoutMs,
  });

  it('a result crosses instances, chunked, and arrives whole', async () => {
    const { a, b, setDevice } = twoInstances();
    const text = 'y'.repeat(RESULT_CHUNK_CHARS * 2 + 17);
    setDevice(async (msg) => { await b.onResultFrame({ type: 'browser-result', reqId: msg.reqId, executorId: 'ex-r', bindingId: 'bind-1', result: { ok: true, text } }, who); });
    expect(await req(a)).toEqual({ ok: true, text });
    expect(a.pendingCount()).toBe(0);
  });

  it('a result for another binding, executor or tenant is dropped, so the request times out', async () => {
    for (const bad of [{ bindingId: 'bind-2' }, { executorId: 'ex-other' }]) {
      const { a, b, setDevice } = twoInstances();
      setDevice(async (msg) => { await b.onResultFrame({ type: 'browser-result', reqId: msg.reqId, executorId: 'ex-r', bindingId: 'bind-1', ...bad, result: { ok: true } }, who); });
      expect(await req(a, 80)).toEqual({ ok: false, error: 'timeout' });
    }
    const { a, b, setDevice } = twoInstances();
    setDevice(async (msg) => { await b.onResultFrame({ type: 'browser-result', reqId: msg.reqId, executorId: 'ex-r', bindingId: 'bind-1', result: { ok: true } }, { ...who, tenantId: 'tenant-other' }); });
    expect(await req(a, 80)).toEqual({ ok: false, error: 'timeout' });
  });

  it('a result that arrives after the timeout is dropped, never applied', async () => {
    const { a, b, setDevice } = twoInstances();
    let late: (() => Promise<void>) | null = null;
    setDevice(async (msg) => { late = () => b.onResultFrame({ type: 'browser-result', reqId: msg.reqId, executorId: 'ex-r', bindingId: 'bind-1', result: { ok: true } }, who); });
    expect(await req(a, 40)).toEqual({ ok: false, error: 'timeout' });
    await late!();
    expect(a.pendingCount()).toBe(0);
  });
});

describe('ADR 1136 P2 entry criterion 1 — the executor is the person\'s attached browser, from any instance', () => {
  beforeEach(() => { _setRemoteExecutorHub(new RemoteExecutorHub(async () => undefined, async () => async () => undefined, async () => true)); });

  it('resolves only an online browser device, and a newer attach makes the older executor replaced', async () => {
    const p = await pair('oidc:p2a2-exec', 'browser');
    const me = identityOf(p.device);
    expect(await remoteExecutorFor(T, 'oidc:p2a2-exec')).toBeNull(); // nothing attached
    await dispatchDeviceFrame({ type: 'browser-attach', executorId: 'ex-1', protocolVersion: 1 }, me);
    expect(await remoteExecutorFor(T, 'oidc:p2a2-exec')).toBeNull(); // attached but offline
    await markPresent(p.device.deviceId, T, 'instance-b');
    const first = await remoteExecutorFor(T, 'oidc:p2a2-exec');
    expect(first?.executorId).toBe('ex-1');
    await dispatchDeviceFrame({ type: 'browser-attach', executorId: 'ex-2', protocolVersion: 1 }, me);
    expect(await first!.perform({ op: 'snapshot' }, { timeoutMs: 20 })).toEqual({ ok: false, error: 'replaced' });
    expect(first!.state()).toBe('replaced');
    expect((await remoteExecutorFor(T, 'oidc:p2a2-exec'))?.executorId).toBe('ex-2');
    // Another person never gets this browser.
    expect(await remoteExecutorFor(T, 'oidc:p2a2-someone-else')).toBeNull();
  });
});
