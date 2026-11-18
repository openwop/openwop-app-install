// ADR 1136 P2b — the companion's browser mode, without a browser:
//   - the daemon's two modes answer only their own messages (the device-side
//     capability check, P2 condition 3), and a browser daemon attaches with ids only;
//   - the executor's own refusals (P2 condition 6);
//   - a browser pairing and a terminal pairing are stored apart;
//   - a missing optional dependency degrades to "browser mode unavailable" and
//     leaves terminal mode working;
//   - a browser pairing against a host that does not grant one is refused.
//
// Sabotage that reds it: answer a browser-op in terminal mode, or a terminal
// `open` in browser mode; send any field beyond executorId/protocolVersion on
// attach; drop the `file:`/`data:`/`javascript:`/`chrome:` refusal, the
// credentialed-URL refusal or the private-address refusal; store both pairings
// under one keychain account or folder; let `loadPlaywright` throw; accept a
// start response without `capability: 'browser'`.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHostDaemon, BROWSER_PROTOCOL_VERSION } from '../src/daemon.js';
import { navigationRefusal, requestRefusal, isPrivateHost } from '../src/browserRefusals.js';
import { browserHome, loadCredential, saveCredential } from '../src/credentialStore.js';
import { loadPlaywright } from '../src/browserExecutor.js';
import { startPairing } from '../src/pairing.js';
import { brandedDefaults } from '../src/branding.js';

function browserDaemon(perform) {
  const sent = [];
  const executor = { perform: perform ?? (async (op) => ({ ok: true, seen: op.op })) };
  const d = new AgentHostDaemon({ mode: 'browser', browser: { executor, executorId: 'ex_1' }, apiRoot: 'http://x', token: 't', root: '/r' });
  d.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  return { d, sent, executor };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a browser daemon attaches with ids only, and answers a browser-op on the same socket', async () => {
  const sent = [];
  class FakeWs { constructor() { this.readyState = 1; FakeWs.last = this; } send(m) { sent.push(JSON.parse(m)); } close() {} }
  const d = new AgentHostDaemon({ mode: 'browser', browser: { executor: { perform: async () => ({ ok: true }) }, executorId: 'ex_9' }, apiRoot: 'http://x', token: 't', root: '/r', WebSocketImpl: FakeWs });
  d.connect();
  FakeWs.last.onopen();
  assert.deepEqual(sent, [{ type: 'browser-attach', executorId: 'ex_9', protocolVersion: BROWSER_PROTOCOL_VERSION }]);

  const b = browserDaemon();
  b.d.handle({ type: 'browser-op', reqId: 'r'.repeat(22), executorId: 'ex_1', bindingId: 'bind', kind: 'snapshot', op: { op: 'snapshot' } });
  await tick();
  assert.deepEqual(b.sent, [{ type: 'browser-result', reqId: 'r'.repeat(22), executorId: 'ex_1', bindingId: 'bind', result: { ok: true, seen: 'snapshot' } }]);
});

test('a browser daemon ignores an op for another executor, a mismatched kind, and every terminal message', async () => {
  let performed = 0;
  const { d, sent } = browserDaemon(async () => { performed += 1; return { ok: true }; });
  d.handle({ type: 'browser-op', reqId: 'r'.repeat(22), executorId: 'ex_other', bindingId: 'b', kind: 'snapshot', op: { op: 'snapshot' } });
  d.handle({ type: 'browser-op', reqId: 'r'.repeat(22), executorId: 'ex_1', bindingId: 'b', kind: 'click', op: { op: 'snapshot' } });
  d.handle({ type: 'open', sessionId: 'sess', cols: 80, rows: 24 });
  d.handle({ type: 'task', taskId: 't1' });
  await tick();
  assert.equal(performed, 0);
  assert.deepEqual(sent, []);
});

test('a terminal daemon ignores every browser operation', async () => {
  const sent = [];
  const d = new AgentHostDaemon({ apiRoot: 'http://x', token: 't', root: '/r', ptyFactory: () => { throw new Error('no pty in this test'); } });
  d.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  d.handle({ type: 'browser-op', reqId: 'r'.repeat(22), executorId: 'ex_1', bindingId: 'b', kind: 'snapshot', op: { op: 'snapshot' } });
  await tick();
  assert.deepEqual(sent, []);
});

