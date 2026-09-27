/**
 * RATCHET — a collection/rail cell is a `<Link>`, never a `<button>`.
 *
 * THE DEFECT CLASS (DESIGN.md §4.5 rule 12; ADRs 0518, 0519 and
 * `docs/steward/COLLECTION-CANON-SWEEP.md`). A list of entities renders each row
 * as a `<button>` whose className toggles `btn-accent`/`btn-ghost` on an id
 * comparison, and clicking it selects in component state. On screen it is
 * indistinguishable from a link. What silently does nothing:
 *
 *   - cmd-click / middle-click (open in a new tab)
 *   - "copy link address"
 *   - browser Back / Forward
 *   - sharing or bookmarking whatever is open
 *
 * Because none of that is visible in a screenshot or a render test, the pattern
 * spread by copy-paste across SEVEN surfaces before anyone measured it — and it
 * dragged a second defect along, since a row that isn't a link tends to grow a
 * delete button beside it, one mis-aimed click from the row you meant to open.
 *
 * WHY A RATCHET. The seven were found by grepping exactly this signature. That
 * makes it cheap to keep finding — and the fix only holds while nobody writes
 * the eighth. A rail is exempt from the Grid⇄List toggle (rule 11), NOT from
 * this: `.kbase-layout` / `.media-layout` / `.publishing-layout` cells are all
 * `<Link>`s now.
 *
 * SCOPE. The `btn-accent`/`btn-ghost` selection ternary specifically — the
 * measured signature, not a general theory of buttons. A `<button>` that toggles
 * those classes for a non-navigational reason (a filter chip, a mode switch)
 * would be a false positive; none exists today, and one should be added to
 * ALLOWED with a note rather than silently reshaping the check.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** Non-navigational uses of the ternary, each justified in a comment here. */
const ALLOWED = new Set<string>([]);

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') tsxFiles(p, acc); }
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) acc.push(p);
  }
  return acc;
}

/** The JSX element a match sits inside: walk back to the nearest unclosed `<`. */
function owningTag(src: string, at: number): string {
  const open = src.lastIndexOf('<', at);
  if (open < 0) return '';
  return /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(open, at))?.[1] ?? '';
}

describe('collection + rail cells are links', () => {
  it('no <button> carries the btn-accent/btn-ghost selection ternary', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\?\s*'btn-accent'\s*:\s*'btn-ghost'/g)) {
        const tag = owningTag(src, m.index);
        if (tag === 'button') {
          offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(
      offenders,
      'A selection cell is rendering as a <button>. On screen it looks like a link, ' +
        'but cmd-click, middle-click, "copy link address", and Back/Forward all do ' +
        'nothing. Render it as a <Link> to the URL that opens it (a rail may link to ' +
        '`?param=<id>`; a full-page collection gets a path route). See DESIGN.md §4.5 ' +
        'rule 12 and docs/steward/COLLECTION-CANON-SWEEP.md.',
    ).toEqual([]);
  });
});
