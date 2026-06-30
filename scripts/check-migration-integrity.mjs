#!/usr/bin/env node
/**
 * Migration-integrity + version-lockstep gate (ADR 0052 §"the skill", step 4).
 *
 * Run by `/cut-app-release` BEFORE publishing. Fails (exit 1) unless:
 *  - the sqlite + postgres `MIGRATIONS` maps are CONTIGUOUS `1..LATEST_SCHEMA_VERSION`
 *    with no gaps/dupes and `max key === LATEST_SCHEMA_VERSION` (a gap means a
 *    customer mid-version can't replay forward);
 *  - the app-migration `version`s are contiguous `1..N` (or empty), no dupes;
 *  - the app version is in LOCKSTEP across `/VERSION`, both `package.json`s, and
 *    `src/version.ts` `APP_VERSION` (ADR 0052 §D4 — one SSoT, propagated).
 *
 * No deps; parses the sources textually (cheap + CI-safe).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const fail = [];

/** Extract the numeric MIGRATIONS keys between `const MIGRATIONS` and `applyMigrations`. */
function migrationKeys(src) {
  const start = src.indexOf('MIGRATIONS');
  const end = src.indexOf('applyMigrations');
  const body = src.slice(start, end > start ? end : undefined);
  return [...body.matchAll(/^\s+(\d+):\s*(?:async\s*)?\(/gm)].map((m) => Number(m[1]));
}

function checkSchema(label, file) {
  const src = read(file);
  const keys = migrationKeys(src).sort((a, b) => a - b);
  const max = keys[keys.length - 1] ?? 0;
  // `LATEST_SCHEMA_VERSION` is now DERIVED from the MIGRATIONS map
  // (`= Math.max(...Object.keys(MIGRATIONS).map(Number))`) rather than a
  // hand-bumped literal — so a "latest ≠ max migration" gap is impossible by
  // construction. Accept either form: a literal (legacy), or the derived
  // expression (latest := max key). Anything else is a real defect.
  const literal = /LATEST_SCHEMA_VERSION\s*=\s*(\d+)/.exec(src)?.[1];
  const derived = /LATEST_SCHEMA_VERSION\s*=\s*Math\.max\(\s*\.\.\.\s*Object\.keys\(\s*MIGRATIONS\s*\)/.test(src);
  const latest = literal !== undefined ? Number(literal) : derived ? max : NaN;
  if (!Number.isInteger(latest)) {
    fail.push(`${label}: LATEST_SCHEMA_VERSION not found (neither a numeric literal nor the derived Math.max(...Object.keys(MIGRATIONS)) form)`);
    return;
  }
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) fail.push(`${label}: duplicate migration keys ${[...new Set(dupes)].join(',')}`);
  for (let v = 1; v <= latest; v++) {
    if (!keys.includes(v)) fail.push(`${label}: missing migration ${v} (LATEST=${latest})`);
  }
  if (max !== latest) fail.push(`${label}: max migration ${max} ≠ LATEST_SCHEMA_VERSION ${latest}`);
  return latest;
}

const sqliteLatest = checkSchema('sqlite', 'backend/typescript/src/storage/sqlite/schema.ts');
checkSchema('postgres', 'backend/typescript/src/storage/postgres/schema.ts');

// App migrations contiguous 1..N (or empty).
const appSrc = read('backend/typescript/src/host/appMigrations.ts');
const appBody = appSrc.slice(appSrc.indexOf('APP_MIGRATIONS'));
const appVers = [...appBody.matchAll(/version:\s*(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
appVers.forEach((v, i) => { if (v !== i + 1) fail.push(`app-migrations: non-contiguous version ${v} at position ${i + 1}`); });

// Version lockstep (ADR 0052 §D4).
const versionFile = read('VERSION').trim();
const be = JSON.parse(read('backend/typescript/package.json')).version;
const fe = JSON.parse(read('frontend/react/package.json')).version;
const code = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read('backend/typescript/src/version.ts'))?.[1];
for (const [name, v] of [['package.json (backend)', be], ['package.json (frontend)', fe], ['src/version.ts', code]]) {
  if (v !== versionFile) fail.push(`version lockstep: ${name} is ${v}, /VERSION is ${versionFile}`);
}

if (fail.length) {
  console.error('✗ migration-integrity: FAILED\n  - ' + fail.join('\n  - '));
  process.exit(1);
}
console.log(`✓ migration-integrity: schema contiguous (sqlite LATEST=${sqliteLatest}), app-migrations contiguous (${appVers.length}), version lockstep @ ${versionFile}`);
