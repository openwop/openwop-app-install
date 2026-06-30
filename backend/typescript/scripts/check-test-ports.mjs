#!/usr/bin/env node
/**
 * Test-port hygiene gate — prevents the cross-file EADDRINUSE flake from
 * coming back.
 *
 * vitest's forks pool runs test FILES in parallel processes. If two files bind
 * the SAME hard-coded OS port, they race for the socket and the loser fails
 * with EADDRINUSE — nondeterministically, so a different file fails on each
 * full run while every file passes in isolation. We killed this by binding
 * `app.listen(0)` (OS-assigned free port) and reading the real port from
 * `server.address()`. This gate keeps it dead.
 *
 * A test MUST NOT bind a hard-coded port. Two forbidden shapes:
 *   1. a non-zero numeric literal passed to `.listen(...)`, e.g. `app.listen(18831)`
 *   2. a `const PORT = <number>` (any *PORT* / *port* name) that is then bound
 *      via `.listen(PORT)` in the same file
 *
 * Allowed: `.listen(0, ...)` (ephemeral), `.listen(port)` where `port` comes
 * from a free-port probe or `server.address()`, and a numeric port var that is
 * never `.listen()`-ed (createApp cosmetic config).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, '..', 'test');

const violations = [];
for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'))) {
  const src = readFileSync(join(TEST_DIR, file), 'utf8');
  const lines = src.split('\n');

  // Vector 1: a non-zero numeric literal bound directly.
  lines.forEach((line, i) => {
    const m = /\.listen\(\s*([0-9]+)\b/.exec(line);
    if (m && m[1] !== '0') {
      violations.push(`${file}:${i + 1}  literal port in .listen(${m[1]}) — use .listen(0) and read server.address()`);
    }
  });

  // Vector 2: a hard-coded port const that is actually bound via .listen(VAR).
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[0-9]+\s*;/g)) {
    const varName = m[1];
    if (!/port/i.test(varName)) continue;
    const boundRe = new RegExp(`\\.listen\\(\\s*${varName}\\b`);
    if (boundRe.test(src)) {
      violations.push(`${file}  \`${varName}\` is a hard-coded port bound via .listen(${varName}) — derive it from a free-port probe or .listen(0)`);
    }
  }
}

if (violations.length > 0) {
  console.error('✗ check-test-ports: hard-coded test ports found (cross-file EADDRINUSE flake risk):\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). See scripts/check-test-ports.mjs for the rationale.`);
  process.exit(1);
}
console.log('✓ check-test-ports: no hard-coded test ports');
