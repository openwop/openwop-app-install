'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readSettings, writeSettings, selectHost } = require('../src/settings.js');

let dir, path;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owp-desk-')); path = join(dir, 'settings.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('readSettings on a missing file → empty', () => {
  assert.deepEqual(readSettings(path), { host: null, recent: [] });
});

test('readSettings tolerates corrupt JSON', () => {
  writeFileSync(path, '{ not json');
  assert.deepEqual(readSettings(path), { host: null, recent: [] });
});

test('write then read round-trips + normalizes', () => {
  writeSettings(path, { host: 'http://localhost:8000/', recent: ['http://localhost:8000/'] });
  assert.deepEqual(readSettings(path), { host: 'http://localhost:8000', recent: ['http://localhost:8000'] });
});

test('selectHost validates, dedupes, and fronts the recent list', () => {
  let s = { host: null, recent: [] };
  s = selectHost(s, 'localhost:8000');
  assert.equal(s.host, 'http://localhost:8000');
  s = selectHost(s, 'https://app.openwop.dev');
  assert.deepEqual(s.recent, ['https://app.openwop.dev', 'http://localhost:8000']);
  s = selectHost(s, 'localhost:8000'); // re-select existing → moves to front, no dup
  assert.deepEqual(s.recent, ['http://localhost:8000', 'https://app.openwop.dev']);
});

test('selectHost rejects invalid input (returns null)', () => {
  assert.equal(selectHost({ host: null, recent: [] }, 'file:///x'), null);
  assert.equal(selectHost({ host: null, recent: [] }, ''), null);
});

test('recent list is capped at 8', () => {
  let s = { host: null, recent: [] };
  for (let i = 0; i < 12; i++) s = selectHost(s, `http://h${i}.local:8000`);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent[0], 'http://h11.local:8000');
});

// ADR 0181 Phase E — the optional localServer config round-trips validated and
// survives host switches; malformed blocks read as "not configured".
test('localServer config: validated passthrough + preserved by selectHost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owp-desk-'));
  const p = join(dir, 'settings.json');
  writeFileSync(p, JSON.stringify({
    host: 'http://localhost:8000',
    localServer: { command: ['node', 'lib/index.js'], probeUrl: 'http://localhost:8000/api/readiness', origin: 'http://localhost:8000' },
  }));
  const s = readSettings(p);
  assert.deepEqual(s.localServer?.command, ['node', 'lib/index.js']);
  assert.equal(s.localServer?.probeUrl, 'http://localhost:8000/api/readiness');
  assert.equal(s.localServer?.origin, 'http://localhost:8000');

  const next = selectHost(s, 'https://app.openwop.dev');
  assert.equal(next.host, 'https://app.openwop.dev');
  assert.deepEqual(next.localServer?.command, ['node', 'lib/index.js']); // preserved

  writeFileSync(p, JSON.stringify({ localServer: { command: [] } }));
  assert.equal(readSettings(p).localServer, undefined); // malformed ⇒ not configured

  writeFileSync(p, JSON.stringify({ localServer: { command: ['node'], probeUrl: 'ftp://nope' } }));
  assert.equal(readSettings(p).localServer?.probeUrl, undefined); // non-http probe dropped
});
