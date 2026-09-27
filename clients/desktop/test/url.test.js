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
