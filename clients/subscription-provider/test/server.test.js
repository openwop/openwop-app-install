// ADR 0182 — server wire-mapping + security tests. CLI runners are MOCKED.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { CliError } from '../src/cliRunner.js';

let base;
let server;

before(async () => {
  const started = await startServer({
    port: 0,
    runCodexFn: async ({ messages }) => `codex:${messages[messages.length - 1].content}`,
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => new Promise((r) => server.close(r)));

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('binds loopback only (address is 127.0.0.1)', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('GET /healthz → 200', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('ADR 0756 — /v1/messages (the removed claude -p route) → 404', async () => {
  const res = await post('/v1/messages', { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 404);
});

test('/v1/chat/completions maps to an OpenAI Chat Completion response', async () => {
  const res = await post('/v1/chat/completions', { model: 'gpt-x', messages: [{ role: 'user', content: 'yo' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'codex:yo');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('missing/empty messages → 400', async () => {
  const res = await post('/v1/chat/completions', { messages: [] });
  assert.equal(res.status, 400);
});

test('unknown endpoint → 404', async () => {
  const res = await post('/v1/nope', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 404);
});

test('a CliError auth failure surfaces as 401 subscription_login_required', async () => {
  const authFailing = await startServer({
    port: 0,
    runCodexFn: async () => { throw new CliError('codex', 1, 'not logged in'); },
  });
  const res = await fetch(`http://127.0.0.1:${authFailing.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.type, 'subscription_login_required');
  await new Promise((r) => authFailing.server.close(r));
});

test('shared token gate: wrong token → 401, correct token → 200', async () => {
  const guarded = await startServer({
    port: 0, token: 'secret',
    runCodexFn: async () => 'ok',
  });
  const b = `http://127.0.0.1:${guarded.port}`;
  const bad = await fetch(`${b}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${b}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }) });
  assert.equal(good.status, 200);
  await new Promise((r) => guarded.server.close(r));
});
