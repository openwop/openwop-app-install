/**
 * ADR 0785 P2 — the terminal, end to end over REAL sockets on a real server.
 *
 * A paired device connects out with its key; a signed-in person opens a terminal
 * over HTTP; the device is told to open it and streams output; a browser viewer
 * attaches with a ticket and gets the replay, then live bytes; its keystrokes
 * reach the device; revoking the device closes its socket. Plus every refusal
 * the upgrade boundary owes (D4 items 1–5).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { attachRegisteredUpgradeHandlers, __listUpgradeHandlersForTest } from '../src/host/upgradeRegistry.js';
import { CLAUDE_CODE_OPERATOR_ENV, consentHash } from '../src/features/claude-code/constants.js';
import { __resetPairingRateLimitForTest } from '../src/features/claude-code/routes.js';
import { __runTerminalHeartbeatForTest } from '../src/features/claude-code/terminalSockets.js';
import { resetIssuerLiveCacheForTests } from '../src/middleware/auth.js';
import { setUserStatus } from '../src/features/users/usersService.js';

const BASE_PATH = '/host/openwop-app/claude-code';
let BASE: string; let WS: string; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { const port = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${port}`; WS = `ws://127.0.0.1:${port}`; res(); }); });
  attachRegisteredUpgradeHandlers(server);
  const users = getToggleDefault('users'); if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  process.env[CLAUDE_CODE_OPERATOR_ENV] = 'true';
  __resetPairingRateLimitForTest();
  const t = getToggleDefault('claude-code'); if (t) await saveConfig({ ...t, status: 'on' }, 'test');
});
afterEach(() => { delete process.env[CLAUDE_CODE_OPERATOR_ENV]; });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
let seq = 0;
async function person() {
  const c = client();
  const subject = `cct-${Date.now()}-${seq++}`;
  const tenantId = `org:cct-${Date.now()}-${seq++}`;
  const r = await c.post('/host/openwop-app/test/login', { subject, tenantId, email: `${subject}@a.test` });
  expect(r.status).toBe(201);
  return { c, tenantId };
}
async function pairDevice(owner: Awaited<ReturnType<typeof person>>) {
  const anon = client();
  const s = await anon.post(`${BASE_PATH}/pair/device/start`, { label: 'laptop' });
  await owner.c.post(`${BASE_PATH}/pair/requests/${s.body.userCode}/approve`, { consentHash: consentHash() });
  const p = await anon.post(`${BASE_PATH}/pair/device/poll`, { deviceCode: s.body.deviceCode });
  return { token: p.body.token as string, deviceId: p.body.deviceId as string };
}

/** A socket plus a queue of what it received, and a helper to await the next matching message. */
function open(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const json: any[] = []; const bin: Buffer[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) { bin.push(Buffer.from(data as Buffer)); return; }
    const m = JSON.parse(String(data)); json.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (pred: (m: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
    const hit = json.find(pred); if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`))); ws.once('error', reject); });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, json, bin, next, opened, closed, text: () => Buffer.concat(bin).toString() };
}
const refused = async (url: string, headers: Record<string, string> = {}) => {
  const s = open(url, headers);
  return s.opened.then(() => { s.ws.close(); return 101; }, (e: Error) => Number(/HTTP (\d+)/.exec(e.message)?.[1] ?? 0));
};
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('ADR 0785 P2 — terminal over real sockets', () => {
  it('the feature registered its upgrade handler through the core seam (core imports nothing)', () => {
    expect(__listUpgradeHandlersForTest()).toContain('claude-code');
  });

  it('device connects out → person opens a terminal → viewer sees replay + live bytes, and its keystrokes reach the device', async () => {
    const owner = await person();
    const { token, deviceId } = await pairDevice(owner);

    // Offline device ⇒ a clear 409, not a hang.
    const offline = await owner.c.post(`${BASE_PATH}/terminals`, { deviceId });
    expect(offline.status).toBe(409);

    const device = open(`${WS}/host/openwop-app/claude-code/device`, { authorization: `Bearer ${token}` });
    await device.opened;
    await device.next((m) => m.type === 'hello');
    expect((await owner.c.get(`${BASE_PATH}/devices`)).body.devices[0].online).toBe(true);

    const created = await owner.c.post(`${BASE_PATH}/terminals`, { deviceId, cols: 100, rows: 30, prompt: 'read workflow wf_1 over MCP', approveFromAnywhere: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.terminal.sessionId as string;
    const openMsg = await device.next((m) => m.type === 'open');
    expect(openMsg).toMatchObject({ sessionId, cols: 100, rows: 30, prompt: 'read workflow wf_1 over MCP', approveFromAnywhere: true });
    expect(JSON.stringify(created.body)).not.toContain('read workflow'); // the prompt is never stored on the row

    device.ws.send(JSON.stringify({ type: 'opened', sessionId, generation: 1 }));
    device.ws.send(JSON.stringify({ type: 'output', sessionId, data: b64('welcome\r\n') }));

    const t = await owner.c.post(`${BASE_PATH}/terminals/${sessionId}/ticket`);
    expect(t.status).toBe(200);
    const viewer = open(`${WS}${t.body.path}?ticket=${encodeURIComponent(t.body.ticket)}`, { origin: 'http://localhost:5173' });
    await viewer.opened;
    const attach = await device.next((m) => m.type === 'attach' && m.sessionId === sessionId);
    device.ws.send(JSON.stringify({ type: 'replay', sessionId, viewerId: attach.viewerId, data: b64('welcome\r\n') }));
    device.ws.send(JSON.stringify({ type: 'output', sessionId, data: b64('$ ') }));
    await new Promise((r) => setTimeout(r, 100));
    expect(viewer.text()).toBe('welcome\r\n$ ');

    viewer.ws.send(JSON.stringify({ type: 'input', data: b64('ls\r') }));
    expect(await device.next((m) => m.type === 'input')).toEqual({ type: 'input', sessionId, data: b64('ls\r') });
    viewer.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    expect(await device.next((m) => m.type === 'resize')).toEqual({ type: 'resize', sessionId, cols: 80, rows: 24 });

    device.ws.send(JSON.stringify({ type: 'exit', sessionId, code: 0, requested: false }));
    expect(await viewer.next((m) => m.type === 'exit')).toEqual({ type: 'exit', code: 0, requested: false });
    await new Promise((r) => setTimeout(r, 50));
    expect((await owner.c.get(`${BASE_PATH}/terminals`)).body.terminals[0]).toMatchObject({ sessionId, status: 'exited', exitCode: 0 });

    // Revoking the device closes its live socket.
    await owner.c.del(`${BASE_PATH}/devices/${deviceId}`);
    expect(await device.closed).toBe(4001);
    viewer.ws.close();
  });

  // ADR 0833 D1 (S11) — RED on 97baad74b: the heartbeat re-verified the key
  // but not its ISSUER, so a device paired by a since-disabled user stayed
  // connected (the upgrade asked; the heartbeat did not).
  it('a device whose pairing user is disabled is closed on the next heartbeat (4001)', async () => {
    const owner = await person();
    const me = await owner.c.get('/host/openwop-app/users/me');
    expect(me.status).toBe(200);
    const { token } = await pairDevice(owner);
    const device = open(`${WS}/host/openwop-app/claude-code/device`, { authorization: `Bearer ${token}` });
    await device.opened;
    await device.next((m) => m.type === 'hello');
    await setUserStatus(me.body.userId as string, 'disabled', { reason: 'admin' });
    resetIssuerLiveCacheForTests();
    await __runTerminalHeartbeatForTest();
    expect(await device.closed).toBe(4001);
  });

  it('a device may not speak for a session that is not its own', async () => {
    const a = await person(); const b = await person();
    const da = await pairDevice(a); const db = await pairDevice(b);
    const devA = open(`${WS}/host/openwop-app/claude-code/device`, { authorization: `Bearer ${da.token}` });
    const devB = open(`${WS}/host/openwop-app/claude-code/device`, { authorization: `Bearer ${db.token}` });
    await devA.opened; await devB.opened;
    await devA.next((m) => m.type === 'hello'); await devB.next((m) => m.type === 'hello');
    const sA = (await a.c.post(`${BASE_PATH}/terminals`, { deviceId: da.deviceId })).body.terminal.sessionId;
    // Device B forges an exit for A's session: ignored.
    devB.ws.send(JSON.stringify({ type: 'exit', sessionId: sA, code: 9, requested: false }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await a.c.get(`${BASE_PATH}/terminals`)).body.terminals[0].status).not.toBe('exited');
    devA.ws.close(); devB.ws.close();
  });

  it('refuses every upgrade it should (D4 boundary)', async () => {
    const owner = await person();
    const { token, deviceId } = await pairDevice(owner);
    const dev = `${WS}/host/openwop-app/claude-code/device`;
    expect(await refused(dev)).toBe(401);                                                    // no key
    expect(await refused(dev, { authorization: 'Bearer owk_nope' })).toBe(401);              // bad key
    expect(await refused(dev, { authorization: `Bearer ${token}`, origin: 'http://evil.test' })).toBe(403); // a browser is never a device

    const device = open(dev, { authorization: `Bearer ${token}` });
    await device.opened; await device.next((m) => m.type === 'hello');
    const sessionId = (await owner.c.post(`${BASE_PATH}/terminals`, { deviceId })).body.terminal.sessionId;
    const viewerUrl = `${WS}/host/openwop-app/claude-code/terminal/${sessionId}`;
    expect(await refused(viewerUrl, { origin: 'http://localhost:5173' })).toBe(401);                       // no ticket
    expect(await refused(`${viewerUrl}?ticket=forged.sig`, { origin: 'http://localhost:5173' })).toBe(401); // forged
    const other = await person();
    expect((await other.c.post(`${BASE_PATH}/terminals/${sessionId}/ticket`)).status).toBe(404);          // not yours

    delete process.env[CLAUDE_CODE_OPERATOR_ENV];
    expect(await refused(dev, { authorization: `Bearer ${token}` })).toBe(404);             // operator gate
    device.ws.close();
  });
});

describe('ADR 0785 P2 — the REAL companion daemon against the real server', () => {
  it('clients/agent-host run: opens the session it is told to, streams output, echoes keystrokes, replays on attach, stops on request', async () => {
    const owner = await person();
    const { token, deviceId } = await pairDevice(owner);
    const daemonUrl = new URL('../../../clients/agent-host/src/daemon.js', import.meta.url).href;
    const { AgentHostDaemon } = (await import(daemonUrl)) as { AgentHostDaemon: new (o: Record<string, unknown>) => { start(): void; stop(): void } };

    // A fake PTY that behaves like an echoing shell, so no real `claude` is needed.
    const spawned: { command: string; args: string[]; cwd: string; killed: string[] }[] = [];
    const ptyFactory = (command: string, args: string[], opts: { cwd: string }) => {
      let onData: (d: string) => void = () => {}; let onExit: (e: { exitCode: number }) => void = () => {};
      const rec = { command, args, cwd: opts.cwd, killed: [] as string[] };
      spawned.push(rec);
      setTimeout(() => onData('claude> '), 10);
      return {
        pid: 999_999,
        onData: (cb: typeof onData) => { onData = cb; }, onExit: (cb: typeof onExit) => { onExit = cb; },
        write: (d: string) => onData(d === '\r' ? '\r\n' : d),
        resize: () => {}, kill: (sig: string) => { rec.killed.push(sig); onExit({ exitCode: 0 }); },
      };
    };
    const daemon = new AgentHostDaemon({ apiRoot: BASE, token, root: '/tmp/repo', ptyFactory, WebSocketImpl: globalThis.WebSocket, command: 'claude' });
    daemon.start();
    for (let i = 0; i < 50 && !(await owner.c.get(`${BASE_PATH}/devices`)).body.devices[0]?.online; i += 1) await new Promise((r) => setTimeout(r, 40));

    const created = await owner.c.post(`${BASE_PATH}/terminals`, { deviceId, prompt: 'fix the failing test' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.terminal.sessionId as string;
    for (let i = 0; i < 50 && spawned.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(spawned[0]).toMatchObject({ command: 'claude', args: ['fix the failing test'], cwd: '/tmp/repo' });

    await new Promise((r) => setTimeout(r, 60)); // the prompt output lands before anyone watches
    const t = await owner.c.post(`${BASE_PATH}/terminals/${sessionId}/ticket`);
    const viewer = open(`${WS}${t.body.path}?ticket=${encodeURIComponent(t.body.ticket)}`, { origin: 'http://localhost:5173' });
    await viewer.opened;
    await new Promise((r) => setTimeout(r, 100));
    expect(viewer.text()).toBe('claude> '); // arrived via REPLAY, exactly once

    viewer.ws.send(JSON.stringify({ type: 'input', data: b64('hi') }));
    for (let i = 0; i < 50 && !viewer.text().endsWith('hi'); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(viewer.text()).toBe('claude> hi');

    expect((await owner.c.del(`${BASE_PATH}/terminals/${sessionId}`)).status).toBe(204);
    expect(await viewer.next((m) => m.type === 'exit')).toMatchObject({ type: 'exit', requested: true });
    expect(spawned[0]!.killed).toEqual(['SIGHUP']);
    viewer.ws.close();
    daemon.stop();
  });
});

