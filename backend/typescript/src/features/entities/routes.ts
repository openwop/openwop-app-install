/**
 * Entities routes (ADR 0386 Phase 1) — host-extension REST face under
 * `/v1/host/openwop-app/entities/*` (non-normative).
 *
 * Three-tier RBAC (ADR 0386 matrix row 8, tenant-level — entities are
 * workspace-scoped, not org-scoped, so the gate composes `requireFeatureEnabled`
 * + `resolveEffectiveAccess(tenantId, { subject })` (the developer-keys shape)
 * rather than the org-param `authorizeOrgScope`):
 *   read        = `workspace:read`
 *   entity write = `workspace:write`
 *   type admin  = `host:members:manage` (create/alter/delete types)
 * Fail-closed: toggle off → 404; no principal → 401; missing scope → 403;
 * cross-tenant/unknown rows → 404 (no existence leak — service-side guards).
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, resolveTenantLevelScopes, type Scope, ACT_AS_HEADER } from '../../host/accessControlService.js';
import { entityLocaleContext } from './common.js';
import { readPublicEntities, readPublicEntity, resolveEntityPublicLocale } from './publicRead.js';
import { requireFeatureEnabled, requireString, optionalString, tenantOf } from '../featureRoute.js';
import { verifyApiKey } from '../developer-keys/apiKeyService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  createEntity,
  createEntityType,
  createRelationship,
  deleteEntity,
  deleteEntityType,
  deleteRelationship,
  exportEntities,
  getEntity,
  getEntityType,
  importEntities,
  isTermInUse,
  listEntities,
  listEntityTypes,
  listRelationships,
  queryEntities,
  updateEntity,
  updateEntityType,
  type EntityTypeStatus,
} from './entitiesService.js';
import {
  createTaxonomy,
  createTerm,
  deleteTaxonomy,
  deleteTerm,
  listTaxonomies,
  listTerms,
  reorderTerms,
  updateTerm,
} from './taxonomyService.js';

const TOGGLE = { toggleId: 'entities', label: 'Entities' };
const BASE = '/v1/host/openwop-app/entities';

/** ADR 0406 D7 — the localization opt-in. OFF ⇒ overlay writes REJECT (never a
 *  silent drop) and delivery serves base values with no negotiation. */
async function localizationEnabled(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne('entities-localization', { tenantId }))?.enabled);
}

/** Fail-closed overlay-write gate: providing `localizations` while the toggle
 *  is off is an explicit 400 (a silent drop would be dishonest persistence). */
async function requireLocalizationForWrite(tenantId: string, localizations: unknown): Promise<void> {
  if (localizations === undefined) return;
  if (!(await localizationEnabled(tenantId))) {
    throw new OpenwopError('validation_error', 'Entity localization is not enabled for this workspace (`entities-localization` toggle).', 400, { field: 'localizations' });
  }
}

/** The app's canonical caller subject (matches developer-keys/featureRoute). */
const callerSubjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Acting-member header — the app's tenant-level RBAC convention (orgs/cdp
 *  precedent): absent → the caller is the tenant-owner principal (implicit
 *  owner, tenant == principal in this host); present → that member's row
 *  resolves fail-closed via accessControl (the single RBAC owner). */

interface EntitiesAuth {
  subject: string;
  tenantId: string;
  /** `apikey` callers face the publish gate (ADR 0386 matrix row 7/8). */
  via: 'session' | 'apikey';
}

/** The ADR 0386 scope-grammar target for a type: `<typeName>` at tenant root,
 *  `<projectId>/<typeName>` inside a project namespace. */
const grammarTarget = (typeName: string, projectId: string | undefined): string =>
  projectId ? `${projectId}/${typeName}` : typeName;

/** Match an API key's scope list against the entities grammar (ADR 0270 keys
 *  carry free-form scopes; the grammar is OURS to verify — fail closed).
 *  `entities:admin` grants everything; `…:write` implies `…:read`. */
function apiKeyAllows(scopes: string[], tier: 'read' | 'write' | 'admin', target: string | null): boolean {
  if (scopes.includes('entities:admin')) return true;
  if (tier === 'admin' || target === null) return false;
  if (tier === 'read') {
    return scopes.includes(`entities:${target}:read`) || scopes.includes(`entities:${target}:write`);
  }
  return scopes.includes(`entities:${target}:write`);
}

