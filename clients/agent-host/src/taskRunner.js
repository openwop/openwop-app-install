// ADR 0785 P5 / D8 — run ONE app-dispatched task, headless, and report it.
//
// Each task is a FRESH `claude -p` process: the prior art's lesson (a stateless
// agent against server-held state runs indefinitely) without its TUI injection
// or scraped completion markers. Completion is the CLI's typed `result` event
// (`--output-format stream-json --verbose`), posted back as a typed result.
//
// Permission prompts go to this workspace's approval cards through
// `--permission-prompts host --permission-prompt-tool mcp__openwop__claude-code-permission`
// (P4), so a task started while nobody is at the keyboard still asks a person.
//
// At-most-once on THIS side too: a task id this machine has already run is never
// run again (the host claims before it sends; a redelivered frame is ignored here).

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PERMISSION_TOOL = 'mcp__openwop__claude-code-permission';
const SUMMARY_MAX = 8000;
const SEEN_MAX = 500;

export function taskArgs({ prompt, maxTurns, mcpConfigPath, settingsPath }) {
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns),
    // EXPLICIT, never inherited: a user's own settings may say `auto` (MEASURED on
    // this machine: the CLI reported permissionMode "auto"), which lets the CLI
    // approve tools itself and would bypass the approval cards for work the APP
    // started. acceptEdits: edits inside the workspace root proceed; everything
    // else (Bash, network, files elsewhere) asks a person through the card.
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'host', '--permission-prompt-tool', PERMISSION_TOOL,
    ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
    ...(settingsPath ? ['--settings', settingsPath] : []),
  ];
}

/** The final `result` event of a stream-json transcript, or null. */
export function finalResult(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev && ev.type === 'result') return ev;
  }
  return null;
}

export class TaskRunner {
  /** @param {{ apiRoot: string, token: string, root: string, home: string, command?: string,
   *   launch: () => { mcpConfigPath?: string, settingsPath?: string },
   *   spawnFn?: typeof nodeSpawn, fetchFn?: typeof fetch, log?: (m: string) => void, env?: Record<string,string> }} opts */
  constructor(opts) {
    this.opts = opts;
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.log ?? (() => {});
    this.seenPath = join(opts.home, 'tasks-seen.json');
    this.seen = new Set(existsSync(this.seenPath) ? (() => { try { return JSON.parse(readFileSync(this.seenPath, 'utf8')); } catch { return []; } })() : []);
  }

  remember(taskId) {
    this.seen.add(taskId);
    const list = [...this.seen].slice(-SEEN_MAX);
    const tmp = `${this.seenPath}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); renameSync(tmp, this.seenPath); } catch { /* best-effort */ }
  }

  /** Handle one `task` frame. Resolves when the result has been reported. */
  async run(frame) {
    const { taskId } = frame;
    if (!taskId || this.seen.has(taskId)) { this.log(`task ${taskId} already handled here; ignoring`); return 'skipped'; }
    this.remember(taskId); // BEFORE running: a crash mid-task must not re-run it on restart
    const prompt = String(frame.inputs?.prompt ?? '');
    const maxTurns = Number(frame.inputs?.maxTurns) || 30;
    this.log(`task ${taskId}: starting headless Claude Code`);
    let report;
    try {
      const { lines, code } = await this.exec(taskArgs({ prompt, maxTurns, ...this.opts.launch() }));
      const result = finalResult(lines);
      report = result
        ? { status: 'completed', isError: result.is_error === true || result.subtype === 'error_max_turns', summary: String(result.result ?? '').slice(0, SUMMARY_MAX), numTurns: result.num_turns, costUsd: result.total_cost_usd }
        : { status: 'failed', message: `Claude Code exited (${code}) without a result.` };
    } catch (err) {
      report = { status: 'failed', message: `Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}` };
    }
    await this.report(taskId, report);
    return report.status;
  }

  exec(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.opts.command ?? 'claude', args, { cwd: this.opts.root, env: this.opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = []; let buf = '';
      child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      child.on('error', reject);
      child.on('close', (code) => { if (buf) lines.push(buf); resolve({ lines, code }); });
    });
  }

  async report(taskId, body) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const res = await this.fetchFn(`${this.opts.apiRoot}/host/openwop-app/claude-code/tasks/${encodeURIComponent(taskId)}/result`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` }, body: JSON.stringify(body),
        });
        if (res.ok || res.status === 404) return; // accepted, already finished, or no longer ours
      } catch { /* network: retry */ }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    this.log(`task ${taskId}: could not report its result; the workspace will time it out as maybe-executed`);
  }
}
