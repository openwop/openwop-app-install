#!/usr/bin/env node
// ADR 0182 — `openwop-subscription-provider` entry point.
//
// Starts the loopback subscription shim, then prints the endpoint the operator
// wires into the self-hosted backend via OPENWOP_SUBSCRIPTION_ENDPOINT. Warns
// (does not fail) when no vendor-CLI login is detected, so the operator knows to
// run `codex` login first (ADR 0756 removed the Claude harness). This is the CLI surface @openwop/cli can
// later adopt as `openwop provider serve`.

import { startServer } from './server.js';
import { subscriptionLoginDetected, SUPPORTED_HARNESSES } from './detect.js';

function parseArgs(argv) {
  const out = { port: Number(process.env.OPENWOP_SUBSCRIPTION_SHIM_PORT) || 8790 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) { out.port = Number(argv[++i]); }
  }
  return out;
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));
  const token = process.env.OPENWOP_SUBSCRIPTION_SHIM_TOKEN?.trim() || null;

  // Read-only readiness: warn about providers with no detected login.
  const detected = [];
  for (const provider of Object.keys(SUPPORTED_HARNESSES)) {
    const ok = subscriptionLoginDetected(provider);
    if (ok) detected.push(provider);
    else process.stderr.write(`[subscription-provider] no login detected for ${provider} (${SUPPORTED_HARNESSES[provider].harness}); run its login first.\n`);
  }

  const { port: bound } = await startServer({ port, ...(token ? { token } : {}) });
  process.stdout.write(
    `[subscription-provider] listening on http://127.0.0.1:${bound}\n` +
    `  OpenAI-chat:        POST http://127.0.0.1:${bound}/v1/chat/completions (openai → codex)\n` +
    `  Wire into the SELF-HOSTED backend: OPENWOP_SUBSCRIPTION_ENDPOINT=http://127.0.0.1:${bound}\n` +
    `  Detected logins: ${detected.length ? detected.join(', ') : 'none — log into codex first'}\n` +
    (token ? '  Shared token: required (OPENWOP_SUBSCRIPTION_SHIM_TOKEN set)\n' : '  Loopback-only; no shared token set.\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`[subscription-provider] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
