#!/usr/bin/env node
/**
 * Lockstep version bump (ADR 0052 §D4). Updates the ONE app version across all
 * its mirrors so `/cut-app-release` can't ship a split version:
 *   /VERSION · backend/typescript/package.json · frontend/react/package.json ·
 *   backend/typescript/src/version.ts (APP_VERSION)
 *
 * Usage: node scripts/bump-version.mjs <X.Y.Z>
 * Validates SemVer (X.Y.Z, optional -pre / +build) and writes all four in place.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error('usage: node scripts/bump-version.mjs <X.Y.Z>  (SemVer)');
  process.exit(2);
}

const p = (rel) => join(ROOT, rel);
const setJsonVersion = (rel) => {
  const j = JSON.parse(readFileSync(p(rel), 'utf8'));
  j.version = next;
  writeFileSync(p(rel), JSON.stringify(j, null, 2) + '\n');
};

writeFileSync(p('VERSION'), next + '\n');
setJsonVersion('backend/typescript/package.json');
setJsonVersion('frontend/react/package.json');
const vf = p('backend/typescript/src/version.ts');
writeFileSync(vf, readFileSync(vf, 'utf8').replace(/(APP_VERSION\s*=\s*)['"][^'"]+['"]/, `$1'${next}'`));

console.log(`✓ bumped app version → ${next} (VERSION, 2× package.json, src/version.ts)`);
