/**
 * Channel Manager chat tools (CFP-1 repair — CHAT-FIRST-PORT-AUDIT finding #1;
 * D9 field-sales port map row 1 "RIDES").
 *
 * The `feature.dealers.agents` Channel Manager used to allowlist raw node typeIds
 * (`openwop:feature.dealers.nodes.list-dealers`, …) that NO host registrant
 * projects into a conversational tool — silently dropped, persona toothless.
 * These register the READ surface the advisory agent needs, over the SAME entity
 * accessors the HTTP routes call, behind the SAME predicate (toggle `dealers` ON
 * + the caller's RFC 0049 `workspace:read` in the named org).
 *
 * Advisory-read posture (D9): the agent answers channel questions and triages
 * pending registrations, PROPOSING which to approve — a human disposes through
 * the governed `host:dealers:manage` route. There is deliberately NO
 * approve-registration tool here (the port map's Phases 3-4, not this repair).
 *
 * Vuln posture (the kicktodo-core precedent): a read FAILS EMPTY without an
 * acting user; an unknown/unauthorized org is a fail-closed empty read; a
 * disabled feature is a typed `feature_disabled`.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveReadOrgScope, str } from '../../host/agentToolKit.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listDealers, listOutlets } from './entities/dealer.js';
import { listRegistrations } from './entities/registration.js';

export const DEALERS_LIST_DEALERS_TOOL_ID = 'openwop:dealers.list-dealers';
export const DEALERS_LIST_OUTLETS_TOOL_ID = 'openwop:dealers.list-outlets';
export const DEALERS_LIST_REGISTRATIONS_TOOL_ID = 'openwop:dealers.list-registrations';

/** The SAME access decision the read routes make (`authorizeOrgScope` → toggle +
 *  `resolveEffectiveAccess` `workspace:read` in the org), via the shared read
 *  gate: no-user ⇒ empty, disabled ⇒ typed `feature_disabled`, unknown-org /
 *  no-scope ⇒ empty (CFPT-1). */
const resolveDealerRead = (scope: BundleScope, orgIdInput?: string) =>
  resolveReadOrgScope(scope, { featureId: 'dealers', featureLabel: 'Dealer Network' }, orgIdInput);

export function registerDealerAgentTools(): void {
  const orgProp = { orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' } };

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DEALERS_LIST_DEALERS_TOOL_ID,
      description: "List the org's dealers (channel partners over CRM companies), optionally filtered by `territoryId` or `status`. Read-only.",
      inputSchema: { type: 'object', properties: { ...orgProp, territoryId: { type: 'string', description: 'Optional territory filter.' }, status: { type: 'string', description: 'Optional status filter (e.g. active/suspended).' } }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveDealerRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ dealers: [] }) };
      if (r.kind === 'error') return r.result;
      const filter = { ...(str(input.territoryId) ? { territoryId: str(input.territoryId)! } : {}), ...(str(input.status) ? { status: str(input.status)! } : {}) };
      return { content: JSON.stringify({ dealers: await listDealers(scope.tenantId, r.orgId, filter) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DEALERS_LIST_OUTLETS_TOOL_ID,
      description: "List the org's retail outlets (store-location records), optionally filtered to one dealer via `dealerId`. Read-only.",
      inputSchema: { type: 'object', properties: { ...orgProp, dealerId: { type: 'string', description: 'Optional dealer filter.' } }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveDealerRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ outlets: [] }) };
      if (r.kind === 'error') return r.result;
      const filter = { ...(str(input.dealerId) ? { dealerId: str(input.dealerId)! } : {}) };
      return { content: JSON.stringify({ outlets: await listOutlets(scope.tenantId, r.orgId, filter) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DEALERS_LIST_REGISTRATIONS_TOOL_ID,
      // R2 DLR2-M5 — "the governed admin route" has not existed since CFP-1 demolished
      // the bespoke approve/reject endpoints; the decision moved to the SHARED Reviews
      // inbox. A model obeying this sentence sends the user to the Dealers console to
      // click a button that is not there. Also names `queueFailed`, so a registration
      // whose review card never landed is not reported as "awaiting review".
      description: "List partner deal-registrations, optionally filtered by `dealerId` or `status` (e.g. `pending` to triage what awaits approval). Read-only. The agent PROPOSES which to approve; a human disposes in the shared Reviews inbox (the decision needs host:dealers:manage) — there is no approve/reject control on the Dealers page. A row with `queueFailed: true` was saved but its review card never reached the inbox, so nobody has been asked to decide it: say so rather than calling it awaiting review.",
      inputSchema: { type: 'object', properties: { ...orgProp, dealerId: { type: 'string', description: 'Optional dealer filter.' }, status: { type: 'string', description: 'Optional status filter (pending/approved/rejected).' } }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveDealerRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ registrations: [] }) };
      if (r.kind === 'error') return r.result;
      const filter = { ...(str(input.dealerId) ? { dealerId: str(input.dealerId)! } : {}), ...(str(input.status) ? { status: str(input.status)! } : {}) };
      return { content: JSON.stringify({ registrations: await listRegistrations(scope.tenantId, r.orgId, filter) }) };
    },
  });
}
