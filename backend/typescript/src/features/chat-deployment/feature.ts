/**
 * Chat deployment console (ADR 0145) — a FRONTEND-ONLY consolidation console.
 *
 * The backend half exists solely to register the `chat-deployment` feature toggle
 * (default OFF, tenant-bucketed) so the frontend nav gate resolves server-side
 * (the FE is never the authority — ADR 0001 §3.4). There is NO route, service,
 * surface, pack, or wire: the console mounts existing owners (Scheduled chats,
 * Chat widgets) and adds nothing to the protocol surface.
 *
 * @see docs/adr/0145-surface-rehoming-chat-and-platform-declutter.md
 */
import type { BackendFeature } from '../types.js';

export const chatDeploymentFeature: BackendFeature = {
  id: 'chat-deployment',
  // Frontend-only: no HTTP surface. The console composes existing owners' routes.
  registerRoutes: () => {},
  toggleDefault: {
    id: 'chat-deployment',
    label: 'Chat deployment console',
    description:
      'One console for putting the AI chat to work without someone in the seat — scheduled runs + the public website widget (ADR 0145).',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'chat-deployment',
  },
};
