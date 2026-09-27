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
 * from a free-port probe or `server.address()`, a numeric port var that is
 * never `.listen()`-ed (createApp cosmetic config), and an env-overridable
 * default (`Number(process.env.X ?? 18081)` — a caller can always move it).
 *
 * SCOPE WIDENED TO `conformance/` (H17). This gate existed and had exactly the
 * right rule, and it did not catch `conformance/run.ts`'s `const PORT = 18080;`
 * + `app.listen(PORT)` — the textbook vector-2 shape — for one reason: it only
 * ever read `test/`. `scripts/ci.sh` runs `npm run test:conformance` inside
 * `npm run ci`, so two worktrees gating at once raced the same socket and the
 * loser's gate died with EADDRINUSE mid-run, reading as a real break. The
 * cross-PROCESS collision is the same defect as the cross-FILE one this gate was
 * built for; only the directory differed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** Every file this gate reads, as `<label>` → absolute path. */
const scanned = [
  ...readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => [`test/${f}`, join(ROOT, 'test', f)]),
  ...readdirSync(join(ROOT, 'conformance'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [`conformance/${f}`, join(ROOT, 'conformance', f)]),
];

const violations = [];
for (const [file, path] of scanned) {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');

  // Vector 1: a non-zero numeric literal bound directly.
  lines.forEach((line, i) => {
    const m = /\.listen\(\s*([0-9]+)\b/.exec(line);
    if (m && m[1] !== '0') {
      violations.push(`${file}:${i + 1}  literal port in .listen(${m[1]}) — use .listen(0) and read server.address()`);
    }
  });

  // Vector 3 (H41, 2026-08-17): an ephemeral listen on the WILDCARD address.
  // `.listen(0)` / `.listen(0, cb)` binds `[::]` (dual-stack), and the tests
  // then fetch `http://127.0.0.1:<port>`. On macOS a process bound specifically
  // to `127.0.0.1:P` coexists with a `[::]:P` wildcard and WINS v4 connections
  // — so when the kernel hands the test a port some resident daemon holds on
  // loopback v4, the fetch reaches the daemon. MEASURED 2026-08-17: Grammarly
  // Desktop held a TLS listener on 127.0.0.1:49473 for a day; four different
  // test files "flaked" with `HTTPParserError … data: <15 03 03 00 02 02 32>`
  // (a TLS alert, byte-identical to `nc 127.0.0.1 49473`), each "passing
  // alone" — ~(listens per gate)/16384 ≈ 3.5% of full gates. Binding to
  // '127.0.0.1' makes the kernel pick a port free ON LOOPBACK V4, so the
  // collision is impossible by construction. Allowed: `.listen(0, '127.0.0.1'`
  // (and any explicit host string); flagged: `.listen(0)` and `.listen(0, <cb>)`.
  lines.forEach((line, i) => {
    // A second argument that is a quoted string, or an identifier that NAMES a
    // host (`bind`, `host`, `addr…`), is an explicit address; anything else in
    // that position (`() =>`, `res`, `resolve`, `r`) is the callback, i.e. the
    // wildcard form.
    const m3 = /\.listen\(\s*0\s*(\)|,\s*([^\s,)]+))/.exec(line);
    if (m3 && (m3[1] === ')' || !/^(['"]|.*(bind|host|addr))/i.test(m3[2] ?? ''))) {
      violations.push(`${file}:${i + 1}  .listen(0, …) binds the [::] wildcard — bind loopback v4 explicitly: .listen(0, '127.0.0.1', …) (H41: a resident 127.0.0.1 TLS listener on the same port answers the test's fetch)`);
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
console.log(`✓ check-test-ports: no hard-coded test ports (${scanned.length} file(s) scanned, test/ + conformance/)`);
