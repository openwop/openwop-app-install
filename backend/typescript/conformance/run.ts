/**
 * Conformance harness — boots the sample backend in-process and runs
 * `@openwop/openwop-conformance` against it.
 *
 * Usage:
 *   npm run test:conformance           # boots in-process, runs full suite
 *   npm run test:conformance -- --filter discovery   # subset
 *
 * Exit code is the conformance CLI's exit code. CI gates on this.
 *
 * Honest expectations: this sample stubs more than the postgres
 * reference host (no Ed25519 audit chain, no durable webhook queue,
 * no production-profile claim). The pass-matrix in the README
 * documents which scenarios skip-equivalent and why.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp, loadConfigFromEnv } from '../src/index.js';

const PORT = 18080;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.OPENWOP_CONFORMANCE_API_KEY ?? 'sample-conformance-token';

async function main(): Promise<void> {
  // Boot in-process. Use the in-memory storage backend so the suite
  // gets a clean slate per process. Wire the conformance API key into
  // the BE's auth allowlist so authed requests succeed.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.PORT = String(PORT);
  process.env.OPENWOP_API_KEY = API_KEY;
  // Conformance-only env. Both flags are spec-aligned for a black-box
  // suite run; production deploys NEVER set these.
  // - RATELIMIT_DISABLED: the suite issues 1200+ requests in a short
  //   window. The sample's per-IP rate limiter (60 req/min default)
  //   would otherwise 429-cascade and mask real failures.
  // - AUTH_DISABLE_COOKIES: the suite asserts 401 on missing
  //   credentials per `auth.md §3`. Default behavior auto-issues an
  //   anon session cookie, which silently grants access and shifts
  //   the 401 to a 200/201.
  process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Test seam needs enabling for envelope/accept, capability-toggle,
  // llm-prompt-wrap, and the variables mutation seam.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';

  // RFC 0108 / ADR 0121 — stand up a reachable mock compat (OpenAI-compatible)
  // endpoint so the `aiproviders-selfhosted-honesty` scenario is NON-VACUOUS: it
  // dispatches against the advertised `compat` id and asserts it reaches a real
  // endpoint (succeed OR transport-error, NOT capability_not_provided), and that
  // the endpoint URL never leaks (§D). The mock is loopback, so private egress is
  // allowed for this conformance run only. This is the host-witness step of the
  // RFC 0108 accept cycle; production NEVER sets these.
  const compatMock = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'conformance-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
    s.write('data: [DONE]\n\n');
    s.end();
  });
  await new Promise<void>((res) => compatMock.listen(0, '127.0.0.1', () => res()));
  const compatPort = (compatMock.address() as AddressInfo).port;
  process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
  process.env.OPENWOP_TEST_COMPAT_ENDPOINT = `http://127.0.0.1:${compatPort}/v1`;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // the mock is on loopback
  process.env.OPENWOP_REQUIRE_BEHAVIOR = 'true';      // honesty gate (RFC 0108 flip pass)
  // eslint-disable-next-line no-console
  console.log(`[conformance] compat mock at http://127.0.0.1:${compatPort}/v1 — selfHosted advertised (RFC 0108)`);

  // Full-catalog resolution. The PUBLISHED conformance package omits the
  // `spec/v1/*.md` prose (it's a test package, not the spec), so the
  // spec-corpus-validity scenarios under-register (~430 fewer cases) when the
  // suite resolves fixtures/schemas from node_modules — our Total reads ~1720 vs
  // the steward's repo-layout basis. Point OPENWOP_CONFORMANCE_ROOT at the
  // sibling `openwop` spec repo (the CLAUDE.md `../openwop` convention) when
  // present so the full corpus loads and the Total is apples-to-apples with the
  // steward (~2148 @ 1.29.0). An explicit override always wins; absent the
  // sibling we fall back to the vendored partial corpus with a loud note.
  if (!process.env.OPENWOP_CONFORMANCE_ROOT) {
    const repoRoot = resolve(process.cwd(), '..', '..');
    const siblingSpecRepo = resolve(repoRoot, '..', 'openwop');
    if (existsSync(resolve(siblingSpecRepo, 'conformance', 'fixtures'))) {
      process.env.OPENWOP_CONFORMANCE_ROOT = siblingSpecRepo;
      // eslint-disable-next-line no-console
      console.log(`[conformance] full-catalog basis: OPENWOP_CONFORMANCE_ROOT=${siblingSpecRepo}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[conformance] sibling ../openwop spec repo not found — running the VENDORED partial corpus (spec-corpus-validity under-registers; Total is NOT comparable to the steward repo-layout basis). Set OPENWOP_CONFORMANCE_ROOT to the openwop repo for a full-catalog measurement.');
    }
  }

  const app = await createApp({
    ...loadConfigFromEnv(),
    port: PORT,
    storageDsn: 'memory://',
  });

  await new Promise<void>((res) => {
    const server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[conformance] sample backend listening at ${BASE_URL}`);
      res();
      // Keep `server` referenced so it doesn't GC.
      void server;
    });
  });

  // Run the suite SERIALLY (`--no-file-parallelism`). The conformance suite
  // shares ONE in-process host whose test seam holds GLOBAL mutable state (the
  // projected event log + `POST /test/reset`). Running files in parallel lets
  // one file's reset clobber another file's projected events mid-test → false
  // failures (most visibly the envelope-reliability + engine-projection
  // scenarios, which assert exact event counts). The steward measures
  // "in-process serial"; we match it. The vendored CLI (`dist/cli.js`) silently
  // drops unknown flags, so it CANNOT forward `--no-file-parallelism` — invoke
  // vitest directly against the suite's own config instead. The only CLI
  // behaviors we rely on (filter → --testNamePattern, the --offline subset)
  // are mirrored here.
  const conformanceRoot = resolve('node_modules', '@openwop', 'openwop-conformance');
  const configPath = resolve(conformanceRoot, 'vitest.config.ts');
  const argv = process.argv.slice(2);
  const filterIdx = argv.indexOf('--filter');
  const filter = filterIdx >= 0 ? argv[filterIdx + 1] : undefined;
  const vitestArgs = ['vitest', 'run', '--config', configPath, '--no-file-parallelism'];
  if (argv.includes('--offline')) {
    vitestArgs.push('src/scenarios/fixtures-valid.test.ts', 'src/scenarios/spec-corpus-validity.test.ts');
  }
  if (filter !== undefined) vitestArgs.push('--testNamePattern', filter);
  const child = spawn('npx', vitestArgs, {
    cwd: conformanceRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENWOP_BASE_URL: BASE_URL,
      OPENWOP_API_KEY: API_KEY,
      OPENWOP_IMPLEMENTATION_NAME: 'openwop-workflow-engine',
      OPENWOP_IMPLEMENTATION_VERSION: '0.1.0',
    },
  });

  child.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.log(`[conformance] suite exited with code ${code}`);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[conformance] harness error:', err);
  process.exit(1);
});
