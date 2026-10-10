// ADR 0785 P5 — the companion's headless task runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_TOOL, TaskRunner, finalResult, taskArgs } from '../src/taskRunner.js';

function fakeSpawn(lines, code = 0) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit('data', Buffer.from(lines.join('\n'))); child.emit('close', code); });
    return child;
  };
  return { spawnFn, calls };
}
function runner(spawnFn, reports) {
  return new TaskRunner({
    apiRoot: 'https://h', token: 'owk_t', root: '/repo', home: mkdtempSync(join(tmpdir(), 'tr-')),
    launch: () => ({ mcpConfigPath: '/c/mcp.json', settingsPath: '/c/settings.json' }),
    spawnFn, fetchFn: async (url, init) => { reports.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
}
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the test.', num_turns: 4, total_cost_usd: 0.08 });

test('headless args: stream-json, bounded turns, and permission prompts routed to the workspace tool', () => {
  const a = taskArgs({ prompt: 'p', maxTurns: 7, mcpConfigPath: '/m', settingsPath: '/s' });
  assert.deepEqual(a.slice(0, 2), ['-p', 'p']);
  assert.ok(a.includes('--verbose') && a.includes('stream-json'));
  assert.equal(a[a.indexOf('--max-turns') + 1], '7');
  assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], PERMISSION_TOOL);
  assert.equal(a[a.indexOf('--permission-prompts') + 1], 'host');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits', 'never inherit a user\'s auto mode for app-started work');
});

test('reports the typed result event, run in the workspace root', async () => {
  const reports = [];
  const { spawnFn, calls } = fakeSpawn(['{"type":"system"}', '{"type":"assistant"}', RESULT]);
  assert.equal(await runner(spawnFn, reports).run({ taskId: 't1', inputs: { prompt: 'fix it', maxTurns: 5 } }), 'completed');
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.equal(reports[0].url, 'https://h/host/openwop-app/claude-code/tasks/t1/result');
  assert.deepEqual(reports[0].body, { status: 'completed', isError: false, summary: 'Fixed the test.', numTurns: 4, costUsd: 0.08 });
});

test('no result event → a typed failure, not a silent success', async () => {
  const reports = [];
  const { spawnFn } = fakeSpawn(['{"type":"assistant"}'], 1);
  await runner(spawnFn, reports).run({ taskId: 't2', inputs: { prompt: 'x' } });
  assert.equal(reports[0].body.status, 'failed');
});

test('AT-MOST-ONCE on the device: a task id already handled is never run again', async () => {
  const reports = [];
  const { spawnFn, calls } = fakeSpawn([RESULT]);
  const r = runner(spawnFn, reports);
  await r.run({ taskId: 'dup', inputs: { prompt: 'x' } });
  assert.equal(await r.run({ taskId: 'dup', inputs: { prompt: 'x' } }), 'skipped');
  assert.equal(calls.length, 1);
});

test('finalResult takes the LAST result event and skips garbage lines', () => {
  assert.equal(finalResult(['nope', '{"type":"result","result":"a"}', '{"type":"result","result":"b"}']).result, 'b');
  assert.equal(finalResult(['{"type":"assistant"}']), null);
});
