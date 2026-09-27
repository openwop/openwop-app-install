/**
 * Team channels / real-time messaging (ADR 0126, backlog B18). A channel is a new
 * conversation `type:'channel'` over the existing conversation store — NOT a second
 * chat system. v1 local-host, presence-free (presence/typing/receipts + cross-host
 * are RFC-gated). A `channels` toggle, off by default, per tenant.
 *
 * @see docs/adr/0126-team-channels-realtime-messaging.md
 * @see docs/adr/0192-channels-ux-identity-parity.md
 */
import type { BackendFeature } from '../types.js';
import { registerChannelRoutes } from './routes.js';
import { registerChannelsAgentTools } from './agentTools.js';
import { setAgentLabelResolver } from '../../host/subjectDisplay.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';

export const channelsFeature: BackendFeature = {
  id: 'channels',
  registerRoutes: (deps) => {
    registerChannelRoutes(deps);
    registerChannelsAgentTools(); // XCH-HOLE-7 (round 3) — openwop:channels.list (ADR 0308 seam)
    // ADR 0192 D2 — legacy agent members (no add-time `displayLabel`) resolve
    // their display through the registry; current members carry the label on
    // the participant record and never reach this resolver.
    // ADR 0379 P1 audit disposition: no tenant gate NEEDED here — the ids come
    // from the conversation's own participant records (tenant-owned rows, adds
    // are tenant-gated in addChannelAgent), and only label/persona is read.
    setAgentLabelResolver(async (tenantId, agentIds) => {
      const out = new Map<string, string>();
      await Promise.all(agentIds.map(async (id) => {
        try {
          const resolved = await getAgentRegistry().resolve(id, tenantId);
          if (resolved) out.set(id, resolved.label ?? resolved.persona);
        } catch { /* fall back at the seam */ }
      }));
      return out;
    });
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
