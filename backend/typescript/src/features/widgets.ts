/**
 * Widgets — the canonical *example* of a self-contained feature package's
 * backend half (ADR 0001 §2.2/§6 step 2). It is a reference vertical slice, NOT
 * a product feature, so it carries **no `toggleDefault`** — it never belonged in
 * the per-tenant Feature-toggles catalog (removed 2026-06-11). Activation is its
 * own deploy-time `OPENWOP_EXAMPLE_WIDGETS_ENABLED` env gate (route mounting),
 * which is the right control for an example surface.
 */

import type { BackendFeature } from './types.js';
import { registerWidgetRoutes } from '../routes/widgets.js';

export const widgetsFeature: BackendFeature = {
  id: 'widgets',
  registerRoutes: ({ app }) => registerWidgetRoutes(app),
  // No `toggleDefault` — env-gated example, not a product toggle.
};
