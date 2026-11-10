// ADR 0785 P4 — the interactive hook maps the workspace's answer onto the CLI's
// PermissionRequest output, and defers (prints nothing) whenever it cannot get one. Only an
// explicit `allow` from a good response may print allow.
//
// Sabotage that reds it: allow and deny swapped; an unknown behavior treated as allow; the
// input echoed into the decision; a wrong tool, tool name, input, bearer, event name or
// `on_timeout`; `timedOut` ignored; an unreachable workspace, an `isError` result or a non-OK
// response that prints allow; garbage stdin or a missing tool name that still asks; no default
// deny message. The `isError` fixture carries a parsable allow on purpose: an empty `content`
// also ends in the parse catch, which hid that guard's removal.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

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
  assert.equal(sent.init.headers.authorization, 'Bearer owk_x');
  assert.deepEqual(JSON.parse(sent.init.body), {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'claude-code-permission', arguments: { tool_name: 'Bash', input: { command: 'ls' }, on_timeout: 'defer' } },
  });
});

test('deny in the app → deny decision carrying the reason', async () => {
  const out = await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'deny', message: 'Denied in the app: no' }) });
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied in the app: no' });
  // Anything that is not an explicit allow is a deny, with a reason of its own.
  const unknown = await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'maybe' }) });
  assert.deepEqual(JSON.parse(unknown).hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied in the app.' });
});

test('nobody answered in time → print NOTHING (the terminal prompt decides)', async () => {
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'deny', timedOut: true }) }), '');
});

test('workspace unreachable, an error result, or garbage stdin → defer, never a silent allow', async () => {
  const allow = JSON.stringify({ behavior: 'allow' });
  const respond = (result) => async () => ({ ok: true, json: async () => ({ result }) });
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: async () => { throw new Error('ECONNREFUSED'); } }), '');
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: respond({ isError: true, content: [{ type: 'text', text: allow }] }) }), '');
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'allow' }, false) }), '');
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }) }), '');
  assert.equal(await runPermissionHook({ stdin, apiRoot: 'https://h', token: 't', fetchFn: respond({ isError: false, content: [{ type: 'text', text: 'not json' }] }) }), '');
  assert.equal(await runPermissionHook({ stdin: 'not json', apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'allow' }) }), '');
  assert.equal(await runPermissionHook({ stdin: '{}', apiRoot: 'https://h', token: 't', fetchFn: reply({ behavior: 'allow' }) }), '');
});
