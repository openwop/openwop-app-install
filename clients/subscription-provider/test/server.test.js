// ADR 0182 — server wire-mapping + security tests. CLI runners are MOCKED.
// The shim drives a subscription CLI, so it binds loopback only and an optional
// shared token gates it. ADR 0756 removed the claude -p route. Not in `npm run ci`:
// run `npm test` in clients/subscription-provider.
//
// Sabotage that turns it red (each probed): binding 0.0.0.0, restoring /v1/messages,
// accepting any Authorization (or none), each refusal's status and error type,
// dropping the model, 401 for a non-auth failure. Extra servers close in `finally`,
// so a failed assertion reports instead of holding the process open.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { CliError } from '../src/cliRunner.js';

let base;
let server;
let codexCalls = [];

before(async () => {
  const started = await startServer({
    port: 0,
    runCodexFn: async ({ messages, model }) => { codexCalls.push({ model }); return `codex:${messages[messages.length - 1].content}`; },
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
  codexCalls = [];
  const res = await post('/v1/messages', { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'not_found');
  assert.deepEqual(codexCalls, []); // no CLI ran
});

test('/v1/chat/completions maps to an OpenAI Chat Completion response', async () => {
  codexCalls = [];
  const res = await post('/v1/chat/completions', { model: 'gpt-x', messages: [{ role: 'user', content: 'yo' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(codexCalls, [{ model: 'gpt-x' }]);
  assert.equal(body.model, 'gpt-x');
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'codex:yo');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('missing/empty messages → 400', async () => {
  for (const body of [{ messages: [] }, {}]) {
    const res = await post('/v1/chat/completions', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.type, 'invalid_request');
  }
});

test('unknown endpoint → 404', async () => {
  const res = await post('/v1/nope', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'not_found');
});

test('a CliError auth failure surfaces as 401 subscription_login_required', async () => {
  const authFailing = await startServer({
    port: 0,
    runCodexFn: async () => { throw new CliError('codex', 1, 'not logged in'); },
  });
  const nonAuth = await startServer({
    port: 0,
    runCodexFn: async () => { throw new CliError('codex', 2, 'boom'); },
  });
  const call = (port) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
  });
  try {
    const res = await call(authFailing.port);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, 'subscription_login_required');
    // The distinction is the point: a failure that is not a login is not "re-login".
    const other = await call(nonAuth.port);
    assert.equal(other.status, 502);
    const { error } = await other.json();
    assert.equal(error.type, 'harness_error');
    assert.equal(error.harness, 'codex');
  } finally {
    await new Promise((r) => authFailing.server.close(r));
    await new Promise((r) => nonAuth.server.close(r));
  }
});

test('shared token gate: wrong token → 401, correct token → 200', async () => {
  let calls = 0;
  const guarded = await startServer({
    port: 0, token: 'secret',
    runCodexFn: async () => { calls++; return 'ok'; },
  });
  const b = `http://127.0.0.1:${guarded.port}`;
  const call = (auth) => fetch(`${b}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }) });
  try {
    for (const auth of [{}, { authorization: 'Bearer wrong' }]) {
      const bad = await call(auth);
      assert.equal(bad.status, 401, JSON.stringify(auth));
      assert.equal((await bad.json()).error.type, 'unauthorized');
    }
    assert.equal(calls, 0); // refused before the CLI
    const good = await call({ authorization: 'Bearer secret' });
    assert.equal(good.status, 200);
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => guarded.server.close(r));
  }
});
