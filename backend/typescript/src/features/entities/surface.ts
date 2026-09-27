/**
 * `ctx.features.entities` — the ADR 0014 workflow-surface face (ADR 0386
 * Phase 6). This is the strategic payoff: every user-defined type becomes a
 * store the engine (and the one chat, via the read tools) can read before it
 * writes and write through validation.
 *
 * Conventions (csm/crm precedent):
 * - Tenant comes from the run scope, NEVER node args (CTI-1); every service
 *   call is tenant-guarded at the service layer.
 * - Node output is recorded in the durable event log → INTERNAL storage
 *   columns are projected out before returning.
 * - Creation idempotency: the pack node layer supplies a deterministic
 *   `entity:${runId}:${nodeId}` id when the author omits one (ADR 0162), so a
 *   re-run/`:fork` never double-creates.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { resolveLocalizedValues } from '../../host/i18n/index.js';
import { entityLocaleContext } from './common.js';
import {
  createEntity,
  deleteEntity,
  getEntity,
  getEntityType,
  listEntityTypes,
  queryEntities,
  updateEntity,
  type EntityRecord,
  type EntityTypeRecord,
} from './entitiesService.js';

const INTERNAL = new Set(['tenantId', 'recordKey', 'typeId']);

function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

/**
 * ADR 0406 D6 — the resolved-view projection for an EXPLICIT `locale` read
 * arg (replay-deterministic: the locale is a node argument, never ambient
 * request state). Values resolve exact → family → base; the overlay map is
 * dropped from the resolved view (one locale in, one locale out). When the
 * localization context is absent (toggle off / no locales) the resolved view
 * degrades to base values — byte-identical to pre-localization.
 */
function projectResolved(
  rec: EntityRecord,
  locale: string,
  ctx: { baseLocale: string } | undefined,
): Record<string, unknown> {
  const out = project(rec);
  if (ctx) out.values = resolveLocalizedValues(rec.values, rec.localizations, locale, ctx.baseLocale);
  delete out.localizations;
  return out;
}
const projectOne = (o: EntityRecord | null): Record<string, unknown> | null => (o ? project(o) : null);

/** Type projection for models/workflows — generated from the stored SSoT
 *  record (never hand-copied; pinned by promptCatalogParity). */
export function projectType(t: EntityTypeRecord): Record<string, unknown> {
  return {
    name: t.name,
    displayName: t.displayName,
    ...(t.description !== undefined ? { description: t.description } : {}),
    projectId: t.projectId,
    status: t.status,
    ...(t.publicRead === true ? { publicRead: true } : {}),
    fields: t.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      ...(f.options ? { options: f.options } : {}),
      ...(f.refEntityType ? { refEntityType: f.refEntityType } : {}),
      ...(f.localizable === true ? { localizable: true } : {}),
    })),
  };
}

export function buildEntitiesSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actor = `run:${scope.runId ?? 'unknown'}`;
  const projectIdOf = (args: Record<string, unknown>): string | undefined => optStr(args.projectId);
  // ADR 0409 — SYSTEM types (crm.*, cms.page, commerce.product) are façade-
  // owned; the generic workflow surface's READ verbs must not expose them (the
  // façade's per-org RBAC would be bypassed). Writes are already blocked by
  // `assertNotSystemWrite` in create/update/delete.
  const isUserType = async (args: Record<string, unknown>): Promise<boolean> => {
    const type = await getEntityType(tenantId, projectIdOf(args), str(args.typeName));
    return !type?.system;
  };
  return {
    listTypes: async (args) => {
      const types = (await listEntityTypes(tenantId, projectIdOf(args))).filter((t) => !t.system);
      return { types: types.map(projectType) };
    },
    getType: async (args) => {
      const type = await getEntityType(tenantId, projectIdOf(args), str(args.typeName));
      return { type: type && !type.system ? projectType(type) : null };
    },
    query: async (args) => {
      if (!(await isUserType(args))) return { entities: [], total: 0 };
      const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined;
      const sortKey = optStr((args.sort as { key?: unknown } | undefined)?.key);
      const sortDir = (args.sort as { dir?: unknown } | undefined)?.dir;
      const page = await queryEntities({
        tenantId,
        projectId: projectIdOf(args),
        typeName: str(args.typeName),
        ...(args.filters !== undefined ? { filters: args.filters } : {}),
        ...(sortKey !== undefined
          ? { sort: { key: sortKey, ...(sortDir === 'asc' || sortDir === 'desc' ? { dir: sortDir } : {}) } }
          : {}),
        ...(optStr(args.termId) !== undefined ? { termId: str(args.termId) } : {}),
        ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
        ...(optStr(args.cursor) !== undefined ? { cursor: str(args.cursor) } : {}),
      });
      const locale = optStr(args.locale);
      if (locale !== undefined) {
        const ctx = await entityLocaleContext(tenantId);
        return {
          entities: page.entities.map((rec) => projectResolved(rec, locale, ctx)),
          total: page.total,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      }
      return {
        entities: page.entities.map(project),
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
    get: async (args) => {
      if (!(await isUserType(args))) return { entity: null };
      const entity = await getEntity({
        tenantId,
        projectId: projectIdOf(args),
        typeName: str(args.typeName),
        entityId: str(args.entityId),
      });
      const locale = optStr(args.locale);
      if (entity && locale !== undefined) {
        const ctx = await entityLocaleContext(tenantId);
        return { entity: projectResolved(entity, locale, ctx) };
      }
      return { entity: projectOne(entity) };
    },
    create: async (args) => {
      if (args.values === null || typeof args.values !== 'object' || Array.isArray(args.values)) {
        throw new Error('`values` must be an object.');
      }
      if (args.localizations !== undefined && !(await entityLocaleContext(tenantId))) {
        throw new Error('Entity localization is not enabled for this workspace (`entities-localization` toggle + authored locales).');
      }
      const entity = await createEntity({
        tenantId,
        projectId: projectIdOf(args),
        typeName: str(args.typeName),
        values: args.values as Record<string, unknown>,
        ...(args.termIds !== undefined ? { termIds: args.termIds } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.localizations !== undefined ? { localizations: args.localizations } : {}),
        // The node layer supplies the deterministic id (ADR 0162).
        ...(optStr(args.entityId) !== undefined ? { entityId: str(args.entityId) } : {}),
        createdBy: actor,
      });
      return { entity: projectOne(entity) };
    },
    update: async (args) => {
      if (args.values === null || typeof args.values !== 'object' || Array.isArray(args.values)) {
        throw new Error('`values` must be an object.');
      }
      if (args.localizations !== undefined && !(await entityLocaleContext(tenantId))) {
        throw new Error('Entity localization is not enabled for this workspace (`entities-localization` toggle + authored locales).');
      }
      const entity = await updateEntity({
        tenantId,
        projectId: projectIdOf(args),
        typeName: str(args.typeName),
        entityId: str(args.entityId),
        values: args.values as Record<string, unknown>,
        ...(args.termIds !== undefined ? { termIds: args.termIds } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.localizations !== undefined ? { localizations: args.localizations } : {}),
        actor,
      });
      return { entity: projectOne(entity) };
    },
    delete: async (args) => {
      const deleted = await deleteEntity({
        tenantId,
        projectId: projectIdOf(args),
        typeName: str(args.typeName),
        entityId: str(args.entityId),
      });
      return { deleted };
    },
  };
}
