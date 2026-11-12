/**
 * ADR 1100 D3 — where an issue is, and what the check says aloud.
 *
 * Red when: the panel numbers over the page's raw sections instead of the
 * resolved list the editor shows, so a deleted shared reference shifts every
 * later number (case 1); the image number is lost (case 2); an incomplete check
 * is announced as clean, or a count drops the incomplete note (case 3); shared
 * sections still LOADING count as read (case 4); Go to from another tab tries to
 * scroll a canvas that is not mounted (case 5).
 */
import { describe, it, expect } from 'vitest';
import { a11yCheckAnnouncement, a11yLocateAction, a11yRefPosition, a11ySharedUnreadOf } from '../a11yLocation.js';
import { resolveSharedRefs } from '../resolveSharedRefs.js';
import type { Section } from '../cmsClient.js';

const raw: Section[] = [
  { sectionId: 'gone', type: 'image', data: {}, ref: { sharedSectionId: 'deleted' } },
  { sectionId: 'img', type: 'image', data: { token: 't', alt: '' } },
];

describe('a11yRefPosition', () => {
  it('numbers as the editor lists sections: a deleted shared reference is not counted', () => {
    const resolved = resolveSharedRefs(raw, [], false); // the read succeeded; "deleted" is gone
    expect(a11yRefPosition(resolved, 'img')).toMatchObject({ n: 1, section: { sectionId: 'img' } });
    expect(a11yRefPosition(resolved, 'gone')).toBeUndefined();
  });

  it('carries the image number of a `<id>#<n>` ref', () => {
    expect(a11yRefPosition(raw, 'img#3')).toMatchObject({ n: 2, item: 3 });
  });
});

describe('a11yCheckAnnouncement', () => {
  it('never announces an incomplete check as clean', () => {
    expect(a11yCheckAnnouncement(0, false)).toEqual([{ key: 'panelNone' }]);
    expect(a11yCheckAnnouncement(0, true)).toEqual([{ key: 'panelIncompleteShared' }]);
    expect(a11yCheckAnnouncement(2, true)).toEqual([{ key: 'panelSummary', params: { count: 2 } }, { key: 'panelIncompleteShared' }]);
    expect(a11yCheckAnnouncement(2, false)).toEqual([{ key: 'panelSummary', params: { count: 2 } }]);
  });
});

describe('a11ySharedUnreadOf', () => {
  it('loading or failed shared sections make a page with references incomplete', () => {
    expect(a11ySharedUnreadOf(false, false, raw)).toBe(true); // still loading
    expect(a11ySharedUnreadOf(true, true, raw)).toBe(true); // the read failed
    expect(a11ySharedUnreadOf(false, true, raw)).toBe(false); // read
    expect(a11ySharedUnreadOf(false, false, [raw[1]!])).toBe(false); // no references at all
  });
});

describe('a11yLocateAction', () => {
  it('scrolls only on the Edit tab; elsewhere it opens the editor', () => {
    expect(a11yLocateAction('edit')).toBe('jump');
    expect(a11yLocateAction('page')).toBe('open');
    expect(a11yLocateAction('preview')).toBe('open');
  });
});
