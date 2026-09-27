/**
 * Models console (ADR 0145) — a FRONTEND-ONLY consolidation console.
 *
 * There is NO route, service, surface, pack, or wire: the console mounts
 * existing owners (Model Router, Evals leaderboard) and adds nothing to the
 * protocol surface.
 *
 * § Correction (ADR 0434) — graduated off its toggle to always-on.
 * The backend half existed solely to register a toggle so the frontend nav gate
 * could resolve server-side (the FE is never the authority — ADR 0001 §3.4).
 * But the toggle only ever chose a NAVIGATION SHAPE, not a capability: ON
 * rendered one hub with two tabs; OFF rendered the same two routes standalone
 * via `hiddenWhenFeature`. Nothing was gained or lost functionally either way,
 * and both destinations stayed reachable in both states — so the toggle was an
 * unresolved information-architecture decision deferred to per-tenant
 * configuration rather than a product option. Its contents (`model-router`) had
 * already graduated to always-on in ADR 0134; the wrapper outliving the thing
 * it wrapped was the drift. Pick one nav shape: the hub.
 *
 * @see docs/adr/0145-surface-rehoming-chat-and-platform-declutter.md
 * @see docs/adr/0434-graduate-substrate-toggles.md
 */
import type { BackendFeature } from '../types.js';

export const modelsFeature: BackendFeature = {
  id: 'models',
  // Frontend-only: no HTTP surface. The console composes existing owners' routes.
  registerRoutes: () => {},
  // No toggleDefault — graduated off its toggle (§ Correction above).
};
