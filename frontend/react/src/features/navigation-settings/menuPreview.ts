import { FEATURES } from '../../chrome/features.js';
import { resolveNav, type AccessPredicate, type NavAuthority, type ResolvedNav } from '../../chrome/navConfig/resolveNav.js';
import { EMPTY_MENU_CONFIG, type MenuConfig, type MenuConfigBundle } from '../../chrome/navConfig/types.js';

export type MenuPreviewScope = 'user' | 'tenant';

/** Preview through the production resolver. Tenant previews intentionally omit
 * the current operator's personal overlay: this is what everyone will inherit. */
export function resolveMenuPreview(scope: MenuPreviewScope, working: MenuConfig, bundle: MenuConfigBundle, access: AccessPredicate, authority: NavAuthority): ResolvedNav {
  return resolveNav({
    features: FEATURES,
    tenant: scope === 'tenant' ? working : bundle.tenant,
    user: scope === 'tenant' ? EMPTY_MENU_CONFIG : working,
    access,
    authority,
  });
}
