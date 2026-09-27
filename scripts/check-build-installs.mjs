#!/usr/bin/env node
/**
 * ZERO gate: no build config may run `npm install`. It must be `npm ci`.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * npm >= 11.5 prunes the transitive dependencies of an `optionalDependency`
 * during `npm install`. In this repo that silently drops
 * `@azure/core-rest-pipeline`, leaving the Azure Key Vault KMS backend
 * present-but-unloadable. The root `Dockerfile` carries the full A/B
 * measurement (#2680, corrected in #2696): same lockfile, same command, only
 * npm differs — 466 packages and a working `@azure/identity` on npm 10.9.8,
 * 464 packages and `ERR_MODULE_NOT_FOUND` on npm 11.6.2.
 *
 * The root Dockerfile was fixed. The other build configs were not, and nothing
 * was watching, so they stayed on `npm install` for months. Whether they
 * currently ship the broken tree is a question about which npm the base image
 * happens to bundle TODAY — i.e. it is luck, and luck expires the moment
 * `node:22-slim` bumps its bundled npm. `npm ci` makes it independent of luck:
 * it installs exactly the lockfile and fails loudly when package.json and the
 * lockfile disagree.
 *
 * ── WHY A REQUIRED-PATHS FLOOR ────────────────────────────────────────────
 *
 * A scanner whose glob matches nothing prints nothing and exits 0 — identical
 * output to a clean repo. That is the most common way a guard in this repo has
 * turned out to be inert. So this gate asserts that a named set of build
 * configs was actually READ before it is allowed to report success. If one of
 * them is renamed or moved, the gate fails and names it, rather than quietly
 * shrinking its own scope.
 *
 * ── WHAT THIS CANNOT SEE, said plainly ────────────────────────────────────
 *
 *   - It strips `#` comments before matching. A shell comment inside a `run:`
 *     block that says `npm install` is therefore invisible — deliberate, since
 *     the root Dockerfile's rationale quotes the forbidden command repeatedly.
 *     Over-stripping can only produce false NEGATIVES here, never a false pass
 *     of a real `RUN npm install`.
 *   - It is a text scan. An install assembled at runtime (`$PKG_CMD install`,
 *     a Makefile target invoked from a Dockerfile, a script the image copies
 *     in) passes. It pins the literal spellings; it is not a proof of absence.
 *   - It polices npm only. `yarn install` / `pnpm install` are not modelled
 *     because this repo has neither.
 *
 * There is no exemption mechanism on purpose. If a build config ever genuinely
 * needs `npm install`, add it here with the reason written down — a silent skip
 * list is how a zero gate becomes decorative.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Build configs that MUST exist and MUST be scanned. Not the whole scan set —
 * the walk below finds more — but the floor that makes a silent no-op
 * impossible. Every entry here is a config a deploy actually uses.
 */
export const REQUIRED = [
  'Dockerfile',                          // Cloud Run / fly / render — the live backend image
  'deploy/compose/frontend.Dockerfile',  // docker-compose.yml `web.build`
  'deploy/compose/docker-compose.yml',
  'deploy/render/render.yaml',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'test-results', 'e2e-artifacts', 'playwright-report',
]);

/** Is this a file whose contents describe how something gets BUILT? */
export function isBuildConfig(name, relPath) {
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return true;
  if (/^docker-compose.*\.ya?ml$/.test(name)) return true;
  if (name === 'render.yaml' || name === 'cloudbuild.yaml' || name === 'Procfile') return true;
  if (relPath.startsWith('.github/workflows/') && /\.ya?ml$/.test(name)) return true;
  if (relPath.startsWith('deploy/') && /\.ya?ml$/.test(name)) return true;
  return false;
}

/**
 * `base` is the path the repo-relative test in `isBuildConfig` is taken against.
 * It must be the root being WALKED, not the module-level ROOT: the first version
 * of this closed over ROOT, so the `.github/workflows/` and `deploy/` prefix arms
 * matched only when the walk happened to start at the repo. The tests caught it,
 * which is the whole reason they drive a synthetic tree.
 */
function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, base, out);
    else if (isBuildConfig(entry, relative(base, abs))) out.push(abs);
  }
  return out;
}

/** Strip `#` comments. See "what this cannot see" above. */
function stripComments(line) {
  const i = line.indexOf('#');
  return i === -1 ? line : line.slice(0, i);
}

// `npm install` / `npm i` in any form except an explicit global install, which
// installs a TOOL rather than the project's dependency closure and so is not
// what this gate is about.
const OFFENDING = /\bnpm\s+(install|i)\b(?![^\n]*(-g\b|--global\b))/;

/**
 * `root`/`required` are parameterised ONLY so the tests can drive this over a
 * synthetic tree. Nothing in the repo passes them; the defaults are the gate.
 * Without this seam the REQUIRED-floor arm could not be exercised at all, and an
 * unexercised floor is exactly the inert-guard shape this script exists to avoid.
 */
export function scan({ root = ROOT, required = REQUIRED } = {}) {
  const files = walk(root, root).sort();
  const scanned = new Set(files.map((f) => relative(root, f)));
  const findings = [];
  const missing = required.filter((p) => !scanned.has(p));

  for (const abs of files) {
    const rel = relative(root, abs);
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((raw, idx) => {
      const line = stripComments(raw);
      if (OFFENDING.test(line)) findings.push({ file: rel, line: idx + 1, text: raw.trim() });
    });
  }
  return { files: [...scanned], findings, missing };
}

function main() {
  const { files, findings, missing } = scan();

  if (missing.length > 0) {
    console.error('check-build-installs: a REQUIRED build config was not scanned.');
    for (const m of missing) console.error(`  MISSING: ${m}`);
    console.error('\n  Either the file moved (update REQUIRED in this script and say why),');
    console.error('  or the walk stopped seeing it. Until then this gate cannot report a');
    console.error('  meaningful pass, so it fails instead of printing a clean scan.');
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error('check-build-installs: a build config runs `npm install`. Use `npm ci`.');
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`);
    console.error('\n  npm >= 11.5 prunes an optionalDependency\'s transitive deps during');
    console.error('  `npm install` — in this repo that silently breaks the Azure KMS backend.');
    console.error('  `npm ci` installs exactly the lockfile. See the header of the root');
    console.error('  Dockerfile for the measured A/B.');
    process.exit(1);
  }

  console.log(`✓ check-build-installs: no \`npm install\` across ${files.length} build config(s); all ${REQUIRED.length} required config(s) scanned.`);
}

if (isEntryModule(import.meta.url)) main();
