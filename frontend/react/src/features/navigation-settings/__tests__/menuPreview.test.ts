/**
 * Menu Settings live preview (ADR 0139) renders through the production resolver.
 * A personal (`user`) preview layers the draft over the tenant default; a
 * workspace-default (`tenant`) preview is what EVERYONE will inherit, so it must
 * not include the editing operator's own personal overlay. Each case is the
 * other's positive control (`/operations` is feature-gated, so `hidden` applies).
 */
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
