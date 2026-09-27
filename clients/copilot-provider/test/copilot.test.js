// ADR 0757 — the Copilot runner with a FAKE SDK client: no runtime, no network,
// no real token. Pins the multi-user lock-down config and token handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCopilotRunner, sessionConfig, flattenMessages, rejectAll, CopilotTurnError } from '../src/copilot.js';

function fakeClientCtor({ reply = 'hello', deltas = ['hel', 'lo'], failWith = null } = {}) {
  const seen = { clientOpts: null, sessionConfigs: [], prompts: [], disconnects: 0, starts: 0 };
  class FakeClient {
    constructor(opts) { seen.clientOpts = opts; }
    async start() { seen.starts++; }
    async createSession(config) {
      seen.sessionConfigs.push(config);
      const handlers = {};
      return {
        on(type, fn) { handlers[type] = fn; return () => { delete handlers[type]; }; },
        async sendAndWait({ prompt }) {
          seen.prompts.push(prompt);
          if (failWith) throw new Error(failWith);
          for (const d of deltas) handlers['assistant.message_delta']?.({ data: { deltaContent: d } });
          return { data: { content: reply } };
        },
        async disconnect() { seen.disconnects++; },
      };
    }
  }
  return { FakeClient, seen };
}

test('the client runs in multi-user empty mode and never uses an ambient login', async () => {
  const { FakeClient, seen } = fakeClientCtor();
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  await run({ token: 'gho_abc', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.clientOpts.mode, 'empty');
  assert.equal(seen.clientOpts.useLoggedInUser, false);
  assert.equal(seen.clientOpts.baseDirectory, '/tmp/x');
  assert.equal('gitHubToken' in seen.clientOpts, false, 'the token must never be client-wide');
});

test('every session is locked to plain chat: no tools, all permissions rejected, no discovery', async () => {
  const cfg = sessionConfig({ token: 'gho_abc', model: 'gpt-5', system: 'be brief', workingDirectory: '/tmp/w' });
  assert.deepEqual(cfg.availableTools, []);
  assert.equal(cfg.onPermissionRequest, rejectAll);
  assert.equal(rejectAll().kind, 'reject');
  assert.equal(cfg.enableConfigDiscovery, false);
  assert.equal(cfg.skipCustomInstructions, true);
  assert.equal('mcpServers' in cfg, false);
  assert.equal('tools' in cfg, false);
  // APPEND keeps the SDK guardrails; `replace` would strip them.
  assert.deepEqual(cfg.systemMessage, { mode: 'append', content: 'be brief' });
  assert.equal(cfg.workingDirectory, '/tmp/w');
});

test('the caller token is the SESSION-level gitHubToken (never client-wide)', () => {
  const cfg = sessionConfig({ token: 'gho_abc', workingDirectory: '/tmp/w' });
  assert.equal(cfg.gitHubToken, 'gho_abc');
  assert.equal('gitHubTokenProvider' in cfg, false);
});

test('the chat tile\'s `default` model leaves the model to Copilot; a real id is passed through', () => {
  assert.equal('model' in sessionConfig({ token: 'gho_abc', model: 'default', workingDirectory: '/tmp/w' }), false);
  assert.equal(sessionConfig({ token: 'gho_abc', model: 'gpt-5', workingDirectory: '/tmp/w' }).model, 'gpt-5');
});

test('streams deltas, returns the text, and disconnects the session', async () => {
  const { FakeClient, seen } = fakeClientCtor();
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  const got = [];
  const text = await run({ token: 'gho_abc', model: 'gpt-5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], onDelta: (d) => got.push(d) });
  assert.equal(text, 'hello');
  assert.deepEqual(got, ['hel', 'lo']);
  assert.equal(seen.disconnects, 1);
  assert.equal(seen.sessionConfigs[0].model, 'gpt-5');
  assert.match(seen.prompts[0], /User: q/);
});

test('one shared client across turns (one runtime), one session per turn', async () => {
  const { FakeClient, seen } = fakeClientCtor();
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  await run({ token: 'gho_a', messages: [{ role: 'user', content: '1' }] });
  await run({ token: 'gho_b', messages: [{ role: 'user', content: '2' }] });
  assert.equal(seen.starts, 1);
  assert.equal(seen.sessionConfigs.length, 2);
  // Each session carries ITS caller's token — never another user's.
  assert.equal(seen.sessionConfigs[0].gitHubToken, 'gho_a');
  assert.equal(seen.sessionConfigs[1].gitHubToken, 'gho_b');
});

test('a runtime error is scrubbed of any GitHub credential and classified', async () => {
  const { FakeClient, seen } = fakeClientCtor({ failWith: 'Unauthorized for token gho_SECRET123' });
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  await assert.rejects(
    () => run({ token: 'gho_SECRET123', messages: [{ role: 'user', content: 'q' }] }),
    (err) => err instanceof CopilotTurnError && err.isAuth === true && !err.message.includes('gho_SECRET123'),
  );
  assert.equal(seen.disconnects, 1, 'the session is disconnected on failure too');
});

test('flattenMessages separates system text from the transcript', () => {
  const { system, prompt } = flattenMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  assert.equal(system, 'sys');
  assert.equal(prompt, 'User: a\n\nAssistant: b');
});
