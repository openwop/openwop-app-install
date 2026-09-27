/**
 * ADR 0624 D2 — the corpus-wide pack↔surface ARGUMENT-KEY parity scan.
 *
 * THE CLASS: `feature.profiles.nodes.get` sent `{ profileId }` while
 * `surface.getProfile` read `args.userId` (`UPWF-1`); `surfaceStr` coerced the
 * absent key to `''` and the node reported success-with-null for every input,
 * for six weeks, past three grade passes. Nothing on either side of the
 * pack→surface edge was wrong on its own — the KEY did not match — and no test
 * crossed the edge. This scan crosses it for every `feature.*.nodes` pack.
 *
 * SCOPED HONESTLY (the review's (f)): a literal-key scan can only judge a call
 * whose argument is an object literal WITHOUT a spread, against a surface method
 * whose parameter is READABLE (destructured, or read only as `args.<k>` /
 * `args['k']` / `(args ?? {}).<k>` / `const { k } = args`). Everything else is
 * classified, counted and PINNED — never silently excluded:
 *
 *   call sites  → literalNoSpread | spread | nonLiteral
 *   methods     → readable | opaque (the param is passed whole, spread, or
 *                 never named)
 *
 * The population counts (three call-site classes, two method classes, and the
 * asserted-pair count) are DENOMINATORS in the committed fixture
 * (`test/fixtures/pack-surface-arg-parity.json`): a shrink-only baseline that
 * could shrink by exclusion would measure nothing, so growth OR shrinkage of any
 * denominator is a reviewed diff. Counts alone are blind to a COMPENSATING move
 * (one method turning opaque while another turns readable nets to zero — review
 * S2), so the fixture also pins the excluded population BY IDENTITY:
 * `opaqueMethods` (`<surfaceId>.<method>`) and `excludedCallSites`
 * (`<pack>/index.mjs:<line> <cls> → <surfaceId>.<method>`), asserted as SET
 * equality. Parity — every key a pack SENDS is a key the surface READS — is
 * asserted on the literal × readable pairs only. Drift found in OTHER features
 * is baselined as `knownDrift` (shrink-only: a fixed row must be removed; a new
 * row is red) and filed per feature, per the ADR.
 *
 * A second drift kind, `missing-method` (review S4): a call whose method NO
 * bound surface defines — a typo'd name — is flagged in EVERY call class
 * (it used to be attributed to the single bound surface and then skipped as
 * "no method"). `pack-manifest-impl-parity.test.ts` does NOT cover this: it
 * checks pack.json `nodes[]` ↔ the `nodes` export (node type ids), never the
 * surface methods a node body calls. First corpus run: zero real packs hit it.
 *
 * REGENERATING THE FIXTURE (after a deliberate population change — never to
 * absorb drift; `knownDrift` is hand-maintained and only ever shrinks):
 *
 *   PACK_SURFACE_PARITY_WRITE=1 node node_modules/vitest/vitest.mjs run test/pack-surface-arg-parity.test.ts
 *
 * then review the fixture diff line by line — every moved denominator is a
 * claim about the corpus.
 *
 * BINDING a pack to its surface(s): the surface ids the pack names
 * (`ctx.features.<id>`, `ctx.features['<id>']`, `ensure(ctx, '<id>', …)`) plus
 * the pack's own slug, intersected with the surfaces `src/features/*\/feature.ts`
 * registers (`surface: { id, build }` → the `build` function's `return {…}`).
 * A call site is `<receiver>.<method>(…)` where `<method>` belongs to a bound
 * surface and `<receiver>` is either the `ctx.features.<id>` chain or a local
 * `const` initialised from `ctx.features…` / an `ensure…(` helper — receivers
 * the scan cannot resolve are outside its population (stated, not hidden).
 *
 * Both sides are parsed with the TypeScript compiler API (the `.mjs` packs parse
 * as JS) — a regex cannot see a wrapped literal (`a-one-line-grep-cannot-see-a-
 * wrapped-comment`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { excludedCallSiteId, opaqueMethodId, scan, type CallClass, type Fixture } from './packSurfaceParityScan.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/pack-surface-arg-parity.json');

const driftKey = (d: { kind?: string; pack: string; surfaceId: string; method: string; sent: string[] }): string => `${d.kind ?? 'unread-keys'} ${d.pack} → ${d.surfaceId}.${d.method}(${[...d.sent].sort().join(',')})`;

describe('pack↔surface argument-key parity (ADR 0624 D2)', () => {
  const s = scan();
  expect(existsSync(FIXTURE), `fixture missing: ${FIXTURE}`).toBe(true);
  const prior = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  const count = (cls: CallClass) => s.calls.filter((c) => c.cls === cls).length;
  const observed = {
    callSites: { literalNoSpread: count('literalNoSpread'), spread: count('spread'), nonLiteral: count('nonLiteral') },
    methods: { readable: s.methods.filter((m) => m.readable).length, opaque: s.methods.filter((m) => !m.readable).length },
    assertedPairs: s.assertedPairs,
    opaqueMethods: s.methods.filter((m) => !m.readable).map(opaqueMethodId).sort(),
    excludedCallSites: s.calls.filter((c) => c.cls !== 'literalNoSpread').map(excludedCallSiteId).sort(),
  };
  if (process.env.PACK_SURFACE_PARITY_WRITE === '1') {
    // Regenerate the DENOMINATORS only. `knownDrift` is hand-maintained and
    // shrink-only: rows the scan no longer observes are dropped (fixed), and a
    // NEW drift row is never absorbed here — fix the feature.
    const observedDrift = new Set(s.drift.map(driftKey));
    const next: Fixture = { ...observed, knownDrift: prior.knownDrift.filter((d) => observedDrift.has(driftKey(d))) };
    writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

  it('anti-vacuity: the scan found a real corpus on BOTH sides, and the profiles pair is inside the asserted population', () => {
    expect(s.surfaces).toBeGreaterThanOrEqual(40);
    expect(s.methods.length).toBeGreaterThanOrEqual(150);
    expect(observed.callSites.literalNoSpread).toBeGreaterThanOrEqual(100);
    expect(observed.assertedPairs).toBeGreaterThanOrEqual(50);
    const get = s.calls.find((c) => c.pack === 'feature.profiles.nodes' && c.method === 'getProfile');
    expect(get, 'feature.profiles.nodes.get → getProfile call site not found — the scan cannot see the UPWF-1 site').toBeTruthy();
    expect(get!.cls).toBe('literalNoSpread');
    expect(get!.keys).toEqual(['userId']);
    const m = s.methods.find((x) => x.surfaceId === 'profiles' && x.method === 'getProfile');
    expect(m?.readable).toBe(true);
    expect(m?.keys).toEqual(['userId']);
  });

  it('the population counts (call-site classes, method classes, asserted pairs) are PINNED denominators (growth or shrinkage is a reviewed diff)', () => {
    expect(observed.callSites, `call-site classes moved — update the fixture deliberately:\n${JSON.stringify(observed.callSites)}`).toEqual(fixture.callSites);
    expect(observed.methods, `surface-method classes moved — update the fixture deliberately:\n${JSON.stringify(observed.methods)}`).toEqual(fixture.methods);
    expect(observed.assertedPairs, `asserted literal×readable pair count moved (${observed.assertedPairs} vs ${fixture.assertedPairs})`).toBe(fixture.assertedPairs);
  });

  it('the EXCLUDED population is pinned by IDENTITY (set equality) — a compensating move cannot net to zero against the counts', () => {
    // Sorted arrays ⇒ set equality with multiplicity; a site or method that moves
    // in or out of the excluded population is a named, reviewed diff.
    expect(observed.opaqueMethods, 'opaque surface methods moved (by name) — update the fixture deliberately').toEqual([...fixture.opaqueMethods].sort());
    expect(observed.excludedCallSites, 'spread / nonLiteral call sites moved (by site) — update the fixture deliberately').toEqual([...fixture.excludedCallSites].sort());
    expect(fixture.opaqueMethods.length).toBe(fixture.methods.opaque);
    expect(fixture.excludedCallSites.length).toBe(fixture.callSites.spread + fixture.callSites.nonLiteral);
  });

  it('every key a pack SENDS is a key its surface READS, on every literal×readable pair — and every method a pack CALLS exists on its surface — except the shrink-only known drift', () => {
    const known = new Set(fixture.knownDrift.map(driftKey));
    const unexpected = s.drift.filter((d) => !known.has(driftKey(d)));
    const describe1 = (d: (typeof s.drift)[number]): string => d.kind === 'missing-method'
      ? `  ${d.pack}/index.mjs:${d.line} calls ${d.surfaceId}.${d.method} — NO bound surface defines it (typo? renamed?)`
      : `  ${d.pack}/index.mjs:${d.line} sends {${d.sent.join(', ')}} → ${d.surfaceId}.${d.method} reads {${d.read.join(', ')}}`;
    expect(
      unexpected,
      `NEW pack→surface drift (the UPWF-1 class — the surface silently drops what the pack sends, or the method does not exist; fix the feature, never the baseline):\n${unexpected.map(describe1).join('\n')}`,
    ).toEqual([]);
    const observedKeys = new Set(s.drift.map(driftKey));
    const stale = fixture.knownDrift.filter((d) => !observedKeys.has(driftKey(d))).map(driftKey);
    expect(stale, `stale known-drift rows (fixed, or the site moved) — remove them from the fixture:\n${stale.join('\n')}`).toEqual([]);
  });

  describe('SELF-TEST: the REAL `scan()` against a synthetic corpus (review S3 — the old witness re-implemented the filter inline and never ran the scanner)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-surface-parity-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const featuresDir = join(root, 'features');
    const packsDir = join(root, 'packs');
    mkdirSync(join(featuresDir, 'synth'), { recursive: true });
    mkdirSync(join(packsDir, 'feature.synth.nodes'), { recursive: true });
    writeFileSync(join(featuresDir, 'synth', 'feature.ts'), [
      "import { buildSynth } from './surface.js';",
      "export const feature = { id: 'synth', surface: { id: 'synth', build: buildSynth } };",
      '',
    ].join('\n'));
    writeFileSync(join(featuresDir, 'synth', 'surface.ts'), [
      'export function buildSynth(scope: { tenantId: string }) {',
      '  return {',
      '    getThing: async (args: Record<string, unknown>) => ({ v: args.foo, t: scope.tenantId }),',
      '    other: async (args: Record<string, unknown>) => ({ v: args.bar }),',
      '  };',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(packsDir, 'feature.synth.nodes', 'index.mjs'), [
      'export const nodes = {',
      '  get: async (inputs, ctx) => {',
      '    const s = ctx.features.synth;',
      '    const a = await s.getThing({ fooX: inputs.x });', // line 4 — unread key
      '    const b = await s.other({ bar: 1 });',            // line 5 — clean pair
      '    const c = await s.nope({ foo: 1 });',             // line 6 — missing method
      '    return { a, b, c };',
      '  },',
      '};',
      '',
    ].join('\n'));
    const synth = scan({ featuresDir, packsDir });

    it('binds the synthetic pack to its surface and asserts the clean pair', () => {
      expect(synth.surfaces).toBe(1);
      expect(synth.methods.map((m) => `${m.surfaceId}.${m.method}:${m.readable ? m.keys.join(',') : 'opaque'}`).sort()).toEqual(['synth.getThing:foo', 'synth.other:bar']);
      expect(synth.calls.map((c) => `${c.method}@${c.line}:${c.cls}`)).toEqual(['getThing@4:literalNoSpread', 'other@5:literalNoSpread', 'nope@6:literalNoSpread']);
      expect(synth.assertedPairs).toBe(2);
    });

    it('flags exactly ONE unread-keys row (the UPWF-1 shape) and ONE missing-method row (the S4 shape)', () => {
      expect(synth.drift).toEqual([
        { kind: 'unread-keys', pack: 'feature.synth.nodes', surfaceId: 'synth', method: 'getThing', sent: ['fooX'], read: ['foo'], line: 4 },
        { kind: 'missing-method', pack: 'feature.synth.nodes', surfaceId: 'synth', method: 'nope', sent: ['foo'], read: [], line: 6 },
      ]);
    });
  });
});

