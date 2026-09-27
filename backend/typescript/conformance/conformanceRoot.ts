/**
 * Which corpus the pinned conformance suite is allowed to evaluate.
 *
 * `run.ts` points OPENWOP_CONFORMANCE_ROOT at the sibling `../openwop` spec
 * repo so the spec-corpus-validity scenarios see the full catalog (the npm
 * package omits `spec/v1/*.md`). That coupling has a failure mode this module
 * exists to close (MEASURED 2026-08-16): the sibling is `main` and moves
 * independently of the pin. openwop#1009 added a fourth cross-file `$ref`
 * (`compensation-policy.schema.json`) to `workflow-definition.schema.json`;
 * the pinned 1.106.0 `fixtures-valid.test.ts` registers peer schemas from a
 * FIXED list, so `ajv.compile` threw at describe time and the file died — on
 * every app branch and on `main`, for a change no app commit made. A suite
 * cannot honestly evaluate a corpus newer (or older) than itself: the scenarios
 * and the schemas they load are ONE artifact at ONE version.
 *
 * Rule, in order:
 *   1. an explicit OPENWOP_CONFORMANCE_ROOT always wins — an operator who sets
 *      it is asserting the match themselves;
 *   2. the sibling WORKING TREE, only when its `conformance/package.json`
 *      version equals the installed `@openwop/openwop-conformance` version;
 *   3. otherwise the sibling repo's release TAG for the installed version
 *      (`openwop-conformance/v<version>`), exported once into a per-version
 *      cache dir — the full repo layout the suite's `paths.ts` expects
 *      (`schemas/`, `api/`, `conformance/fixtures/`, plus the `spec/v1` and
 *      `RFCS` prose that six always-on scenarios read directly), at EXACTLY the
 *      version the scenarios were written against. `git archive` of the tag
 *      is ~60 ms;
 *   4. otherwise the VENDORED corpus the package ships (a smaller Total,
 *      honestly labelled — and MEASURED 2026-08-16: six 1.106.0 always-on
 *      scenarios ENOENT on the missing prose there, so this tier is a
 *      degraded measurement, not a clean one).
 * Every non-explicit tier prints exactly which pin bump restores tier 2.
 */

export type ConformanceRootDecision =
  | { use: 'explicit'; root: string }
  | { use: 'sibling'; root: string; version: string }
  | { use: 'sibling-tag'; tag: string; version: string; siblingVersion: string }
  | { use: 'vendored'; reason: 'no-sibling' }
  | { use: 'vendored'; reason: 'version-mismatch-no-tag'; siblingVersion: string; installedVersion: string };

/** The release tag the spec repo cuts for each conformance version. */
export function conformanceTagFor(version: string): string {
  return `openwop-conformance/v${version}`;
}

export interface ConformanceRootInputs {
  /** OPENWOP_CONFORMANCE_ROOT as set by the caller, if any. */
  explicitRoot: string | undefined;
  /** Absolute path of the sibling spec repo (`../openwop`). */
  siblingRoot: string;
  /** Whether `<siblingRoot>/conformance/fixtures` exists. */
  siblingHasFixtures: boolean;
  /** `<siblingRoot>/conformance/package.json` `version`, or undefined if unreadable. */
  siblingVersion: string | undefined;
  /** Installed `@openwop/openwop-conformance` `package.json` `version`. */
  installedVersion: string;
  /** Whether the sibling repo has the tag `conformanceTagFor(installedVersion)`. */
  siblingHasInstalledTag: boolean;
}

export function decideConformanceRoot(i: ConformanceRootInputs): ConformanceRootDecision {
  if (i.explicitRoot) return { use: 'explicit', root: i.explicitRoot };
  if (!i.siblingHasFixtures) return { use: 'vendored', reason: 'no-sibling' };
  if (i.siblingVersion !== undefined && i.siblingVersion === i.installedVersion) {
    return { use: 'sibling', root: i.siblingRoot, version: i.installedVersion };
  }
  const siblingVersion = i.siblingVersion ?? '(unreadable)';
  if (i.siblingHasInstalledTag) {
    return { use: 'sibling-tag', tag: conformanceTagFor(i.installedVersion), version: i.installedVersion, siblingVersion };
  }
  return { use: 'vendored', reason: 'version-mismatch-no-tag', siblingVersion, installedVersion: i.installedVersion };
}

/** One line for the runner log; the message IS the shipping instruction. */
export function describeConformanceRoot(d: ConformanceRootDecision): string {
  switch (d.use) {
    case 'explicit':
      return `[conformance] full-catalog basis: OPENWOP_CONFORMANCE_ROOT=${d.root} (explicit — caller asserts the corpus matches the pinned suite)`;
    case 'sibling':
      return `[conformance] full-catalog basis: OPENWOP_CONFORMANCE_ROOT=${d.root} (sibling corpus @ ${d.version} == pinned suite)`;
    case 'sibling-tag':
      return `[conformance] sibling ../openwop working tree is @ ${d.siblingVersion} but the pinned @openwop/openwop-conformance is ${d.version} — a suite cannot evaluate a corpus at another version (its scenarios and the schemas they load are one artifact). Using the sibling repo's tag ${d.tag} (full-catalog basis at EXACTLY the pinned version). To measure the working tree again: publish/bump the pin to ${d.siblingVersion}.`;
    case 'vendored':
      return d.reason === 'no-sibling'
        ? '[conformance] sibling ../openwop spec repo not found — running the VENDORED partial corpus (spec-corpus-validity under-registers; Total is NOT comparable to the steward repo-layout basis). Set OPENWOP_CONFORMANCE_ROOT to the openwop repo for a full-catalog measurement.'
        : `[conformance] sibling ../openwop corpus is @ ${d.siblingVersion} but the pinned @openwop/openwop-conformance is ${d.installedVersion}, and the sibling has no tag ${conformanceTagFor(d.installedVersion)} — running the VENDORED partial corpus (smaller Total; six 1.106-line always-on scenarios read prose the tarball omits and will fail). Fetch the tag (\`git -C ../openwop fetch --tags\`) or publish/bump the pin to ${d.siblingVersion}.`;
  }
}
