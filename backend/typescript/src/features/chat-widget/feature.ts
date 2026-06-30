/**
 * Public embeddable chat widget (ADR 0127, backlog B19) — a domain-allowlisted,
 * capability-token-gated public gateway over the EXISTING chat (ADR 0073
 * EmbeddedConversation), NOT a second chat component.
 *
 * PUB-5 (doc correction): the feature is ALWAYS-ON — the per-tenant `chat-widget` toggle
 * was deliberately removed in the ADR 0134 graduation (see the comment below). A tenant
 * controls its public exposure per-WIDGET: a widget serves only when `enabled` AND it has
 * a token + a non-empty `allowedDomains` allowlist, so a tenant with no enabled widgets has
 * no public surface. There is intentionally no wholesale tenant kill-switch.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import type { BackendFeature } from '../types.js';
import { registerChatWidgetRoutes } from './routes.js';
import { registerChatWidgetPublicGateway } from './publicGateway.js';
import { presentationEnabled } from '../../host/hostProfile.js';

export const chatWidgetFeature: BackendFeature = {
  id: 'chat-widget',
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
  // ADR 0168 — the operator CRUD routes are a normal org-scoped API and stay mounted;
  // only the PUBLIC embed gateway (the browser-render surface) is withheld in
  // OPENWOP_PROFILE=headless. (chatWidget advertises no blanket discovery capability —
  // it gates per-widget at runtime — so there is no advert to co-gate; see ADR 0168
  // correction note. The gate here unmounts the browser surface, the part that matters.)
  registerRoutes: (deps) => {
    registerChatWidgetRoutes(deps);
    if (presentationEnabled('chatWidget')) registerChatWidgetPublicGateway(deps);
  },
};
