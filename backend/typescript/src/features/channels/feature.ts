/**
 * Team channels / real-time messaging (ADR 0126, backlog B18). A channel is a new
 * conversation `type:'channel'` over the existing conversation store — NOT a second
 * chat system. v1 local-host, presence-free (presence/typing/receipts + cross-host
 * are RFC-gated). A `channels` toggle, off by default, per tenant.
 *
 * @see docs/adr/0126-team-channels-realtime-messaging.md
 */
import type { BackendFeature } from '../types.js';
import { registerChannelRoutes } from './routes.js';

export const channelsFeature: BackendFeature = {
  id: 'channels',
  registerRoutes: (deps) => { registerChannelRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
