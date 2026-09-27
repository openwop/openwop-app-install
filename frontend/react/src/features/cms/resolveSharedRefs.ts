/**
 * resolveSharedRefs — how a page's inherit-by-reference blocks (ADR 0204 C4)
 * render in the editor's previews.
 *
 * Extracted from `CmsPage` during UX_UPGRADE-content R2 (CMS2-B5) because the
 * rule turned out to have a THIRD case nobody had named, and an unnamed case
 * inside a `useMemo` is a case no test can reach:
 *
 *   1. the `ref` resolves         → render the shared section's content
 *   2. the shared section is GONE → drop the block (the page really is short one)
 *   3. **the LIST READ FAILED**   → keep the block
 *
 * Case 3 was being handled as case 2. Dropping a block you cannot resolve is
 * only honest when you KNOW it is gone; when the read failed you know nothing,
 * and rendering the page without its header — beside an editor block reading
 * "Shared section no longer exists" and offering Remove — is the most
 * persuasive possible argument for destroying a `ref` that may be on every page
 * in the org. Recovery is version history.
 */
import type { Section, SharedSection } from './cmsClient.js';

export function resolveSharedRefs(
  sections: readonly Section[],
  sharedSections: readonly SharedSection[],
  /** The shared-section LIST READ failed — unresolvable means "unknown", not "deleted". */
  sharedFailed: boolean,
): Section[] {
  return sections
    .map((s) => {
      if (!s.ref) return s;
      const sh = sharedSections.find((x) => x.sharedSectionId === s.ref?.sharedSectionId);
      if (sh) return { ...s, type: sh.type, data: sh.data, ...(sh.localizations ? { localizations: sh.localizations } : {}) };
      return sharedFailed ? s : null;
    })
    .filter((s): s is Section => s !== null);
}
