// ADR 0785 D3 — the file credential store every platform relies on: the developer key is
// owner-only on disk, a save leaves no second copy, and the stream base is recorded without
// disturbing the key.
//
// Sabotage that reds it: a 0755 directory or 0644 file (one-edit breaks of BOTH halves of each
// double guard: create mode + chmod), no chmod over a pre-existing wider home, a dropped token,
// `clearCredential` leaving the file, a temp copy left behind, a save without host or token,
// and in `setStreamBase`: no delete on null, a blanked token, 0644, a true on an unpaired home.
//
// Ceilings: "atomically" (temp + rename) cannot be told from a direct overwrite from outside
// without a crash seam, so the observable half is asserted: no temp file remains. The darwin
// keychain path is exercised by hand; every save here passes `useKeychain: false`. Never probe
// `keychainAvailable`: the sabotage writes to this machine's real login keychain.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCredential, loadCredential, saveCredential, setStreamBase } from '../src/credentialStore.js';

const scratch = [];
const fresh = () => { const base = mkdtempSync(join(tmpdir(), 'agent-host-')); scratch.push(base); return join(base, 'home'); };
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('saves with a 0700 directory and a 0600 file, and round-trips', () => {
  const home = fresh();
  saveCredential({ home, host: 'https://h', token: 'owk_secret', deviceId: 'ccd_1', tenantId: 'org:t', expiresAt: '2030-01-01', useKeychain: false });
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  const c = loadCredential({ home });
  assert.equal(c.token, 'owk_secret');
  assert.equal(c.deviceId, 'ccd_1');
  assert.equal(c.tokenIn, 'file');
});

test('a pre-existing wider home is tightened to 0700', () => {
  const home = fresh();
  mkdirSync(home);
  chmodSync(home, 0o755);
  saveCredential({ home, host: 'https://h', token: 'owk_x', useKeychain: false });
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('unpaired ⇒ null; clear forgets it', () => {
  const home = fresh();
  assert.equal(loadCredential({ home }), null);
  saveCredential({ home, host: 'https://h', token: 'owk_x', useKeychain: false });
  const cleared = clearCredential({ home });
  assert.equal(cleared.host, 'https://h');
  assert.equal(loadCredential({ home }), null);
});

test('re-pairing overwrites atomically (no temp file left behind)', () => {
  const home = fresh();
  saveCredential({ home, host: 'https://h', token: 'owk_1', useKeychain: false });
  saveCredential({ home, host: 'https://h', token: 'owk_2', useKeychain: false });
  assert.equal(loadCredential({ home }).token, 'owk_2');
  assert.ok(!readFileSync(join(home, 'credentials.json'), 'utf8').includes('owk_1'));
  assert.deepEqual(readdirSync(home), ['credentials.json']);
});

test('refuses to save without a host and token', () => {
  const home = fresh();
  assert.throws(() => saveCredential({ home, host: 'https://h', useKeychain: false }), /host and token/);
  assert.throws(() => saveCredential({ home, token: 'owk_x', useKeychain: false }), /host and token/);
  assert.equal(existsSync(home), false, 'a refused save writes nothing');
});

test('setStreamBase records the direct origin beside the pairing without touching the key', () => {
  const home = fresh();
  saveCredential({ home, host: 'https://app.example.com', apiBase: '', token: 'owk_secret', deviceId: 'ccd_1', useKeychain: false });
  assert.equal(setStreamBase({ home, streamBase: 'https://backend.example.run.app' }), true);
  const c = loadCredential({ home });
  assert.equal(c.streamBase, 'https://backend.example.run.app');
  assert.equal(c.token, 'owk_secret');
  assert.equal(c.host, 'https://app.example.com');
  assert.equal(c.deviceId, 'ccd_1');
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  setStreamBase({ home, streamBase: null });
  assert.equal(loadCredential({ home }).streamBase, undefined);
});

test('setStreamBase on an unpaired machine is a no-op', () => {
  const home = fresh();
  assert.equal(setStreamBase({ home, streamBase: 'https://x.example' }), false);
  assert.equal(existsSync(home), false);
});
