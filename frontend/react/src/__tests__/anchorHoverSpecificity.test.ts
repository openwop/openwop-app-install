/**
 * RATCHET — an unclassed `a:hover` may never declare `color`.
 *
 * THE DEFECT CLASS. `a:hover` written plainly is specificity (0,1,1). Every
 * component class that colors an anchor — `.surface-card`, `.fp-card--link`,
 * `.chip`, `.fp-btn--primary`, `.admin-overview-card` — is (0,1,0). So the
 * BASE state honored the component and the HOVER state silently overrode it:
 * hovering a `<Link className="surface-card">` repainted the anchor accent,
 * and every descendant with no `color` of its own (card title, lede, body)
 * INHERITED it. An entire card of text went clay-orange on hover. On filled
 * treatments it painted clay-on-clay — unreadable, not merely wrong.
 *
 * WHY A RATCHET AND NOT JUST THE FIX. The app fixed this one surface at a time
 * for years — `a.btn-accent-solid:hover`, `button.surface-card:hover`, each
 * with a comment explaining the trap, each landing only after a human SAW the
 * flash on one more page. The compound pins treated the symptom; the (0,1,1)
 * hover rule kept manufacturing new instances faster than review caught them.
 * De-specifying it to `a:where(:hover)` (0,0,1) retires the class — but only
 * for as long as nobody "tidies" the `:where()` away, which reads like a
 * no-op wrapper unless you know what it is load-bearing for.
 *
 * SCOPE. global.css only — the sole stylesheet that styles bare anchors
 * app-wide. A component stylesheet pinning its OWN classed hover is fine and
 * is not asserted over here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Comments are stripped first: this file documents heavily, and a `/* … *​/`
 * block sitting between two rules is otherwise swallowed into the following
 * rule's selector by the flat matcher below. */
const CSS = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Rule blocks as [selectorList, declarations]. Flat enough for this file. */
function rules(): Array<{ sel: string; body: string }> {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1]!.trim(),
    body: m[2]!,
  }));
}

/**
 * An anchor-hover selector carrying NO specificity-raising qualifier outside
 * `:where()` — i.e. one that would outrank a component class. `a:where(:hover)`
 * is exempt (that IS the fix); `a.chip:hover` / `.docs-index-item:hover` are
 * exempt (a class owns them, which is the point).
 */
function isUnclassedAnchorHover(selector: string): boolean {
  const s = selector.trim();
  if (!s.startsWith('a')) return false;
  // Strip every :where(...) group — by definition it adds no specificity.
  const stripped = s.replace(/:where\([^)]*\)/g, '');
  if (!/:hover\b/.test(stripped)) return false;
  // Anything left beyond the tag + pseudo-classes (a class, id, or attribute)
  // means a component owns this rule.
  return !/[.#[]/.test(stripped);
}

describe('global anchor hover is de-specified', () => {
  it('no unclassed a:hover rule declares color', () => {
    const offenders = rules()
      .filter((r) => /(^|[;{\s])color\s*:/.test(r.body))
      .flatMap((r) => r.sel.split(',').map((s) => s.trim()))
      .filter(isUnclassedAnchorHover);

    expect(
      offenders,
      `An unclassed anchor-hover rule declares \`color\` at specificity (0,1,1) or higher. ` +
        `It will override EVERY component class that colors an anchor (.surface-card, ` +
        `.chip, .fp-btn--primary …) on hover, and every descendant inherits the flip. ` +
        `Wrap the pseudo-class: \`a:where(:hover)\`.`,
    ).toEqual([]);
  });

  it('bare content links still get an accent-hover shift', () => {
    // The fix must not silently delete the hover affordance it de-specifies:
    // an anchor with no competing class still has to change on hover.
    const rule = rules().find((r) =>
      r.sel.split(',').some((s) => s.trim() === 'a:where(:hover)'),
    );
    expect(rule, 'the de-specified global anchor-hover rule is missing').toBeDefined();
    expect(rule!.body).toMatch(/color:\s*var\(--clay-text-hover\)/);
  });
});
