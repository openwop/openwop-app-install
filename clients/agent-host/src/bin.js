#!/usr/bin/env node
// ADR 0785 — `openwop-agent-host`, the Claude Code companion.
//
//   openwop-agent-host pair --host https://app.example.com [--label "work mac"] [--api-base <url>]
//   openwop-agent-host status
//   openwop-agent-host unpair
//
//   openwop-agent-host run [--root <dir>]
//
// Pairing gives this machine a developer key for the workspace; `run` hosts the
// terminal sessions (P2) and app-dispatched tasks (P5).
// The companion connects OUT; it never opens a listening port.

import { hostname, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { apiRootFor, discoverStreamBase, normalizeHost, serviceRootFor, startPairing, waitForApproval } from './pairing.js';
import { AgentHostDaemon } from './daemon.js';
import { nodePtyFactory } from './ptySessions.js';
import { writeClaudeConfig } from './claudeConfig.js';
import { runPermissionHook } from './permissionHook.js';
import { TaskRunner } from './taskRunner.js';
import { clearCredential, defaultHome, loadCredential, saveCredential, setStreamBase } from './credentialStore.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--') && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
  }
  return { command, opts };
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

async function pair(opts) {
  if (!opts.host) { err('Usage: openwop-agent-host pair --host https://your-app.example.com'); return 2; }
  const host = normalizeHost(opts.host);
  const apiBase = typeof opts['api-base'] === 'string' ? opts['api-base'] : (process.env.OPENWOP_AGENT_HOST_API_BASE ?? '');
  const label = typeof opts.label === 'string' ? opts.label : hostname();
  const started = await startPairing({ host, apiBase, label, platform: `${platform()}-${arch()}` });
  out('');
  out(`  Your pairing code:  ${started.userCode}`);
  out('');
  out(`  Open ${started.verificationUrl} while signed in,`);
  out('  and TYPE the code above. (The link never carries the code: if someone sends');
  out('  you a pairing link with a code already in it, do not approve it.)');
  out(`  (the code expires in ${Math.round(started.expiresIn / 60)} minutes)`);
  out('');
  out('  Tip: signing Claude Code in with an Anthropic API key is the supported path.');
  out('');
  const result = await waitForApproval({ host, apiBase, deviceCode: started.deviceCode, interval: started.interval, expiresIn: started.expiresIn });
  if (result.status === 'denied') { err('The pairing was denied. Nothing was stored.'); return 1; }
  if (result.status === 'failed') { err(`The pairing was approved, but ${result.message ?? 'the device key could not be issued.'} Nothing was stored.`); return 1; }
  if (result.status !== 'approved') { err('The code expired before it was approved. Run pair again.'); return 1; }
  const streamBase = await discoverStreamBase(apiRootFor(host, apiBase));
  const { tokenIn } = saveCredential({ host, apiBase, ...(streamBase ? { streamBase } : {}), token: result.token, deviceId: result.deviceId, tenantId: result.tenantId, expiresAt: result.expiresAt });
  out(`Paired. Device ${result.deviceId}; key stored in the ${tokenIn === 'keychain' ? 'macOS keychain' : `file ${defaultHome()}/credentials.json (mode 0600)`}.`);
  return 0;
}

function status() {
  const c = loadCredential();
  if (!c) { out('Not paired. Run: openwop-agent-host pair --host https://your-app.example.com'); return 1; }
  out(`Paired with ${c.host}`);
  out(`  device:  ${c.deviceId}`);
  out(`  expires: ${c.expiresAt ?? 'unknown'}`);
  out(`  key:     ${c.token ? 'present' : 'MISSING'} (${c.tokenIn})`);
  return c.token ? 0 : 1;
}

