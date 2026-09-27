import { describe, expect, it } from 'vitest';
import { EMPTY_MENU_CONFIG } from '../../../chrome/navConfig/types.js';
import { resolveMenuPreview } from '../menuPreview.js';

const authority = { admin: true, superadmin: true, scopes: [] };

describe('Menu Settings live preview parity', () => {
  it('user preview merges the tenant default beneath the draft', () => {
    const preview = resolveMenuPreview('user', EMPTY_MENU_CONFIG, {
      tenant: { headers: [], items: { '/operations': { hidden: true } } },
      user: EMPTY_MENU_CONFIG,
    }, () => true, authority);
    expect(preview.admin.flatMap((group) => group.items).some((item) => item.to === '/operations')).toBe(false);
  });

  it('workspace-default preview excludes the current operator personal overlay', () => {
    const preview = resolveMenuPreview('tenant', EMPTY_MENU_CONFIG, {
      tenant: EMPTY_MENU_CONFIG,
      user: { headers: [], items: { '/operations': { hidden: true } } },
    }, () => true, authority);
    expect(preview.admin.flatMap((group) => group.items).some((item) => item.to === '/operations')).toBe(true);
  });
});
