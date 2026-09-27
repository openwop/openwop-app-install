/**
 * CSM chat tools (CFP-1 repair; ADR 0308 D2 seam) — the health-insights
 * persona's REAL grounding over the customer-success accounts store.
 *
 * Born of the CHAT-FIRST-PORT-AUDIT #1 finding (docs/chat-first-port/
 * d1-crm-csm.md): the `feature.csm.agents` pack allowlisted the node typeId
 * `openwop:feature.csm.nodes.health-read`, which NO host registrant provided, so
 * `compileAgentTools` silently dropped it and the read-only insights agent ran
 * in the ONE chat with zero tools — surfacing "at-risk accounts" from
 * hallucinated numbers. The node is SURFACE-backed (`ctx.features.csm`), not
 * pure compute, so this bridges the CSM surface into chat via the sanctioned
 * `registerFeatureAgentTool` seam (the campaign-intel / crm precedent).
 *
 * Authority parity: the tool builds `ctx.features.csm` (buildCsmSurface) — the
 * SAME adapter the routes and workflow nodes call. CSM is TENANT-scoped (the
 * routes gate on the `csm` toggle only, no org), so the gate is toggle + acting
 * user: FAIL EMPTY without a human principal (a scheduled/system turn must not
 * enumerate a workspace's accounts). Read-only by design — the persona reports,
 * it never mutates health (no write tool in its allowlist). Toggle honesty lives
 * in the `run` (per-tenant dynamic; disabled ⇒ typed `feature_disabled`).
 *
 * @see docs/chat-first-port/d1-crm-csm.md
 * @see docs/adr/0212-csm-crm-linkage.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { toolFailLog } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { checkTenantEntitlement } from '../../host/entitlementSeam.js';
import { buildCsmSurface } from './surface.js';

const csmLog = createLogger('csm.agent-tools');

const TOGGLE_ID = 'csm';

export const CSM_HEALTH_READ_TOOL_ID = 'openwop:feature.csm.nodes.health-read';

type ToolResult = { content: string; isError?: boolean };

function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (ADR 0308 D2) — per-tenant + per-user subject, the
 *  SAME `{tenantId, userId}` the routes' `subjectOf` builds. */
async function csmEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne(TOGGLE_ID, { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

export function registerCsmAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CSM_HEALTH_READ_TOOL_ID,
      description:
        'Read customer-success accounts ordered by health (most at-risk first), or ONE account by `accountId`, over the '
        + 'CSM surface. This is your ONLY source of truth — never invent an account, score, or activity. Returns { accounts } '
        + '(or { account } when `accountId` is given). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Optional — fetch a single account by id instead of the at-risk list.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope: BundleScope): Promise<ToolResult> {
      if (!(await csmEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'CSM is not enabled for this workspace — tell the user you cannot read customer-success accounts here.');
      }
      // FAIL EMPTY — a scheduled/system turn with no human principal must not
      // enumerate a workspace's accounts.
      if (!scope.actingUserId) return { content: JSON.stringify({ accounts: [] }) };
      // CSMWF-1 / ADR 0645 D1 — SHARE THE ROUTE'S PREDICATE. `GET /accounts`
      // gates on `workspace:read` (`routes.ts:150`); this tool used to gate on
      // the toggle alone and then do a tenant-wide `listAccounts`, so a member
      // with no `workspace:read` was refused by the route and handed the whole
      // account book — ARR, renewal dates, owner attribution — through chat.
      // `assertTenantScope` is the same predicate `requireTenantScope` wraps for
      // the HTTP lane, and the sibling `crm/agentTools.ts` already calls it.
      // `read`, not `write`: this tool only reads, and over-gating would refuse
      // legitimate readers. Sharing the DATA adapter (`buildCsmSurface`) is not
      // sharing the ACCESS predicate — conflating the two is what hid this.
      try {
        await checkTenantEntitlement(scope.tenantId, TOGGLE_ID);
        await assertTenantScope(scope.tenantId, scope.actingUserId, 'workspace:read', {
          ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}),
        });
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details ?? undefined);
        return toolFailLog(csmLog, 'openwop:csm', err);
      }
      const accountId = str(input.accountId);
      try {
        const surface = buildCsmSurface(scope);
        if (accountId) return { content: JSON.stringify(await surface.getAccount!({ accountId })) };
        return { content: JSON.stringify(await surface.listAccounts!({})) };
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details ?? undefined);
        return toolFailLog(csmLog, 'openwop:csm', err); // CFPT-6
      }
    },
  });
}
