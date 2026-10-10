/**
 * Public embeddable chat widget (ADR 0127, backlog B19) — a domain-allowlisted,
 * capability-token-gated public gateway over the EXISTING chat (ADR 0073
 * EmbeddedConversation), NOT a second chat component.
 *
 * Toggle: `chat-widget`, default ON, per tenant. ADR 0820 §8.2 restored it (the
 * ADR 0134 graduation had removed it, and PUB-5 recorded "no wholesale tenant
 * kill-switch") so the feature can be sold in the Support bundle. The operator
 * routes gate on toggle + plan (`authorizeOrgScope`). The PUBLIC gateway gates on
 * the toggle only (`resolveToggle`): a visitor is never refused on the owner's
 * plan (ADR 0176 shopper exemption); the owner-lapse policy is ADR 0820 §7's.
 * Per-widget control is unchanged: a widget serves only when `enabled` AND it has a
 * token + a non-empty `allowedDomains` allowlist.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import type { BackendFeature } from '../types.js';
import { registerChatWidgetRoutes } from './routes.js';
import { registerChatWidgetPublicGateway } from './publicGateway.js';
import { presentationEnabled } from '../../host/hostProfile.js';
import { onRosterMemberDeleted } from '../../host/rosterLifecycle.js';
import { disableWidgetsForDeletedAgent, purgeTenantWidgetTokens } from './widgetService.js';
import { registerAnonSurfaceWriteGate } from '../../host/anonymousActor.js';
import { registerTenantPurgeHook } from '../../host/hostExtPersistence.js';

export const chatWidgetFeature: BackendFeature = {
  id: 'chat-widget',
  toggleDefault: {
    id: 'chat-widget',
    label: 'Website chat widget',
    description:
      'Embed the AI chat on your own website: domain-allowlisted widgets answered by one of your agents. Turn OFF to stop serving every widget at once (their settings are kept).',
    category: 'Support',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'chat-widget',
  },
  // ADR 0168 — the operator CRUD routes are a normal org-scoped API and stay mounted;
  // only the PUBLIC embed gateway (the browser-render surface) is withheld in
  // OPENWOP_PROFILE=headless. (chatWidget advertises no blanket discovery capability —
  // it gates per-widget at runtime — so there is no advert to co-gate; see ADR 0168
  // correction note. The gate here unmounts the browser surface, the part that matters.)
  registerRoutes: (deps) => {
    registerChatWidgetRoutes(deps);
    if (presentationEnabled('chatWidget')) registerChatWidgetPublicGateway(deps);
    // ADR 0469 A4 — the deferred-execution handler for a HELD anon write. Registered
    // unconditionally (not behind the presentation gate): an approval created while the
    // public surface was live must remain decidable even in headless mode.
    registerAnonSurfaceWriteGate();
    // ADR 0288 — disable (never delete) this feature's widgets when their roster
    // member is deleted: a widget is a live public credential; serving stops,
    // the authored config survives for re-assignment.
    onRosterMemberDeleted('chat-widget', async ({ tenantId, rosterId, agentId }) => {
      await disableWidgetsForDeletedAgent(tenantId, { rosterId, ...(agentId ? { agentId } : {}) });
    });
    // ADR 0590 tenant-teardown pre-hook: the token index (`chatwidget:tokenidx`)
    // keys by the opaque capability token with no tenant, so the generic
    // purgeTenantHostExt walk cannot reach it. This enumerates the tenant's
    // widgets (while they still resolve) and drops each one's token-index entry.
    registerTenantPurgeHook('chat-widget', purgeTenantWidgetTokens);
  },
};
