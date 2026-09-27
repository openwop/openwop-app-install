/**
 * RFC 0173 §C.1 — the effect-seam manifest, and the drift guard that is the whole
 * reason the manifest is trustworthy.
 *
 * `replay.md`: a seam OMITTED from the manifest is invisible to the suite — its
 * absence witnesses nothing and is found only by a later audit. So the dangerous
 * failure here is silent, and a hand-maintained list is exactly the artifact that
 * produces it. #2871 already ran this experiment in this repo: 55 chain nodes were
 * retargeted off a side-effect allowlist, the list kept claiming protection, and
 * nothing went red.
 *
 * The first test below is therefore the load-bearing one. It reads the SOURCE for
 * `assertEffectAllowed(` call sites and fails if any file holding one is missing
 * from `SEAM_CALL_SITES` — so a new guarded effect anywhere in `src/` cannot reach
 * the wire as an omitted row.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { SEAM_CALL_SITES, SEAM_ROWS } from '../src/host/effectSeamManifest.js';
import { effectSeamManifestBody } from '../src/routes/effectSeams.js';

/** Every `.ts` under src/, excluding the guard's own definition site. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * Call sites, found by stripping comments FIRST. A previous ratchet in this repo
 * counted commented-out mentions as real call sites and reported a number that
 * was never true; the docblock in `runEffectContext.ts` alone would add several.
 */
function callSiteFiles(): Set<string> {
  const found = new Set<string>();
  for (const abs of sourceFiles('src')) {
    if (abs.endsWith('host/runEffectContext.ts')) continue; // the definition, not a call
    const src = readFileSync(abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/\bassertEffectAllowed\s*\(/.test(src)) found.add(abs.replace(/\\/g, '/'));
  }
  return found;
}

describe('effect-seam manifest (RFC 0173 §C.1)', () => {
  it('every assertEffectAllowed call site in src/ is classified into a manifest row', () => {
    const actual = callSiteFiles();
    // Non-vacuity: if this probe finds nothing, it is broken, and a broken probe
    // would report a perfectly clean manifest for a host with no rows at all.
    expect(actual.size).toBeGreaterThan(5);

    const declared = new Set(SEAM_CALL_SITES.map((c) => c.file));
    const unclassified = [...actual].filter((f) => !declared.has(f)).sort();
    expect(
      unclassified,
      'a guarded effect exists in src/ with no manifest row — it would reach the wire as an OMITTED seam, ' +
        'which replay.md makes invisible to the suite rather than an error. Add it to SEAM_CALL_SITES and SEAM_ROWS.',
    ).toEqual([]);

    // The reverse direction: a declared site that no longer holds a call is a row
    // describing an effect path the host cannot reach — a false positive claim.
    const stale = [...declared].filter((f) => !actual.has(f)).sort();
    expect(stale, 'SEAM_CALL_SITES names a file with no assertEffectAllowed call — the row is stale.').toEqual([]);
  });

  it('every classified call site resolves to a row, and every row is guarded', () => {
    const rowSeams = new Set(SEAM_ROWS.map((r) => r.seam));
    const missing = SEAM_CALL_SITES.filter((c) => !rowSeams.has(c.seam)).map((c) => c.seam);
    expect(missing, 'a call site maps to a seam name with no row').toEqual([]);
    for (const row of SEAM_ROWS) {
      expect(row.guarded, `${row.seam}: §C.1 requires every row to be guarded`).toBe(true);
      expect(row.guardedBy.length, `${row.seam}: guardedBy must name the real mechanism`).toBeGreaterThan(20);
      expect(row.seam, `${row.seam}: must match the schema's seam pattern`).toMatch(
        /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/,
      );
    }
  });

  it('the served body carries the manifest shape and a build identity', () => {
    const body = effectSeamManifestBody() as {
      manifestVersion: string;
      host: { name: string; build: { kind: string; id: string } };
      seams: unknown[];
    };
    expect(body.manifestVersion).toBe('1');
    expect(body.host.build.kind).toBe('commit');
    expect(typeof body.host.build.id).toBe('string');
    expect(body.seams.length).toBe(SEAM_ROWS.length);
  });

  /**
   * The claim this file exists to protect is "the served body IS a valid
   * effect-seam manifest", and only the schema can say that. Validating against
   * the TypeScript type would be circular — the type is my description of the
   * contract, not the contract — and it was my own wrong reading of the `kind`
   * enum that produced the corpus change behind this row.
   *
   * The vendored copy is the right source here rather than the package: it is
   * what ships in the image (`Dockerfile` COPY) and therefore what a deployed
   * revision would be judged against.
   */
  it('the served body validates against the vendored effect-seam-manifest schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { readFileSync } = await import('node:fs');
    const schema = JSON.parse(readFileSync('../../schemas/v2/effect-seam-manifest.schema.json', 'utf8')) as object;
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const body = effectSeamManifestBody();
    expect(validate(body), `manifest violates the schema: ${JSON.stringify(validate.errors ?? [])}`).toBe(true);

    // Non-vacuity: the validator must actually reject something. Without this a
    // mis-compiled schema (or an `allErrors` object that never runs) reports a
    // clean pass for any body at all.
    expect(validate({ manifestVersion: '1', host: { name: 'x' }, seams: [] })).toBe(false);
  });
});
