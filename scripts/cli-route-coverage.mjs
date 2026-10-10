#!/usr/bin/env node
/**
 * Which of this host's HTTP routes can `@openwop/cli` drive?
 *
 *   node scripts/cli-route-coverage.mjs [--cli ../openwop-cli] [--json] [--all]
 *
 * Used by the `/update-cli` skill to find the gap between what this app serves
 * and what the CLI can reach. Stdlib only; reads source, runs nothing.
 *
 * WHY THE METHOD MATTERS (measured on the 1.1.0 program, 2026-09-27): a
 * literal "does the CLI contain this exact path string" check reported ~1,130
 * gaps when the real number was ~90. Both sides build paths indirectly:
 *  - routes register through constants (`app.get(BASE, …)`,
 *    `` `${BASE}/items` ``) and the `v1('/x')` helper, so a regex over string
 *    literals misses them — they are resolved here from same-file `const`s;
 *  - the CLI composes paths from base constants (`${MESSAGING_BASE}/relay`),
 *    so a route counts as covered when EVERY static segment of it appears in
 *    ONE CLI source file (as `/seg`, `seg/`, `'seg'` or `` `seg ``). That is a
 *    heuristic — it can over-count a segment reused in an unrelated file, never
 *    under-count a composed path — so read the residue it prints.
 *
 * Excluded by default: conformance/test seams and mock routes (not operator
 * surfaces). `--all` keeps them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = path.resolve(flag('--cli') ?? path.join(repoRoot, '..', 'openwop-cli'));
const backendSrc = path.join(repoRoot, 'backend', 'typescript', 'src');
const asJson = argv.includes('--json');
const includeSeams = argv.includes('--all');

if (!fs.existsSync(path.join(cliRoot, 'src'))) {
  console.error(`No CLI checkout at ${cliRoot} (pass --cli <path to openwop-cli>).`);
  process.exit(2);
}

function walk(dir, keep, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(__tests__|node_modules)$/.test(e.name)) walk(p, keep, out); }
    else if (keep(p)) out.push(p);
  }
  return out;
}

// 1. Host routes, resolving same-file string constants.
const routes = new Map();
for (const file of walk(backendSrc, (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
  const src = fs.readFileSync(file, 'utf8');
  const consts = {};
  for (let pass = 0; pass < 3; pass++) {
    for (const m of src.matchAll(/const\s+([A-Za-z_0-9]+)\s*(?::\s*string)?\s*=\s*(['"`])([^'"`]*)\2/g)) {
      consts[m[1]] = m[3].replace(/\$\{(\w+)\}/g, (_, k) => consts[k] ?? `{${k}}`);
    }
  }
  // `v1(…)` and (ADR 0812 P3b) `vendorPath(…)` wrap a registration path; both are
  // resolved below. A migrated vendor family registers UNVERSIONED (`/host/…`).
  const re = /\.(get|post|put|patch|delete)\(\s*(?:(v1|vendorPath)\(\s*)?(?:(['"`])([^'"`]*)\3|([A-Za-z_][A-Za-z_0-9]*)\s*[,)])/g;
  for (const m of src.matchAll(re)) {
    let p = m[4] !== undefined ? m[4] : consts[m[5]];
    if (p === undefined) continue;
    p = p.replace(/\$\{(\w+)\}/g, (_, k) => consts[k] ?? `{${k}}`);
    if (!p.startsWith('/')) continue;
    if (m[2] === 'v1' && !p.startsWith('/v')) p = `/v1${p}`;
    if (m[2] === 'vendorPath') p = `/host/openwop-app${p}`;
    // Versioned paths, and (ADR 0812 P3b) the unversioned vendor space a migrated
    // family now registers on. Keyed WITHOUT the version, so a route that moved
    // from /v1 to the bare path is still the same route (counted once).
    if (!p.startsWith('/v') && !p.startsWith('/host/')) continue;
    const rel = path.relative(backendSrc, file);
    if (!includeSeams && /seam|Seam|test|conformance|mock/i.test(rel + p)) continue;
    routes.set(`${m[1].toUpperCase()} ${p.replace(/^\/v1(?=\/)/, '')}`, rel);
  }
}

// 2. CLI sources.
const cliFiles = walk(path.join(cliRoot, 'src'), (p) => p.endsWith('.ts')).map((p) => fs.readFileSync(p, 'utf8'));

// 3. Coverage: every static segment of the route (after the version + host root) in ONE CLI file.
const staticSegments = (p) => p.replace(/\?.*$/, '').replace(/^\/v[12]\//, '/').replace(/^\/host\/(openwop-app|sample)\//, '/')
  .split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{'));
const covered = (p) => {
  const segs = staticSegments(p);
  if (segs.length === 0) return true;
  return cliFiles.some((src) => segs.every((g) => src.includes(`/${g}`) || src.includes(`${g}/`) || src.includes(`'${g}'`) || src.includes(`\`${g}`)));
};

const rows = [...routes].map(([mp, file]) => { const [method, p] = mp.split(' '); return { method, path: p, file, covered: covered(p) }; });
const gaps = rows.filter((r) => !r.covered);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ routes: rows.length, covered: rows.length - gaps.length, gaps }, null, 2)}\n`);
} else {
  console.log(`${rows.length - gaps.length} of ${rows.length} host routes reachable from the CLI (${cliRoot}); ${gaps.length} not.`);
  const byFile = {};
  for (const g of gaps) (byFile[g.file] ??= []).push(`${g.method} ${g.path}`);
  for (const [file, list] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${file} (${list.length})`);
    for (const l of list) console.log(`  ${l}`);
  }
}