/**
 * Dual auth (ADR 0386 Phase 4): a `Bearer owk_…` token verifies through the
 * ONE key store (`developer-keys.verifyApiKey` — no second key system) and
 * carries the `entities:<target>:read|write` / `entities:admin` grammar; the
 * tenant comes FROM the key (never the request). Everything else is the
 * session path (tenant-level RBAC via accessControl). Fail-closed throughout.
 */
async function requireEntitiesScope(
  req: Request,
  scope: Scope,
  opts?: { type?: { name: string; projectId: string | undefined } },
): Promise<EntitiesAuth> {
  const bearer = req.header('authorization');
  if (bearer?.startsWith('Bearer owk_')) {
    const key = await verifyApiKey(bearer.slice('Bearer '.length).trim());
    if (!key) throw new OpenwopError('unauthenticated', 'Invalid or expired API key.', 401, {});
    // Toggle authority is per-TENANT for a key caller — resolve with the key's tenant.
    const assignment = await resolveOne(TOGGLE.toggleId, { tenantId: key.tenantId });
    if (!assignment || !assignment.enabled) {
      throw new OpenwopError('not_found', `${TOGGLE.label} is not enabled for this tenant.`, 404, { feature: TOGGLE.toggleId });
    }
    const tier = scope === 'host:members:manage' ? 'admin' : scope === 'workspace:write' ? 'write' : 'read';
    const target = opts?.type ? grammarTarget(opts.type.name, opts.type.projectId) : null;
    if (!apiKeyAllows(key.scopes, tier, target)) {
      throw new OpenwopError('forbidden_scope', 'API key lacks the required entities scope.', 403, {
        requiredTier: tier,
        ...(target !== null ? { target } : {}),
      });
    }
    // Publish gate (ADR 0386): a draft type is a 404 to a key caller —
    // indistinguishable from absent. Session callers see drafts (authoring).
    if (opts?.type) {
      const type = await getEntityType(key.tenantId, opts.type.projectId, opts.type.name);
      if (!type || type.status !== 'published' || type.system) {
        throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: opts.type.name });
      }
    }
    return { subject: `apikey:${key.keyId}`, tenantId: key.tenantId, via: 'apikey' };
  }
  await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
  const subject = callerSubjectOf(req);
  if (!subject) {
    throw new OpenwopError('unauthenticated', 'Entities requires an authenticated principal.', 401, {});
  }
  const tenantId = tenantOf(req);
  const actingMember = req.header(ACT_AS_HEADER);
  // ADR 0731 — resolve the SESSION caller, and resolve them with the TENANT-LEVEL
  // resolver. This used to pass `{}` when there was no X-Act-As header, and with
  // neither `memberId` nor `subject` `resolveEffectiveAccess` returns
  // `basis:'tenant-owner'` with OWNER_SCOPES — so the scope check below passed
  // unconditionally and the 403 this file's header advertises could never fire
  // (MEASURED: a `viewer` member created an entity type and wrote a row, both 201).
  // `resolveSubjectScopesUnion` rather than `resolveEffectiveAccess({ subject })`:
  // these surfaces are workspace-scoped, and the org-scoped first-match resolver is
  // non-deterministic for a subject with memberships in several orgs (its own
  // docblock says so). `resolveTenantLevelScopes` = that union PLUS the ADR 0372
  // exit: a single-principal tenant (anon sandbox / personal) is its own owner;
  // a SHARED `ws:` workspace fails closed, which is the escalation being fixed.
  const access = actingMember
    ? await resolveEffectiveAccess(tenantId, { memberId: actingMember.trim() })
    : await resolveTenantLevelScopes(tenantId, subject);
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  // ADR 0409 — SYSTEM types (cms.page, crm.company/deal, commerce.product) are
  // INVISIBLE to the generic user-facing entities API: they are managed only by
  // their owning FAÇADE, whose per-org RBAC would otherwise be bypassed by a
  // generic `workspace:read` query. A 404 (never an existence leak).
  if (opts?.type) {
    const type = await getEntityType(tenantId, opts.type.projectId, opts.type.name);
    if (type?.system) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: opts.type.name });
  }
  return { subject, tenantId, via: 'session' };
}

const projectOf = (req: Request): string | undefined =>
  optionalString((req.query.projectId as unknown) ?? (req.body as { projectId?: unknown } | undefined)?.projectId);

