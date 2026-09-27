// ADR 0182 — cliRunner mapping tests. The vendor CLI is MOCKED (injected
// runCommand); no real subscription, no real spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenMessages, runCodex, CliError } from '../src/cliRunner.js';

test('flattenMessages splits system from turns and joins text parts', () => {
  const { system, prompt } = flattenMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: 'why?' },
  ]);
  assert.equal(system, 'be terse');
  assert.match(prompt, /User: hello/);
  assert.match(prompt, /Assistant: hi/);
  assert.match(prompt, /User: why\?/);
});

test('runCodex throws a CliError with isAuth on a login failure', async () => {
  const mock = async () => ({ stdout: 'Please run `codex login` first', code: 1 });
  await assert.rejects(
    () => runCodex({ messages: [{ role: 'user', content: 'q' }] }, mock),
    (err) => err instanceof CliError && err.isAuth === true && err.harness === 'codex',
  );
});

test('runCodex runs `codex exec` and returns trimmed stdout', async () => {
  let seenBin, seenArgs;
  const mock = async (bin, args) => { seenBin = bin; seenArgs = args; return { stdout: '  codex answer\n', code: 0 }; };
  const text = await runCodex({ messages: [{ role: 'user', content: 'q' }] }, mock);
  assert.equal(text, 'codex answer');
  assert.equal(seenBin, 'codex');
  assert.equal(seenArgs[0], 'exec');
});

test('runCodex non-zero exit → CliError', async () => {
  const mock = async () => ({ stdout: 'boom', code: 2 });
  await assert.rejects(() => runCodex({ messages: [{ role: 'user', content: 'q' }] }, mock), CliError);
});
