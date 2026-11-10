// ADR 0757 — the sidecar's wire + security with an injected fake runTurn. It binds loopback
// only, takes a user's GitHub token on every request and echoes it nowhere, speaks OpenAI SSE,
// and never presents a failed turn as a clean stop.
//
// Sabotage that reds it: a non-loopback bind; no [DONE], role chunk or `stop`; a wrong object
// type; the token or model not reaching runTurn; a missing, `ghp_` or non-Bearer credential
// accepted; `ghu_` or `github_pat_` refused; `unknown` passed as a model; missing or empty
// messages accepted; the 404 route or healthz body changed; auth failures as 502 or others as
// 401; a mid-stream failure finishing `stop`.
//
// Every extra server closes in a `finally`: an assertion that threw past `server.close` used to
// leave the listener open, so a real failure read as a 300 s hang of the whole file.
//
// `npm run ci` does not run this file: run `node --test` in clients/copilot-provider.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { CopilotTurnError } from '../src/copilot.js';

let base;
let server;
const calls = [];

before(async () => {
  const started = await startServer({
    port: 0,
    runTurn: async ({ token, model, messages, onDelta }) => {
      calls.push({ token, model });
      onDelta('Hel');
      onDelta('lo');
      return `Hello:${messages.length}`;
    },
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => new Promise((r) => server.close(r)));

beforeEach(() => { calls.length = 0; });

const post = (body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const closeNow = (s) => new Promise((r) => { s.server.close(r); s.server.closeAllConnections(); });

test('binds loopback only (address is 127.0.0.1)', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('streams OpenAI chat.completion.chunk SSE terminated by [DONE]', async () => {
  const res = await post({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer gho_abc123' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((l) => l.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), 'Hello');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(chunks[0].object, 'chat.completion.chunk');
  assert.equal(chunks[0].model, 'gpt-5');
  // The token reached runTurn and is echoed nowhere in the response.
  assert.deepEqual(calls, [{ token: 'gho_abc123', model: 'gpt-5' }]);
  assert.equal(text.includes('gho_abc123'), false);
});

test('refuses a missing token, and a classic ghp_ PAT the SDK does not support', async () => {
  for (const headers of [{}, { authorization: 'Bearer ghp_classic' }, { authorization: 'Bearer ' }, { authorization: 'Basic gho_abc123' }]) {
    const res = await post({ messages: [{ role: 'user', content: 'q' }] }, headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, 'copilot_login_required');
  }
  assert.equal(calls.length, 0, 'no refused request reaches runTurn');
  // The other side of the same allowlist: the prefixes the SDK does take.
  for (const token of ['ghu_abc', 'github_pat_abc']) {
    const res = await post({ messages: [{ role: 'user', content: 'q' }] }, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(calls.at(-1).token, token);
  }
});

test('an `unknown` model is dropped so Copilot picks its default', async () => {
  await (await post({ model: 'unknown', messages: [{ role: 'user', content: 'q' }] }, { authorization: 'Bearer gho_x' })).text();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, undefined);
});

test('missing messages → 400; unknown path → 404; GET healthz → 200', async () => {
  for (const body of [{ messages: [] }, {}]) {
    const res = await post(body, { authorization: 'Bearer gho_x' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.type, 'invalid_request');
  }
  assert.equal(calls.length, 0);
  const notFound = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).error.type, 'not_found');
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});

test('an auth failure before streaming → 401 copilot_login_required; other failures → 502', async () => {
  for (const [err, status, type] of [
    [new CopilotTurnError('not entitled', { isAuth: true }), 401, 'copilot_login_required'],
    [new Error('boom'), 502, 'copilot_error'],
  ]) {
    const s = await startServer({ port: 0, runTurn: async () => { throw err; } });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer gho_x' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
      });
      assert.equal(res.status, status);
      const { error } = await res.json();
      assert.equal(error.type, type);
      assert.equal(error.message, err.message);
    } finally { await closeNow(s); }
  }
});

test('a failure after streaming began ends the stream with finish_reason error, never stop', async () => {
  const s = await startServer({ port: 0, runTurn: async ({ onDelta }) => { onDelta('par'); throw new Error('boom'); } });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer gho_x' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => l.replace(/^data: /, ''));
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), 'par');
    assert.deepEqual(chunks.map((c) => c.choices[0].finish_reason).filter(Boolean), ['error']);
  } finally { await closeNow(s); }
});
