// ADR 0785 P4 — the interactive hook maps the workspace's answer onto the CLI's
// PermissionRequest output, and defers (prints nothing) whenever it cannot get one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPermissionHook } from '../src/permissionHook.js';

const reply = (answer, ok = true) => async () => ({ ok, json: async () => ({ result: { isError: false, content: [{ type: 'text', text: JSON.stringify(answer) }] } }) });
const stdin = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });

test('allow in the app → allow decision', async () => {
  let sent;
  const out = await runPermissionHook({ stdin, apiRoot: 'https://h', token: 'owk_x', fetchFn: async (url, init) => { sent = { url, init }; return reply({ behavior: 'allow', updatedInput: { command: 'ls' } })(); } });
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(sent.url, 'https://h/host/openwop-app/mcp');
  assert.equal(JSON.parse(sent.init.body).params.arguments.on_timeout, 'defer');
});

test('deny in the app → deny decision carrying the reason', async () => {
  const out = await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'deny', message: 'Denied in the app: no' }) });
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied in the app: no' });
});

test('nobody answered in time → print NOTHING (the terminal prompt decides)', async () => {
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'deny', timedOut: true }) }), '');
});

test('workspace unreachable, an error result, or garbage stdin → defer, never a silent allow', async () => {
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: async () => { throw new Error('ECONNREFUSED'); } }), '');
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ result: { isError: true, content: [] } }) }) }), '');
  assert.equal(await runPermissionHook({ stdin: 'not json', apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'allow' }) }), '');
});
