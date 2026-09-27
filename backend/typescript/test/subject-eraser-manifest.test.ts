/**
 * WF-CONS-2 — a never-imported eraser must not read as `failed: 0`.
 *
 * `eraseSubject` reported `total: erasers.length` — a REGISTRATION-ORDER
 * artifact — against no expected set, and every caller's success test is
 * `failed === 0`. An eraser whose module was never imported contributed to
 * NEITHER number, so a never-registered feature was indistinguishable from a
 * cleanly-erased one: the subject's data stays and the operator is told the
 * erasure completed. `host/applyGrant.ts` was the LIVE instance — the one host
 * eraser registering at module scope, outside `hostSubjectErasers.ts`'s explicit
 * boot list, while the ADR 0464 coverage ledger claimed the two stores it owns
 * were covered by it.
 *
 * THREE LAYERS, because each closes a hole the others structurally cannot see:
 *
 *  1. SOURCE PIN — the manifest is re-derived here from every
 *     `registerSubjectEraser(` call site. Adding an eraser without adding a
 *     manifest entry fails. This catches manifest drift, and nothing else.
 *  2. BOOT PIN — a REAL `createApp()` boot, asserted against the manifest. This
 *     is the layer source-scanning cannot provide: an eraser present in source
 *     but never IMPORTED is invisible to (1) and fails here. The assessment's
 *     exact words: "No test asserts a real `createApp` boot yields the expected
 *     eraser count."
 *  3. RUNTIME — `eraseSubject` returns `missing` and counts it in `failed`, so
 *     a gap that somehow reaches production is a typed failure on the DSAR
 *     rather than a silent success.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_SUBJECT_ERASERS } from '../src/host/subjectEraserManifest.js';
import {
  registeredSubjectEraserIds, missingSubjectErasers, registerSubjectEraser, __isSyntheticEraserRegistry,
} from '../src/host/subjectErasure.js';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/** Comments are not code (the repo's KB-3 lesson) — a commented-out
 *  registration must not count as one. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every `registerSubjectEraser(<name>)` id declared in source. */
function idsFromSource(): Set<string> {
  const out = new Set<string>();
  const RE = /registerSubjectEraser\(\s*(?:async\s+function\s+)?([A-Za-z_$][\w$]*)/g;
  for (const file of walk(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (file.endsWith(join('host', 'subjectErasure.ts'))) continue; // the definition, not a registration
    for (const m of src.matchAll(RE)) out.add(m[1]!);
  }
  return out;
}

describe('WF-CONS-2 — the subject-eraser expected set', () => {
  it('LAYER 1: the manifest equals what source declares (it cannot drift silently)', () => {
    const derived = idsFromSource();
    // Non-vacuity FIRST: a broken walker or regex would make both sides empty
    // and the equality below would pass over nothing.
    expect(derived.size, 'the source scan must find the real population').toBeGreaterThanOrEqual(70);
    expect(derived.has('eraseSubjectApplyGrants'), 'the LIVE instance this finding named').toBe(true);
    expect(derived.has('eraseSalesCommissionsSubject'), 'the eraser that had to be NAMED to be visible').toBe(true);
    expect([...derived].sort()).toEqual([...EXPECTED_SUBJECT_ERASERS].sort());
  });

  it('the registry refuses an ANONYMOUS eraser (unreportable + manifest-invisible)', () => {
    expect(() => registerSubjectEraser(Object.defineProperty(async () => {}, 'name', { value: '' })))
      .toThrow(/NAMED/);
  });
});

describe('WF-CONS-2 — LAYER 2: a real boot registers every expected eraser', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const { createApp } = await import('../src/index.js');
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });

  it('nothing in the manifest is missing after createApp()', () => {
    // NON-VACUITY: `missingSubjectErasers()` returns [] unconditionally once a
    // test seam has emptied the registry. If anything in this file (or a future
    // edit to it) reset the registry, the assertion below would pass over
    // nothing at all — which is the exact vacuity shape WF-CONS-10 names.
    expect(__isSyntheticEraserRegistry(), 'this suite must assert against the REAL boot registry').toBe(false);
    // The whole point: an eraser declared in source but never IMPORTED reaches
    // this assertion and no other. Before this existed, `applyGrant`'s
    // module-scope registration could have been dropped by any import-graph
    // change and the fan-out would still have reported `failed: 0`.
    expect(missingSubjectErasers()).toEqual([]);
    const live = new Set(registeredSubjectEraserIds());
    for (const id of EXPECTED_SUBJECT_ERASERS) expect(live.has(id), `${id} was never registered at boot`).toBe(true);
  });

  it('the live registry declares no eraser the manifest does not know about', () => {
    // The other direction: an eraser added at runtime (or by a module the
    // manifest was never updated for) is an UNTRACKED erasure, which is a
    // different problem from a missing one but is equally invisible.
    const unexpected = registeredSubjectEraserIds().filter((id) => !EXPECTED_SUBJECT_ERASERS.has(id));
    expect(unexpected).toEqual([]);
  });
});

describe('WF-CONS-2 — LAYER 3: a missing eraser is a TYPED FAILURE on the DSAR itself', () => {
  it('eraseSubject counts and NAMES an expected-but-unregistered eraser', async () => {
    // A real (non-synthetic) registry with exactly one manifest entry removed is
    // the production shape of this defect: the module was never imported. Built
    // by monkey-patching the manifest rather than the registry, because
    // `__resetSubjectErasers()` would mark the registry synthetic and suppress
    // the very check under test.
    const { EXPECTED_SUBJECT_ERASERS: manifest } = await import('../src/host/subjectEraserManifest.js');
    const { eraseSubject, registeredSubjectEraserIds: liveIds } = await import('../src/host/subjectErasure.js');
    const live = liveIds();
    expect(live.length, 'this case needs the REAL boot registry').toBeGreaterThan(50);

    const ghost = '__eraserThatWasNeverImported';
    (manifest as Set<string>).add(ghost);
    try {
      const out = await eraseSubject('t-missing-eraser', 'nobody');
      expect(out.missing).toContain(ghost);
      // It COUNTS — on `origin/main` a never-registered eraser contributed to
      // neither `total` nor `failed`, so `failed === 0` and the operator was
      // told the erasure completed.
      expect(out.failed).toBeGreaterThan(0);
      // …and it is NAMED, so the operator has something to escalate with, and
      // distinguishable from an eraser that ran and threw.
      expect(out.failedFeatures.some((f) => f.includes(ghost) && f.includes('never registered'))).toBe(true);
      // The denominator does not shrink to hide it.
      expect(out.total).toBe(live.length + out.missing.length);
    } finally {
      (manifest as Set<string>).delete(ghost);
    }
  });
});
