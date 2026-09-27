/**
 * Commissions Analyst chat tools (CFP-1 repair — CHAT-FIRST-PORT-AUDIT finding
 * #1; D9 field-sales port map row 1 "RIDES").
 *
 * The `feature.sales-commissions.agents` Commissions Analyst used to allowlist
 * raw node typeIds (`openwop:feature.sales-commissions.nodes.list-plans`, …) that
 * NO host registrant projects into a conversational tool — silently dropped,
 * persona toothless. These register the READ surface the advisory agent needs,
 * over the SAME entity accessors the HTTP routes call, behind the SAME predicate
 * (toggle `sales-commissions` ON + the caller's RFC 0049 `workspace:read`).
 *
 * Read-only MONEY posture (D9 money rule): these are read-only projections — the
 * host never moves money, and the agent NEVER computes or approves a statement
 * (those stay human-gated `host:commissions:manage` ops — the port map's Phases
 * 3-4, not this repair). Statement reads are SUBJECT-SCOPED exactly like the
 * route: a rep sees only their OWN statements unless they hold
 * `host:commissions:manage`.
 *
 * Vuln posture (the kicktodo-core precedent): a read FAILS EMPTY without an
 * acting user; an unknown/unauthorized org is a fail-closed empty read; a
 * disabled feature is a typed `feature_disabled`.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listPlans } from './entities/plan.js';
import { listStatements } from './entities/statement.js';

export const COMMISSIONS_LIST_PLANS_TOOL_ID = 'openwop:sales-commissions.list-plans';
export const COMMISSIONS_LIST_STATEMENTS_TOOL_ID = 'openwop:sales-commissions.list-statements';

type ToolResult = { content: string; isError?: boolean };

function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (the app-builder precedent): per-tenant, fail-closed. */
async function commissionsEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('sales-commissions', scope);
}

type ReadScope =
  | { kind: 'ok'; orgId: string; viewer: string; canSeeAll: boolean }
  | { kind: 'empty' }
  | { kind: 'error'; result: ToolResult };

/**
 * The SAME access decision the read routes make (`authorizeOrgScope` → toggle +
 * `resolveEffectiveAccess` `workspace:read` in the org), for a chat-tool scope.
 * Also resolves `canSeeAll` (`host:commissions:manage`) for the route's
 * statement subject-scoping — a rep sees only their own unless they hold manage.
 */
async function resolveCommissionRead(scope: BundleScope, orgIdInput?: string): Promise<ReadScope> {
  const viewer = scope.actingUserId;
  if (!viewer) return { kind: 'empty' };
  if (!(await commissionsEnabled(scope))) {
    return { kind: 'error', result: toolError('feature_disabled', 'The Sales Commissions feature is not enabled for this workspace — tell the user you cannot answer comp questions here.') };
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { kind: 'error', result: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`) };
  if (!orgs.some((o) => o.orgId === orgId)) return { kind: 'empty' };
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: viewer, orgId });
  if (!access.scopes.includes('workspace:read')) return { kind: 'empty' };
  return { kind: 'ok', orgId, viewer, canSeeAll: access.scopes.includes('host:commissions:manage') };
}

export function registerCommissionAgentTools(): void {
  const orgProp = { orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' } };

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMMISSIONS_LIST_PLANS_TOOL_ID,
      description: "List the org's commission plans (percentage/fixed rates + accelerators over CRM won deals and territory quota attainment). Read-only. Use to ground comp questions and PROPOSE plan changes — a human disposes.",
      inputSchema: { type: 'object', properties: { ...orgProp }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveCommissionRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ plans: [] }) };
      if (r.kind === 'error') return r.result;
      return { content: JSON.stringify({ plans: await listPlans(scope.tenantId, r.orgId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMMISSIONS_LIST_STATEMENTS_TOOL_ID,
      description: "List commission statements, optionally filtered by `subjectId` (the rep), `period` (YYYY-Qn or YYYY-MM), or `planId`. Read-only, and SUBJECT-SCOPED: a rep sees only their own statements unless they hold the commissions-manage scope. Use to explain how a rep's statement was computed.",
      inputSchema: { type: 'object', properties: { ...orgProp, subjectId: { type: 'string', description: 'Optional rep (deal owner) filter.' }, period: { type: 'string', description: 'Optional period filter (YYYY-Qn or YYYY-MM).' }, planId: { type: 'string', description: 'Optional plan filter.' } }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveCommissionRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ statements: [] }) };
      if (r.kind === 'error') return r.result;
      const statements = await listStatements(
        scope.tenantId,
        r.orgId,
        { subjectId: str(input.subjectId), period: str(input.period), planId: str(input.planId) },
        r.canSeeAll,
        r.viewer,
      );
      return { content: JSON.stringify({ statements }) };
    },
  });
}
