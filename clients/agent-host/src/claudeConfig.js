// ADR 0785 D6 / D9 — the files the companion hands `claude` at launch.
//
//   mcp.json       this workspace's MCP mount, authenticated per request by a
//                  `headersHelper` COMMAND — the developer key is never written
//                  into the file and never placed in the environment, because
//                  every child of `claude` (its Bash tool included) inherits the
//                  environment, and one prompt-injected `env` would leak it.
//   settings.json  deny-rules for the companion's own credential store and the
//                  usual secrets (the prior art's set), plus — from P4 — the
//                  permission hook.
//
// Both are regenerated on every `run`, so an upgrade never leaves stale config.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_NAME = 'openwop';

function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** The command Claude Code runs to get the MCP Authorization header. */
export function headersHelperCommand(binPath = resolve(fileURLToPath(import.meta.url), '..', 'bin.js')) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(binPath)} mcp-headers`;
}

export function buildMcpConfig(apiRoot, helper = headersHelperCommand()) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `${apiRoot}/host/openwop-app/mcp`,
        headersHelper: helper,
      },
    },
  };
}

export function buildSettings({ home, hookCommand } = {}) {
  const settings = {
    permissions: {
      deny: [
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(./**/.env)',
        // The companion's own credential store: Claude Code reaches this host
        // through MCP, never by reading the key.
        ...(home ? [`Read(${home}/**)`] : []),
        'Bash(openwop-agent-host mcp-headers*)',
      ],
    },
  };
  if (hookCommand) {
    settings.hooks = {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 300 }] }],
    };
  }
  return settings;
}

/** Write both files under `home`; returns their paths for `claude --mcp-config / --settings`. */
export function hookCommandFor(binPath = resolve(fileURLToPath(import.meta.url), '..', 'bin.js')) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(binPath)} permission-hook`;
}

/** Write the MCP config and BOTH settings variants: the default (the TUI decides)
 *  and the opt-in "approve from anywhere" one, which adds the PermissionRequest hook. */
export function writeClaudeConfig({ home, apiRoot, hookCommand = hookCommandFor() }) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const mcpConfigPath = join(home, 'mcp.json');
  const settingsPath = join(home, 'settings.json');
  const remoteSettingsPath = join(home, 'settings-approve-anywhere.json');
  writeAtomic(mcpConfigPath, buildMcpConfig(apiRoot));
  writeAtomic(settingsPath, buildSettings({ home }));
  writeAtomic(remoteSettingsPath, buildSettings({ home, hookCommand }));
  return { mcpConfigPath, settingsPath, remoteSettingsPath };
}
