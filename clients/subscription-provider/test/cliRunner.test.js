// ADR 0182 — cliRunner mapping tests. The vendor CLI is MOCKED (injected
// runCommand); no real subscription, no real spawn. The credential stays with the
// CLI, so this mapping is all the shim does. Not in `npm run ci`: run `npm test`
// in clients/subscription-provider.
//
// Sabotage that turns it red (each probed): reordering turns, joining parts with a
// separator, dropping the system prompt or --model, not trimming, swallowing a
// non-zero exit, narrowing the auth heuristic, or making every failure read as auth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenMessages, runCodex, CliError } from '../src/cliRunner.js';

test('flattenMessages splits system from turns and joins text parts', () => {
  const { system, prompt } = flattenMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi ' }, { type: 'image', url: 'x' }, { type: 'text', text: 'there' }] },
    { role: 'user', content: 'why?' },
    { role: 'system', content: 'in english' },
  ]);
  assert.equal(system, 'be terse\nin english');
  assert.equal(prompt, 'User: hello\n\nAssistant: hi there\n\nUser: why?');
});

test('runCodex throws a CliError with isAuth on a login failure', async () => {
  for (const stdout of ['Please run `codex login` first', 'not logged in', 'Unauthorized', 'authentication required', 'HTTP 401']) {
    await assert.rejects(
      () => runCodex({ messages: [{ role: 'user', content: 'q' }] }, async () => ({ stdout, code: 1 })),
      (err) => err instanceof CliError && err.isAuth === true && err.harness === 'codex',
      stdout,
    );
  }
});

test('runCodex runs `codex exec` and returns trimmed stdout', async () => {
  let seenBin, seenArgs;
  const mock = async (bin, args) => { seenBin = bin; seenArgs = args; return { stdout: '  codex answer\n', code: 0 }; };
  const text = await runCodex({ messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'q' }], model: 'gpt-x' }, mock);
  assert.equal(text, 'codex answer');
  assert.equal(seenBin, 'codex');
  assert.deepEqual(seenArgs, ['exec', 'be terse\n\nUser: q', '--model', 'gpt-x']);
});

test('runCodex non-zero exit → CliError', async () => {
  const mock = async () => ({ stdout: 'boom', code: 2 });
  await assert.rejects(
    () => runCodex({ messages: [{ role: 'user', content: 'q' }] }, mock),
    (err) => err instanceof CliError && err.code === 2 && err.harness === 'codex' && err.isAuth === false,
  );
});
