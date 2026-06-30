#!/usr/bin/env node
// check-vendored-schemas — drift guard for the LOAD-BEARING vendored schemas.
//
// The repo-root `schemas/` dir holds vendored copies of openwop/openwop canonical
// schemas. Most are reference-only (the backend hand-writes the matching TS types
// and merely `@see`s them) — those are refreshed best-effort via
// `scripts/sync-schemas.sh` and are NOT guarded here (guarding all ~57 would force
// a re-vendor PR on every unrelated upstream schema edit, pure churn for docs the
// app never executes).
//
// THIS guard covers only the schemas the backend actually compiles + validates
// data against at runtime (so a stale copy would mean the app mis-accepts or
// mis-rejects live data — a real bug, not cosmetic):
//
//   - schemas/ai-envelope.schema.json            (host/envelopeAcceptor.ts)
//   - schemas/envelopes/*.schema.json            (host/envelopeAcceptor.ts, per-kind)
//   - schemas/prompt-pack-manifest.schema.json   (host/promptPackLoader.ts)
//   - schemas/prompt-kind.schema.json            (   "  — manifest $ref)
//   - schemas/prompt-template.schema.json        (   "  — manifest $ref)
//   - schemas/prompt-ref.schema.json             (   "  — manifest $ref)
//   - schemas/connection-pack-manifest.schema.json (features/connections/connectionPackLoader.ts)
//
// Canonical source: the local openwop corpus (OPENWOP_CORPUS_DIR or ../openwop,
// same as sync-schemas.sh) when present; otherwise the GitHub raw `main` branch
// (OPENWOP_SPEC_RAW_BASE override) so the guard also runs in a corpus-less CI.
//
// Pure Node 20 stdlib (+ fetch). Run from repo root: `node scripts/check-vendored-schemas.mjs`.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'schemas');

// The fixed load-bearing set + the per-kind envelopes/ directory (globbed so a
// newly-added envelope kind is covered automatically).
const FIXED = [
  'ai-envelope.schema.json',
  'prompt-pack-manifest.schema.json',
  'prompt-kind.schema.json',
  'prompt-template.schema.json',
  'prompt-ref.schema.json',
  'connection-pack-manifest.schema.json',
];
const paths = FIXED.map((f) => `schemas/${f}`);
const envelopesDir = join(VENDORED, 'envelopes');
if (existsSync(envelopesDir)) {
  for (const f of readdirSync(envelopesDir)) {
    if (f.endsWith('.schema.json')) paths.push(`schemas/envelopes/${f}`);
  }
}

// Resolve the canonical source: local corpus dir wins (offline-friendly, same as
// sync-schemas.sh), else GitHub raw.
const corpusDir = process.env.OPENWOP_CORPUS_DIR ?? join(ROOT, '..', 'openwop');
const useLocal = existsSync(join(corpusDir, 'schemas'));
const rawBase = process.env.OPENWOP_SPEC_RAW_BASE ?? 'https://raw.githubusercontent.com/openwop/openwop/main';
const sourceLabel = useLocal ? `local corpus ${corpusDir}` : rawBase;

async function canonical(rel) {
  if (useLocal) {
    const p = join(corpusDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  const res = await fetch(`${rawBase}/${rel}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${rel} → HTTP ${res.status}`);
  return await res.text();
}

const drift = [];
const missing = [];
let checked = 0;

try {
  for (const rel of paths) {
    const localPath = join(ROOT, rel);
    if (!existsSync(localPath)) {
      missing.push(`${rel} (absent in app — a load-bearing schema MUST be vendored)`);
      continue;
    }
    const canon = await canonical(rel);
    if (canon === null) {
      missing.push(`${rel} (not found in canonical ${sourceLabel})`);
      continue;
    }
    // Trailing-whitespace-insensitive; any real content delta is drift.
    if (readFileSync(localPath, 'utf8').replace(/\s+$/, '') !== canon.replace(/\s+$/, '')) {
      drift.push(rel);
    }
    checked++;
  }
} catch (err) {
  // Network failure with no local corpus → can't verify. SKIP (don't block the
  // local CI gate on an infra blip); the check enforces whenever canonical is
  // reachable (a checked-out ../openwop or a working GitHub fetch).
  if (!useLocal) {
    console.warn(`check-vendored-schemas: SKIPPED — canonical unreachable (${err.message}). ` +
      `Set OPENWOP_CORPUS_DIR to a local openwop checkout to verify offline.`);
    process.exit(0);
  }
  throw err;
}

if (drift.length || missing.length) {
  console.error(`check-vendored-schemas: load-bearing vendored schemas are out of sync with canonical (${sourceLabel}).`);
  for (const d of drift) console.error(`  DRIFT:   ${d}`);
  for (const m of missing) console.error(`  MISSING: ${m}`);
  console.error(`\n  These schemas are compiled + validated at runtime — a stale copy is a real`);
  console.error(`  validation bug. Refresh with: bash scripts/sync-schemas.sh`);
  process.exit(1);
}

console.log(`check-vendored-schemas: ok — all ${checked} load-bearing vendored schema(s) match canonical (${sourceLabel}).`);
