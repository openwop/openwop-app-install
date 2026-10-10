// ADR 0785 P4 — the interactive, opt-in `PermissionRequest` hook.
//
// Claude Code runs this command (from the per-session settings the companion
// writes when the user chose "approve from anywhere") with the prompt on stdin.
// It asks the workspace through the SAME MCP tool headless tasks use, with
// `on_timeout: 'defer'`, and answers in the hook-output shape the CLI validates
// (read from the installed 2.1.285 schema): decision allow | deny. When nobody
// answers in the app in time it prints NOTHING — the documented way to fall
// back to the terminal's own prompt, so the person at the keyboard still decides.

/** @returns {Promise<string>} what to print on stdout ('' = defer to the TUI). */
export async function runPermissionHook({ stdin, apiRoot, token, fetchFn = fetch }) {
  let ev;
  try { ev = JSON.parse(stdin); } catch { return ''; }
  const toolName = typeof ev.tool_name === 'string' ? ev.tool_name : '';
  if (!toolName) return '';
  let res;
  try {
    res = await fetchFn(`${apiRoot}/host/openwop-app/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claude-code-permission', arguments: { tool_name: toolName, input: ev.tool_input ?? {}, on_timeout: 'defer', ...(ev.tool_use_id ? { tool_use_id: ev.tool_use_id } : {}) } } }),
    });
  } catch { return ''; } // the workspace is unreachable: let the person decide at the terminal
  let body;
  try { body = await res.json(); } catch { return ''; }
  if (!res.ok || body?.result?.isError) return '';
  let answer;
  try { answer = JSON.parse(body.result.content[0].text); } catch { return ''; }
  if (answer.timedOut) return '';
  const decision = answer.behavior === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: typeof answer.message === 'string' ? answer.message : 'Denied in the app.' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}
