/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, unit E8 / MERCH-C) — the Discovery Curator's
 * REAL conversational tools.
 *
 * The agent pack (`feature.discovery.agents`) allowlisted node typeIds that no
 * provider projects into chat, so at dispatch every tool was silently dropped
 * (agentDispatch resolveAgentTools) — a persona that loads, answers, and can do
 * nothing. These `registerFeatureAgentTool` builtins fix that: one thin wrapper
 * per capability, delegating to the SAME service fns the REST routes call
 * (`discoveryService` — the single source of truth), and gated exactly like the
 * HTTP path (`authorizeOrgScope` → toggle + org RBAC via `resolveEffectiveAccess`).
 *
 * Collections + merch-rules carry NO money and are trivially reversible, so the
 * ADR 0058 chat-drivability review permits DIRECT agent authoring (no HITL gate)
 * — the same ruling `surface.ts` records. Read tools (`read before you write`)
 * fail EMPTY without an acting user; write tools fail TYPED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { claimIgnition, recordIgnitionRun, ignitionKey } from '../../host/ignitionGuard.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveFeatureToggle, toolFailLog } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import { listOrgs, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import {
  listCollections, createCollection, listMerchRules, createMerchRule, searchProducts,
} from './discoveryService.js';

export const DISCOVERY_SEARCH_TOOL_ID = 'openwop:discovery.search';
export const DISCOVERY_LIST_COLLECTIONS_TOOL_ID = 'openwop:discovery.list-collections';
export const DISCOVERY_LIST_RULES_TOOL_ID = 'openwop:discovery.list-rules';
export const DISCOVERY_CREATE_COLLECTION_TOOL_ID = 'openwop:discovery.create-collection';
export const DISCOVERY_CREATE_RULE_TOOL_ID = 'openwop:discovery.create-rule';

const FEATURE = 'discovery';
type ToolResult = { content: string; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: JSON.stringify(v) });
const toolError = (error: string, message: string): { content: string; isError: true } => ({ content: JSON.stringify({ error, message }), isError: true });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Resolve + AUTHORIZE the org a merch tool acts in, sharing the routes'
 * predicate (toggle → org membership → RFC 0049 scope via
 * `resolveEffectiveAccess`, exactly what `authorizeOrgScope`/`requireOrgScope`
 * enforce). The chat scope carries no `orgId`, so it is a tool arg (validated),
 * defaulting to the workspace's sole org (the common demo case).
 *
 * `mode:'read'` fails EMPTY (returns `{ empty: true }`) on every denial — no
 * acting user, toggle off, unknown/foreign org, missing scope — so a
 * system/scheduled turn or a wrong org never enumerates or leaks existence.
 * `mode:'write'` fails TYPED so the model can correct (`org_required`, etc.).
 * Ambiguity (many orgs, none named) is TYPED in both modes — the model must choose.
 */
