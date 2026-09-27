/**
 * RATCHET — a loading sentinel must not outlive its request.
 *
 * The class (measured by `openwop-app-2` in #2589, swept here): a state declared
 * `useState<T | null>(null)` whose render treats `null` as LOADING, and whose
 * catch sets an error **without resetting the state**. The page then shows an
 * honest error with a spinner still turning underneath it, forever.
 *
 * WHY A RATCHET AND NOT JUST THE SWEEP: this class survived multiple careful UX
 * passes — including features graded "A+" by the people who wrote the grade, and
 * two files whose *other* `| null` state had already been fixed. A defect class
 * you have no name for does not show up in a review, however rigorous. Only a
 * check that runs every build does.
 *
 * SCOPE IS DELIBERATELY NARROW. It asserts only over the files this sweep
 * actually verified and fixed — the `ui/Field` precedent (#2533): never make a
 * repo-wide claim you have not earned. A ratchet that asserts more than was
 * checked is the same "claiming what you didn't verify" defect, aimed at our own
 * tooling. Adding a file here is a promise that a human read it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * Files verified by the 2026-07-26 sweep. Each had at least one state where
 * `null` meant "loading" and a catch left it null.
 */
const SWEPT = [
  'features/twin/AgentTwinPanel.tsx',
  'features/twin/ProfileTwinGrantsTab.tsx',
  'walkthroughs/WalkthroughsPage.tsx',
  'features/projects/ProjectsPage.tsx',
  'features/projects/ProjectMembersTab.tsx',
  'features/priority-matrix/PriorityMatrixPage.tsx',
  'features/priority-matrix/PriorityListPage.tsx',
  'canvas/HistoryModal.tsx',
  'features/capability-firewall/FirewallRulesPage.tsx',
] as const;

/** States in a swept file that render `null` as loading. Verified by hand. */
/**
 * #2596 §correction, completed here: `setX((prev) => prev ?? [])` is the WRONG
 * shape wherever the empty state makes a CLAIM rather than saying "nothing here".
 * It was applied mechanically to nine states in #2593 and was wrong in all of
 * them — the firewall's `orgs` only escaped because its copy happened to be
 * read. Every entry below now uses a distinct `<x>Failed` state, checked ABOVE
 * the loading branch.
 *
 * The rule, so the next person does not re-derive it: **the resolution depends on
 * what the empty state SAYS.** An empty state that instructs ("create one",
 * "add people"), asserts safety/privacy/security, or unlocks a control the
 * non-empty state hides, needs a third state — never `[]`.
 */
const CLAIM_BEARING: Record<string, string[]> = {
  'features/projects/ProjectsPage.tsx': ['loadFailed'],
  'features/projects/ProjectMembersTab.tsx': ['membersFailed'],
  'features/priority-matrix/PriorityMatrixPage.tsx': ['listsFailed'],
  'features/priority-matrix/PriorityListPage.tsx': ['listsFailed', 'ideasFailed'],
  'walkthroughs/WalkthroughsPage.tsx': ['mineFailed'],
  'canvas/HistoryModal.tsx': ['rowsFailed'],
};

/** Sentinels for which `[]` really IS the honest resolution (none remain). */
const SENTINELS: Record<string, string[]> = {
  // `view` moved OFF the resolve-to-empty shape — see the write-affordance
  // assertion below. This is the one where the empty state unlocked a button.
  'features/twin/AgentTwinPanel.tsx': [],
  // `grants` moved OFF the resolve-to-`[]` shape — see the consent-dashboard
  // assertion below for why that shape was wrong on this one page.
  'features/twin/ProfileTwinGrantsTab.tsx': [],
  // All six moved OFF the resolve-to-`[]` shape (the completion of #2596's
  // correction): each of their empty states instructs or makes a claim, so each
  // now uses a distinct `<x>Failed` state — asserted by CLAIM_BEARING above.
  'walkthroughs/WalkthroughsPage.tsx': [],
  'features/projects/ProjectsPage.tsx': [],
  'features/projects/ProjectMembersTab.tsx': [],
  'features/priority-matrix/PriorityMatrixPage.tsx': [],
  'features/priority-matrix/PriorityListPage.tsx': [],
  'canvas/HistoryModal.tsx': [],
  // `orgs` is handled by a dedicated `orgsFailed` branch rather than by
  // resolving the sentinel — see the separate assertion below for why.
  'features/capability-firewall/FirewallRulesPage.tsx': [],
};

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const setterOf = (state: string): string => `set${state[0]!.toUpperCase()}${state.slice(1)}`;

