// ADR 0182 — drive the vendor's OWN official CLI non-interactively.
//
// The shim NEVER extracts or forwards a token. It runs `codex
// exec` under the user's own login (which the CLI reads from its own store),
// captures stdout, and maps it to/from an OpenAI/Anthropic-compatible shape.
// The subprocess boundary is the whole point: the credential stays with the CLI.
//
// `runCommand` is injected so tests exercise the mapping against a mocked CLI
// (no real subscription, no real spawn). The default implementation shells out
// via child_process.execFile.

import { execFile } from 'node:child_process';

/** Default runner: execFile the binary, resolve { stdout, stderr, code }. */
export function defaultRunCommand(bin, args, { input = '', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0 });
    });
    if (input) {
      try { child.stdin?.end(input); } catch { /* best effort */ }
    }
  });
}

/** Flatten OpenAI/Anthropic `messages[]` into a system prompt + a user prompt. */
export function flattenMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';
    if (m?.role === 'system') system.push(text);
    else turns.push(`${m?.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  return { system: system.join('\n').trim(), prompt: turns.join('\n\n').trim() };
}

/** Run Codex non-interactively: `codex exec <prompt>` → stdout text. */
export async function runCodex({ messages, model }, runCommand = defaultRunCommand) {
  const { system, prompt } = flattenMessages(messages);
  const full = system ? `${system}\n\n${prompt}` : prompt;
  const args = ['exec', full];
  if (model) args.push('--model', model);
  const { stdout, code } = await runCommand('codex', args, { input: '' });
  if (code !== 0) throw new CliError('codex', code, stdout);
  return stdout.trim();
}

export class CliError extends Error {
  constructor(harness, code, output) {
    super(`${harness} exited ${code}`);
    this.harness = harness;
    this.code = code;
    this.output = output;
    // Heuristic: is this an auth failure the operator should re-login for?
    this.isAuth = /not logged in|unauthor|authentication|please run .*login|401/i.test(String(output || ''));
  }
}
