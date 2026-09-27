/**
 * kicktodo-integrations chat tool (ADR 0421 / ADR 0308 seam) — a READ so the
 * participant's integration SETUP STATE is visible in the ONE chat.
 *
 * The integration setup surface (grant/revoke a calendar or messaging consent,
 * link/unlink a wearable, mint a feed) is REST-only and was invisible to
 * KickBot, so it could not honestly answer "is my calendar connected?" This
 * tool reports the ACTING USER's OWN state only — consents, linked wearables,
 * and the deployment's calendar-transport readiness. It is READ-ONLY: setup
 * WRITES stay route-level with the acting human (the accountability precedent —
 * this tool never grants consent or links a device).
 *
 * Vuln-scan posture (the kicktodo-core reads precedent): FAILS EMPTY without an
 * acting user — a scheduled/system turn with no human principal must never
 * enumerate a participant's integration state. Toggle-off is honest, not an
 * error: the tool reports `enabled: false` with empty state.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listConsents, CONSENT_KINDS } from './integrationService.js';
import { listWearableLinksForSubject } from './wearableLinkService.js';
import { isCalendarTransportConfigured } from './calendarWriteService.js';

/** SSoT for the tool id. Inlined as a literal wherever a kicktodo-core module
 *  references it (KickBot's allowlist), because kicktodo-core must not import UP
 *  into kicktodo-integrations (dependsOn direction — an import cycle). */
export const KICKTODO_INTEGRATIONS_STATUS_TOOL_ID = 'openwop:kicktodo.integrations-status';

export function registerKicktodoIntegrationsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: KICKTODO_INTEGRATIONS_STATUS_TOOL_ID,
      description:
        "The user's KickTodo integration setup state: which consents they have granted "
        + '(calendar projection, calendar write, wearable evidence, messaging reminders), which wearable '
        + 'providers are linked, and whether this deployment has a calendar-write transport configured at all. '
        + 'Use it to answer "is my calendar/wearable connected?" and to tell them what is left to set up. '
        + 'Read-only — granting a consent or linking a device is done by the user on the integrations page, not here.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      // Fail EMPTY without a human principal — never enumerate a participant's
      // integration state from a system/scheduled turn.
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ enabled: false, consents: [], wearableLinks: [], calendarTransportConfigured: false }) };
      }
      // Per-call toggle honesty (per-tenant, dynamic). Disabled ⇒ honest empty,
      // NOT an error (a read fails empty).
      const featureOn = await resolveFeatureToggle('kicktodo-integrations', scope);
      if (!featureOn) {
        return { content: JSON.stringify({ enabled: false, consents: [], wearableLinks: [], calendarTransportConfigured: false }) };
      }

      const granted = await listConsents(scope.tenantId, scope.actingUserId);
      const consents = CONSENT_KINDS.map((kind) => {
        const c = granted.find((g) => g.kind === kind);
        const live = Boolean(c && !c.revokedAt);
        return { kind, consented: live, ...(live && c ? { grantedAt: c.grantedAt } : {}) };
      });
      const links = await listWearableLinksForSubject(scope.tenantId, scope.actingUserId);
      const wearableLinks = links.map((l) => ({ provider: l.provider, linkedAt: l.linkedAt }));

      return {
        content: JSON.stringify({
          enabled: true,
          consents,
          wearableLinks,
          // Deployment-global: whether a calendar-write transport exists at all
          // (the honest "a sync could run" signal — ADR 0466 ships it gated-off).
          calendarTransportConfigured: isCalendarTransportConfigured(),
        }),
      };
    },
  });
}
