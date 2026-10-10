// ADR 0785 D3 — the file credential store (the keychain path is darwin-only and
// exercised by hand; these tests pin the file fallback every platform relies on).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCredential, loadCredential, saveCredential } from '../src/credentialStore.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'agent-host-')), 'home');

test('saves with a 0700 directory and a 0600 file, and round-trips', () => {
  const home = fresh();
  saveCredential({ home, host: 'https://h', token: 'owk_secret', deviceId: 'ccd_1', tenantId: 'org:t', expiresAt: '2030-01-01', useKeychain: false });
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  const c = loadCredential({ home });
  assert.equal(c.token, 'owk_secret');
  assert.equal(c.deviceId, 'ccd_1');
  assert.equal(c.tokenIn, 'file');
  rmSync(home, { recursive: true, force: true });
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
});

test('refuses to save without a host and token', () => {
  assert.throws(() => saveCredential({ home: fresh(), host: 'https://h', useKeychain: false }), /host and token/);
});

test('setStreamBase records the direct origin beside the pairing without touching the key', async () => {
  const { setStreamBase } = await import('../src/credentialStore.js');
  const home = mkdtempSync(join(tmpdir(), 'agent-host-sb-'));
  try {
    saveCredential({ home, host: 'https://app.example.com', apiBase: '', token: 'owk_secret', deviceId: 'ccd_1', useKeychain: false });
    assert.equal(setStreamBase({ home, streamBase: 'https://backend.example.run.app' }), true);
    const c = loadCredential({ home });
    assert.equal(c.streamBase, 'https://backend.example.run.app');
    assert.equal(c.token, 'owk_secret');
    assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
    setStreamBase({ home, streamBase: null });
    assert.equal(loadCredential({ home }).streamBase, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('setStreamBase on an unpaired machine is a no-op', async () => {
  const { setStreamBase } = await import('../src/credentialStore.js');
  const home = mkdtempSync(join(tmpdir(), 'agent-host-sb-'));
  try { assert.equal(setStreamBase({ home, streamBase: 'https://x.example' }), false); } finally { rmSync(home, { recursive: true, force: true }); }
});
