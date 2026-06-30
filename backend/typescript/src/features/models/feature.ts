/**
 * Models console (ADR 0145) — a FRONTEND-ONLY consolidation console.
 *
 * The backend half exists solely to register the `models` feature toggle
 * (default OFF, tenant-bucketed) so the frontend nav gate resolves server-side
 * (the FE is never the authority — ADR 0001 §3.4). There is NO route, service,
 * surface, pack, or wire: the console mounts existing owners (Model Router,
 * Evals leaderboard) and adds nothing to the protocol surface.
 *
 * @see docs/adr/0145-surface-rehoming-chat-and-platform-declutter.md
 */
import type { BackendFeature } from '../types.js';

export const modelsFeature: BackendFeature = {
  id: 'models',
  // Frontend-only: no HTTP surface. The console composes existing owners' routes.
  registerRoutes: () => {},
  toggleDefault: {
    id: 'models',
    label: 'Models console',
    description:
      'One console for model routing + the model leaderboard — choose which model answers and see which performs (ADR 0145).',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'models',
  },
};
