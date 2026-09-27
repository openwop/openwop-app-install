// ADR 0757 — the sidecar's wire + security with an injected fake runTurn.

import { test, before, after } from 'node:test';
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

const post = (body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

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
  // The token reached runTurn and is echoed nowhere in the response.
  assert.equal(calls.at(-1).token, 'gho_abc123');
  assert.equal(text.includes('gho_abc123'), false);
});

test('refuses a missing token, and a classic ghp_ PAT the SDK does not support', async () => {
  for (const headers of [{}, { authorization: 'Bearer ghp_classic' }, { authorization: 'Bearer ' }]) {
    const res = await post({ messages: [{ role: 'user', content: 'q' }] }, headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, 'copilot_login_required');
  }
});

test('an `unknown` model is dropped so Copilot picks its default', async () => {
  await (await post({ model: 'unknown', messages: [{ role: 'user', content: 'q' }] }, { authorization: 'Bearer gho_x' })).text();
  assert.equal(calls.at(-1).model, undefined);
});

test('missing messages → 400; unknown path → 404; GET healthz → 200', async () => {
  assert.equal((await post({ messages: [] }, { authorization: 'Bearer gho_x' })).status, 400);
  assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('an auth failure before streaming → 401 copilot_login_required; other failures → 502', async () => {
  for (const [err, status, type] of [
    [new CopilotTurnError('not entitled', { isAuth: true }), 401, 'copilot_login_required'],
    [new Error('boom'), 502, 'copilot_error'],
  ]) {
    const s = await startServer({ port: 0, runTurn: async () => { throw err; } });
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer gho_x' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
    });
    assert.equal(res.status, status);
    assert.equal((await res.json()).error.type, type);
    await new Promise((r) => s.server.close(r));
  }
});
