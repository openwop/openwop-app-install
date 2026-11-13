/**
 * ADR 1105 D11 — `siteNav.groupLabel`, an authored heading for a page's nav
 * group (#5779 item 8). Trimmed and capped like `label`; a non-string or a
 * label on a page with no `group` is a 400, never a silent drop; blank is
 * dropped. Red when: the field is not kept, the group requirement goes, or the
 * cap is not applied.
 */
import { describe, expect, it } from 'vitest';
import { cleanSiteNav } from '../src/features/cms/cmsService.js';
import { OpenwopError } from '../src/types.js';

describe('cleanSiteNav groupLabel (ADR 1105 D11)', () => {
  it('keeps a trimmed, capped heading beside its group', () => {
    expect(cleanSiteNav({ group: 'product', groupLabel: '  Try it  ' })).toEqual({ group: 'product', groupLabel: 'Try it' });
    expect(cleanSiteNav({ group: 'company', groupLabel: 'x'.repeat(60) })?.groupLabel).toHaveLength(40);
  });

  it('refuses a heading with no group, and a non-string', () => {
    expect(() => cleanSiteNav({ groupLabel: 'Try it' })).toThrow(OpenwopError);
    expect(() => cleanSiteNav({ groupLabel: 'Try it' })).toThrow(/needs `siteNav.group`/);
    expect(() => cleanSiteNav({ group: 'product', groupLabel: 7 })).toThrow(/must be a string/);
  });

  it('drops a blank heading', () => {
    expect(cleanSiteNav({ group: 'trust', groupLabel: '   ' })).toEqual({ group: 'trust' });
  });
});
