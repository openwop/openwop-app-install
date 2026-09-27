/**
 * UX_UPGRADE-content ROUND 2 — CMS2-B5.
 *
 * ONE swallowed read (`listSharedSections(...).catch(() => setSharedSections([]))`)
 * told the editor FOUR things, all of them "this section was deleted":
 *
 *  1. the ref block read *"Shared section no longer exists — remove or replace
 *     this block"*,
 *  2. **Detach disappeared** (it needs the shared body to copy in), leaving
 *     **Remove** as the only offered action,
 *  3. `resolvedSections` DROPPED the block from both previews, so the page
 *     rendered as if the header had already been removed — the most persuasive
 *     argument possible for pressing Remove,
 *  4. the org's shared-sections list vanished from the settings panel.
 *
 * The `ref` those four nudge you to destroy can be on every page in the org, and
 * recovery is version history. The page ALREADY had this exact pattern one
 * hundred lines up (`sharedImpactFailed`), which is why "the read failed" was a
 * three-line fix and not a redesign.
 *
 * These tests drive `SectionsEditor` directly: the four consequences are its
 * render decisions, and mounting the whole `CmsPage` to reach them would test
 * the org picker instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SectionsEditor } from '../SectionsEditor.js';
import { resolveSharedRefs } from '../resolveSharedRefs.js';

const REF_SECTION = { sectionId: 's1', type: 'hero', data: {}, ref: { sharedSectionId: 'shsec:hdr' } };
const SHARED = { sharedSectionId: 'shsec:hdr', name: 'Site header', type: 'hero', data: { heading: 'Ship faster' } };

const view = (props: Record<string, unknown>): void => {
  render(
    <SectionsEditor
      sections={[REF_SECTION] as never}
      assets={[]}
      onChange={() => {}}
      onPickMedia={async () => null}
      {...props}
    />,
  );
};

afterEach(cleanup);

describe('CMS2-B5 — a failed shared-section read is not a deletion', () => {
  it('does NOT claim the section no longer exists', () => {
    view({ sharedSections: [], sharedFailed: true });
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  it('warns against Remove, because Remove destroys a ref used across the org', () => {
    view({ sharedSections: [], sharedFailed: true });
    // The honest instruction is "reload first", not "remove or replace".
    expect(screen.getByText(/do not remove it/i)).toBeTruthy();
  });

  it('a section that is GENUINELY gone still says so (the negative control)', () => {
    // Without this arm the assertions above are satisfied by an editor that
    // never reports a missing shared section at all — which would be a new
    // failure-as-silence in place of the failure-as-deletion being fixed.
    view({ sharedSections: [], sharedFailed: false });
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
    expect(screen.queryByText(/do not remove it/i)).toBeNull();
  });

  it('a resolvable shared section renders its name and offers Detach (the other control)', () => {
    view({ sharedSections: [SHARED], sharedFailed: false });
    // `getAllBy` — the name appears on the block AND in the add-a-shared-section
    // picker below it; the point of this arm is that it resolved at all.
    expect(screen.getAllByText('Site header').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /detach/i })).toBeTruthy();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });
});

describe('CMS2-B5 — the PREVIEW does not render the page as if the block were gone', () => {
  // The third and most persuasive consequence of the same swallowed read: with
  // the ref block dropped from both previews, the editor SEES a headerless page.
  // Nothing else on the screen argues as hard for pressing Remove.
  const REF = REF_SECTION as never;
  const INLINE = { sectionId: 's2', type: 'prose', data: { markdown: 'Body.' } } as never;

  it('keeps an unresolvable block when the list read FAILED', () => {
    const out = resolveSharedRefs([REF, INLINE], [], true);
    expect(out.map((s) => s.sectionId)).toEqual(['s1', 's2']);
  });

  it('drops it when the shared section is GENUINELY gone (the negative control)', () => {
    // Both polarities from the same helper — an "it is kept" assertion alone
    // would pass against a helper that never drops anything.
    const out = resolveSharedRefs([REF, INLINE], [], false);
    expect(out.map((s) => s.sectionId)).toEqual(['s2']);
  });

  it('resolves to the shared content when the read succeeded', () => {
    const out = resolveSharedRefs([REF], [SHARED as never], false);
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toEqual({ heading: 'Ship faster' });
  });
});
