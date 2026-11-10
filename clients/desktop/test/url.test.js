// ADR 0181 — host-origin helpers. `parseHostOrigin` is the gate in front of
// `win.loadURL` (selectHost, cleanOrigin): only http(s), never rewritten, and only
// the origin survives. Not in `npm run ci`: run `npm test` in clients/desktop.
//
// Sabotage that turns it red (each probed): the coercion, re-schemeing a scheme,
// the http(s) allowlist, returning the input instead of the origin.
// `isLoopbackOrigin` and `sameOrigin` have no product caller (DESK-URL-DEAD-1):
// those two cases stay until the helpers go, by decision of wave 77.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigin, parseHostOrigin, isLoopbackOrigin, sameOrigin } = require('../src/url.js');

test('normalizeOrigin strips trailing slashes', () => {
  assert.equal(normalizeOrigin('http://localhost:8000/'), 'http://localhost:8000');
  assert.equal(normalizeOrigin('  http://x//  '), 'http://x');
  assert.equal(normalizeOrigin(42), '');
});

test('parseHostOrigin accepts full URLs and coerces bare host:port to http', () => {
  assert.equal(parseHostOrigin('https://app.openwop.dev'), 'https://app.openwop.dev');
  assert.equal(parseHostOrigin('localhost:8000'), 'http://localhost:8000');
  assert.equal(parseHostOrigin('127.0.0.1:6767/'), 'http://127.0.0.1:6767');
  assert.equal(parseHostOrigin('https://app.openwop.dev/some/path?q=1'), 'https://app.openwop.dev');
});

test('parseHostOrigin rejects junk and non-http schemes', () => {
  assert.equal(parseHostOrigin(''), null);
  assert.equal(parseHostOrigin('   '), null);
  assert.equal(parseHostOrigin('file:///etc/passwd'), null);
  assert.equal(parseHostOrigin('ftp://x'), null);
  assert.equal(parseHostOrigin(null), null);
});

test('isLoopbackOrigin', () => {
  assert.equal(isLoopbackOrigin('http://localhost:8000'), true);
  assert.equal(isLoopbackOrigin('http://127.0.0.1'), true);
  assert.equal(isLoopbackOrigin('https://app.openwop.dev'), false);
  assert.equal(isLoopbackOrigin('garbage'), false);
});

test('sameOrigin compares normalized forms', () => {
  assert.equal(sameOrigin('http://x:8000', 'http://x:8000/'), true);
  assert.equal(sameOrigin('http://x:8000', 'http://x:9000'), false);
  assert.equal(sameOrigin('', ''), false);
});
