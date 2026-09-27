#!/usr/bin/env node

/**
 * Refuse a deploy when the conformance package installed in node_modules is
 * not the exact version resolved by package-lock.json.
 *
 * The certification bundle and contractProvenance.suiteVersion are derived
 * from the INSTALLED package. Merely checking that the directory exists lets a
 * long-lived deploy checkout certify with an old suite and stamp that old
 * version into a new image. `npm ci` is the repair; deploy must never guess.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const backend = resolve(root, 'backend/typescript');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

try {
  const lock = readJson(resolve(backend, 'package-lock.json'));
  const expected = lock.packages?.['node_modules/@openwop/openwop-conformance']?.version;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error('package-lock.json has no resolved @openwop/openwop-conformance version');
  }

  const installed = readJson(resolve(backend, 'node_modules/@openwop/openwop-conformance/package.json')).version;
  if (installed !== expected) {
    console.error(`deploy: stale backend dependencies — @openwop/openwop-conformance is ${installed}, lockfile resolves ${expected}.`);
    console.error('        Certification and contract provenance are derived from the installed package. Repair with:');
    console.error(`          ( cd "${backend}" && npm ci )`);
    process.exit(1);
  }

  console.log(`✓ deploy dependency parity: conformance ${installed} matches package-lock.json`);
} catch (error) {
  console.error(`deploy: cannot verify backend dependency parity — ${error instanceof Error ? error.message : String(error)}`);
  console.error(`        Repair with: ( cd "${backend}" && npm ci )`);
  process.exit(1);
}