export function registerEntitiesRoutes({ app }: RouteDeps): void {
  // ADR 0406 — the editor's locale context (ONE resolver: entityLocaleContext,
  // the same the surface/tools use; the FE never re-derives toggle+settings).
  app.get(`${BASE}/locale-context`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read');
      const loc = await entityLocaleContext(tenantId);
      res.json(loc ? { enabled: true, baseLocale: loc.baseLocale, supportedLocales: loc.supportedLocales } : { enabled: false });
    } catch (err) { next(err); }
  });

  // ---- Types ----
  app.get(`${BASE}/types`, async (req, res, next) => {
    try {
      const auth = await requireEntitiesScope(req, 'workspace:read');
      // ADR 0409 — SYSTEM types are invisible to the generic API (façade-owned).
      const types = (await listEntityTypes(auth.tenantId, projectOf(req))).filter((t) => !t.system);
      // Draft schemas are authoring state — key callers (even entities:admin)
      // see only the published catalog (the publish gate, applied to the list).
      res.json({ types: auth.via === 'apikey' ? types.filter((t) => t.status === 'published') : types });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/types`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as {
        name?: unknown; displayName?: unknown; description?: unknown; fields?: unknown; projectId?: unknown;
      };
      const rec = await createEntityType({
        tenantId,
        projectId: optionalString(body.projectId),
        name: requireString(body.name, 'name'),
        displayName: optionalString(body.displayName) ?? requireString(body.name, 'name'),
        ...(optionalString(body.description) !== undefined ? { description: optionalString(body.description) } : {}),
        fields: body.fields,
        createdBy: subject,
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/types/:name`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read', { type: { name: req.params.name, projectId: projectOf(req) } });
      const rec = await getEntityType(tenantId, projectOf(req), req.params.name);
      if (!rec) throw new OpenwopError('not_found', 'Entity type not found.', 404, { name: req.params.name });
      res.json(rec);
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/types/:name`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as {
        displayName?: unknown; description?: unknown; fields?: unknown; status?: unknown; publicRead?: unknown; projectId?: unknown;
      };
      const rec = await updateEntityType({
        tenantId,
        projectId: projectOf(req),
        name: req.params.name,
        patch: {
          ...(optionalString(body.displayName) !== undefined ? { displayName: optionalString(body.displayName) } : {}),
          ...(body.description === null ? { description: null } : {}),
          ...(optionalString(body.description) !== undefined ? { description: optionalString(body.description) } : {}),
          ...(body.fields !== undefined ? { fields: body.fields } : {}),
          ...(body.status !== undefined ? { status: body.status as EntityTypeStatus } : {}),
          ...(body.publicRead !== undefined ? { publicRead: body.publicRead } : {}),
        },
        actor: subject,
      });
      if (!rec) throw new OpenwopError('not_found', 'Entity type not found.', 404, { name: req.params.name });
      res.json(rec);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/types/:name`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const deleted = await deleteEntityType({ tenantId, projectId: projectOf(req), name: req.params.name });
      if (!deleted) throw new OpenwopError('not_found', 'Entity type not found.', 404, { name: req.params.name });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---- Entities ----
  app.get(`${BASE}/types/:name/entities`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read', { type: { name: req.params.name, projectId: projectOf(req) } });
      const limitRaw = Number(req.query.limit);
      const page = await listEntities({
        tenantId,
        projectId: projectOf(req),
        typeName: req.params.name,
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        ...(optionalString(req.query.cursor) !== undefined ? { cursor: optionalString(req.query.cursor) } : {}),
      });
      res.json(page);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/types/:name/entities`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEntitiesScope(req, 'workspace:write', { type: { name: req.params.name, projectId: projectOf(req) } });
      const body = (req.body ?? {}) as { values?: unknown; entityId?: unknown; projectId?: unknown };
      if (body.values === null || typeof body.values !== 'object' || Array.isArray(body.values)) {
        throw new OpenwopError('validation_error', 'Field `values` must be an object.', 400, { field: 'values' });
      }
      const withTerms = (req.body ?? {}) as { termIds?: unknown; status?: unknown; localizations?: unknown };
      await requireLocalizationForWrite(tenantId, withTerms.localizations);
      const rec = await createEntity({
        tenantId,
        projectId: projectOf(req),
        typeName: req.params.name,
        values: body.values as Record<string, unknown>,
        ...(withTerms.termIds !== undefined ? { termIds: withTerms.termIds } : {}),
        ...(withTerms.status !== undefined ? { status: withTerms.status } : {}),
        ...(withTerms.localizations !== undefined ? { localizations: withTerms.localizations } : {}),
        ...(optionalString(body.entityId) !== undefined ? { entityId: optionalString(body.entityId) } : {}),
        createdBy: subject,
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  // ---- Query / export / import (ADR 0386 Phase 3) ----
  app.post(`${BASE}/types/:name/query`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read', { type: { name: req.params.name, projectId: projectOf(req) } });
      const body = (req.body ?? {}) as {
        filters?: unknown; sort?: { key?: unknown; dir?: unknown }; termId?: unknown; limit?: unknown; cursor?: unknown; projectId?: unknown;
      };
      const limitRaw = Number(body.limit);
      const sortKey = optionalString(body.sort?.key);
      const page = await queryEntities({
        tenantId,
        projectId: projectOf(req),
        typeName: req.params.name,
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
        ...(sortKey !== undefined
          ? { sort: { key: sortKey, ...(body.sort?.dir === 'asc' || body.sort?.dir === 'desc' ? { dir: body.sort.dir } : {}) } }
          : {}),
        ...(optionalString(body.termId) !== undefined ? { termId: optionalString(body.termId) } : {}),
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        ...(optionalString(body.cursor) !== undefined ? { cursor: optionalString(body.cursor) } : {}),
      });
      res.json(page);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/types/:name/export`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read', { type: { name: req.params.name, projectId: projectOf(req) } });
      const rows = await exportEntities({ tenantId, projectId: projectOf(req), typeName: req.params.name });
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${req.params.name}.ndjson"`);
      for (const row of rows) {
        // ADR 0407/0406 — entry status + locale overlays round-trip losslessly
        // (import validates both through the same closed-world path).
        res.write(`${JSON.stringify({
          entityId: row.entityId,
          values: row.values,
          ...(row.termIds ? { termIds: row.termIds } : {}),
          ...(row.status ? { status: row.status } : {}),
          ...(row.localizations ? { localizations: row.localizations } : {}),
        })}\n`);
      }
      res.end();
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/types/:name/import`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEntitiesScope(req, 'workspace:write', { type: { name: req.params.name, projectId: projectOf(req) } });
      const body = (req.body ?? {}) as { ndjson?: unknown; projectId?: unknown };
      const result = await importEntities({
        tenantId,
        projectId: projectOf(req),
        typeName: req.params.name,
        ndjson: requireString(body.ndjson, 'ndjson'),
        allowLocalizations: await localizationEnabled(tenantId),
        actor: subject,
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/types/:name/entities/:entityId`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read', { type: { name: req.params.name, projectId: projectOf(req) } });
      const rec = await getEntity({
        tenantId, projectId: projectOf(req), typeName: req.params.name, entityId: req.params.entityId,
      });
      if (!rec) throw new OpenwopError('not_found', 'Entity not found.', 404, { entityId: req.params.entityId });
      res.json(rec);
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/types/:name/entities/:entityId`, async (req, res, next) => {
    try {
      const { subject, tenantId } = await requireEntitiesScope(req, 'workspace:write', { type: { name: req.params.name, projectId: projectOf(req) } });
      const body = (req.body ?? {}) as { values?: unknown; projectId?: unknown };
      if (body.values === undefined) body.values = {}; // termIds-only patch
      if (body.values === null || typeof body.values !== 'object' || Array.isArray(body.values)) {
        throw new OpenwopError('validation_error', 'Field `values` must be an object.', 400, { field: 'values' });
      }
      const withTerms = (req.body ?? {}) as { termIds?: unknown; status?: unknown; localizations?: unknown };
      await requireLocalizationForWrite(tenantId, withTerms.localizations);
      const rec = await updateEntity({
        tenantId,
        projectId: projectOf(req),
        typeName: req.params.name,
        entityId: req.params.entityId,
        values: body.values as Record<string, unknown>,
        ...(withTerms.termIds !== undefined ? { termIds: withTerms.termIds } : {}),
        ...(withTerms.status !== undefined ? { status: withTerms.status } : {}),
        ...(withTerms.localizations !== undefined ? { localizations: withTerms.localizations } : {}),
        actor: subject,
      });
      if (!rec) throw new OpenwopError('not_found', 'Entity not found.', 404, { entityId: req.params.entityId });
      res.json(rec);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/types/:name/entities/:entityId`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:write', { type: { name: req.params.name, projectId: projectOf(req) } });
      const deleted = await deleteEntity({
        tenantId, projectId: projectOf(req), typeName: req.params.name, entityId: req.params.entityId,
      });
      if (!deleted) throw new OpenwopError('not_found', 'Entity not found.', 404, { entityId: req.params.entityId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---- Taxonomies + terms (ADR 0386 Phase 2; type-admin tier) ----
  app.get(`${BASE}/taxonomies`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read');
      res.json({ taxonomies: await listTaxonomies(tenantId, projectOf(req)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/taxonomies`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { name?: unknown; displayName?: unknown; projectId?: unknown };
      const rec = await createTaxonomy({
        tenantId,
        projectId: optionalString(body.projectId),
        name: requireString(body.name, 'name'),
        ...(optionalString(body.displayName) !== undefined ? { displayName: optionalString(body.displayName) } : {}),
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/taxonomies/:name`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const deleted = await deleteTaxonomy({ tenantId, projectId: projectOf(req), name: req.params.name });
      if (!deleted) throw new OpenwopError('not_found', 'Taxonomy not found.', 404, { name: req.params.name });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/taxonomies/:name/terms`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read');
      res.json({ terms: await listTerms(tenantId, projectOf(req), req.params.name) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/taxonomies/:name/terms`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { slug?: unknown; label?: unknown; parentId?: unknown; projectId?: unknown };
      const rec = await createTerm({
        tenantId,
        projectId: optionalString(body.projectId),
        taxonomyName: req.params.name,
        slug: requireString(body.slug, 'slug'),
        ...(optionalString(body.label) !== undefined ? { label: optionalString(body.label) } : {}),
        ...(optionalString(body.parentId) !== undefined ? { parentId: optionalString(body.parentId) } : {}),
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/taxonomies/:name/terms/reorder`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { orderedSlugs?: unknown };
      if (!Array.isArray(body.orderedSlugs)) {
        throw new OpenwopError('validation_error', '`orderedSlugs` must be an array.', 400, { field: 'orderedSlugs' });
      }
      const terms = await reorderTerms({
        tenantId,
        projectId: projectOf(req),
        taxonomyName: req.params.name,
        orderedSlugs: body.orderedSlugs.map((x) => String(x)),
      });
      res.json({ terms });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/taxonomies/:name/terms/:slug`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { label?: unknown; parentId?: unknown };
      const rec = await updateTerm({
        tenantId,
        projectId: projectOf(req),
        taxonomyName: req.params.name,
        slug: req.params.slug,
        patch: {
          ...(optionalString(body.label) !== undefined ? { label: optionalString(body.label) } : {}),
          ...(body.parentId === null ? { parentId: null } : {}),
          ...(optionalString(body.parentId) !== undefined ? { parentId: optionalString(body.parentId) } : {}),
        },
      });
      if (!rec) throw new OpenwopError('not_found', 'Term not found.', 404, { slug: req.params.slug });
      res.json(rec);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/taxonomies/:name/terms/:slug`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const deleted = await deleteTerm({
        tenantId,
        projectId: projectOf(req),
        taxonomyName: req.params.name,
        slug: req.params.slug,
        isTermInUse,
      });
      if (!deleted) throw new OpenwopError('not_found', 'Term not found.', 404, { slug: req.params.slug });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---- Relationships (ADR 0386 Phase 2; type-admin tier) ----
  app.get(`${BASE}/relationships`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'workspace:read');
      res.json({ relationships: await listRelationships(tenantId, projectOf(req)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/relationships`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as {
        fromTypeName?: unknown; toTypeName?: unknown; cardinality?: unknown; onDelete?: unknown; projectId?: unknown;
      };
      const rec = await createRelationship({
        tenantId,
        projectId: optionalString(body.projectId),
        fromTypeName: requireString(body.fromTypeName, 'fromTypeName'),
        toTypeName: requireString(body.toTypeName, 'toTypeName'),
        ...(optionalString(body.cardinality) !== undefined ? { cardinality: optionalString(body.cardinality) } : {}),
        ...(optionalString(body.onDelete) !== undefined ? { onDelete: optionalString(body.onDelete) } : {}),
      });
      res.status(201).json(rec);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/relationships/:fromTypeName/:toTypeName`, async (req, res, next) => {
    try {
      const { tenantId } = await requireEntitiesScope(req, 'host:members:manage');
      const deleted = await deleteRelationship({
        tenantId,
        projectId: projectOf(req),
        fromTypeName: req.params.fromTypeName,
        toTypeName: req.params.toTypeName,
      });
      if (!deleted) throw new OpenwopError('not_found', 'Relationship not found.', 404, {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---- Public read (ADR 0407 D2) ----
  // Anonymous, opt-in, fail-closed. Registered under the SIBLING prefix
  // `public-entities` (the `public-forms ≠ forms` rule in middleware/auth.ts —
  // a public prefix never nests inside an authed namespace; correction note on
  // ADR 0407, which sketched `/entities/public/…`). ONE uniform 404 covers:
  // toggle off, unknown tenant/type, type draft, publicRead absent, cross-
  // tenant probe — indistinguishable, no existence leak. Responses are the
  // `toPublicEntity` projection ONLY (no actor subjects, no storage internals),
  // and draft entries are excluded before pagination.
  const PUBLIC_BASE = '/v1/host/openwop-app/public-entities';
  const publicNotFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});

  /** Locale from the request (route-only): explicit `?locale=` wins, else
   *  Accept-Language — then handed to the SHARED gate (`readPublicEntities`)
   *  that the crawler prerender resolver also calls (no-cloaking by shared
   *  code — ADR 0407 D3). */
  const localeFromReq = (req: Request, tenantId: string) =>
    resolveEntityPublicLocale(tenantId, {
      ...(optionalString(req.query.locale) !== undefined ? { explicit: optionalString(req.query.locale) } : {}),
      ...(req.header('accept-language') ? { acceptLanguage: req.header('accept-language') } : {}),
    });

  app.get(`${PUBLIC_BASE}/:tenantId/types/:typeName/entities`, async (req, res, next) => {
    try {
      const projectId = optionalString(req.query.projectId);
      // Bounded filter spec: a JSON array in the query string (validated
      // closed-world by queryEntities against the type's fields).
      let filters: unknown;
      const rawFilters = optionalString(req.query.filters);
      if (rawFilters !== undefined) {
        if (rawFilters.length > 2048) throw new OpenwopError('validation_error', '`filters` is too long.', 400, { field: 'filters' });
        try { filters = JSON.parse(rawFilters); } catch {
          throw new OpenwopError('validation_error', '`filters` must be valid JSON.', 400, { field: 'filters' });
        }
      }
      const limitRaw = Number(req.query.limit);
      const sortKey = optionalString(req.query.sortKey);
      const sortDir = req.query.sortDir === 'asc' || req.query.sortDir === 'desc' ? req.query.sortDir : undefined;
      const loc = await localeFromReq(req, req.params.tenantId);
      const result = await readPublicEntities({
        tenantId: req.params.tenantId,
        ...(projectId !== undefined ? { projectId } : {}),
        typeName: req.params.typeName,
        ...(filters !== undefined ? { filters } : {}),
        ...(sortKey !== undefined ? { sort: { key: sortKey, ...(sortDir ? { dir: sortDir } : {}) } } : {}),
        ...(optionalString(req.query.termId) !== undefined ? { termId: optionalString(req.query.termId) } : {}),
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        ...(optionalString(req.query.cursor) !== undefined ? { cursor: optionalString(req.query.cursor) } : {}),
        ...(loc ? { locale: loc } : {}),
      });
      if (loc) { res.set('Content-Language', loc.negotiated); res.set('Vary', 'Accept-Language'); }
      res.json(result);
    } catch (err) { next(err); }
  });

  app.get(`${PUBLIC_BASE}/:tenantId/types/:typeName/entities/:entityId`, async (req, res, next) => {
    try {
      const projectId = optionalString(req.query.projectId);
      const loc = await localeFromReq(req, req.params.tenantId);
      const entity = await readPublicEntity({
        tenantId: req.params.tenantId,
        ...(projectId !== undefined ? { projectId } : {}),
        typeName: req.params.typeName,
        entityId: req.params.entityId,
        ...(loc ? { locale: loc } : {}),
      });
      if (!entity) throw publicNotFound();
      if (loc) { res.set('Content-Language', loc.negotiated); res.set('Vary', 'Accept-Language'); }
      res.json(entity);
    } catch (err) { next(err); }
  });
}
