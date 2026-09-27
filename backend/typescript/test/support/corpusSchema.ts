/**
 * Load a canonical OpenWOP schema from the CONFORMANCE PACKAGE, not from the
 * repo's vendored `schemas/` copy.
 *
 * WHY. A test that validates against a vendored copy certifies conformance to
 * whatever that copy happens to say. Measured instance (RFC 0145 G2): the
 * vendored `capabilities.schema.json` sat SEVEN properties behind upstream —
 * missing the five RFC 0144 declared families plus `anonymousActor` and
 * `replay` — and everything stayed green, because nothing compared them. A
 * discovery advert validated against that copy would have been certified
 * against a contract that no longer existed.
 *
 * `scripts/check-vendored-schemas.mjs` now guards those two copies, which
 * DETECTS the drift. Importing from the package is strictly better: there is no
 * second copy, so the drift cannot occur. The version is pinned by the lockfile
 * and moves only when someone deliberately bumps it — which is exactly the
 * property a conformance assertion needs.
 *
 * SCOPE — this is for TEST-VALIDATED schemas only. The rest of `schemas/` stays
 * vendored on purpose: the Docker image loads them at runtime and
 * `gcloud run deploy --source .` uploads only this repo, so a devDependency
 * would not exist in the deployed image. Do not "finish the job" by pointing
 * runtime loaders here.
 *
 * `createRequire` is safe in this file specifically because tests are NOT
 * bundled by esbuild — the `esbuild-banner-createrequire-collision` hazard
 * applies to `src/`, which this is not.
 */
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);

/** A JSON Schema document with the `$defs` map the run-event payload legs read. */
export interface CorpusSchema {
  $defs?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Resolve + parse `<name>` from the corpus schema tree, which lives in a
 * DIFFERENT package on each corpus major:
 *
 *   1.x — `@openwop/openwop-conformance/schemas/`
 *   2.x — `@openwop/spec-artifacts/schemas/`   (the suite tarball ships only
 *          `schemas/CORPUS-STAMP.json`; the schemas themselves moved out)
 *
 * Both are tried, so one helper spans the overlap instead of every caller
 * knowing which major it is on.
 *
 * CORRECTED 2026-09-04. This resolved from the conformance package ONLY, and
 * when #3634 pinned the corpus to the v2 line every caller started throwing —
 * 12 assertions across 8 files, red on `origin/main` from that merge onward.
 * MEASURED: the same 8 files are 102/102 green at `2578e025c` (suite 1.159.0,
 * the commit before the pin) and 12-failed at every commit after it.
 *
 * The loud throw below was RIGHT and is kept: it said "the packaging changed,
 * NOT that the schema is optional", which is exactly what had happened. It
 * failed honestly and nothing acted on it, which is why the gate stayed red —
 * a correct error message is not a substitute for someone reading it.
 *
 * Throws with both package versions when neither layout has the file, so a
 * future packaging change still fails loudly here rather than degrading into
 * an empty-object validation that passes everything.
 */
const CORPUS_SCHEMA_PACKAGES = ['@openwop/spec-artifacts', '@openwop/openwop-conformance'] as const;

function packageVersion(pkg: string): string {
  try {
    return (require(`${pkg}/package.json`) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'absent';
  }
}

export function corpusSchema(name: string): CorpusSchema {
  const tried: string[] = [];
  for (const pkg of CORPUS_SCHEMA_PACKAGES) {
    const spec = `${pkg}/schemas/${name}`;
    try {
      return require(require.resolve(spec)) as CorpusSchema;
    } catch (err) {
      tried.push(`${spec} (${pkg}@${packageVersion(pkg)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `corpusSchema: cannot load schemas/${name} from any corpus package. ` +
    `These are pinned at stable tarball paths (check-npm-pack-contents.sh); ` +
    `a failure here means the packaging changed, NOT that the schema is optional. ` +
    `Tried:\n  ${tried.join('\n  ')}`,
  );
}
