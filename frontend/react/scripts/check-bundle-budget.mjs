#!/usr/bin/env node
/**
 * Bundle-budget gate — runs AFTER `vite build`, against `dist/assets/*.js`.
 *
 * The entry chunk is what every user downloads before the app is interactive,
 * so it gets a hard gzip ceiling. CI fails the build if it grows past budget,
 * which forces a deliberate decision (raise the budget, or code-split) rather
 * than letting first-load weight creep up silently (frontend enterprise-review
 * Batch F). A second, looser ceiling guards any single non-entry chunk.
 *
 * Budgets are gzip bytes (what the network actually transfers). Raise them
 * here, in the same PR that justifies the growth.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ASSETS = 'dist/assets';
// Entry chunk gzip ceiling. After overlay + route lazy-loading the entry is
// ~140 kB gzip; ceiling set at 160 kB to lock in the win with modest headroom.
const ENTRY_GZIP_BUDGET = 160 * 1024;
// Any single non-entry chunk gzip ceiling.
const CHUNK_GZIP_BUDGET = 260 * 1024;

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
} catch {
  console.error(`check-bundle-budget: ${ASSETS} not found — run \`vite build\` first.`);
  process.exit(1);
}

function gzipBytes(path) {
  return gzipSync(readFileSync(path)).length;
}

const kib = (n) => `${(n / 1024).toFixed(1)} kB`;
let failed = false;

for (const f of files) {
  const path = join(ASSETS, f);
  const raw = statSync(path).size;
  const gz = gzipBytes(path);
  const isEntry = f.startsWith('index-');
  const budget = isEntry ? ENTRY_GZIP_BUDGET : CHUNK_GZIP_BUDGET;
  if (gz > budget) {
    failed = true;
    console.error(
      `✗ check-bundle-budget: ${f} is ${kib(gz)} gzip (${kib(raw)} min) — over the ` +
      `${isEntry ? 'ENTRY' : 'chunk'} budget of ${kib(budget)}. Code-split or raise the budget in scripts/check-bundle-budget.mjs.`,
    );
  }
}

if (failed) process.exit(1);

const entry = files.find((f) => f.startsWith('index-'));
if (entry) {
  console.log(`✓ check-bundle-budget: entry chunk ${kib(gzipBytes(join(ASSETS, entry)))} gzip (budget ${kib(ENTRY_GZIP_BUDGET)}).`);
} else {
  console.log('✓ check-bundle-budget: no entry chunk matched index-*.js (skipped).');
}
