/**
 * RFC 0146 — `contractProvenance`: which corpus revision this host implements against.
 *
 * WHY THIS IS DERIVED AND NOT A CONSTANT (this is the whole point of the field).
 *
 * v1.x corpus changes are additive, so a discovery document written against an OLDER
 * contract still validates against the newer schema. Validation is structurally blind to
 * this drift — which is exactly why this host sat at 81 root properties against an
 * 88-property contract and stayed green. The corpus cannot see our files; the only party
 * positioned to notice is a consumer, and all it can see is what we say.
 *
 * A hand-written constant would satisfy the schema and then drift on the first bump —
 * i.e. it would reproduce the defect the field exists to detect, while claiming to
 * detect it. So both values are read from the INSTALLED package's
 * `schemas/CORPUS-STAMP.json`. That makes RFC 0146 requirement 2 ("a host advertising it
 * MUST report the revision it actually implements") true BY CONSTRUCTION rather than by
 * agreement — the same move as deriving `registrationSource` from the artifact registry
 * for RFC 0145. No external leg can witness requirement 2 (recorded as RFC 0146 G2), so
 * structural truth is the only kind available here.
 *
 * TWO THINGS THIS IS NOT:
 *  - NOT an integrity check. `corpusCommit` says WHICH contract, never whether the copy
 *    was modified. Hand-edit a vendored schema and this still reads clean.
 *  - NOT a compatibility gate. A consumer MUST NOT refuse interop solely because our
 *    provenance differs from its own; a host on an older revision is conformant. The
 *    field detects drift, it does not make drift an error.
 */

