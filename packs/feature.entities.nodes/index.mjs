/**
 * feature.entities.nodes — executors over ctx.features.entities (ADR 0386
 * Phase 6). Config/input merge: inputs win. Tenant comes from the run scope
 * inside the surface (CTI-1) — never from node args.
 */

function ensureEntities(ctx) {
  const entities = ctx.features && ctx.features.entities;
  if (!entities || typeof entities.listTypes !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.entities — the entities feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.openwop-app.entities' },
    );
  }
  return entities;
}

const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** ADR 0162 deterministic id: explicit id wins; else `entity:<runId>:<nodeId>`. */
function idFor(ctx, provided) {
  return str(provided) || `entity:${ctx.runId}:${ctx.nodeId}`;
}

export async function typesRead(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  if (str(i.typeName)) {
    const out = await entities.getType({ typeName: i.typeName, projectId: i.projectId });
    return { status: 'success', outputs: { type: out.type ?? null } };
  }
  const out = await entities.listTypes({ projectId: i.projectId });
  return { status: 'success', outputs: { types: out.types ?? [] } };
}

export async function query(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  const out = await entities.query({
    typeName: i.typeName,
    filters: i.filters,
    sort: i.sort,
    termId: i.termId,
    limit: i.limit,
    cursor: i.cursor,
    projectId: i.projectId,
    // ADR 0406 — explicit locale (replay-deterministic node arg): values
    // resolve exact → family → base; the overlay map never rides the output.
    locale: i.locale,
  });
  return { status: 'success', outputs: { entities: out.entities ?? [], total: out.total ?? 0, nextCursor: out.nextCursor } };
}

export async function get(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  const out = await entities.get({ typeName: i.typeName, entityId: i.entityId, projectId: i.projectId, locale: i.locale });
  return { status: 'success', outputs: { entity: out.entity ?? null } };
}

export async function create(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  const out = await entities.create({
    typeName: i.typeName,
    values: i.values,
    termIds: i.termIds,
    projectId: i.projectId,
    // ADR 0406/0407 — overlays + entry status write through the same
    // closed-world path (the surface fail-closes overlays on toggle-off).
    status: i.status,
    localizations: i.localizations,
    entityId: idFor(ctx, i.entityId),
  });
  return { status: 'success', outputs: { entity: out.entity ?? null } };
}

export async function update(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  const out = await entities.update({
    typeName: i.typeName,
    entityId: i.entityId,
    values: i.values,
    termIds: i.termIds,
    projectId: i.projectId,
    status: i.status,
    localizations: i.localizations,
  });
  if (!out.entity) {
    throw Object.assign(new Error(`entity not found: ${i.entityId}`), { code: 'not_found' });
  }
  return { status: 'success', outputs: { entity: out.entity } };
}

export async function del(ctx) {
  const entities = ensureEntities(ctx);
  const i = merged(ctx);
  const out = await entities.delete({ typeName: i.typeName, entityId: i.entityId, projectId: i.projectId });
  return { status: 'success', outputs: { deleted: out.deleted === true } };
}

export const nodes = {
  'feature.entities.nodes.types-read': typesRead,
  'feature.entities.nodes.query': query,
  'feature.entities.nodes.get': get,
  'feature.entities.nodes.create': create,
  'feature.entities.nodes.update': update,
  'feature.entities.nodes.delete': del,
};
