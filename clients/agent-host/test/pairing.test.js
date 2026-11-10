// ADR 0785 P1 (D3) — the companion's pairing protocol, against a scripted fake host. The
// developer key goes to an https host only, and it follows a discovered origin only when that
// origin passes validation.
//
// Sabotage that reds it: http accepted for the host or the API base; a `localhost…` lookalike
// accepted; a path kept on the host; a wrong device prefix; the approval link off the app
// origin; a blip that ends polling; the host's interval ignored; failed or denied masked as
// expired; a 404 poll that keeps polling; a late or removed deadline; discovery unvalidated or
// off its well-known path; any of https, username, password, query, fragment or scheme dropped
// from `validStreamBase`; a failed discovery yielding a value; the service root unvalidated.
//
// The fake clock's sleep throws an hour in, so a sabotage that never stops polling fails a
// named case instead of spinning.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverStreamBase, normalizeHost, serviceRootFor, startPairing, validStreamBase, waitForApproval } from '../src/pairing.js';

/** A fetch that answers from a script of `[status, body]` per call, recording each request. */
function scripted(responses) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return { status, json: async () => body };
  };
  return { fetchFn, calls };
}
const HOUR_MS = 3_600_000;
/** A fake clock for `waitForApproval`: sleeping advances it and records the wait. */
function clock() {
  let t = 0;
  const slept = [];
  return {
    now: () => t,
    slept,
    sleepFn: async (ms) => {
      slept.push(ms);
      t += ms;
      if (t > HOUR_MS) throw new Error('still polling an hour in: the deadline did not hold');
    },
  };
}

test('refuses a non-https host, but allows localhost for development', () => {
  assert.throws(() => normalizeHost('http://app.example.com'), /non-https/);
  assert.throws(() => normalizeHost('http://localhost.evil.example'), /non-https/);
  assert.equal(normalizeHost('https://app.example.com/some/path'), 'https://app.example.com');
  assert.equal(normalizeHost('http://localhost:5173'), 'http://localhost:5173');
});

test('start posts label + platform to the device prefix (under --api-base) and builds the approval URL on the app origin', async () => {
  const { fetchFn, calls } = scripted([[201, { deviceCode: 'owdc_x', userCode: 'BCDF-GH23', expiresIn: 600, interval: 5, verificationPath: '/claude-code/pair' }]]);
  const s = await startPairing({ host: 'https://app.example.com', apiBase: '/api', label: 'mac', platform: 'darwin-arm64', fetchFn });
  // The canonical, version-agnostic root — not the /v1 twin that retires.
  assert.equal(calls[0].url, 'https://app.example.com/api/host/openwop-app/claude-code/pair/device/start');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { label: 'mac', platform: 'darwin-arm64' });
  assert.equal(s.verificationUrl, 'https://app.example.com/claude-code/pair');
});

test('an absolute --api-base on another origin carries the API calls; the approval link stays on the app origin', async () => {
  const { fetchFn, calls } = scripted([[201, { deviceCode: 'owdc_x', userCode: 'BCDF-GH23', expiresIn: 600, interval: 5, verificationPath: '/claude-code/pair' }]]);
  const s = await startPairing({ host: 'https://app.example.com', apiBase: 'https://api.example.com/', label: 'm', platform: 'p', fetchFn });
  assert.equal(calls[0].url, 'https://api.example.com/host/openwop-app/claude-code/pair/device/start');
  assert.equal(s.verificationUrl, 'https://app.example.com/claude-code/pair');
  await assert.rejects(startPairing({ host: 'https://app.example.com', apiBase: 'http://api.example.com', label: 'm', platform: 'p', fetchFn }), /non-https/);
  await assert.rejects(startPairing({ host: 'https://app.example.com', apiBase: 'http://localhost.evil.example', label: 'm', platform: 'p', fetchFn }), /non-https/);
});

test('start explains a host that has not enabled pairing (404) instead of a bare status', async () => {
  const { fetchFn } = scripted([[404, { error: 'not_found' }]]);
  await assert.rejects(startPairing({ host: 'https://h', label: 'x', platform: 'p', fetchFn }), /not enabled/);
});

