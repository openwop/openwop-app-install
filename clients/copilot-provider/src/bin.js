#!/usr/bin/env node
// ADR 0757 — `openwop-copilot-provider` entry point.
//
// Starts the loopback Copilot sidecar and prints the value the backend needs in
// OPENWOP_COPILOT_ENDPOINT. Uses GitHub's official @github/copilot-sdk, which
// ships the Copilot runtime for the host platform (no runtime download).

import { CopilotClient } from '@github/copilot-sdk';
import { createCopilotRunner } from './copilot.js';
import { startServer } from './server.js';

function parseArgs(argv) {
  const out = { port: Number(process.env.OPENWOP_COPILOT_SIDECAR_PORT) || 8791 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));
  const runTurn = createCopilotRunner({ ClientCtor: CopilotClient });
  const { port: bound } = await startServer({ port, runTurn });
  process.stdout.write(
    `[copilot-provider] listening on http://127.0.0.1:${bound}\n` +
    `  Backend: OPENWOP_COPILOT_ENDPOINT=http://127.0.0.1:${bound}/v1\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[copilot-provider] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
