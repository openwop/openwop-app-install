// ADR 0785 P1 — the companion's pairing protocol, against a scripted fake host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, startPairing, waitForApproval } from '../src/pairing.js';

/** A fetch that answers from a script of `[status, body]` per call, recording each request. */
function scripted(responses) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return { status, json: async () => body };
  };
  return { fetchFn, calls };
}
const noSleep = async () => {};

test('refuses a non-https host, but allows localhost for development', () => {
  assert.throws(() => normalizeHost('http://app.example.com'), /non-https/);
  assert.equal(normalizeHost('https://app.example.com/some/path'), 'https://app.example.com');
  assert.equal(normalizeHost('http://localhost:5173'), 'http://localhost:5173');
});

test('start posts label + platform to the device prefix (under --api-base) and builds the approval URL on the app origin', async () => {
  const { fetchFn, calls } = scripted([[201, { deviceCode: 'owdc_x', userCode: 'BCDF-GH23', expiresIn: 600, interval: 5, verificationPath: '/claude-code/pair' }]]);
  const s = await startPairing({ host: 'https://app.example.com', apiBase: '/api', label: 'mac', platform: 'darwin-arm64', fetchFn });
  // The canonical, version-agnostic root — not the /v1 twin that retires.
  assert.equal(calls[0].url, 'https://app.example.com/api/host/openwop-app/claude-code/pair/device/start');
  assert.deepEqual(calls[0].body, { label: 'mac', platform: 'darwin-arm64' });
  assert.equal(s.verificationUrl, 'https://app.example.com/claude-code/pair');
});

test('an absolute --api-base on another origin carries the API calls; the approval link stays on the app origin', async () => {
  const { fetchFn, calls } = scripted([[201, { deviceCode: 'owdc_x', userCode: 'BCDF-GH23', expiresIn: 600, interval: 5, verificationPath: '/claude-code/pair' }]]);
  const s = await startPairing({ host: 'https://app.example.com', apiBase: 'https://api.example.com/', label: 'm', platform: 'p', fetchFn });
  assert.equal(calls[0].url, 'https://api.example.com/host/openwop-app/claude-code/pair/device/start');
  assert.equal(s.verificationUrl, 'https://app.example.com/claude-code/pair');
  await assert.rejects(startPairing({ host: 'https://app.example.com', apiBase: 'http://api.example.com', label: 'm', platform: 'p', fetchFn }), /non-https/);
});

test('start explains a host that has not enabled pairing (404) instead of a bare status', async () => {
  const { fetchFn } = scripted([[404, { error: 'not_found' }]]);
  await assert.rejects(startPairing({ host: 'https://h', label: 'x', platform: 'p', fetchFn }), /not enabled/);
});

test('polls through pending (and a network blip) until approved, returning the key once', async () => {
  const { fetchFn, calls } = scripted([
    [200, { status: 'pending', interval: 5 }],
    new Error('ECONNRESET'),
    [200, { status: 'pending', interval: 5 }],
    [200, { status: 'approved', token: 'owk_abc', deviceId: 'ccd_1', tenantId: 'org:t', expiresAt: '2030-01-01' }],
  ]);
  const r = await waitForApproval({ host: 'https://h', deviceCode: 'owdc_x', interval: 5, expiresIn: 600, fetchFn, sleepFn: noSleep });
  assert.equal(r.status, 'approved');
  assert.equal(r.token, 'owk_abc');
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.body.deviceCode === 'owdc_x'));
});

test('an approved-but-failed mint is reported with the host message, not as an expiry', async () => {
  const { fetchFn } = scripted([[200, { status: 'failed', message: 'the workspace has 100 keys' }]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, sleepFn: noSleep }), { status: 'failed', message: 'the workspace has 100 keys' });
});

test('a denied pairing stops polling and says so', async () => {
  const { fetchFn } = scripted([[200, { status: 'denied' }]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, sleepFn: noSleep }), { status: 'denied' });
});

test('a 404 poll (expired / consumed) ends as expired', async () => {
  const { fetchFn } = scripted([[404, {}]]);
  assert.deepEqual(await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 1, expiresIn: 60, fetchFn, sleepFn: noSleep }), { status: 'expired' });
});

test('stops at the code expiry even if the host keeps saying pending', async () => {
  let t = 0;
  const { fetchFn } = scripted(Array.from({ length: 100 }, () => [200, { status: 'pending', interval: 5 }]));
  const r = await waitForApproval({ host: 'https://h', deviceCode: 'd', interval: 5, expiresIn: 20, fetchFn, sleepFn: async (ms) => { t += ms; }, now: () => t });
  assert.equal(r.status, 'expired');
});

// ── ADR 0785 2026-10-04: the device socket must bypass a front door that drops
// the WebSocket Upgrade. The host advertises its direct origin in discovery.
import { discoverStreamBase, serviceRootFor, validStreamBase } from '../src/pairing.js';

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
  assert.equal(validStreamBase('https://backend.example.com/?x=1'), null);
  assert.equal(validStreamBase('not a url'), null);
  assert.equal(validStreamBase('http://localhost:8080'), 'http://localhost:8080');
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