test('the executor refuses non-web schemes, credentialed URLs and private addresses on its own', () => {
  for (const u of ['file:///etc/passwd', 'chrome://settings', 'chrome-extension://abcdefghijklmnop/page.html', 'about:config', 'about:srcdoc', 'data:text/html,<p>x', 'javascript:alert(1)', 'view-source:https://a.example', 'blob:https://a.example/1']) {
    assert.match(String(navigationRefusal(u)), /^scheme:/, u);
  }
  assert.equal(navigationRefusal('https://user:pw@a.example/'), 'credentialed');
  for (const u of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[fd00::1]/', 'http://printer.local/', 'http://localhost:3000/', 'http://db.internal/']) {
    assert.equal(navigationRefusal(u), 'private_address', u);
  }
  assert.equal(navigationRefusal('https://shop.example.com/a'), null);
  assert.equal(navigationRefusal('about:blank'), null);
  assert.equal(navigationRefusal('http://127.0.0.1:4100/', { allowHosts: ['127.0.0.1'] }), null);
  assert.equal(requestRefusal('http://10.0.0.5/admin'), 'private_address');
  assert.equal(requestRefusal('data:image/png;base64,AAAA'), null);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('a browser pairing and a terminal pairing are stored apart', () => {
  const home = mkdtempSync(join(tmpdir(), 'owp-ah-'));
  saveCredential({ home, host: 'https://h.example', token: 'term-key', deviceId: 'd1', useKeychain: false });
  saveCredential({ home: browserHome(home), kind: 'browser', host: 'https://h.example', token: 'browser-key', deviceId: 'd2', useKeychain: false });
  assert.equal(loadCredential({ home }).token, 'term-key');
  const b = loadCredential({ home: browserHome(home) });
  assert.equal(b.token, 'browser-key');
  assert.equal(b.kind, 'browser');
});

test('without playwright-core, browser mode says it is unavailable and nothing throws', async () => {
  const missing = await loadPlaywright(async () => { throw Object.assign(new Error("Cannot find package 'playwright-core'"), { code: 'ERR_MODULE_NOT_FOUND' }); });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /browser mode is unavailable/);
  // Terminal mode never imports it: the daemon module loaded above with no browser.
  const d = new AgentHostDaemon({ apiRoot: 'http://x', token: 't', root: '/r', ptyFactory: () => ({}) });
  assert.equal(d.mode, 'terminal');
});

test('a browser pairing is refused unless the host says it granted one', async () => {
  const reply = (json, status = 201) => async () => ({ status, json: async () => json, text: async () => JSON.stringify(json), headers: new Headers({ 'content-type': 'application/json' }), ok: status < 400 });
  const base = { deviceCode: 'owdc_x', userCode: 'ABCD-EFGH', expiresIn: 600, interval: 5, verificationPath: '/claude-code/pair' };
  await assert.rejects(startPairing({ host: 'https://h.example', apiBase: '', label: 'l', platform: 'p', capability: 'browser', fetchFn: reply(base) }), /does not offer browser pairing/);
  const ok = await startPairing({ host: 'https://h.example', apiBase: '', label: 'l', platform: 'p', capability: 'browser', fetchFn: reply({ ...base, capability: 'browser' }) });
  assert.equal(ok.capability, 'browser');
  const sentBodies = [];
  await startPairing({ host: 'https://h.example', apiBase: '', label: 'l', platform: 'p', fetchFn: async (_u, init) => { sentBodies.push(JSON.parse(init.body)); return reply(base)(); } });
  assert.equal('capability' in sentBodies[0], false, 'a terminal pairing sends nothing new');
});

test('branding supplies a default host and name; a bad file changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owp-brand-'));
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify({ productName: 'MyndHyve', defaultHost: 'https://myndhyve.ai' }));
  assert.deepEqual(brandedDefaults(good), { productName: 'MyndHyve', defaultHost: 'https://myndhyve.ai' });
  const bad = join(dir, 'bad.json'); writeFileSync(bad, JSON.stringify({ defaultHost: 'http://insecure.example/path' }));
  assert.deepEqual(brandedDefaults(bad), {});
  assert.deepEqual(brandedDefaults(join(dir, 'missing.json')), {});
});

test('no module imports playwright-core statically, so terminal mode loads without it', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const src = new URL('../src/', import.meta.url);
  for (const f of readdirSync(src).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(new URL(f, src), 'utf8');
    assert.equal(/^\s*import\s[^;]*['"]playwright-core['"]/m.test(text), false, `${f} imports playwright-core statically`);
  }
  // The only route in is the guarded dynamic import.
  assert.match(readFileSync(new URL('browserExecutor.js', src), 'utf8'), /import\('playwright-core'\)/);
});
