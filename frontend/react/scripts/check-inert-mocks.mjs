#!/usr/bin/env node
/**
 * INERT `vi.mock` override — ZERO gate.
 *
 * THE DEFECT. A `vi.mock` factory key that the target module does not export
 * overrides nothing. The import the component actually uses resolves to the REAL
 * module, so a test that believes it stubbed a read is making a real one. Vitest
 * cannot warn: a factory returning extra properties is legal, and the spread of
 * `importOriginal()` supplies the genuine implementation right next to the dead
 * override. The test still passes — for the wrong reason — until timing shifts.
 *
 * THE CASE THAT PROVED IT (fixed alongside this gate).
 * `features/crm/__tests__/secondaryReadHonesty.test.tsx` listed `listGmailSyncs`
 * in its `../crmClient.js` mock. `listGmailSyncs` lives in `gmailSyncClient.ts`,
 * and `GmailSyncTab` imports it from there — so the override was dead and every
 * run performed a real `fetch`. In jsdom that rejects with "fetch failed", which
 * set the component's error state and rendered a SECOND retry button, so
 * `getByRole('button', {name:/retry/i})` threw "Found multiple elements" whenever
 * the rejection landed before the assertion.
 *
 * MEASURED: 3/10 failures running that one file ALONE; 0/12 after pointing the
 * mock at the right module. It had been attributed to full-suite worker
 * contention — but it reproduced solo, so contention was never needed to explain
 * it. A test can be intrinsically racy and still look like environmental flake,
 * and "passes in isolation" proves nothing when the flake rate is ~30% and you
 * only ran isolation ONCE.
 *
 * WHY THE GATE IS ZERO, NOT A RATCHET. An inert override has no legitimate use:
 * it is always either a typo, a moved export, or a stale key left behind when a
 * module was split. Unlike the count-based gates in this directory, there is no
 * honest population to preserve.
 *
 * SCOPE / KNOWN LIMITS, stated because a gate that overstates its reach is worse
 * than none:
 *  - Relative specifiers only. A package mock (`vi.mock('react-i18next')`) has no
 *    file to resolve, so it is skipped rather than guessed at.
 *  - Keys are read at the factory object's TOP level, outside parentheses, with
 *    comments stripped. Earlier drafts without those two rules reported
 *    parameter annotations (`opts: SubOpts`) and prose (`bug:` in a comment) as
 *    missing exports — 117 findings, nearly all false. If this ever fires on
 *    something that IS exported, suspect the export-detection regexes below
 *    before editing the test.
 *  - Export detection is textual (`export function|const|let|class`, an
 *    `export { … }` list, `as <name>`, `export type|interface|enum`). A module
 *    that re-exports via `export * from` will NOT be seen, so such a key would
 *    be reported. None exist today; if one appears, widen this, do not silence it.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Test files under src/. `git ls-files` is exact in a working copy, but the
 *  white-label bundle is a `git archive` extraction with NO `.git`, where it
 *  dies (`fatal: not a git repository`) and takes the adopter's `npm run build`
 *  down with it. Fall back to walking the tree — same file set, no git needed.
 *  Deliberately a FALLBACK, not a replacement: in a working copy `git ls-files`
 *  keeps honouring .gitignore, so untracked scratch tests stay out of the scan. */
function walkTests(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTests(p));
    else if (/\.test\.tsx?$/.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

let files;
try {
  files = execSync("git ls-files 'src/**/*.test.tsx' 'src/**/*.test.ts'", { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(Boolean);
} catch {
  files = walkTests(join(ROOT, 'src'));
}

/** Blank out comments (preserving newlines) so prose cannot look like a key. */
function stripComments(s) {
  let out = '', i = 0, inStr = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) { if (c === inStr && s[i - 1] !== '\\') inStr = null; out += c; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Slice from `start` (index of `(`) to its matching `)`, so each vi.mock call
 *  is paired with ITS OWN factory rather than a neighbour's. */
function balanced(src, start) {
  let depth = 0, inStr = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i], p = src[i - 1];
    if (inStr) { if (c === inStr && p !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const resolveTarget = (fromFile, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(resolve(ROOT, fromFile)), spec).replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext)) return base + ext;
  return null;
};

const exportsKey = (targetSrc, key) =>
  new RegExp(`export\\s+(async\\s+)?(function|const|let|class)\\s+${key}\\b`).test(targetSrc) ||
  new RegExp(`export\\s*\\{[^}]*\\b${key}\\b[^}]*\\}`).test(targetSrc) ||
  new RegExp(`\\bas\\s+${key}\\b`).test(targetSrc) ||
  new RegExp(`export\\s+(type|interface|enum)\\s+${key}\\b`).test(targetSrc) ||
  (key === 'default' && /export\s+default\b/.test(targetSrc));

const findings = [];
let mocksChecked = 0;

for (const rel of files) {
  const src = stripComments(readFileSync(resolve(ROOT, rel), 'utf8'));
  for (const m of [...src.matchAll(/vi\.mock\s*\(/g)]) {
    const call = balanced(src, m.index + m[0].length - 1);
    if (!call) continue;
    const specM = call.match(/^\(\s*['"]([^'"]+)['"]/);
    if (!specM) continue;
    const target = resolveTarget(rel, specM[1]);
    if (!target) continue;
    mocksChecked++;
    const targetSrc = readFileSync(target, 'utf8');
    const bodyStart = call.indexOf('{', call.indexOf(','));
    if (bodyStart < 0) continue;
    let depth = 0, paren = 0, inStr = null;
    for (let i = bodyStart; i < call.length; i++) {
      const c = call[i], p = call[i - 1];
      if (inStr) { if (c === inStr && p !== '\\') inStr = null; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '(') { paren++; continue; }
      if (c === ')') { paren--; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 1 && paren === 0) {
        const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(call.slice(i));
        if (km && /[{,\s]/.test(p ?? '')) {
          if (!exportsKey(targetSrc, km[1])) {
            findings.push({ rel, spec: specM[1], key: km[1], target: target.replace(ROOT + '/', '') });
          }
          i += km[0].length - 1;
        }
      }
    }
  }
}

if (findings.length) {
  console.error(`✗ check-inert-mocks: ${findings.length} vi.mock override(s) the target module does not export.`);
  console.error('  Each one is DEAD — the component uses the real implementation, so a "mocked" read can hit the network.');
  for (const f of findings) {
    console.error(`\n  ${f.rel}`);
    console.error(`    vi.mock('${f.spec}') overrides '${f.key}', not exported by ${f.target}`);
    console.error(`    → mock the module that really exports '${f.key}', or delete the key.`);
  }
  process.exit(1);
}

console.log(`✓ check-inert-mocks: every vi.mock override resolves to a real export (${mocksChecked} relative mocks across ${files.length} test files).`);
