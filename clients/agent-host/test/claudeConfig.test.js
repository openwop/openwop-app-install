// ADR 0785 P3 — the files `claude` is launched with.

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
  assert.ok(!JSON.stringify(cfg).includes('owk_'));
});

test('settings deny reading the companion store and running its header helper from a tool', () => {
  const s = buildSettings({ home: '/Users/me/.openwop/agent-host' });
  assert.ok(s.permissions.deny.includes('Read(/Users/me/.openwop/agent-host/**)'));
  assert.ok(s.permissions.deny.some((r) => r.startsWith('Bash(openwop-agent-host mcp-headers')));
  assert.ok(s.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.equal(s.hooks, undefined, 'no hook until one is configured (P4)');
});

test('written files are 0600 and the launch args carry them before the prompt', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'cc-cfg-')), 'h');
  const paths = writeClaudeConfig({ home, apiRoot: 'http://localhost:8080' });
  assert.equal(statSync(paths.mcpConfigPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.settingsPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(paths.mcpConfigPath, 'utf8')).mcpServers.openwop.url, 'http://localhost:8080/host/openwop-app/mcp');
  const { remoteSettingsPath, ...launch } = paths;
  assert.deepEqual(claudeLaunchArgs({ prompt: 'go', ...launch }), ['--settings', paths.settingsPath, '--mcp-config', paths.mcpConfigPath, 'go']);
  // The default settings carry NO hook (the TUI decides); the opt-in variant does, in the CLI's nested shape.
  assert.equal(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).hooks, undefined);
  const remote = JSON.parse(readFileSync(remoteSettingsPath, 'utf8'));
  assert.equal(remote.hooks.PermissionRequest[0].matcher, '*');
  assert.match(remote.hooks.PermissionRequest[0].hooks[0].command, /permission-hook/);
});
