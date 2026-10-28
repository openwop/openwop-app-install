/**
 * ADR 0889 D7 — the ONE source of the `agents.evalSuite` advertisement.
 *
 * It advertises exactly what this host implements. The RFC 0244 facets
 * (`trajectory`, `trials`, `fixtureMatching`, `regressionVerdict`) are added
 * ONLY when the VENDORED v2 schemas carry them: the closed v2 `agents` record
 * rejects an unknown member, so advertising ahead of the schema sync would red
 * this host's own certified cut. The same switch decides whether RFC 0244
 * fields go on the wire at all (events + summary), so advert and wire move
 * together.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../_repoPath.js';
import { IMPLEMENTED_MODES, MAX_COST_USD_PER_SUITE, MAX_TASKS_PER_SUITE, MAX_TRIALS } from './suiteStore.js';

let cached: boolean | undefined;

/** True iff the vendored v2 schemas carry the RFC 0244 wire (evalScored.trialIndex + the trials facet). */
export function rfc0244WireAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    // ESM: no `__dirname` (a ReferenceError here was swallowed by the catch and
    // read as "no wire" — caught by the conformance lane, now pinned by a test).
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const payloads = JSON.parse(readFileSync(join(dir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as {
      $defs?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const caps = readFileSync(join(dir, 'v2', 'capabilities.schema.json'), 'utf8');
    cached = !!payloads.$defs?.evalScored?.properties?.trialIndex && /"regressionVerdict"/.test(caps);
  } catch {
    cached = false;
  }
  return cached;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0244WireCache(force?: boolean): void {
  cached = force;
}

let cached0245: boolean | undefined;

/**
 * True iff the vendored v2 schemas carry RFC 0245: `toolResponses[].isError` in
 * the suite schema and `agents.evalSuite.fixtureErrors` in capabilities. The v2
 * `agents` record is closed, so advertising ahead of the schema sync would red
 * this host's own certified cut (the ADR 0889 D7 rule).
 */
export function rfc0245WireAvailable(): boolean {
  if (cached0245 !== undefined) return cached0245;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const suite = readFileSync(join(dir, 'v2', 'agent-eval-suite.schema.json'), 'utf8');
    const caps = readFileSync(join(dir, 'v2', 'capabilities.schema.json'), 'utf8');
    cached0245 = /"isError"/.test(suite) && /"fixtureErrors"/.test(caps);
  } catch {
    cached0245 = false;
  }
  return cached0245;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0245WireCache(force?: boolean): void {
  cached0245 = force;
}

let cached0251: boolean | undefined;

/**
 * ADR 0983 D5 — true iff the vendored v2 capabilities schema defines RFC 0251's
 * `agents.evalSuite.baselineSelection`. The facet is closed, so it is advertised
 * only once the pin that carries it is vendored (the RFC 0245 precedent above).
 */
export function rfc0251WireAvailable(): boolean {
  if (cached0251 !== undefined) return cached0251;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    cached0251 = /"baselineSelection"/.test(readFileSync(join(dir, 'v2', 'capabilities.schema.json'), 'utf8'));
  } catch {
    cached0251 = false;
  }
  return cached0251;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0251WireCache(force?: boolean): void {
  cached0251 = force;
}

let cachedGated: boolean | undefined;

/**
 * True iff the vendored `eval-summary` schema defines the RFC 0246 §D members
 * (`gatedScore`, `gatedAggregateScore`). The schema is closed, so the host emits
 * them only once the pin that carries them is vendored (RFC 0244/0247 precedent).
 */
export function rfc0246FieldsAvailable(): boolean {
  if (cachedGated !== undefined) return cachedGated;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const summary = readFileSync(join(dir, 'v2', 'eval-summary.schema.json'), 'utf8');
    cachedGated = /"gatedScore"/.test(summary) && /"gatedAggregateScore"/.test(summary);
  } catch {
    cachedGated = false;
  }
  return cachedGated;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0246FieldsCache(force?: boolean): void {
  cachedGated = force;
}

let cached0252: boolean | undefined;

/**
 * True iff the vendored v2 schemas carry RFC 0252: `agents.evalSuite.recordedFixtures`
 * in capabilities and `fixtureRuns` on `eval.started`. Both are closed, so the
 * host accepts `fixtureRuns`, echoes it and advertises the member only once the
 * pin that carries them is vendored (the ADR 0889 D7 rule; ADR 0984).
 */
export function rfc0252WireAvailable(): boolean {
  if (cached0252 !== undefined) return cached0252;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const payloads = JSON.parse(readFileSync(join(dir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as {
      $defs?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const caps = readFileSync(join(dir, 'v2', 'capabilities.schema.json'), 'utf8');
    cached0252 = !!payloads.$defs?.evalStarted?.properties?.fixtureRuns && /"recordedFixtures"/.test(caps);
  } catch {
    cached0252 = false;
  }
  return cached0252;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0252WireCache(force?: boolean): void {
  cached0252 = force;
}

export interface EvalSuiteCapability {
  modes: string[];
  maxTasksPerSuite: number;
  maxCostUsdPerSuite: number;
  trajectory?: true;
  trials?: { maxTrials: number };
  fixtureMatching?: true;
  regressionVerdict?: true;
  fixtureErrors?: true;
  baselineSelection?: true;
  recordedFixtures?: true;
}

export function evalSuiteCapability(): EvalSuiteCapability {
  const base: EvalSuiteCapability = {
    modes: [...IMPLEMENTED_MODES],
    maxTasksPerSuite: MAX_TASKS_PER_SUITE,
    maxCostUsdPerSuite: MAX_COST_USD_PER_SUITE,
  };
  if (!rfc0244WireAvailable()) return base;
  return {
    ...base, trajectory: true, trials: { maxTrials: MAX_TRIALS }, fixtureMatching: true, regressionVerdict: true,
    // RFC 0245 §C (ADR 0929) — advertised only once the vendored schemas carry it.
    ...(rfc0245WireAvailable() ? { fixtureErrors: true as const } : {}),
    // RFC 0251 (ADR 0983) — root `evalModes` / `baselineRunId` on an eval create.
    ...(rfc0251WireAvailable() ? { baselineSelection: true as const } : {}),
    // RFC 0252 §A (ADR 0984) — requires fixtureMatching, which this branch always carries.
    ...(rfc0252WireAvailable() ? { recordedFixtures: true as const } : {}),
  };
}
