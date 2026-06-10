/**
 * Widgets — the first feature converted to the BackendFeature contract
 * (ADR 0001 §2.2/§6 step 2). Previously a bare ROUTE_MODULES entry; now the
 * canonical example of a self-contained feature package's backend half.
 *
 * Behavior-preserving: registerWidgetRoutes keeps its own
 * OPENWOP_EXAMPLE_WIDGETS_ENABLED env gate (route mounting), so existing
 * deploys are unchanged. The added `feature.widgets` toggle is the
 * forward-looking activation surface (off by default, matching the env
 * default) — features authored after this one gate their UI/nav on the toggle
 * via useFeatureAccess.
 */

import type { BackendFeature } from './types.js';
import { registerWidgetRoutes } from '../routes/widgets.js';

export const widgetsFeature: BackendFeature = {
  id: 'widgets',
  registerRoutes: ({ app }) => registerWidgetRoutes(app),
  toggleDefault: {
    id: 'widgets',
    label: 'Example widgets',
    description: 'Reference host-extension vertical slice (white-label PRD §4).',
    category: 'Examples',
    status: 'off',
    bucketUnit: 'user',
    salt: 'widgets',
  },
};
