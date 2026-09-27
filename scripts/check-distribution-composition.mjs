#!/usr/bin/env node
/**
 * Distribution composition gate — assert that a named distribution still SHIPS
 * the features it exists to ship.
 *
 * `gen-distribution.mjs --check` validates that every manifest is well-formed
 * and closure-clean. It cannot tell you that a manifest is *wrong*: a manifest
 * that silently drops the entire product it is named after is perfectly valid.
 * That is exactly what happened — `distributions/kicktodo.json` listed only the
 * nine BACKEND KickTodo ids, so all six FRONTEND modules tree-shook out and
 * every KickTodo build shipped without its participant UI. `--check` was green
 * throughout, because nothing was malformed.
 *
 * So this asserts the other direction: for each named distribution, a set of
 * feature ids that MUST survive. Registry-level rather than build-level on
 * purpose — the defect lives in the manifest -> registry step, a full build adds
 * only bundler behaviour, and a check that costs a build gets moved out of the
 * default lane, which is how it stops running at all.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-distribution.mjs';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** distribution -> feature ids that MUST survive, with WHY. Grow this whenever a
 *  distribution loses something it should have kept; never shrink it to make a
 *  red go away. */
const REQUIRED = {
  kicktodo: {
    // The six FRONTEND modules. Their absence is the defect this file exists for:
    // no participant UI, no `/kicktodo/today`, and a green `--check`.
    kicktodo: 'the participant surfaces — /kicktodo/today, plan, discover, progress, journal, guide',
    'kicktodo-circles': 'accountability circles',
    'kicktodo-studio': 'Creator Studio',
    'kicktodo-admin': 'operator console',
    'kicktodo-org-programs': 'org programs',
    'kicktodo-seats': 'seat management',
    // The delegated owners. KickTodo stores provenance and references rather
    // than duplicating file/document/vector stores (PRD §9.7), so Creator Studio
    // has nothing to delegate to if these leave the build.
    documents: 'Creator Studio source ingestion (PRD §5, §6.1)',
    notebooks: 'research sources (PRD §9.7, §7.4)',
    podcasts: 'audio pack reuse (PRD §7.4)',
    // Campaigns. `campaign-studio` renders a `canvas.campaign` artifact that only
    // the campaign features can emit — shipping it without them is a dead surface.
    campaigns: 'marketing the challenges',
    'campaign-studio': 'the ADR 0153 campaign canvas — needs campaigns present to have an emitter',
  },
};

/** Every id registered in either canonical registry. */
function registeredFeatureIds() {
  const ids = new Set();
  for (const f of ['backend/typescript/src/features/index.ts', 'frontend/react/src/features/registry.ts']) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/import \{ (\w+)Feature \}/g)) {
      ids.add(m[1].replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`));
    }
  }
  return ids;
}

export function checkDistributionComposition() {
  const errors = [];
  const registered = registeredFeatureIds();

  for (const [distribution, required] of Object.entries(REQUIRED)) {
    // A required id that is not registered can never be found in a filtered
    // registry either — so without this the expectation would silently pass
    // through as "absent, but it's absent everywhere". A typo here would make
    // the gate assert nothing, which is the failure mode this repo keeps hitting.
    for (const id of Object.keys(required)) {
      if (!registered.has(id)) {
        errors.push(`${distribution}: required feature '${id}' is not registered in either registry — typo, or the feature was deleted (fix the id or drop the expectation deliberately)`);
      }
    }

    const result = generate(distribution, { write: false });
    // An empty exclude list means the checked-in registries ARE the build, so
    // everything registered survives and there is nothing to assert.
    if (!result.generated) continue;

    // `generate()` reports the ids it FILTERED OUT of each registry. Asserting
    // against that set rather than against the generated source keeps this gate
    // independent of how the source is delivered (file, string, or neither).
    const excluded = new Set([...result.excludedBackend, ...result.excludedFrontend]);
    for (const [id, why] of Object.entries(required)) {
      if (!registered.has(id)) continue; // already reported above
      if (excluded.has(id)) {
        errors.push(`${distribution}: '${id}' is EXCLUDED but must ship — ${why}`);
      }
    }
  }
  return errors;
}

if (isEntryModule(import.meta.url)) {
  const errors = checkDistributionComposition();
  if (errors.length > 0) {
    console.error('distribution composition invalid:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  const n = Object.values(REQUIRED).reduce((a, r) => a + Object.keys(r).length, 0);
  console.log(`✓ check-distribution-composition: ${n} required feature(s) survive across ${Object.keys(REQUIRED).length} named distribution(s).`);
}