test('polls through pending (and a network blip) until approved, returning the key once', async () => {
  const { fetchFn, calls } = scripted([
    [200, { status: 'pending', interval: 7 }],
    new Error('ECONNRESET'),
    [200, { status: 'pending', interval: 9 }],
    [200, { status: 'approved', token: 'owk_abc', deviceId: 'ccd_1', tenantId: 'org:t', expiresAt: '2030-01-01' }],
  ]);
  const c = clock();
  const r = await waitForApproval({ host: 'https://h', deviceCode: 'owdc_x', interval: 5, expiresIn: 600, fetchFn, ...c });
  assert.equal(r.status, 'approved');
  assert.equal(r.token, 'owk_abc');
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.body.deviceCode === 'owdc_x'));
  assert.deepEqual(c.slept, [5000, 7000, 7000, 9000], 'each wait is the interval the host last asked for; a blip keeps it');
});

test('an approved-but-failed mint is reported with the host message, not as an expiry', async () => {
  const { fetchFn } = scripted([[200, { status: 'failed', message: 'the workspace has 100 keys' }]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, ...clock() }), { status: 'failed', message: 'the workspace has 100 keys' });
});

test('a denied pairing stops polling and says so', async () => {
  const { fetchFn, calls } = scripted([[200, { status: 'denied' }]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, ...clock() }), { status: 'denied' });
  assert.equal(calls.length, 1);
});

test('a 404 poll (expired / consumed) ends as expired', async () => {
  const { fetchFn, calls } = scripted([[404, {}]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, ...clock() }), { status: 'expired' });
  assert.equal(calls.length, 1, 'the 404 ends it; the deadline did not');
});

test('stops at the code expiry even if the host keeps saying pending', async () => {
  const { fetchFn, calls } = scripted(Array.from({ length: 100 }, () => [200, { status: 'pending', interval: 5 }]));
  const r = await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 5, expiresIn: 20, fetchFn, ...clock() });
  assert.equal(r.status, 'expired');
  assert.equal(calls.length, 4, 'polls at 5, 10, 15 and 20 s of a 20 s code, then stops');
});

// ── ADR 0785 2026-10-04: the device socket must bypass a front door that drops
// the WebSocket Upgrade. The host advertises its direct origin in discovery.
const discovery = (streamBase, ok = true) => async (url) => ({ ok, url, json: async () => ({ extensions: { 'openwop-app.host': { streamBase } } }) });

test('discovery: reads the advertised direct origin from the paired root', async () => {
  let asked = '';
  const fetchFn = async (url) => { asked = url; return discovery('https://backend.example.run.app/')(url); };
  assert.equal(await discoverStreamBase('https://app.example.com/api', { fetchFn }), 'https://backend.example.run.app');
  assert.equal(asked, 'https://app.example.com/api/.well-known/openwop');
});

test('discovery: a non-https, credentialed, or query-bearing origin is refused (the key would follow it)', async () => {
  assert.equal(validStreamBase('http://backend.example.com'), null);
  assert.equal(validStreamBase('https://u:p@backend.example.com'), null);
  assert.equal(validStreamBase('https://u@backend.example.com'), null);
  assert.equal(validStreamBase('https://:p@backend.example.com'), null);
  assert.equal(validStreamBase('https://backend.example.com/?x=1'), null);
  assert.equal(validStreamBase('https://backend.example.com/#f'), null);
  assert.equal(validStreamBase('ftp://localhost:21'), null);
  assert.equal(validStreamBase('not a url'), null);
  assert.equal(validStreamBase('http://localhost:8080'), 'http://localhost:8080');
  // The path the key would really follow: what discovery read, not only the helper.
  assert.equal(await discoverStreamBase('https://app.example.com', { fetchFn: discovery('http://evil.example') }), null);
});

test('discovery: an unreachable or silent host yields null, so the paired root is kept', async () => {
  assert.equal(await discoverStreamBase('https://app.example.com', { fetchFn: async () => { throw new Error('offline'); } }), null);
  assert.equal(await discoverStreamBase('https://app.example.com', { fetchFn: discovery(undefined) }), null);
  assert.equal(await discoverStreamBase('https://app.example.com', { fetchFn: discovery('https://x.example', false) }), null);
});

test('service root: the direct origin wins; without one, the paired root (the 2026-10-04 pairing had apiBase "")', () => {
  assert.equal(serviceRootFor({ host: 'https://app.example.com', apiBase: '', streamBase: 'https://backend.example.run.app' }), 'https://backend.example.run.app');
  assert.equal(serviceRootFor({ host: 'https://app.example.com', apiBase: '' }), 'https://app.example.com');
  assert.equal(serviceRootFor({ host: 'https://app.example.com', apiBase: '/api', streamBase: 'http://evil.example' }), 'https://app.example.com/api');
});