// Alias the import: the esbuild bundle banner injects its own top-level
// `import { createRequire } from 'module'`, and esbuild renames local identifiers BEFORE
// the raw banner text is prepended — an unaliased import here produces a duplicate
// top-level declaration that fails at CONTAINER BOOT with a green `tsc`
// ("Identifier 'createRequire' has already been declared"). Same reason as
// routes/workflowChainExpandSeam.ts.
import { createRequire as nodeCreateRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../observability/logger.js';

import { contractProvenanceSuiteVersion } from './buildInfo.js';

const log = createLogger('host.contractProvenance');

export interface ContractProvenance {
  suiteVersion: string;
  /** OPTIONAL, per RFC 0146: "Both members are OPTIONAL; a host that knows only
   *  one advertises only that one." Required here until 2026-08-15, which made
   *  the spec's own case — a host with the image stamp but no corpus commit —
   *  unrepresentable. The stamp carries a published suite version and nothing
   *  else, and inventing a commit to satisfy a type would be the false
   *  statement requirement 2 forbids. */
  corpusCommit?: string;
}

/** Overridable so a test can point the derivation at a DIFFERENT stamp — the sabotage
 *  that distinguishes "reads the stamp" from "returns a constant that happens to match". */
export function readContractProvenanceFrom(stampPath: string): ContractProvenance | undefined {
  let raw: string;
  try {
    raw = readFileSync(stampPath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('contract provenance stamp is not valid JSON — omitting contractProvenance', { stampPath });
    return undefined;
  }

  const stamp = (parsed ?? {}) as Record<string, unknown>;
  // THE STAMP RENAMED ITS OWN FIELD AT THE MAJOR, and the rename is silent.
  //
  //   1.x  { suiteVersion, corpusCommit }
  //   2.x  { package, version, corpusTag, corpusCommit }   <- suite version is `version`
  //
  // Read both spellings. Only the KEY moved: `version` on a 2.x stamp is the
  // same fact `suiteVersion` was on a 1.x one — the version of the suite that
  // produced the vendored contract — so this is one field with two names, not
  // a guess about a different one.
  //
  // Found 2026-09-04 while moving this host to the v2 corpus line: the reader
  // required the 1.x spelling, so every 2.x stamp fell through to "missing
  // suiteVersion/corpusCommit" and the field was OMITTED. Omission is
  // legitimate under RFC 0146 (absent => unspecified), which is exactly why it
  // went unnoticed — an honest omission and a broken derivation are
  // indistinguishable on the wire. Same shape as the `corpusSchema()` break in
  // the same pin: the 2.x packaging moved something and the reader kept looking
  // where it used to be.
  const suiteVersion = typeof stamp['suiteVersion'] === 'string' && stamp['suiteVersion']
    ? (stamp['suiteVersion'] as string)
    : (typeof stamp['version'] === 'string' ? (stamp['version'] as string) : '');
  const corpusCommit = stamp['corpusCommit'];
  if (!suiteVersion || typeof corpusCommit !== 'string' || !corpusCommit) {
    log.warn('contract provenance stamp is missing suiteVersion/corpusCommit — omitting contractProvenance', { stampPath });
    return undefined;
  }
  return { suiteVersion, corpusCommit };
}

/** Absolute path to the installed conformance package's corpus stamp. */
export function corpusStampPath(): string | undefined {
  try {
    const require_ = nodeCreateRequire(import.meta.url);
    return join(dirname(require_.resolve('@openwop/openwop-conformance/package.json')), 'schemas', 'CORPUS-STAMP.json');
  } catch {
    return undefined;
  }
}

let cached: ContractProvenance | undefined;
let resolved = false;

/**
 * The provenance to advertise, or `undefined` to OMIT the field.
 *
 * Omission is deliberate when the stamp cannot be read. RFC 0146 makes the field
 * optional, and a silent host is *inapplicable* rather than failing — whereas advertising
 * a guessed or placeholder revision would be a false statement about the contract, which
 * is strictly worse than saying nothing. Never substitute a fallback constant here.
 */
/**
 * The choice between the two sources, as a PURE function — and it is separate
 * for a reason worth keeping.
 *
 * Written inline first, it could not be tested: in a dev tree the package
 * resolves, so `fromStamp` is always set, the fallback never runs, and a test of
 * "the production case" passes whether the fallback exists or not. Deleting the
 * fallback entirely left that test GREEN. A test that cannot fail is the thing
 * this codebase keeps finding, and I wrote one here before extracting this.
 *
 * Pure and exported, both branches are reachable from a test with no mocking —
 * and `vi.mock` would not have helped anyway, since `contractProvenance()` calls
 * its collaborators intra-module, where a rebound export never applies.
 */
export function chooseProvenance(
  fromStamp: ContractProvenance | undefined,
  fromImageStamp: string | null,
): ContractProvenance | undefined {
  // The package stamp wins when present: it carries `corpusCommit` too, and
  // RFC 0146 prefers the fuller statement.
  if (fromStamp) return fromStamp;
  // Production: the package is absent (`npm ci --omit=dev`), so the image stamp
  // is the only source. Suite version only — inventing a `corpusCommit` to fill
  // the shape would be the false statement requirement 2 forbids.
  if (fromImageStamp) return { suiteVersion: fromImageStamp };
  // Neither: OMIT. Absent ⇒ unspecified (requirement 1).
  return undefined;
}

export function contractProvenance(): ContractProvenance | undefined {
  if (resolved) return cached;
  resolved = true;
  const path = corpusStampPath();
  cached = path ? readContractProvenanceFrom(path) : undefined;
  // ── THE IMAGE FALLBACK, and why it is not belt-and-braces ────────────────
  // MEASURED 2026-08-15 against the live deployment: this file was PRESENT in
  // the running commit and the wire carried NO `contractProvenance`. The
  // resolver above cannot work in production by construction —
  // `@openwop/openwop-conformance` is a devDependency and `Dockerfile:85` runs
  // `npm ci --omit=dev`, so `require.resolve` throws in the runtime stage.
  //
  // The feature was therefore deployed and silently inert exactly where a
  // staleness signal is worth anything. Nothing was WRONG (RFC 0146 makes
  // absence legitimate: absent ⇒ unspecified), which is why it went unnoticed —
  // an honest omission and a broken derivation look identical on the wire.
  //
  // So fall back to `build-meta/corpus-suite.txt`, stamped at BUILD time from
  // the same installed package by `scripts/write-build-commit.mjs`. Still
  // DERIVED, never a constant — RFC 0146 guidance G2 wants the claim
  // "structurally true instead of merely asserted", and a hand-written version
  // would be a second place to update that drifts toward agreeing with itself.
  //
  // `corpusCommit` is deliberately NOT reconstructed here: the image stamp
  // carries only the published suite version, and both members are optional.
  // Advertising a commit we did not read would be the false statement
  // requirement 2 forbids.
  cached = chooseProvenance(cached, contractProvenanceSuiteVersion());
  if (!cached) {
    log.warn('conformance corpus stamp unresolvable — omitting contractProvenance from discovery', {});
  }
  return cached;
}

/** Test seam: drop the memoised value so a test can re-derive. */
export function __resetContractProvenance(): void {
  resolved = false;
  cached = undefined;
}