// Mode-aware: a READ resolve may fail EMPTY (a system turn / no rows), so callers
// branch on `empty`; a WRITE resolve NEVER returns empty (every miss is typed), so
// its callers narrow straight to `{ orgId }` after the `error` branch.
async function resolveToolOrg(scope: BundleScope, orgIdArg: string | undefined, mode: 'read'): Promise<{ orgId: string } | { empty: true } | { error: ToolResult }>;
async function resolveToolOrg(scope: BundleScope, orgIdArg: string | undefined, mode: 'write'): Promise<{ orgId: string } | { error: ToolResult }>;
async function resolveToolOrg(
  scope: BundleScope,
  orgIdArg: string | undefined,
  mode: 'read' | 'write',
): Promise<{ orgId: string } | { empty: true } | { error: ToolResult }> {
  const required: Scope = mode === 'read' ? 'workspace:read' : 'workspace:write';
  const deny = (error: string, message: string): { empty: true } | { error: ToolResult } =>
    mode === 'read' ? { empty: true } : { error: toolError(error, message) };

  const featureOn = await resolveFeatureToggle(FEATURE, scope);
  if (!featureOn) return deny('feature_disabled', 'The Discovery feature is not enabled for this workspace.');
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return deny('acting_user_required', 'This tool runs on behalf of a signed-in user.');

  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdArg ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  // Ambiguity is always typed — an empty read would hide that the model must pick.
  if (!orgId) return { error: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`) };
  if (!orgs.some((o) => o.orgId === orgId)) return deny('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(required)) return deny('forbidden_scope', `The user lacks ${required} on that organization.`);
  return { orgId };
}

/** Map a service-layer OpenwopError (closed-world validation) into the typed
 *  tool error the agent loop feeds back as its ONE repair signal. */
const log = createLogger('discovery.agent-tools');
function fromServiceError(e: unknown): { content: string; isError: true } {
  if (e instanceof OpenwopError) return toolError(e.code, e.message);
  return toolFailLog(log, 'openwop:discovery', e) as { content: string; isError: true }; // CFPT-6
}

export function registerDiscoveryAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DISCOVERY_SEARCH_TOOL_ID,
      description:
        'Faceted product search over the storefront catalog (optionally scoped to a collection). '
        + 'Returns matching productIds + facet counts. Use it to ground every curation suggestion in real '
        + 'products and facet values — never invent product ids. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text query (optional).' },
          collectionId: { type: 'string', description: 'Restrict the search to one collection (optional).' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ productIds: [], facets: [] });
      if ('error' in resolved) return resolved.error;
      const result = await searchProducts({
        tenantId: scope.tenantId, orgId: resolved.orgId,
        ...(optStr(input.q) ? { q: optStr(input.q)! } : {}),
        ...(optStr(input.collectionId) ? { collectionId: optStr(input.collectionId)! } : {}),
      });
      return ok({ productIds: result.products.map((p) => p.productId), facets: result.facets, appliedRuleIds: result.appliedRuleIds });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DISCOVERY_LIST_COLLECTIONS_TOOL_ID,
      description:
        'List the storefront collections (id, name, slug, type manual/dynamic, active). Read this BEFORE authoring '
        + 'a collection so you do not duplicate an existing one. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ collections: [] });
      if ('error' in resolved) return resolved.error;
      const collections = await listCollections(scope.tenantId, resolved.orgId);
      return ok({
        collections: collections.map((c) => ({
          collectionId: c.collectionId, name: c.name, slug: c.slug, type: c.type, active: c.active,
          ...(c.productIds ? { productCount: c.productIds.length } : {}),
          ...(c.rule ? { rule: c.rule } : {}),
        })),
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DISCOVERY_LIST_RULES_TOOL_ID,
      description:
        'List the merchandising rules (id, name, scope, actions pin/boost/bury/hide, active). Read this BEFORE '
        + 'authoring a rule so you understand what is already re-ordering results. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ rules: [] });
      if ('error' in resolved) return resolved.error;
      const rules = await listMerchRules(scope.tenantId, resolved.orgId);
      return ok({
        rules: rules.map((r) => ({ ruleId: r.ruleId, name: r.name, scope: r.scope, actions: r.actions, active: r.active, ...(r.holdoutPct !== undefined ? { holdoutPct: r.holdoutPct } : {}) })),
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DISCOVERY_CREATE_COLLECTION_TOOL_ID,
      description:
        'Create a storefront collection — MANUAL (a hand-picked productIds list) or DYNAMIC (a live rule by '
        + 'category/tag/price). Prefer dynamic when the grouping is rule-expressible so it stays current. '
        + 'Ground productIds in `search` results. No money moves; the collection is live immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Collection name.' },
          type: { type: 'string', enum: ['manual', 'dynamic'], description: 'manual (productIds) or dynamic (rule).' },
          productIds: { type: 'array', items: { type: 'string' }, description: 'Manual collections only — the curated product ids.' },
          rule: {
            type: 'object',
            description: 'Dynamic collections only — a facet predicate.',
            properties: {
              categories: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
              minPrice: { type: 'number' },
              maxPrice: { type: 'number' },
              // R2 PD2-1 — the model had no way to name a currency and no way to learn
              // one was needed, while the prompt told it to author price rules over a
              // multi-currency catalog.
              currency: { type: 'string', description: 'REQUIRED with minPrice/maxPrice. The ISO code those bounds are in (the catalog is multi-currency; a bound applies only to products priced in this currency).' },
            },
            additionalProperties: false,
          },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['name', 'type'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'write');
      if ('error' in resolved) return resolved.error;
      const name = str(input.name);
      if (!name) return toolError('validation_error', '`name` is required.');
      // LOW-1 idempotent create — a retried identical create (same org + name)
      // inside the window returns the collection already created, never a duplicate.
      const key = ignitionKey('discovery.create-collection', resolved.orgId, name.toLowerCase());
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed) {
        return ok({ ...(claim.existingRunId ? { collectionId: claim.existingRunId } : {}), name, type: input.type, deduped: true, note: 'That collection was just created — reusing it.' });
      }
      try {
        const c = await createCollection({
          tenantId: scope.tenantId, orgId: resolved.orgId, createdBy: scope.agentProfileId ?? scope.actingUserId ?? 'agent',
          name, type: input.type, productIds: input.productIds, rule: input.rule,
        });
        await recordIgnitionRun(scope.tenantId, key, c.collectionId);
        return ok({ collectionId: c.collectionId, name: c.name, slug: c.slug, type: c.type, note: 'Collection created and live. Tell the user its name and type.' });
      } catch (e) { return fromServiceError(e); }
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DISCOVERY_CREATE_RULE_TOOL_ID,
      description:
        'Create a merchandising rule that re-orders search/collection results — pin a product to a position, or '
        + 'boost/bury/hide by a facet predicate. Optionally set a holdout % (a control cohort that sees the '
        + 'unmodified order) to measure lift. Propose the rule + its effect before creating it. No money moves.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Rule name.' },
          scope: { type: 'string', description: "Where it applies: 'all', 'query:<term>', or 'collection:<id>'. Default 'all'." },
          actions: {
            type: 'array',
            description: 'One or more actions. pin: {kind,productId,position}; boost: {kind,predicate,factor} where factor > 1 promotes and < 1 demotes (it is applied to the rank, so 1.1 is a nudge and 10 is a hard promotion); bury/hide: {kind,predicate}. A predicate is {categories?,tags?,minPrice?,maxPrice?,currency?} — `currency` is REQUIRED whenever a price bound is used.',
            items: { type: 'object', additionalProperties: true },
          },
          holdoutPct: { type: 'number', description: 'Optional control-cohort percentage (1..100) held back from the rule to measure lift.' },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['name', 'actions'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'write');
      if ('error' in resolved) return resolved.error;
      const name = str(input.name);
      if (!name) return toolError('validation_error', '`name` is required.');
      // LOW-1 idempotent create — a retried identical create (same org + name)
      // inside the window returns the rule already created, never a duplicate.
      const key = ignitionKey('discovery.create-rule', resolved.orgId, name.toLowerCase());
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed) {
        return ok({ ...(claim.existingRunId ? { ruleId: claim.existingRunId } : {}), name, deduped: true, note: 'That merch rule was just created — reusing it.' });
      }
      try {
        const r = await createMerchRule({
          tenantId: scope.tenantId, orgId: resolved.orgId, createdBy: scope.agentProfileId ?? scope.actingUserId ?? 'agent',
          name, scope: optStr(input.scope) ?? 'all', actions: input.actions, holdoutPct: input.holdoutPct,
        });
        await recordIgnitionRun(scope.tenantId, key, r.ruleId);
        return ok({ ruleId: r.ruleId, name: r.name, scope: r.scope, actions: r.actions.length, note: 'Merch rule created and active. Tell the user what it does.' });
      } catch (e) { return fromServiceError(e); }
    },
  });
}
