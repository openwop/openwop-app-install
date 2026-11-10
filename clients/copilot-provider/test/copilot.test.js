// ADR 0757 — the Copilot runner with a FAKE SDK client: no runtime, no network, no real token.
// Pins the multi-user lock-down config and token handling, on the helper AND on what a real
// turn hands `createSession`.
//
// Sabotage that reds it: any lock-down field changed (mode, ambient login, a client-wide token,
// tools, permissions, discovery, instructions, `replace`) in `sessionConfig` or overridden at
// `createSession`; a working directory left behind; `default` passed as a model; content
// returned over the stream, or no delta when the runtime did not stream; no disconnect; a
// client per turn; a shared token; any GitHub token prefix left unscrubbed; every or no error
// classed as auth; system text in the transcript; a wrong role label.
//
// `npm run ci` does not run this file: run `node --test` in clients/copilot-provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createCopilotRunner, sessionConfig, flattenMessages, rejectAll, CopilotTurnError } from '../src/copilot.js';

function fakeClientCtor({ reply = 'hello', deltas = ['hel', 'lo'], failWith = null } = {}) {
  const seen = { clientOpts: null, sessionConfigs: [], workdirListings: [], prompts: [], disconnects: 0, starts: 0 };
  class FakeClient {
    constructor(opts) { seen.clientOpts = opts; }
    async start() { seen.starts++; }
    async createSession(config) {
      seen.sessionConfigs.push(config);
      seen.workdirListings.push(readdirSync(config.workingDirectory));
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

  // The same lock-down on what a real turn hands the SDK, not only on the helper.
  const { FakeClient, seen } = fakeClientCtor();
  await createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' })({ token: 'gho_abc', messages: [{ role: 'user', content: 'hi' }] });
  const live = seen.sessionConfigs[0];
  assert.deepEqual(live.availableTools, []);
  assert.equal(live.onPermissionRequest, rejectAll);
  assert.equal(live.enableConfigDiscovery, false);
  assert.equal(live.skipCustomInstructions, true);
  assert.equal(live.streaming, true);
  assert.equal('mcpServers' in live, false);
  assert.equal('tools' in live, false);
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
  // `reply` differs from the joined deltas, so the streamed text is what must come back.
  const { FakeClient, seen } = fakeClientCtor({ reply: 'whole' });
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  const got = [];
  const text = await run({ token: 'gho_abc', model: 'gpt-5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], onDelta: (d) => got.push(d) });
  assert.equal(text, 'hello');
  assert.deepEqual(got, ['hel', 'lo']);
  assert.equal(seen.disconnects, 1);
  assert.equal(seen.sessionConfigs[0].model, 'gpt-5');
  assert.equal(seen.sessionConfigs[0].systemMessage.content, 's');
  assert.equal(seen.prompts[0], 'User: q');

  // A runtime that did not stream: the whole answer is surfaced as one delta.
  const { FakeClient: Silent } = fakeClientCtor({ reply: 'whole', deltas: [] });
  const whole = [];
  const silentRun = createCopilotRunner({ ClientCtor: Silent, baseDirectory: '/tmp/x' });
  assert.equal(await silentRun({ token: 'gho_abc', messages: [{ role: 'user', content: 'q' }], onDelta: (d) => whole.push(d) }), 'whole');
  assert.deepEqual(whole, ['whole']);
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
  // Each turn gets its own empty working directory, and removes it.
  const [first, second] = seen.sessionConfigs.map((c) => c.workingDirectory);
  assert.notEqual(first, second);
  assert.deepEqual(seen.workdirListings, [[], []]);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), false);
});

test('a runtime error is scrubbed of any GitHub credential and classified', async () => {
  const { FakeClient, seen } = fakeClientCtor({ failWith: 'Unauthorized for gho_SECRET1, ghu_SECRET2, ghs_SECRET3, ghp_SECRET4 and github_pat_SECRET5' });
  const run = createCopilotRunner({ ClientCtor: FakeClient, baseDirectory: '/tmp/x' });
  await assert.rejects(
    () => run({ token: 'gho_SECRET1', messages: [{ role: 'user', content: 'q' }] }),
    (err) => {
      assert.ok(err instanceof CopilotTurnError);
      assert.equal(err.isAuth, true);
      assert.equal(err.message, 'Unauthorized for [REDACTED], [REDACTED], [REDACTED], [REDACTED] and [REDACTED]');
      return true;
    },
  );
  assert.equal(seen.disconnects, 1, 'the session is disconnected on failure too');

  const { FakeClient: Broken } = fakeClientCtor({ failWith: 'runtime crashed' });
  await assert.rejects(
    () => createCopilotRunner({ ClientCtor: Broken, baseDirectory: '/tmp/x' })({ token: 'gho_abc', messages: [{ role: 'user', content: 'q' }] }),
    (err) => {
      assert.ok(err instanceof CopilotTurnError);
      assert.equal(err.isAuth, false);
      assert.equal(err.message, 'runtime crashed');
      return true;
    },
  );
});

test('flattenMessages separates system text from the transcript', () => {
  const { system, prompt } = flattenMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  assert.equal(system, 'sys');
  assert.equal(prompt, 'User: a\n\nAssistant: b');
});
