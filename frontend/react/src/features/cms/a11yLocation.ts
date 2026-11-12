/**
 * ADR 1100 D3 — where an accessibility issue is on a CMS page, and what the check
 * announces. Pure, so the panel's numbering and the spoken result are testable
 * apart from CmsPage.
 */
import { splitA11yRef } from './cmsA11y.js';
import type { Section } from './cmsClient.js';

/** The issue's section and its 1-based position, numbered over the RESOLVED
 *  sections: the list the editor's Sections menu and canvas show (a reference to
 *  a deleted shared section is not in it). */
export function a11yRefPosition(resolved: readonly Section[], nodeRef: string): { n: number; section: Section; item?: number } | undefined {
  const { sectionId, item } = splitA11yRef(nodeRef);
  const i = resolved.findIndex((s) => s.sectionId === sectionId);
  const section = resolved[i];
  if (!section) return undefined;
  return { n: i + 1, section, ...(item === undefined ? {} : { item }) };
}

/** The `a11y` keys the check speaks, in order. An incomplete check is never
 *  announced as clean, and a count is followed by the incomplete note. */
export function a11yCheckAnnouncement(count: number, incomplete: boolean): Array<{ key: string; params?: Record<string, number> }> {
  if (count === 0) return [{ key: incomplete ? 'panelIncompleteShared' : 'panelNone' }];
  return [{ key: 'panelSummary', params: { count } }, ...(incomplete ? [{ key: 'panelIncompleteShared' }] : [])];
}

/** Whether the check is incomplete: the page has shared references whose
 *  content is not read yet (loading) or could not be read (failed). */
export function a11ySharedUnreadOf(sharedFailed: boolean, sharedLoaded: boolean, sections: readonly Section[]): boolean {
  return (sharedFailed || !sharedLoaded) && sections.some((s) => s.ref);
}

/** "Go to" on the Edit tab scrolls to the section (its canvas is mounted); from
 *  another tab it opens the section's editor, which mounts the canvas. */
export function a11yLocateAction(workspaceMode: string): 'jump' | 'open' {
  return workspaceMode === 'edit' ? 'jump' : 'open';
}
