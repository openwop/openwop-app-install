/**
 * CS-3 (KickTodo UX-ASSESSMENT) — KickTodo pages use the ONE page-title
 * primitive, `<PageHeader>` (DESIGN.md §5), instead of hand-rolling
 * `<header className="page-header">`. A hand-rolled header drifts: it skips the
 * `page-header__lead` wrapper and the `action-bar` on the actions cluster, so
 * the hierarchy the primitive guarantees is re-derived (and gets wrong) per page.
 *
 * SHRINK-ONLY. `REMAINING` is the measured set of KickTodo files still
 * hand-rolling the header, each with the reason it was not converted. The scan is
 * DERIVED (every non-test `.tsx` under `features/kicktodo*`), so a new page that
 * hand-rolls the header turns this red, and so does converting a listed page
 * without deleting its entry (the list cannot rot into a silent allowance).
 *
 * Breaks it: re-introducing `<header className="page-header">` on any of the
 * twelve pages CS-3 converted (sabotage-witnessed on `AdminCommercePage.tsx`:
 * restoring its hand-rolled header turned the first case red).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FEATURES = join(process.cwd(), 'src', 'features');

/** Hand-rolled headers still present, with why. Delete an entry when converting. */
const REMAINING: Record<string, string> = {
  // Header carries a chip/meta strip + depth strip that PageHeader has no slot for.
  'kicktodo/ChallengeDetailPage.tsx': 'chip meta strip inside the header',
  // The guide's name is its own <h1> class plus an inline rename form.
  'kicktodo/GuidePage.tsx': 'custom title + inline rename form',
  // Participant pages outside the CS-3 admin/creator scope (wave 4H participant lane).
  'kicktodo/JournalPage.tsx': 'participant page, outside CS-3 scope',
  'kicktodo/ProgressPage.tsx': 'participant page, outside CS-3 scope (action sits under the lede)',
  // Provenance strip, chips, risk signals and transformation all live in the header.
  'kicktodo-studio/CandidateWorkspacePage.tsx': 'provenance strip + chips inside the header',
};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...tsxFiles(p));
    } else if (name.endsWith('.tsx') && !name.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

const handRolled = readdirSync(FEATURES)
  .filter((d) => d.startsWith('kicktodo'))
  .flatMap((d) => tsxFiles(join(FEATURES, d)))
  .filter((f) => readFileSync(f, 'utf8').includes('<header className="page-header"'))
  .map((f) => relative(FEATURES, f).split(sep).join('/'))
  .sort();

describe('KickTodo pages use <PageHeader> (CS-3)', () => {
  it('no KickTodo page hand-rolls the page header outside the listed remainder', () => {
    expect(handRolled.filter((f) => !(f in REMAINING))).toEqual([]);
  });

  it('every listed remainder still hand-rolls it (convert ⇒ delete the entry)', () => {
    expect(Object.keys(REMAINING).filter((f) => !handRolled.includes(f))).toEqual([]);
  });
});
