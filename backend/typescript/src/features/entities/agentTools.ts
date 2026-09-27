/**
 * Entities chat-time tools (ADR 0386 Phase 6 — the ADR 0308/0315 seam).
 * READ-ONLY in v1: the chat lane can discover the content model and query
 * records; writes stay on the engine lane (`ctx.features.entities` nodes)
 * where they ride deterministic ids + closed-world validation.
 *
 * - `openwop:entities.describe-type` is the CATALOG tool — its output is
 *   GENERATED from the stored EntityType SSoT via the same `projectType`
 *   projection the workflow surface uses (never hand-copied; pinned by
 *   `__tests__/promptCatalogParity.test.ts`) and is SCHEMA_READ_EXEMPT
 *   (never compacted).
 * - Both tools fail EMPTY without an acting user (the projects-tool
 *   precedent) and scope every read to the run's tenant.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { FIELD_TYPES } from '../../host/customFields/index.js';
import { resolveLocalizedValues } from '../../host/i18n/index.js';
import { getEntityType, listEntityTypes, queryEntities } from './entitiesService.js';
import { entityLocaleContext } from './common.js';
import { projectType } from './surface.js';

export const ENTITIES_DESCRIBE_TYPE_TOOL_ID = 'openwop:entities.describe-type';
export const ENTITIES_QUERY_TOOL_ID = 'openwop:entities.query';

/** The one toggle gate both the routes and the tools sit behind (CFPT-1b subject). */
async function entitiesEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('entities', scope);
}

export function registerEntitiesAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: ENTITIES_DESCRIBE_TYPE_TOOL_ID,
      description:
        'Describe the workspace content model (user-defined entity types). Without arguments lists every type; '
        + `with typeName returns that type's full field schema (field kinds: ${FIELD_TYPES.join(', ')}). `
        + 'ALWAYS call this before querying or reasoning about entity records — the schema is defined at runtime by the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          typeName: { type: 'string', description: 'Machine name of one type (omit to list all).' },
          projectId: { type: 'string', description: 'Optional project namespace.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ types: [], note: 'no acting user on this run — nothing visible' }) };
      }
      if (!(await entitiesEnabled(scope))) {
        return { content: JSON.stringify({ types: [], note: 'entities feature is not enabled for this tenant' }) };
      }
      const args = (input ?? {}) as { typeName?: unknown; projectId?: unknown };
      const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;
      // ADR 0406 — the workspace's content-locale context rides along so a
      // model knows WHICH locales overlays may target (SSoT: the same
      // entityLocaleContext the surface/routes resolve; never hand-copied).
      const loc = await entityLocaleContext(scope.tenantId);
      const localization = loc
        ? { enabled: true, baseLocale: loc.baseLocale, supportedLocales: loc.supportedLocales }
        : { enabled: false };
      // ADR 0409 — SYSTEM types (cms.page, crm.*, commerce.product) are
      // façade-owned; the generic chat tools never describe/expose them (their
      // per-org RBAC would be bypassed).
      if (typeof args.typeName === 'string' && args.typeName) {
        const type = await getEntityType(scope.tenantId, projectId, args.typeName);
        return { content: JSON.stringify({ type: type && !type.system ? projectType(type) : null, localization }) };
      }
      const types = (await listEntityTypes(scope.tenantId, projectId)).filter((t) => !t.system);
      return { content: JSON.stringify({ types: types.map(projectType), localization }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ENTITIES_QUERY_TOOL_ID,
      description:
        'Query records of a user-defined entity type with typed filters. Call openwop:entities.describe-type first '
        + 'to learn the type’s field schema. Read-only. Filters: [{key, op: eq|neq|in|gt|gte|lt|lte|contains, value}].',
      inputSchema: {
        type: 'object',
        properties: {
          typeName: { type: 'string' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                op: { type: 'string', enum: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'] },
                value: {},
              },
              required: ['key', 'op'],
              additionalProperties: false,
            },
          },
          limit: { type: 'number' },
          projectId: { type: 'string' },
          locale: { type: 'string', description: 'Optional BCP-47 locale — values resolve exact → language family → base (ADR 0406).' },
        },
        required: ['typeName'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ entities: [], note: 'no acting user on this run — nothing visible' }) };
      }
      if (!(await entitiesEnabled(scope))) {
        return { content: JSON.stringify({ entities: [], note: 'entities feature is not enabled for this tenant' }) };
      }
      const args = (input ?? {}) as { typeName?: unknown; filters?: unknown; limit?: unknown; projectId?: unknown; locale?: unknown };
      // ADR 0409 — a SYSTEM type (crm.*, cms.page, commerce.product) is
      // façade-owned; the generic query tool must not read it (its per-org
      // RBAC would be bypassed) — 404-equivalent empty, indistinguishable from absent.
      const projectId0 = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;
      const typeName0 = typeof args.typeName === 'string' ? args.typeName : '';
      const t0 = await getEntityType(scope.tenantId, projectId0, typeName0);
      if (t0?.system) {
        return { content: JSON.stringify({ entities: [], note: 'unknown type' }) };
      }
      try {
        const page = await queryEntities({
          tenantId: scope.tenantId,
          projectId: typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined,
          typeName: typeof args.typeName === 'string' ? args.typeName : '',
          ...(args.filters !== undefined ? { filters: args.filters } : {}),
          limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(args.limit, 50) : 25,
        });
        // ADR 0406 — an explicit locale resolves values (base when the
        // localization context is absent); overlays never ride the tool wire.
        const locale = typeof args.locale === 'string' && args.locale ? args.locale : undefined;
        const loc = locale !== undefined ? await entityLocaleContext(scope.tenantId) : undefined;
        return {
          content: JSON.stringify({
            entities: page.entities.map((e) => ({
              entityId: e.entityId,
              values: locale !== undefined && loc ? resolveLocalizedValues(e.values, e.localizations, locale, loc.baseLocale) : e.values,
              ...(e.termIds ? { termIds: e.termIds } : {}),
            })),
            total: page.total,
          }),
        };
      } catch (err) {
        // Typed failure surfaced to the model — never success-with-empty.
        return { content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) };
      }
    },
  });
}
