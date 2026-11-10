// ADR 0785 P5 (D8) — the companion's headless task runner. App-started work never inherits a
// user's permission mode, always carries the deny rules and the approval tool, reports a typed
// result, and runs at most once on this device, restarts and crashes included.
//
// Sabotage that reds it: any change to the argv (permission mode, prompts, tool id, --settings,
// --mcp-config); a wrong cwd, prompt or bearer; a lost result field; `is_error` or
// `error_max_turns` reported as clean; the last unterminated line lost; no result reported as
// success; a task id never remembered, not persisted, or remembered only after the run; the
// first result taken instead of the last; a garbage line ending the search.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRunner, finalResult, taskArgs } from '../src/taskRunner.js';

const newHome = () => mkdtempSync(join(tmpdir(), 'tr-'));
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  return child;
}
function fakeSpawn(lines, code = 0) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = fakeChild();
    setImmediate(() => { child.stdout.emit('data', Buffer.from(lines.join('\n'))); child.emit('close', code); });
    return child;
  };
  return { spawnFn, calls };
}
function runner(spawnFn, reports, home = newHome()) {
  return new TaskRunner({
    apiRoot: 'https://h', token: 'owk_t', root: '/repo', home,
    launch: () => ({ mcpConfigPath: '/c/mcp.json', settingsPath: '/c/settings.json' }),
    spawnFn, fetchFn: async (url, init) => { reports.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
}
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the test.', num_turns: 4, total_cost_usd: 0.08 });

test('headless args: stream-json, bounded turns, and permission prompts routed to the workspace tool', () => {
  assert.deepEqual(taskArgs({ prompt: 'p', maxTurns: 7, mcpConfigPath: '/m', settingsPath: '/s' }), [
    '-p', 'p',
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '7',
    '--permission-mode', 'acceptEdits', // never inherit a user's auto mode for app-started work
    '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__openwop__claude-code-permission',
    '--mcp-config', '/m',
    '--settings', '/s',
  ]);
});

test('reports the typed result event, run in the workspace root', async () => {
  const reports = [];
  const { spawnFn, calls } = fakeSpawn(['{"type":"system"}', '{"type":"assistant"}', RESULT]);
  assert.equal(await runner(spawnFn, reports).run({ taskId: 't1', inputs: { prompt: 'fix it', maxTurns: 5 } }), 'completed');
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-p', 'fix it']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-turns') + 1], '5');
  assert.equal(calls[0].args[calls[0].args.indexOf('--settings') + 1], '/c/settings.json');
  assert.equal(reports[0].url, 'https://h/host/openwop-app/claude-code/tasks/t1/result');
  assert.equal(reports[0].auth, 'Bearer owk_t');
  assert.deepEqual(reports[0].body, { status: 'completed', isError: false, summary: 'Fixed the test.', numTurns: 4, costUsd: 0.08 });

  // The CLI's own error verdicts stay errors in the report.
  for (const fields of [{ is_error: true, subtype: 'success' }, { is_error: false, subtype: 'error_max_turns' }]) {
    const errored = [];
    const { spawnFn: spawnErrored } = fakeSpawn([JSON.stringify({ type: 'result', result: 'Stopped.', num_turns: 5, total_cost_usd: 0.11, ...fields })]);
    assert.equal(await runner(spawnErrored, errored).run({ taskId: 't1e', inputs: { prompt: 'x' } }), 'completed');
    assert.deepEqual(errored[0].body, { status: 'completed', isError: true, summary: 'Stopped.', numTurns: 5, costUsd: 0.11 });
  }
});

test('no result event → a typed failure, not a silent success', async () => {
  const reports = [];
  const { spawnFn } = fakeSpawn(['{"type":"assistant"}'], 1);
  assert.equal(await runner(spawnFn, reports).run({ taskId: 't2', inputs: { prompt: 'x' } }), 'failed');
  assert.deepEqual(reports[0].body, { status: 'failed', message: 'Claude Code exited (1) without a result.' });
});

test('AT-MOST-ONCE on the device: a task id already handled is never run again', async () => {
  const reports = [];
  const home = newHome();
  const { spawnFn, calls } = fakeSpawn([RESULT]);
  const r = runner(spawnFn, reports, home);
  await r.run({ taskId: 'dup', inputs: { prompt: 'x' } });
  assert.equal(await r.run({ taskId: 'dup', inputs: { prompt: 'x' } }), 'skipped');
  assert.equal(await runner(spawnFn, reports, home).run({ taskId: 'dup', inputs: { prompt: 'x' } }), 'skipped', 'a restarted companion remembers it');
  assert.equal(calls.length, 1);
});

test('AT-MOST-ONCE: a task interrupted mid-run is not re-run after a restart', async () => {
  const reports = [];
  const home = newHome();
  const started = [];
  const neverCloses = (cmd, args) => { started.push(args); return fakeChild(); };
  void runner(neverCloses, reports, home).run({ taskId: 'crash', inputs: { prompt: 'x' } });
  assert.equal(started.length, 1, 'the first process is running');
  const { spawnFn, calls } = fakeSpawn([RESULT]);
  assert.equal(await runner(spawnFn, reports, home).run({ taskId: 'crash', inputs: { prompt: 'x' } }), 'skipped');
  assert.equal(calls.length, 0);
});

test('finalResult takes the LAST result event and skips garbage lines', () => {
  assert.equal(finalResult(['nope', '{"type":"result","result":"a"}', '{"type":"result","result":"b"}']).result, 'b');
  assert.equal(finalResult(['{"type":"result","result":"a"}', 'nope']).result, 'a');
  assert.equal(finalResult(['{"type":"assistant"}']), null);
});