describe('permanent-loading ratchet — the sentinel is resolved on failure', () => {
  it.each(SWEPT)('%s still resolves every loading sentinel it owns', (rel) => {
    const src = read(rel);
    for (const state of SENTINELS[rel] ?? []) {
      const setter = setterOf(state);
      // The fix shape: the failure path resolves the sentinel with
      // `setX((prev) => prev ?? …)`. Its absence means a catch can once again
      // leave `null` on screen as a permanent spinner.
      expect(src, `${rel}: '${state}' no longer resolves its sentinel on failure`)
        .toMatch(new RegExp(`${setter}\\(\\(prev\\) => prev \\?\\?`));
    }
  });

  it.each(Object.keys(CLAIM_BEARING))('%s uses a distinct failed state, never `prev ?? []`', (rel) => {
    const src = read(rel);
    for (const flag of CLAIM_BEARING[rel]!) {
      const setter = `set${flag[0]!.toUpperCase()}${flag.slice(1)}`;
      expect(src, `${rel}: '${flag}' state is gone`).toMatch(new RegExp(`const \\[${flag}, ${setter}\\]`));
      expect(src, `${rel}: '${flag}' never resets on a successful retry`).toMatch(new RegExp(`${setter}\\(false\\)`));
    }
    // The shape #2596 corrected must not come back anywhere in these files.
    expect(src, `${rel}: the mechanical \`prev ?? []\` shape returned`)
      .not.toMatch(/set\w+\(\(prev\) => prev \?\? \[\]\)/);
    // A failed branch BELOW the loading branch is decorative — the spinner wins.
    const failedAt = src.search(/=== null && \w+Failed/);
    if (failedAt >= 0) {
      const loadingAt = src.search(/=== null(?! && \w+Failed)/);
      expect(failedAt, `${rel}: the failed branch is ordered below the loading branch`)
        .toBeLessThan(loadingAt < 0 ? Number.MAX_SAFE_INTEGER : loadingAt);
    }
  });

  it('the firewall keeps a DISTINCT failed state, not an empty list', () => {
    // Resolving this one to `[]` would render "No organizations — create an
    // organization to configure the capability firewall": an instruction a failed
    // read has not earned. `null` and `[]` were both taken, so failure needs a
    // third state — and it must be checked ABOVE the loading early-return,
    // because this page's error Notice sits below it and is otherwise unreachable.
    const src = read('features/capability-firewall/FirewallRulesPage.tsx');
    expect(src).toMatch(/const \[orgsFailed, setOrgsFailed\]/);
    expect(src.indexOf('if (orgsFailed)')).toBeGreaterThan(-1);
    expect(src.indexOf('if (orgsFailed)')).toBeLessThan(src.indexOf('if (orgs === null) return'));
    expect(src).not.toMatch(/\.catch\([^)]*\)\s*=>\s*setOrgs\(\[\]\)/);
  });

  it('the consent dashboard keeps a DISTINCT failed state, not an empty list', () => {
    // The `prev ?? []` shape is right for a LIST (a spinner becomes "nothing
    // here"), and wrong here for the same reason it was wrong for the firewall:
    // this page's empty state reads "No agent can recall your memory" — an
    // affirmative privacy ASSURANCE. Resolving a failed read to `[]` makes a
    // network error tell someone that nothing has access to their data. That is
    // a stronger claim than the permanent spinner it replaced.
    const src = read('features/twin/ProfileTwinGrantsTab.tsx');
    expect(src).toMatch(/const \[loadFailed, setLoadFailed\]/);
    expect(src).toMatch(/grants === null && loadFailed/);
    // The failed branch must be tested BEFORE the bare loading branch, or the
    // loading card wins and the distinction is decorative.
    expect(src.indexOf('grants === null && loadFailed')).toBeLessThan(src.indexOf(') : grants === null ?'));
    expect(src).not.toMatch(/setGrants\(\(prev\) => prev \?\?/);
    expect(src).toMatch(/setLoadFailed\(false\)/); // a successful retry recovers
  });

  it('the firewall DECISIONS read is failed-vs-empty too, not just orgs', () => {
    // The sweep fixed `orgs` on this page and stopped there. `decisions` has the
    // same defect one state over: its catch sets `[]`, which renders "No
    // decisions yet — when the firewall blocks or holds a tool call it appears
    // here". On a security console that reads as "this firewall has never
    // blocked anything", produced by a failed read. Fixes are per-STATE, not
    // per-file; a file appearing in SWEPT does not mean every state in it was
    // checked.
    const src = read('features/capability-firewall/FirewallRulesPage.tsx');
    expect(src).toMatch(/const \[decisionsFailed, setDecisionsFailed\]/);
    expect(src).toMatch(/setDecisionsFailed\(false\)/);
  });

  it('the twin panel never resolves a failed read into a WRITE AFFORDANCE', () => {
    // The escalation of this class, and the reason `prev ?? <empty>` cannot be
    // applied mechanically: ask not only "is the empty state a claim?" but
    // "does the empty state UNLOCK A CONTROL the non-empty state hides?"
    //
    // Here `!link` renders BOTH "{persona} isn't a twin of anyone yet." and the
    // "Make {persona} a twin of me" button. Resolving the sentinel to an empty
    // view therefore offers a write premised on a read that failed — and the
    // server cannot catch it: `linkTwin` (host/twinService.ts) has no
    // already-linked rejection, it silently re-links and REVOKES THE PRIOR
    // TWIN'S GRANT, which is correct for a deliberate admin re-link and
    // indistinguishable from this one.
    const src = read('features/twin/AgentTwinPanel.tsx');
    expect(src).not.toMatch(/setView\(\(prev\) => prev \?\?/);
    expect(src).toMatch(/const \[loadFailed, setLoadFailed\]/);
    // Ordered above the loading branch, or the spinner wins.
    expect(src.indexOf('{loadFailed ?')).toBeGreaterThan(-1);
    expect(src.indexOf('{loadFailed ?')).toBeLessThan(src.indexOf(') : view === null ?'));
    // The retry shares the load path, so it cannot reintroduce the failure-as-
    // loading state it exists to clear.
    expect(src).toMatch(/const load = useCallback/);
  });

  it('is not vacuous — it really read the files and found states to check', () => {
    expect(SWEPT.length).toBeGreaterThanOrEqual(9);
    // SENTINELS is empty BY DESIGN now: every state moved to a distinct failed
    // flag, so non-vacuity is measured against the shape that replaced it. This
    // check earned its keep — it caught `it.each` over an empty CLAIM_BEARING
    // silently generating ZERO tests, which is the vacuity it exists to prevent.
    const checked = Object.values(CLAIM_BEARING).flat().length;
    expect(checked).toBeGreaterThanOrEqual(7);
    for (const rel of SWEPT) expect(read(rel).length).toBeGreaterThan(500);
  });
});
