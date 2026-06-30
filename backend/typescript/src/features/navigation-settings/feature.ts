/**
 * Navigation settings (ADR 0139) — the host-extension backend for the
 * configurable navigation menu: a per-tenant default + per-user personalization
 * overlay over the declared nav. Always-on (no toggle): with empty config the
 * menu is identical to today, so there is no risk surface to gate.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */
import type { BackendFeature } from '../types.js';
import { registerNavigationSettingsRoutes } from './routes.js';

export const navigationSettingsFeature: BackendFeature = {
  id: 'navigation-settings',
  registerRoutes: (deps) => {
    registerNavigationSettingsRoutes(deps);
  },
  // No toggleDefault → always-on.
};