async function run(opts) {
  const c = loadCredential();
  if (!c?.token) { err('Not paired. Run: openwop-agent-host pair --host https://your-app.example.com'); return 1; }
  // D9 — the workspace root: Claude Code sessions start here and nowhere else.
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  // A mistyped --root (e.g. `~/Users/me/x` → /Users/me/Users/me/x) must fail here,
  // not later as a session that cannot start.
  if (!existsSync(root) || !statSync(root).isDirectory()) { err(`--root ${root} is not a folder on this machine.`); return 1; }
  // Re-read the host's direct origin on every start, so a pairing made through a
  // front door that cannot carry WebSockets repairs itself (ADR 0785, 2026-10-04),
  // and a host that moves its origin is followed. Persisted for the permission
  // hook, which Claude Code starts as a separate process per prompt.
  const discovered = await discoverStreamBase(apiRootFor(c.host, c.apiBase));
  if (discovered && discovered !== c.streamBase) { setStreamBase({ streamBase: discovered }); c.streamBase = discovered; }
  const apiRoot = serviceRootFor(c);
  // D6 — Claude Code is launched already connected to this workspace's MCP mount.
  const launch = writeClaudeConfig({ home: defaultHome(), apiRoot });
  // Headless tasks use the DEFAULT settings (no interactive hook): their prompts
  // go to the permission-prompt tool instead.
  const taskRunner = new TaskRunner({
    apiRoot, token: c.token, root, home: defaultHome(),
    launch: () => ({ mcpConfigPath: launch.mcpConfigPath, settingsPath: launch.settingsPath }),
    log: (m) => out(`[agent-host] ${m}`),
  });
  const daemon = new AgentHostDaemon({
    taskRunner,
    apiRoot,
    token: c.token,
    root,
    ptyFactory: nodePtyFactory(),
    launchOptions: () => launch,
    log: (m) => out(`[agent-host] ${m}`),
  });
  out(`[agent-host] device ${c.deviceId}; Claude Code sessions start in ${root}`);
  out(`[agent-host] connecting through ${apiRoot}`);
  if (!c.streamBase && !/^https?:\/\//i.test(c.apiBase ?? '')) {
    out('[agent-host] note: this host advertises no direct origin. If the app keeps showing this device as offline,');
    out('[agent-host] its front door cannot carry WebSockets: pair again with --api-base set to the backend URL.');
  }
  out('[agent-host] waiting for the workspace — open Claude Code in the app. Ctrl+C to stop.');
  daemon.start();
  return new Promise((done) => {
    const quit = () => { daemon.stop(); done(0); };
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
  });
}

/** `headersHelper` for Claude Code's MCP connection: print the Authorization header
 *  as JSON. Reads the key from the credential store at call time, so it never has
 *  to live in a config file or the environment. */
function mcpHeaders() {
  const c = loadCredential();
  if (!c?.token) { err('Not paired.'); return 1; }
  process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${c.token}` })}\n`);
  return 0;
}

/** ADR 0785 P4 — Claude Code's PermissionRequest hook (opt-in sessions only). */
async function permissionHook() {
  const c = loadCredential();
  if (!c?.token) return 0; // not paired: say nothing, the terminal decides
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const outText = await runPermissionHook({ stdin: Buffer.concat(chunks).toString('utf8'), apiRoot: serviceRootFor(c), token: c.token });
  if (outText) process.stdout.write(`${outText}\n`);
  return 0;
}

function unpair() {
  const c = clearCredential();
  if (!c) { out('Not paired; nothing to forget.'); return 0; }
  out(`Forgot the pairing with ${c.host} on this machine.`);
  out(`To revoke the key itself, open ${c.host}/claude-code and choose Revoke.`);
  return 0;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'pair': return pair(opts);
    case 'status': return status();
    case 'run': return run(opts);
    case 'mcp-headers': return mcpHeaders();
    case 'permission-hook': return permissionHook();
    case 'unpair': return unpair();
    default:
      out('openwop-agent-host — the Claude Code companion (ADR 0785)');
      out('  pair --host <url> [--label <name>]                      pair this machine with a workspace (the app finds its backend;');
      out('                                                          --api-base <url> overrides it)');
      out('  run [--root <dir>]                                      connect and host Claude Code sessions (in <dir>, default: here)');
      out('  status                                                  show this machine\'s pairing');
      out('  unpair                                                  forget the pairing here');
      return command ? 2 : 0;
  }
}

main().then((code) => { process.exitCode = code; }, (e) => { err(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
