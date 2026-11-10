// ADR 0785 P3/P4 (D6) — the files `claude` is launched with. The developer key reaches
// Claude Code only through a headersHelper command, never a file; tools are denied the
// companion's store and the usual secrets; the config files are owner-only; the permission
// hook appears only in the opt-in settings.
//
// Sabotage that reds it: a header added to the MCP entry; a wrong MCP path; any rule dropped
// from the deny list; 0644 in `writeAtomic` (a one-edit break of BOTH the write mode and the
// chmod, a double guard: either half alone changes nothing); the hook in the default settings
// or missing from the opt-in ones; a wrong hook timeout; the helper naming the wrong
// subcommand; the prompt moved ahead of the flags.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpConfig, buildSettings, writeClaudeConfig } from '../src/claudeConfig.js';
import { claudeLaunchArgs } from '../src/daemon.js';

test('the MCP config points at the canonical mount and carries NO secret — the key comes from a headersHelper command', () => {
  const cfg = buildMcpConfig('https://app.example.com/api', 'node bin.js mcp-headers');
  assert.deepEqual(cfg.mcpServers.openwop, { type: 'http', url: 'https://app.example.com/api/host/openwop-app/mcp', headersHelper: 'node bin.js mcp-headers' });
});

test('settings deny reading the companion store and running its header helper from a tool', () => {
  const s = buildSettings({ home: '/Users/me/.openwop/agent-host' });
  assert.deepEqual(new Set(s.permissions.deny), new Set([
    'Read(~/.ssh/**)',
    'Read(~/.aws/**)',
    'Read(./**/.env)',
    'Read(/Users/me/.openwop/agent-host/**)',
    'Bash(openwop-agent-host mcp-headers*)',
  ]));
  assert.equal(s.hooks, undefined, 'no hook until one is configured (P4)');
});

test('written files are 0600 and the launch args carry them before the prompt', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'cc-cfg-')), 'h');
  const paths = writeClaudeConfig({ home, apiRoot: 'http://localhost:8080' });
  assert.equal(statSync(paths.mcpConfigPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.remoteSettingsPath).mode & 0o777, 0o600);
  const server = JSON.parse(readFileSync(paths.mcpConfigPath, 'utf8')).mcpServers.openwop;
  assert.deepEqual(Object.keys(server).sort(), ['headersHelper', 'type', 'url'], 'the file holds a helper command, no headers');
  assert.equal(server.url, 'http://localhost:8080/host/openwop-app/mcp');
  assert.match(server.headersHelper, / mcp-headers$/);
  const { remoteSettingsPath, ...launch } = paths;
  assert.deepEqual(claudeLaunchArgs({ prompt: 'go', ...launch }), ['--settings', paths.settingsPath, '--mcp-config', paths.mcpConfigPath, 'go']);
  // The default settings carry NO hook (the TUI decides); the opt-in variant does, in the CLI's nested shape.
  assert.equal(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).hooks, undefined);
  const remote = JSON.parse(readFileSync(remoteSettingsPath, 'utf8'));
  assert.equal(remote.hooks.PermissionRequest[0].matcher, '*');
  const [hook] = remote.hooks.PermissionRequest[0].hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.timeout, 300);
  assert.match(hook.command, / permission-hook$/);
});
