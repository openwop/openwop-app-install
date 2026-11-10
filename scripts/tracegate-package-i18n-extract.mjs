#!/usr/bin/env node
// ADR 1028 P1 — the tracegate-ci package's `keyedExtract` for this repo's i18n tables.
//
// The package hands a catalog file (`export const messages = {…}`) on stdin and wants its
// values as ONE JSON object, so it can re-run only the tests that looked up a key whose
// value changed. This reuses the fork's parser (scripts/lib/tracegate-i18n.mjs
// `flatMessages`) and prints the table NESTED, as i18next sees it: a test that read a
// whole sub-object (`nested`) then sees a change to `nested.label`. Anything the parser
// does not fully understand (a spread, an identifier, `${…}`) exits 1, which the
// package counts as a change: never a skip.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatMessages } from './lib/tracegate-i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function typescript() {
  for (const ws of ['backend/typescript', 'frontend/react']) {
    try { return createRequire(path.join(ROOT, ws, 'package.json'))('typescript'); } catch { /* next */ }
  }
  throw new Error('no TypeScript install found (npm ci in backend/typescript)');
}

/** `{ 'a.b': v }` → `{ a: { b: v } }`; null if a key is both a value and a parent. */
export function nest(flat) {
  const out = {};
  for (const [k, v] of flat) {
    const parts = k.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) {
      if (o[p] === undefined) o[p] = {};
      else if (typeof o[p] !== 'object') return null;
      o = o[p];
    }
    const last = parts[parts.length - 1];
    if (o[last] !== undefined) return null;
    o[last] = v;
  }
  return out;
}

export function extract(ts, src) {
  const flat = flatMessages(ts, src);
  return flat ? nest(flat) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let src = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { src += d; });
  process.stdin.on('end', () => {
    const out = extract(typescript(), src);
    if (!out) {
      process.stderr.write(`tracegate-package-i18n-extract: ${process.env.TRACEGATE_KEYED_FILE ?? 'stdin'} is not plain data\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  });
}
