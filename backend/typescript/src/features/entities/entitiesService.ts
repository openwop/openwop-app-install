/**
 * Entities service (ADR 0386 Phase 1) — the generic store for content types
 * users define at runtime: `EntityType` (schema-defined fields) + `Entity`
 * (closed-world-validated values), tenant + optional project scoped.
 *
 * Boundaries (ADR 0386 §Boundaries — load-bearing):
 * - Field SHAPE validation is the ADR 0257 seam (`host/customFields`) — this
 *   module never forks a second field validator ("add a column" vs "define a
 *   table": the seam validates fields; THIS module mints the table).
 * - `projectId` references the existing ADR 0046 Project subject
 *   (`features/projects/projectsService.ts`) — entities does NOT mint a second
 *   project concept; the import mirrors the established convention
 *   (advisory-board, notebooks, strategy, … all import `getProject`).
 * - CRM records, CMS pages, KB docs, API keys, RBAC, webhook delivery each keep
 *   their single owner — see the ADR's boundaries table.
 *
 * Storage: KV blobs over `host_ext_kv` (ADR 0383 precedent, no SQL migration).
 * - `entity:type`   — one row per EntityType, keyed `${tenantId}:${projectKey}:${name}`.
 *   The DETERMINISTIC key makes name-uniqueness structural: create is a
 *   `compareAndSwap(null, …)` so two concurrent creates cannot both win (the
 *   /architect TOCTOU finding).
 * - `entity:record` — one row per Entity, keyed `${typeId}|${entityId}`. The
 *   typeId prefix makes "list entities of type X" a bounded `listByPrefix`
 *   (O(type rows), never an O(tenant) scan — the host_ext_kv scan incident).
 * - `entity:count`  — a CAS-guarded per-type row counter enforcing the honest
 *   row cap without re-scanning the type on every create.
 */
import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import {
  FIELD_TYPES,
  buildFieldSpec,
  getFieldKindValidator,
  validateFieldValues,
  type FieldSpec,
} from '../../host/customFields/index.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { LOCALE_RE, resolveLocalizedValues } from '../../host/i18n/index.js';
import { normalizeTypeName, projectKeyOf, requireProjectNamespace } from './common.js';
import { getTermById } from './taxonomyService.js';

export { normalizeTypeName, requireProjectNamespace } from './common.js';

/** Honest ceilings (ADR 0386 §Indexing — named, not pretended away). */
export const ENTITY_TYPE_CAP_PER_TENANT = 200;
export const ENTITY_ROW_CAP_PER_TYPE = 10_000;

export type EntityTypeStatus = 'draft' | 'published';

export interface EntityTypeRecord {
  /** Deterministic: `${tenantId}:${projectKey}:${name}` (projectKey '' = tenant root). */
  typeId: string;
  tenantId: string;
  /** '' = tenant-root namespace; else an ADR 0046 Project subject id. */
  projectId: string;
  /** Machine key (slug, unique per tenant+project), immutable after create. */
  name: string;
  displayName: string;
  description?: string;
  fields: FieldSpec[];
  /** `published` gates the entityApi + write nodes (Phases 4/6); in-app member
   *  CRUD works on drafts so authors can iterate before publishing. */
  status: EntityTypeStatus;
  /** ADR 0407 D2 — anonymous read opt-in. Absent/false ⇒ the type is invisible
   *  to the public read surface (read defaults CLOSED, the ADR 0386 posture).
   *  Only meaningful on a `published` type; flipping it is a type-admin op. */
  publicRead?: boolean;
  /** ADR 0408 D1 — a SYSTEM content type (e.g. `cms.page`): code-owned schema
   *  (minted with a dotted name user types can never take — NAME_RE rejects
   *  dots), read-only on the type-admin surface, entity writes only through
   *  the owning feature's system-row API. Reads/query stay generic (the
   *  convergence payoff: entityList over pages). */
  system?: true;
  /** ADR 0409 Phase 1 — a system type that MUST NEVER be served by the
   *  anonymous `public-entities` surface (CRM records are operational /
   *  PII-adjacent). Two locks: `updateEntityType` refuses to set `publicRead`
   *  on it, and the anonymous read gate (`gatePublicType`) refuses it outright.
   *  Omitted ⇒ the type is publicRead-eligible as normal (e.g. commerce.product,
   *  cms.page). */
  neverPublic?: true;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityRecord {
  /** Storage key `${typeId}|${entityId}` — typeId-prefixed for bounded per-type lists. */
  recordKey: string;
  entityId: string;
  tenantId: string;
  projectId: string;
  typeId: string;
  values: Record<string, string | number | boolean>;
  /** Taxonomy membership (ADR 0386 Phase 2) — validated term ids. */
  termIds?: string[];
  /** ADR 0407 D2 — entry-level draft. ABSENT ⇒ live (additive, every existing
   *  row unaffected — the ADR 0383 KV pattern). Draft rows are filtered from
   *  the public read + resolved section data; authed paths see them. */
  status?: 'draft';
  /** ADR 0406 D1 — sparse per-locale overlays over `localizable` string
   *  fields. Keys are BCP-47 tags; each value is a PARTIAL map validated
   *  through the same seam as `values`. ABSENT on every pre-existing row
   *  (additive). Resolution: exact → language family → base (RFC 0103 §C,
   *  `host/i18n.resolveLocalizedValues`). Never leaked on the public wire —
   *  resolved reads emit one locale's values. */
  localizations?: Record<string, Record<string, string>>;
  /** ADR 0408 — the EXTENSION channel: structured values of registered
   *  extension-kind fields (e.g. `blocks`, validated by the kind's registered
   *  validator on write) plus, for SYSTEM types, the owning feature's domain
   *  metadata (stored blind — the façade owns its semantics). `values` stays
   *  scalar so query/localization/public projection are untouched. Absent on
   *  every user-authored row. */
  ext?: Record<string, unknown>;
  /** ADR 0409 — an OPAQUE top-level org id for ORG-scoped system rows (CRM
   *  company/deal, commerce.product). The kernel never interprets it; it exists
   *  so the host-ext RI-7 org-population guard + org teardown (which probe the
   *  top-level `orgId` — `hostExtPersistence.jsonOrgId`) keep seeing org-scoped
   *  rows after they move onto the tenant-scoped kernel. Absent on user rows +
   *  tenant-scoped system rows (cms.page). */
  orgId?: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type RelationshipCardinality = 'one-one' | 'one-many' | 'many-many';
export type RelationshipOnDelete = 'restrict' | 'cascade' | 'set-null';

/**
 * A type-pair policy governing `reference` fields from `fromType` → `toType`
 * (ADR 0386 Phase 2). `onDelete` is ENFORCED on target-entity delete;
 * `cardinality` is declared modelling metadata (schema graph + docs) — its
 * write-time enforcement is deferred (ADR Open questions).
 */
export interface RelationshipRecord {
  /** Deterministic: `${fromTypeId}->${toTypeId}` — one policy per directed pair. */
  relId: string;
  tenantId: string;
  projectId: string;
  fromTypeId: string;
  toTypeId: string;
  cardinality: RelationshipCardinality;
  onDelete: RelationshipOnDelete;
  createdAt: string;
}

interface TypeCountRow {
  typeId: string;
  /** Present so ADR 0284 tenant teardown's JSON probe reaps these rows. */
  tenantId: string;
  count: number;
}

/** Reverse-reference index row: who points at `target`? Keyed
 *  `${targetRecordKey}|${sourceRecordKey}` so "entities referencing X" is a
 *  bounded `listByPrefix`, never a scan. */
interface RefIndexRow {
  key: string;
  tenantId: string;
  sourceRecordKey: string;
}

/** Term-membership index row, keyed `${termId}|${recordKey}`. */
interface TermIndexRow {
  key: string;
  tenantId: string;
  recordKey: string;
}

const types = new DurableCollection<EntityTypeRecord>('entity:type', (t) => t.typeId, undefined, (t) => t.tenantId);
const records = new DurableCollection<EntityRecord>('entity:record', (e) => e.recordKey, undefined, (e) => e.tenantId);
const counts = new DurableCollection<TypeCountRow>('entity:count', (c) => c.typeId);
const relationships = new DurableCollection<RelationshipRecord>('entity:relationship', (r) => r.relId, undefined, (r) => r.tenantId);
const refIdx = new DurableCollection<RefIndexRow>('entity:ref-idx', (r) => r.key);
const termIdx = new DurableCollection<TermIndexRow>('entity:term-idx', (r) => r.key);

const typeKeyOf = (tenantId: string, projectId: string | undefined, name: string): string =>
  `${tenantId}:${projectKeyOf(projectId)}:${name}`;
const recordKeyOf = (typeId: string, entityId: string): string => `${typeId}|${entityId}`;

/** Build + validate the field list through the ONE seam (ADR 0257). Phase 2
 *  adds `reference` (targets a sibling type by name) + `media` (a Media token). */
function buildFields(rawFields: unknown, allowedRefEntities: string[], allowExtensionKinds?: string[]): FieldSpec[] {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new OpenwopError('validation_error', 'A type requires at least one field.', 400, { field: 'fields' });
  }
  if (rawFields.length > 64) {
    throw new OpenwopError('validation_error', 'A type may declare at most 64 fields.', 400, { field: 'fields' });
  }
  const specs = rawFields.map((f) => {
    const input = (f ?? {}) as {
      key?: unknown; label?: unknown; type?: unknown; required?: unknown; options?: unknown; refEntityType?: unknown; localizable?: unknown;
    };
    return buildFieldSpec(
      {
        key: String(input.key ?? ''),
        label: String(input.label ?? input.key ?? ''),
        type: String(input.type ?? ''),
        required: input.required === true,
        options: input.options as string[] | undefined,
        ...(input.refEntityType !== undefined ? { refEntityType: input.refEntityType } : {}),
        // ADR 0406 D2 — the seam enforces string-only + boolean.
        ...(input.localizable !== undefined ? { localizable: input.localizable } : {}),
      },
      allowedRefEntities,
      allowExtensionKinds ? { allowExtensionKinds } : undefined,
    );
  });
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.key)) {
      throw new OpenwopError('validation_error', `Duplicate field key \`${s.key}\`.`, 400, { field: s.key });
    }
    seen.add(s.key);
  }
  return specs;
}

export async function createEntityType(input: {
  tenantId: string;
  projectId?: string;
  name: string;
  displayName: string;
  description?: string;
  fields: unknown;
  createdBy: string;
}): Promise<EntityTypeRecord> {
  const projectId = await requireProjectNamespace(input.tenantId, input.projectId);
  const name = normalizeTypeName(input.name);
  const existing = await types.listForTenantIndexed(input.tenantId);
  if (existing.length >= ENTITY_TYPE_CAP_PER_TENANT) {
    throw new OpenwopError('conflict', `Type cap reached (${ENTITY_TYPE_CAP_PER_TENANT} per workspace).`, 409, {});
  }
  // A `reference` field may target any sibling type in the same scope — or the
  // type being created (self-reference, e.g. an org chart).
  const refTargets = [...existing.filter((t) => t.projectId === projectId).map((t) => t.name), name];
  const now = new Date().toISOString();
  const rec: EntityTypeRecord = {
    typeId: typeKeyOf(input.tenantId, projectId, name),
    tenantId: input.tenantId,
    projectId,
    name,
    displayName: input.displayName.trim() || name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    fields: buildFields(input.fields, refTargets),
    status: 'draft',
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  // Structural uniqueness: the deterministic key + CAS-from-null closes the
  // create/create race (no read-then-write window).
  const won = await types.compareAndSwap(null, rec);
  if (!won) {
    throw new OpenwopError('conflict', `A type named \`${name}\` already exists in this scope.`, 409, { name });
  }
  return rec;
}

export async function listEntityTypes(tenantId: string, projectId?: string): Promise<EntityTypeRecord[]> {
  const all = await types.listForTenantIndexed(tenantId);
  const filtered = projectId === undefined ? all : all.filter((t) => t.projectId === projectKeyOf(projectId));
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getEntityType(
  tenantId: string,
  projectId: string | undefined,
  name: string,
): Promise<EntityTypeRecord | null> {
  const rec = await types.get(typeKeyOf(tenantId, projectId, name));
  return rec && rec.tenantId === tenantId ? rec : null;
}

export async function updateEntityType(input: {
  tenantId: string;
  projectId?: string;
  name: string;
  patch: { displayName?: string; description?: string | null; fields?: unknown; status?: EntityTypeStatus; publicRead?: unknown };
  actor: string;
}): Promise<EntityTypeRecord | null> {
  // Bounded CAS loop: field edits from two admins converge, never silently clobber.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await getEntityType(input.tenantId, input.projectId, input.name);
    if (!existing) return null;
    if (existing.system) {
      // ADR 0408 D1/Phase D — system-type SCHEMAS are code-owned (changes
      // ship as code + migration, never runtime edits). The ONE mutable flag
      // is `publicRead` (an operator opt-in, not schema): it powers
      // entityList-of-pages blocks, and the anonymous wire only ever serves
      // published rows' SCALAR values (`ext`/blocks never leave the kernel).
      const patchKeys = Object.keys(input.patch).filter((k) => (input.patch as Record<string, unknown>)[k] !== undefined);
      if (!(patchKeys.length === 1 && patchKeys[0] === 'publicRead')) {
        throw new OpenwopError('validation_error', `\`${existing.name}\` is a system type — its schema is code-owned (only \`publicRead\` may be toggled).`, 400, { name: existing.name });
      }
    }
    const next: EntityTypeRecord = { ...existing, updatedAt: new Date().toISOString() };
    if (input.patch.displayName !== undefined) next.displayName = input.patch.displayName.trim() || existing.displayName;
    if (input.patch.description !== undefined) {
      if (input.patch.description === null) delete next.description;
      else next.description = input.patch.description;
    }
    if (input.patch.fields !== undefined) {
      const siblings = await listEntityTypes(input.tenantId, existing.projectId);
      const refTargets = siblings.map((t) => t.name);
      if (!refTargets.includes(existing.name)) refTargets.push(existing.name);
      next.fields = buildFields(input.patch.fields, refTargets);
    }
    if (input.patch.status !== undefined) {
      if (input.patch.status !== 'draft' && input.patch.status !== 'published') {
        throw new OpenwopError('validation_error', 'status must be `draft` or `published`.', 400, { field: 'status' });
      }
      next.status = input.patch.status;
    }
    if (input.patch.publicRead !== undefined) {
      if (typeof input.patch.publicRead !== 'boolean') {
        throw new OpenwopError('validation_error', 'publicRead must be a boolean.', 400, { field: 'publicRead' });
      }
      // ADR 0409 Phase 1 — a `neverPublic` type can NEVER be made publicly
      // readable (lock 1 of 2; lock 2 is the anonymous gate).
      if (input.patch.publicRead && existing.neverPublic) {
        throw new OpenwopError('validation_error', `\`${existing.name}\` can never be made publicly readable.`, 400, { name: existing.name });
      }
      if (input.patch.publicRead) next.publicRead = true;
      else delete next.publicRead;
    }
    if (await types.compareAndSwap(existing, next)) return next;
  }
  throw new OpenwopError('conflict', 'Concurrent type update — retry.', 409, { name: input.name });
}

export async function deleteEntityType(input: {
  tenantId: string;
  projectId?: string;
  name: string;
}): Promise<boolean> {
  const existing = await getEntityType(input.tenantId, input.projectId, input.name);
  if (!existing) return false;
  if (existing.system) {
    throw new OpenwopError('validation_error', `\`${existing.name}\` is a system type — it cannot be deleted.`, 400, { name: existing.name });
  }
  // Derive the guard count from the BOUNDED per-type row slice, never the
  // counter row — a crash-leaked +1 must not make a type undeletable forever
  // (grade-data D2). The counter stays the cheap cap check; this is the truth.
  const actualRows = (await records.listByPrefix(`${existing.typeId}|`)).length;
  if (actualRows > 0) {
    throw new OpenwopError(
      'conflict',
      'Type still has entities — delete or export them first.',
      409,
      { name: existing.name, count: actualRows },
    );
  }
  // Refuse while OTHER types' `reference` fields target this type by name in
  // the same scope — deleting it would orphan their field specs (grade-data D4).
  const siblings = await listEntityTypes(input.tenantId, existing.projectId);
  const referencedBy = siblings
    .filter((t) => t.typeId !== existing.typeId)
    .filter((t) => t.fields.some((f) => f.type === 'reference' && f.refEntityType === existing.name))
    .map((t) => t.name);
  if (referencedBy.length > 0) {
    throw new OpenwopError(
      'conflict',
      `Type is referenced by \`${referencedBy.join('`, `')}\` — remove those reference fields first.`,
      409,
      { name: existing.name, referencedBy },
    );
  }
  // Clean relationship policies touching the type (rows are policy metadata —
  // no entities exist at this point, so no enforcement is bypassed).
  const rels = await relationships.listForTenantIndexed(input.tenantId);
  for (const rel of rels) {
    if (rel.fromTypeId === existing.typeId || rel.toTypeId === existing.typeId) {
      await relationships.delete(rel.relId);
    }
  }
  await counts.delete(existing.typeId);
  return types.delete(existing.typeId);
}

/** CAS-guarded counter bump; `delta` −1 floors at 0. Throws `conflict` at the
 *  cap — but ONLY after a recount self-heal (a crash between bump and row-write
 *  can leak +1; the cap must never be blocked by drift, so at the boundary the
 *  counter is re-derived from the actual bounded row slice). */
async function bumpCount(tenantId: string, typeId: string, delta: 1 | -1): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const row = await counts.get(typeId);
    let current = row?.count ?? 0;
    if (delta > 0 && current >= ENTITY_ROW_CAP_PER_TYPE) {
      const actual = (await records.listByPrefix(`${typeId}|`)).length;
      if (actual >= ENTITY_ROW_CAP_PER_TYPE) {
        throw new OpenwopError(
          'conflict',
          `Entity cap reached for this type (${ENTITY_ROW_CAP_PER_TYPE}).`,
          409,
          { typeId, cap: ENTITY_ROW_CAP_PER_TYPE },
        );
      }
      current = actual; // drift healed — proceed with the true count
    }
    const next: TypeCountRow = { typeId, tenantId, count: Math.max(0, current + delta) };
    if (await counts.compareAndSwap(row, next)) return;
  }
  throw new OpenwopError('conflict', 'Concurrent write burst — retry.', 409, { typeId });
}

/** Strip null/undefined (a null on update clears a key — handled by the caller). */
function compactValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

const MAX_TERMS_PER_ENTITY = 32;

/** The reference-resolver injected into the ONE validator (ADR 0257): a
 *  `reference` value must name an EXISTING entity of the target type in the
 *  same tenant+project scope. */
function referenceResolverFor(type: EntityTypeRecord): (refName: string, id: string) => Promise<boolean> {
  return async (refName, id) => {
    const targetTypeId = `${type.tenantId}:${type.projectId}:${refName}`;
    const target = await records.get(recordKeyOf(targetTypeId, id));
    return target !== null && target.tenantId === type.tenantId;
  };
}

/** Validate + dedupe taxonomy membership: every term must exist in the tenant. */
async function validateTermIds(tenantId: string, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`termIds` must be an array of term ids.', 400, { field: 'termIds' });
  }
  const termIds = [...new Set(raw.map((x) => String(x)))];
  if (termIds.length > MAX_TERMS_PER_ENTITY) {
    throw new OpenwopError('validation_error', `An entity may carry at most ${MAX_TERMS_PER_ENTITY} terms.`, 400, { field: 'termIds' });
  }
  for (const termId of termIds) {
    if (!(await getTermById(tenantId, termId))) {
      throw new OpenwopError('validation_error', `Unknown term \`${termId}\`.`, 400, { termId });
    }
  }
  return termIds;
}

/** The target record-keys this entity's `reference` values point at. */
function refTargetKeysOf(type: EntityTypeRecord, values: Record<string, string | number | boolean>): string[] {
  const out: string[] = [];
  for (const spec of type.fields) {
    if (spec.type !== 'reference' || !spec.refEntityType) continue;
    const v = values[spec.key];
    if (typeof v === 'string' && v.length > 0) {
      out.push(recordKeyOf(`${type.tenantId}:${type.projectId}:${spec.refEntityType}`, v));
    }
  }
  return [...new Set(out)];
}

/** Diff + write the reverse-reference index (bounded per-entity fan-out). */
async function syncRefIndex(rec: EntityRecord, prevTargets: string[], nextTargets: string[]): Promise<void> {
  const prev = new Set(prevTargets);
  const next = new Set(nextTargets);
  for (const target of nextTargets) {
    if (!prev.has(target)) {
      await refIdx.put({ key: `${target}|${rec.recordKey}`, tenantId: rec.tenantId, sourceRecordKey: rec.recordKey });
    }
  }
  for (const target of prevTargets) {
    if (!next.has(target)) await refIdx.delete(`${target}|${rec.recordKey}`);
  }
}

/** Diff + write the term-membership index. */
async function syncTermIndex(rec: EntityRecord, prevTermIds: string[], nextTermIds: string[]): Promise<void> {
  const prev = new Set(prevTermIds);
  const next = new Set(nextTermIds);
  for (const termId of nextTermIds) {
    if (!prev.has(termId)) await termIdx.put({ key: `${termId}|${rec.recordKey}`, tenantId: rec.tenantId, recordKey: rec.recordKey });
  }
  for (const termId of prevTermIds) {
    if (!next.has(termId)) await termIdx.delete(`${termId}|${rec.recordKey}`);
  }
}

/** Injected into taxonomyService.deleteTerm — is any entity still in this term? */
export async function isTermInUse(termId: string): Promise<boolean> {
  return (await termIdx.listByPrefix(`${termId}|`)).length > 0;
}

/** ADR 0386 Phase 4 — the host-extension write event (`host.` namespace per
 *  RFC 0086 §E). Fire-and-forget; delivery rides the EXISTING webhook worker +
 *  event→workflow bindings via `hostEventDispatcher` — no new delivery path.
 *  Payload is ids-only (no field values — value payloads could carry PII). */
function emitEntityWritten(tenantId: string, typeName: string, entityId: string, op: 'create' | 'update' | 'delete'): void {
  void emitHostEvent({
    type: 'openwop-app.entities.entity-written',
    tenantId,
    payload: { typeName, entityId, op },
  });
}

export async function createEntity(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  values: Record<string, unknown>;
  termIds?: unknown;
  /** ADR 0407 — `'draft'` withholds the entry from the public read; `'live'`
   *  (or absent) is the default live state (stored as ABSENT). */
  status?: unknown;
  /** ADR 0406 — sparse per-locale overlays (validated against `localizable` fields). */
  localizations?: unknown;
  /** Deterministic id (ADR 0162) — a re-run with the same id returns the existing row. */
  entityId?: string;
  createdBy: string;
}): Promise<EntityRecord> {
  const status = parseEntryStatus(input.status);
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.typeName });
  assertNotSystemWrite(type);
  const localizations = await validateEntityLocalizations(type, input.localizations);
  const values = (await validateFieldValues(type.fields, compactValues(input.values), {
    requireAll: true,
    entityLabel: type.name,
    resolveReference: referenceResolverFor(type),
  })) as Record<string, string | number | boolean>;
  const termIds = input.termIds !== undefined ? await validateTermIds(input.tenantId, input.termIds) : [];
  const entityId = input.entityId?.trim() || randomUUID();
  const recordKey = recordKeyOf(type.typeId, entityId);
  const prior = await records.get(recordKey);
  if (prior) {
    if (input.entityId) return prior; // idempotent re-create (ADR 0162)
    throw new OpenwopError('conflict', 'Entity id collision — retry.', 409, { entityId });
  }
  await bumpCount(input.tenantId, type.typeId, 1);
  const now = new Date().toISOString();
  const rec: EntityRecord = {
    recordKey,
    entityId,
    tenantId: input.tenantId,
    projectId: type.projectId,
    typeId: type.typeId,
    values,
    ...(termIds.length > 0 ? { termIds } : {}),
    ...(status === 'draft' ? { status: 'draft' as const } : {}),
    ...(localizations ? { localizations } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedBy: input.createdBy,
    updatedAt: now,
  };
  const won = await records.compareAndSwap(null, rec);
  if (!won) {
    await bumpCount(input.tenantId, type.typeId, -1);
    const raced = await records.get(recordKey);
    if (raced && input.entityId) return raced; // concurrent idempotent creates converge
    throw new OpenwopError('conflict', 'Entity id collision — retry.', 409, { entityId });
  }
  await syncRefIndex(rec, [], refTargetKeysOf(type, values));
  await syncTermIndex(rec, [], termIds);
  emitEntityWritten(rec.tenantId, type.name, rec.entityId, 'create');
  return rec;
}

/**
 * ADR 0406 — validate a sparse per-locale overlay map: BCP-47 locale keys,
 * each overlay a PARTIAL map over the type's `localizable` string fields,
 * every value through the ONE seam validator (partial posture — required-ness
 * is a base-values invariant). Empty overlays are dropped; an empty result
 * returns undefined so nothing persists an `{}`.
 */
async function validateEntityLocalizations(
  type: EntityTypeRecord,
  raw: unknown,
): Promise<Record<string, Record<string, string>> | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`localizations` must be an object of locale → field overlays.', 400, { field: 'localizations' });
  }
  const localizableDefs = type.fields.filter((f) => f.localizable === true);
  if (localizableDefs.length === 0 && Object.keys(raw).length > 0) {
    throw new OpenwopError('validation_error', `Type \`${type.name}\` has no localizable fields.`, 400, { field: 'localizations' });
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, overlay] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale)) {
      throw new OpenwopError('validation_error', `Invalid overlay locale \`${locale}\` (expected BCP-47).`, 400, { locale });
    }
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
      throw new OpenwopError('validation_error', `Overlay for \`${locale}\` must be an object.`, 400, { locale });
    }
    const provided = compactValues(overlay as Record<string, unknown>);
    for (const key of Object.keys(provided)) {
      if (!localizableDefs.some((f) => f.key === key)) {
        throw new OpenwopError('validation_error', `Field \`${key}\` is not localizable on \`${type.name}\`.`, 400, { key, locale });
      }
    }
    const validated = (await validateFieldValues(localizableDefs, provided, {
      requireAll: false,
      entityLabel: `${type.name} (${locale} overlay)`,
    })) as Record<string, string>;
    if (Object.keys(validated).length > 0) out[locale] = validated;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── System types + system rows (ADR 0408 Phase C) ───────────────────────────

/** Dotted, feature-scoped system names (`cms.page`). User names can NEVER
 *  collide: `normalizeTypeName`'s NAME_RE rejects dots. */
const SYSTEM_NAME_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

/**
 * Mint (idempotently) a SYSTEM content type. Code-owned: schema changes ship
 * as code + migration — a re-mint with a different shape UPDATES the stored
 * schema in place (deterministic key CAS; the owning feature is the only
 * caller). Never counts against the user type cap; never publicRead by
 * default.
 */
export async function mintSystemType(input: {
  tenantId: string;
  name: string;
  displayName: string;
  description?: string;
  fields: unknown;
  /** Registered extension kinds this type's fields may use (e.g. ['blocks']). */
  extensionKinds?: string[];
  /** ADR 0409 Phase 1 — mint a type that can NEVER be publicly readable (CRM). */
  neverPublic?: boolean;
  actor: string;
}): Promise<EntityTypeRecord> {
  if (!SYSTEM_NAME_RE.test(input.name)) {
    throw new OpenwopError('validation_error', 'System type names must be dotted feature-scoped slugs (e.g. `cms.page`).', 400, { name: input.name });
  }
  const fields = buildFields(input.fields, [], input.extensionKinds);
  const typeId = typeKeyOf(input.tenantId, undefined, input.name);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await types.get(typeId);
    const now = new Date().toISOString();
    if (!existing) {
      const rec: EntityTypeRecord = {
        typeId,
        tenantId: input.tenantId,
        projectId: '',
        name: input.name,
        displayName: input.displayName,
        ...(input.description !== undefined ? { description: input.description } : {}),
        fields,
        status: 'published',
        system: true,
        ...(input.neverPublic ? { neverPublic: true as const } : {}),
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
      };
      if (await types.compareAndSwap(null, rec)) return rec;
      continue;
    }
    if (JSON.stringify(existing.fields) === JSON.stringify(fields) && existing.displayName === input.displayName
        && Boolean(existing.neverPublic) === Boolean(input.neverPublic)) {
      return existing; // idempotent re-mint
    }
    // A re-mint reconciles the schema AND the neverPublic flag (code-owned).
    const next: EntityTypeRecord = {
      ...existing, displayName: input.displayName, fields, system: true, updatedAt: now,
      ...(input.neverPublic ? { neverPublic: true as const } : {}),
    };
    if (!input.neverPublic) delete next.neverPublic;
    if (await types.compareAndSwap(existing, next)) return next;
  }
  throw new OpenwopError('conflict', 'Concurrent system-type mint — retry.', 409, { name: input.name });
}

/**
 * Upsert one SYSTEM row (the owning feature's write path — cms pages). Scalar
 * `values` validate through the ONE seam; `ext` entries whose key names an
 * extension-kind FIELD validate through that kind's registered validator;
 * remaining `ext` keys are the feature's domain metadata, stored blind.
 * Put-semantics (the cms page-store contract); maintains the per-type count
 * on first write; emits the host write event.
 */
/** Shared system-row content validation (put + CAS): scalar `values` through
 *  the ONE seam; `ext` extension-kind FIELDS via their registered validator,
 *  other `ext` keys stored blind (façade domain metadata). */
async function validateSystemScalars(type: EntityTypeRecord, values: Record<string, unknown>): Promise<Record<string, string | number | boolean>> {
  const scalarDefs = type.fields.filter((f) => (FIELD_TYPES as string[]).includes(f.type));
  return (await validateFieldValues(scalarDefs, compactValues(values), { requireAll: true, entityLabel: type.name })) as Record<string, string | number | boolean>;
}
async function buildSystemExt(type: EntityTypeRecord, raw: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
  if (raw === undefined) return undefined;
  const ext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const def = type.fields.find((f) => f.key === key && !(FIELD_TYPES as string[]).includes(f.type));
    if (def) {
      const validator = getFieldKindValidator(def.type);
      if (!validator) throw new OpenwopError('validation_error', `Extension kind \`${def.type}\` has no registered validator.`, 400, { key });
      ext[key] = await validator.validate(value, def);
    } else {
      ext[key] = value; // façade-owned domain metadata (stored blind)
    }
  }
  return ext;
}

/**
 * ADR 0409 Phase 2 — CAS-guarded system-row UPDATE (the CRM/commerce merge
 * paths). Swaps only if the CURRENT stored record still satisfies `matches`
 * (the façade's byte-identical CAS predicate over `ext.<domain>`); returns
 * `null` on a CAS miss (row gone, changed, or lost race — the façade's
 * `casUpdate*` returns null and its caller retries, semantics preserved). No
 * count change (update only); shares put's validation + term-sync + event.
 */
export async function casSystemEntity(input: {
  tenantId: string;
  typeName: string;
  entityId: string;
  matches: (current: EntityRecord) => boolean;
  values: Record<string, unknown>;
  ext?: Record<string, unknown>;
  /** ADR 0409 — opaque org id for the host-ext org guard/teardown (org-scoped rows). */
  orgId?: string;
  status?: 'draft' | 'live';
  termIds?: unknown;
  actor: string;
}): Promise<EntityRecord | null> {
  const type = await getEntityType(input.tenantId, undefined, input.typeName);
  if (!type?.system) throw new OpenwopError('not_found', 'System type not found.', 404, { typeName: input.typeName });
  const recordKey = recordKeyOf(type.typeId, input.entityId);
  const existing = await records.get(recordKey);
  if (!existing || !input.matches(existing)) return null; // CAS miss
  const values = await validateSystemScalars(type, input.values);
  const ext = await buildSystemExt(type, input.ext);
  const termIds = input.termIds !== undefined ? await validateTermIds(input.tenantId, input.termIds) : undefined;
  const next: EntityRecord = { ...existing, values, updatedBy: input.actor, updatedAt: new Date().toISOString() };
  if (input.orgId !== undefined) next.orgId = input.orgId; else delete next.orgId;
  if (ext && Object.keys(ext).length > 0) next.ext = ext; else delete next.ext;
  if (input.status === 'draft') next.status = 'draft'; else if (input.status === 'live') delete next.status;
  if (termIds !== undefined) { if (termIds.length > 0) next.termIds = termIds; else delete next.termIds; }
  if (await records.compareAndSwap(existing, next)) {
    if (termIds !== undefined) await syncTermIndex(next, existing.termIds ?? [], termIds);
    emitEntityWritten(next.tenantId, type.name, next.entityId, 'update');
    return next;
  }
  return null; // lost race = CAS miss (caller retries)
}

export async function putSystemEntity(input: {
  tenantId: string;
  typeName: string;
  entityId: string;
  values: Record<string, unknown>;
  ext?: Record<string, unknown>;
  status?: 'draft' | 'live';
  /** ADR 0408 Phase D — taxonomy membership for system rows (blog categories
   *  on pages; validated term ids, index-synced like any row). */
  termIds?: unknown;
  /** ADR 0409 — opaque org id for the host-ext org guard/teardown (org-scoped rows). */
  orgId?: string;
  /** ADR 0406/0453 P2 — sparse per-locale overlays over this type's `localizable`
   *  fields (validated; system types opt into l10n exactly like user entities).
   *  Omit to PRESERVE the existing overlays on update (like `termIds`). */
  localizations?: unknown;
  /** ADR 0754 — CREATE, never update: an existing row (or one a concurrent writer
   *  lands first) is a `409 conflict`, not an overwrite. The absent branch below is
   *  already a CAS against `null`; without this flag its lost race falls through to
   *  the update branch on the retry and overwrites the winner. */
  createOnly?: boolean;
  actor: string;
}): Promise<EntityRecord> {
  const type = await getEntityType(input.tenantId, undefined, input.typeName);
  if (!type?.system) throw new OpenwopError('not_found', 'System type not found.', 404, { typeName: input.typeName });
  const values = await validateSystemScalars(type, input.values);
  const ext = await buildSystemExt(type, input.ext);
  const termIds = input.termIds !== undefined ? await validateTermIds(input.tenantId, input.termIds) : undefined;
  const localizations = input.localizations !== undefined ? await validateEntityLocalizations(type, input.localizations) : undefined;
  const recordKey = recordKeyOf(type.typeId, input.entityId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await records.get(recordKey);
    if (existing && input.createOnly) {
      throw new OpenwopError('conflict', 'A row with this id already exists.', 409, { entityId: input.entityId });
    }
    const now = new Date().toISOString();
    const next: EntityRecord = {
      recordKey,
      entityId: input.entityId,
      tenantId: input.tenantId,
      projectId: type.projectId,
      typeId: type.typeId,
      values,
      ...(termIds !== undefined
        ? (termIds.length > 0 ? { termIds } : {})
        : (existing?.termIds && existing.termIds.length > 0 ? { termIds: existing.termIds } : {})),
      // §Correction (grade-data `ENT-1`) — PRESERVE-ON-OMIT, matching `termIds`
      // and `localizations` below. `next` is built fresh rather than spread from
      // `existing`, so a caller updating only `values` silently DROPPED the row's
      // `ext`, `orgId` and draft `status`. Two of the five omittable fields had
      // already been given explicit preserve semantics; the other three had not,
      // which made the rule inconsistent and the data loss invisible. Concretely
      // for tutorials: a `values`-only refresh erased `ext.customizedAt`, the very
      // marker that decides whether the next refresh may overwrite a tenant edit.
      ...(input.status === 'draft'
        ? { status: 'draft' as const }
        : (input.status === undefined && existing?.status === 'draft' ? { status: 'draft' as const } : {})),
      ...(ext && Object.keys(ext).length > 0
        ? { ext }
        : (input.ext === undefined && existing?.ext ? { ext: existing.ext } : {})),
      // ADR 0453 P2 — provided ⇒ set (or drop when empty); omitted ⇒ preserve
      // the existing overlays (a `values`-only update must not wipe l10n).
      ...(input.localizations !== undefined
        ? (localizations ? { localizations } : {})
        : (existing?.localizations ? { localizations: existing.localizations } : {})),
      ...(input.orgId !== undefined
        ? { orgId: input.orgId }
        : (existing?.orgId ? { orgId: existing.orgId } : {})),
      createdBy: existing?.createdBy ?? input.actor,
      createdAt: existing?.createdAt ?? now,
      updatedBy: input.actor,
      updatedAt: now,
    };
    if (existing) {
      if (await records.compareAndSwap(existing, next)) {
        if (termIds !== undefined) await syncTermIndex(next, existing.termIds ?? [], termIds);
        emitEntityWritten(next.tenantId, type.name, next.entityId, 'update');
        return next;
      }
    } else {
      await bumpCount(input.tenantId, type.typeId, 1);
      if (await records.compareAndSwap(null, next)) {
        if (termIds !== undefined && termIds.length > 0) await syncTermIndex(next, [], termIds);
        emitEntityWritten(next.tenantId, type.name, next.entityId, 'create');
        return next;
      }
      await bumpCount(input.tenantId, type.typeId, -1);
    }
  }
  throw new OpenwopError('conflict', 'Concurrent system-row write — retry.', 409, { entityId: input.entityId });
}

/** Delete one SYSTEM row (no referrer plan — system types declare no
 *  relationships; the owning feature manages its own domain cascades). */
export async function deleteSystemEntity(input: { tenantId: string; typeName: string; entityId: string }): Promise<boolean> {
  const type = await getEntityType(input.tenantId, undefined, input.typeName);
  if (!type?.system) return false;
  const rec = await records.get(recordKeyOf(type.typeId, input.entityId));
  if (!rec || rec.tenantId !== input.tenantId) return false;
  // §Correction (grade-data `ENT-2`) — CLEAN THE INDEXES, like `deleteEntity` does.
  // This path deleted the RECORD only. A system row may carry `termIds` (system
  // types explicitly support them), and `isTermInUse` reads `entity:term-idx`, so
  // an orphaned index row made the deleted entity look like a live user of its
  // term — blocking that term's deletion FOREVER with no way to see why. The
  // ref index has the same shape. Both syncs are idempotent and no-op when the
  // row carries nothing, so this is safe for the scalar-only system rows too.
  await syncRefIndex(rec, refTargetKeysOf(type, rec.values), []);
  await syncTermIndex(rec, rec.termIds ?? [], []);
  await records.delete(rec.recordKey);
  await bumpCount(input.tenantId, type.typeId, -1);
  emitEntityWritten(input.tenantId, type.name, input.entityId, 'delete');
  return true;
}

/** Bounded list of one SYSTEM type's rows (the façade's page store). */
export async function listSystemEntities(tenantId: string, typeName: string): Promise<EntityRecord[]> {
  const type = await getEntityType(tenantId, undefined, typeName);
  if (!type?.system) return [];
  return records.listByPrefix(`${type.typeId}|`);
}

/** Point read of one SYSTEM row. */
export async function getSystemEntity(tenantId: string, typeName: string, entityId: string): Promise<EntityRecord | null> {
  const type = await getEntityType(tenantId, undefined, typeName);
  if (!type?.system) return null;
  const rec = await records.get(recordKeyOf(type.typeId, entityId));
  return rec && rec.tenantId === tenantId ? rec : null;
}

/** ADR 0409 — every row of a system type ACROSS ALL TENANTS (a global scan of
 *  the per-tenant system types). For one-time MIGRATIONS/backfills only (never a
 *  hot path); each row carries its tenantId so the caller writes back per-tenant. */
export async function listAllSystemRows(typeName: string): Promise<EntityRecord[]> {
  const out: EntityRecord[] = [];
  for (const t of await types.list()) {
    if (t.name !== typeName || !t.system) continue;
    out.push(...(await records.listByPrefix(`${t.typeId}|`)));
  }
  return out;
}

/** Test-only: drop every tenant's rows + type record for one system type
 *  (the cms `__resetCms` seam). Production code never calls this. */
export async function __clearSystemEntities(typeName: string): Promise<void> {
  const all = await types.list();
  for (const t of all) {
    if (t.name !== typeName || !t.system) continue;
    for (const row of await records.listByPrefix(`${t.typeId}|`)) await records.delete(row.recordKey);
    await types.delete(t.typeId);
  }
}

/** ADR 0408 D1 — generic entity WRITES are blocked on system types (their
 *  rows are managed by the owning feature's system-row API; generic READS and
 *  query stay open — the convergence payoff). */
function assertNotSystemWrite(type: EntityTypeRecord): void {
  if (type.system) {
    throw new OpenwopError('validation_error', `\`${type.name}\` is a system type — its records are managed by the owning feature.`, 400, { typeName: type.name });
  }
}

/** ADR 0407 — entry-status parser (closed-world: `draft` | `live` | absent). */
function parseEntryStatus(raw: unknown): 'draft' | 'live' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'draft' || raw === 'live') return raw;
  throw new OpenwopError('validation_error', 'status must be `draft` or `live`.', 400, { field: 'status' });
}

/**
 * ADR 0407 D2 — the anonymous-wire projection. Strips storage/actor fields:
 * `createdBy`/`updatedBy` are member subjects (PII-adjacent — MUST NOT reach
 * the public wire), `recordKey`/`typeId`/`tenantId`/`projectId` are storage
 * internals, `status` is redundant (public reads only ever serve live rows).
 */
export interface PublicEntity {
  entityId: string;
  values: Record<string, string | number | boolean>;
  termIds?: string[];
  createdAt: string;
  updatedAt: string;
}
export function toPublicEntity(
  rec: EntityRecord,
  /** ADR 0406 — resolve values to ONE locale (exact → family → base); the
   *  overlay map itself never reaches the anonymous wire. Absent ⇒ base. */
  locale?: { negotiated: string; baseLocale: string },
): PublicEntity {
  const values = locale
    ? resolveLocalizedValues(rec.values, rec.localizations, locale.negotiated, locale.baseLocale)
    : rec.values;
  return {
    entityId: rec.entityId,
    values,
    ...(rec.termIds && rec.termIds.length > 0 ? { termIds: rec.termIds } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export interface EntityPage {
  entities: EntityRecord[];
  nextCursor?: string;
}

const CURSOR_SEP = '\u0000';

export async function listEntities(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  limit?: number;
  cursor?: string;
}): Promise<EntityPage> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.typeName });
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  // Bounded: rows keyed under the typeId prefix only — never a tenant scan.
  const rows = await records.listByPrefix(`${type.typeId}|`);
  rows.sort((a, b) => (a.createdAt === b.createdAt ? a.entityId.localeCompare(b.entityId) : b.createdAt.localeCompare(a.createdAt)));
  let start = 0;
  if (input.cursor) {
    const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
    const [createdAt, entityId] = decoded.split(CURSOR_SEP);
    const idx = rows.findIndex((r) => r.createdAt === createdAt && r.entityId === entityId);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = rows.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < rows.length && last
      ? Buffer.from(`${last.createdAt}${CURSOR_SEP}${last.entityId}`, 'utf8').toString('base64url')
      : undefined;
  return { entities: page, ...(nextCursor ? { nextCursor } : {}) };
}

export async function getEntity(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  entityId: string;
}): Promise<EntityRecord | null> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) return null;
  const rec = await records.get(recordKeyOf(type.typeId, input.entityId));
  return rec && rec.tenantId === input.tenantId ? rec : null;
}

export async function updateEntity(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  entityId: string;
  /** Patch semantics: provided keys replace; explicit `null` clears a NON-required key. */
  values: Record<string, unknown>;
  /** When provided, REPLACES the entity's taxonomy membership. */
  termIds?: unknown;
  /** ADR 0407 — `'draft'` withholds from the public read; `'live'` restores. */
  status?: unknown;
  /** ADR 0406 — when provided, REPLACES the entity's overlay map (the termIds
   *  precedent); `null`/`{}` clears it. */
  localizations?: unknown;
  actor: string;
}): Promise<EntityRecord | null> {
  const nextStatus = parseEntryStatus(input.status);
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) return null;
  assertNotSystemWrite(type);
  const nextLocalizations =
    input.localizations === undefined ? undefined
      : input.localizations === null ? null
        : ((await validateEntityLocalizations(type, input.localizations)) ?? null);
  const requiredKeys = new Set(type.fields.filter((f) => f.required).map((f) => f.key));
  const nextTermIds = input.termIds !== undefined ? await validateTermIds(input.tenantId, input.termIds) : undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await records.get(recordKeyOf(type.typeId, input.entityId));
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const cleared = Object.entries(input.values)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    for (const key of cleared) {
      if (requiredKeys.has(key)) {
        throw new OpenwopError('validation_error', `Field \`${key}\` is required and cannot be cleared.`, 400, { key });
      }
    }
    const provided = compactValues(input.values);
    const validated = (await validateFieldValues(type.fields, provided, {
      requireAll: false,
      entityLabel: type.name,
      resolveReference: referenceResolverFor(type),
    })) as Record<string, string | number | boolean>;
    const nextValues = { ...existing.values, ...validated };
    for (const key of cleared) delete nextValues[key];
    const next: EntityRecord = {
      ...existing,
      values: nextValues,
      updatedBy: input.actor,
      updatedAt: new Date().toISOString(),
    };
    if (nextTermIds !== undefined) {
      if (nextTermIds.length > 0) next.termIds = nextTermIds;
      else delete next.termIds;
    }
    if (nextStatus !== undefined) {
      if (nextStatus === 'draft') next.status = 'draft';
      else delete next.status; // 'live' = the absent default
    }
    if (nextLocalizations !== undefined) {
      if (nextLocalizations) next.localizations = nextLocalizations;
      else delete next.localizations; // null/{} ⇒ clear
    }
    if (await records.compareAndSwap(existing, next)) {
      await syncRefIndex(next, refTargetKeysOf(type, existing.values), refTargetKeysOf(type, nextValues));
      if (nextTermIds !== undefined) await syncTermIndex(next, existing.termIds ?? [], nextTermIds);
      emitEntityWritten(next.tenantId, type.name, next.entityId, 'update');
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Concurrent entity update — retry.', 409, { entityId: input.entityId });
}

/** Referrer bookkeeping for one delete: the relationship policy per SOURCE type
 *  decides restrict / cascade / set-null (default RESTRICT — fail closed). */
const CASCADE_DEPTH_LIMIT = 5;

interface DeletePlan {
  /** Rows to delete, LEAVES FIRST (deepest cascade first, target last). */
  deletions: Array<{ rec: EntityRecord; type: EntityTypeRecord }>;
  /** set-null patches to apply BEFORE the deletions. */
  clears: Array<{ source: EntityRecord; sourceType: EntityTypeRecord; keys: string[] }>;
  /** Stale ref-idx markers discovered during planning — self-healed on execute. */
  staleMarkers: string[];
}

/**
 * PLAN-THEN-EXECUTE delete (grade-code #1 + grade-data D1): the entire referrer
 * closure is walked READ-ONLY first — any `restrict` policy or required-ref
 * set-null anywhere in the closure rejects the whole operation BEFORE a single
 * mutation, so a 409 never leaves partially-deleted state. Stale ref-idx
 * markers (a removed reference field, a crashed index write) are detected by
 * verifying the source still holds a LIVE reference — a marker with no live
 * reference is self-healed, never enforced (no "phantom restrict").
 */
async function planDelete(
  target: { rec: EntityRecord; type: EntityTypeRecord },
  depth: number,
  plan: DeletePlan,
  visiting: Set<string>,
): Promise<void> {
  if (depth > CASCADE_DEPTH_LIMIT) {
    throw new OpenwopError('conflict', `Cascade depth limit (${CASCADE_DEPTH_LIMIT}) exceeded.`, 409, {});
  }
  if (visiting.has(target.rec.recordKey)) return; // reference cycle — already planned
  visiting.add(target.rec.recordKey);

  const referrers = await refIdx.listByPrefix(`${target.rec.recordKey}|`);
  for (const idx of referrers) {
    const source = await records.get(idx.sourceRecordKey);
    if (!source || source.tenantId !== target.rec.tenantId) {
      plan.staleMarkers.push(idx.key); // row gone — self-heal
      continue;
    }
    if (visiting.has(source.recordKey)) continue;
    const sourceType = await types.get(source.typeId);
    if (!sourceType) continue;
    // Liveness: enforce only on a CURRENT reference field whose value still
    // points at the target — anything else is a stale marker (grade-data D1).
    const liveRefKeys = sourceType.fields
      .filter((f) => f.type === 'reference' && f.refEntityType === target.type.name && source.values[f.key] === target.rec.entityId)
      .map((f) => f.key);
    if (liveRefKeys.length === 0) {
      plan.staleMarkers.push(idx.key);
      continue;
    }
    const rel = await relationships.get(`${source.typeId}->${target.type.typeId}`);
    const policy: RelationshipOnDelete = rel?.onDelete ?? 'restrict';
    if (policy === 'restrict') {
      throw new OpenwopError(
        'conflict',
        `Entity is still referenced by \`${sourceType.name}\` records (onDelete: restrict).`,
        409,
        { referencedBy: sourceType.name },
      );
    }
    if (policy === 'cascade') {
      await planDelete({ rec: source, type: sourceType }, depth + 1, plan, visiting);
      continue;
    }
    // set-null — a REQUIRED ref cannot be nulled: fail closed like restrict.
    const required = sourceType.fields.find((f) => liveRefKeys.includes(f.key) && f.required);
    if (required) {
      throw new OpenwopError(
        'conflict',
        `Entity is referenced by a REQUIRED \`${sourceType.name}.${required.key}\` field — cannot set-null.`,
        409,
        { referencedBy: sourceType.name, field: required.key },
      );
    }
    plan.clears.push({ source, sourceType, keys: liveRefKeys });
  }
  // Leaves-first: cascaded referrers were pushed above; the target goes after.
  plan.deletions.push(target);
}

export async function deleteEntity(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  entityId: string;
}): Promise<boolean> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) return false;
  // Defense-in-depth, matching create/update: a system type's rows are managed
  // by its owning façade (which runs the domain cascade + org-RBAC). The HTTP
  // route already 404s system types via requireEntitiesScope, but the workflow
  // `surface.delete` verb reaches this directly — without this guard it would
  // delete a crm.company/crm.deal/cms.page/commerce.product kernel row straight
  // out from under the façade, stranding refs (dangling companyId) and skipping
  // the org scope. Refuse it here so every caller is covered. (ADR 0409 Phase 4.)
  assertNotSystemWrite(type);
  const rec = await records.get(recordKeyOf(type.typeId, input.entityId));
  if (!rec || rec.tenantId !== input.tenantId) return false;

  // Phase 1 — read-only planning. Throws (restrict/required/depth) BEFORE any write.
  const plan: DeletePlan = { deletions: [], clears: [], staleMarkers: [] };
  await planDelete({ rec, type }, 0, plan, new Set());

  // Phase 2 — execute: heal stale markers, apply set-null patches, then delete
  // leaves-first (a crash mid-way leaves extra-deleted leaves, never a
  // half-enforced policy — the target row is the LAST thing removed).
  for (const key of plan.staleMarkers) await refIdx.delete(key);
  for (const clear of plan.clears) {
    // Skip sources that are themselves being deleted by the cascade.
    if (plan.deletions.some((d) => d.rec.recordKey === clear.source.recordKey)) continue;
    await updateEntity({
      tenantId: input.tenantId,
      projectId: clear.source.projectId || undefined,
      typeName: clear.sourceType.name,
      entityId: clear.source.entityId,
      values: Object.fromEntries(clear.keys.map((k) => [k, null])),
      actor: 'system:entities-set-null',
    });
  }
  let deletedTarget = false;
  for (const d of plan.deletions) {
    await syncRefIndex(d.rec, refTargetKeysOf(d.type, d.rec.values), []);
    await syncTermIndex(d.rec, d.rec.termIds ?? [], []);
    const deleted = await records.delete(d.rec.recordKey);
    if (deleted) {
      await bumpCount(d.rec.tenantId, d.type.typeId, -1);
      emitEntityWritten(d.rec.tenantId, d.type.name, d.rec.entityId, 'delete');
    }
    if (d.rec.recordKey === rec.recordKey) deletedTarget = deleted;
  }
  return deletedTarget;
}

// ---- Query / filter (ADR 0386 Phase 3) ----

export type QueryOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
const QUERY_OPS: QueryOp[] = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'];
const MAX_FILTERS = 8;

export interface QueryFilter {
  key: string;
  op: QueryOp;
  value: unknown;
}

function matchesFilter(row: EntityRecord, filter: QueryFilter): boolean {
  const v = row.values[filter.key];
  switch (filter.op) {
    case 'eq':
      return v === filter.value;
    case 'neq':
      return v !== filter.value;
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(v);
    case 'gt':
      return typeof v === typeof filter.value && v !== undefined && v > (filter.value as string | number);
    case 'gte':
      return typeof v === typeof filter.value && v !== undefined && v >= (filter.value as string | number);
    case 'lt':
      return typeof v === typeof filter.value && v !== undefined && v < (filter.value as string | number);
    case 'lte':
      return typeof v === typeof filter.value && v !== undefined && v <= (filter.value as string | number);
    case 'contains':
      return typeof v === 'string' && typeof filter.value === 'string' && v.toLowerCase().includes(filter.value.toLowerCase());
    default:
      return false;
  }
}

/**
 * Server-side filter/sort/paginate over the BOUNDED per-type page (ADR 0386
 * §Indexing — post-fetch over ≤ the row cap, never a tenant scan; the ceiling
 * is named, not pretended away). `termId` narrows via the membership index
 * FIRST, so a term query reads only the term's slice.
 */
export async function queryEntities(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  filters?: unknown;
  sort?: { key: string; dir?: 'asc' | 'desc' };
  termId?: string;
  limit?: number;
  cursor?: string;
  /** ADR 0407 — the public read serves LIVE rows only. Applied BEFORE
   *  sort/pagination so page sizes and cursors stay stable. */
  excludeDrafts?: boolean;
}): Promise<EntityPage & { total: number }> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.typeName });

  const filters: QueryFilter[] = [];
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters) || input.filters.length > MAX_FILTERS) {
      throw new OpenwopError('validation_error', `\`filters\` must be an array of at most ${MAX_FILTERS}.`, 400, { field: 'filters' });
    }
    const specByKey = new Map(type.fields.map((f) => [f.key, f]));
    for (const raw of input.filters) {
      const f = (raw ?? {}) as { key?: unknown; op?: unknown; value?: unknown };
      const key = String(f.key ?? '');
      const spec = specByKey.get(key);
      if (!spec) {
        throw new OpenwopError('validation_error', `Unknown filter field \`${key}\`.`, 400, { key });
      }
      const op = String(f.op ?? 'eq') as QueryOp;
      if (!QUERY_OPS.includes(op)) {
        throw new OpenwopError('validation_error', `op must be one of: ${QUERY_OPS.join(', ')}`, 400, { field: 'op' });
      }
      // Type-check the filter VALUE against the field (grade-code #9a — a
      // range filter with a mismatched value type silently matched nothing).
      if (op === 'in') {
        if (!Array.isArray(f.value)) {
          throw new OpenwopError('validation_error', '`in` filter value must be an array.', 400, { key });
        }
      } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        const wantNumber = spec.type === 'number';
        if (wantNumber && typeof f.value !== 'number') {
          throw new OpenwopError('validation_error', `Range filter on \`${key}\` requires a number value.`, 400, { key });
        }
        if (!wantNumber && typeof f.value !== 'string') {
          throw new OpenwopError('validation_error', `Range filter on \`${key}\` requires a string value.`, 400, { key });
        }
      } else if (op === 'contains' && typeof f.value !== 'string') {
        throw new OpenwopError('validation_error', '`contains` filter value must be a string.', 400, { key });
      }
      filters.push({ key, op, value: f.value });
    }
  }

  let rows: EntityRecord[];
  if (input.termId) {
    const markers = await termIdx.listByPrefix(`${input.termId}|`);
    // Chunked point-reads — never thousands of concurrent gets against the
    // shared pg pool (the connection-budget rule).
    const fetched: (EntityRecord | null)[] = [];
    for (let i = 0; i < markers.length; i += 25) {
      fetched.push(...(await Promise.all(markers.slice(i, i + 25).map((m) => records.get(m.recordKey)))));
    }
    rows = fetched.filter((r): r is EntityRecord => r !== null && r.tenantId === input.tenantId && r.typeId === type.typeId);
  } else {
    rows = await records.listByPrefix(`${type.typeId}|`);
  }

  if (input.excludeDrafts) rows = rows.filter((r) => r.status !== 'draft');
  const filtered = rows.filter((r) => filters.every((f) => matchesFilter(r, f)));

  const sortKey = input.sort?.key;
  const dir = input.sort?.dir === 'asc' ? 1 : -1;
  if (sortKey !== undefined && !type.fields.some((f) => f.key === sortKey) && sortKey !== 'createdAt' && sortKey !== 'updatedAt') {
    throw new OpenwopError('validation_error', `Unknown sort field \`${sortKey}\`.`, 400, { key: sortKey });
  }
  filtered.sort((a, b) => {
    const av = sortKey === undefined || sortKey === 'createdAt' ? a.createdAt : sortKey === 'updatedAt' ? a.updatedAt : a.values[sortKey];
    const bv = sortKey === undefined || sortKey === 'createdAt' ? b.createdAt : sortKey === 'updatedAt' ? b.updatedAt : b.values[sortKey];
    if (av === bv) return a.entityId.localeCompare(b.entityId);
    if (av === undefined) return 1; // missing values sort last either direction
    if (bv === undefined) return -1;
    return (av < bv ? -1 : 1) * dir;
  });

  // KEYSET cursor (grade-code #4 — an offset cursor skips/duplicates rows when
  // rows are written between pages): the cursor pins the last row's (sortValue,
  // entityId); the next page starts strictly after that position in the same
  // deterministic ordering.
  const sortValueOf = (r: EntityRecord): string | number | boolean | undefined =>
    sortKey === undefined || sortKey === 'createdAt' ? r.createdAt : sortKey === 'updatedAt' ? r.updatedAt : r.values[sortKey];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let start = 0;
  if (input.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { v?: unknown; id?: unknown };
      const afterId = String(parsed.id ?? '');
      const idx = filtered.findIndex((r) => sortValueOf(r) === parsed.v && r.entityId === afterId);
      if (idx >= 0) {
        start = idx + 1;
      } else {
        // The pinned row was deleted/changed — resume at the first row sorting
        // strictly after the pinned position (no skips from the removal).
        const after = filtered.findIndex((r) => {
          const v = sortValueOf(r);
          if (v === undefined) return false;
          if (parsed.v === undefined || parsed.v === null) return true;
          if (v === parsed.v) return r.entityId.localeCompare(afterId) * dir > 0;
          return (v < (parsed.v as string | number) ? -1 : 1) * dir > 0;
        });
        start = after >= 0 ? after : filtered.length;
      }
    } catch {
      start = 0; // unreadable cursor — first page
    }
  }
  const page = filtered.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < filtered.length && last
      ? Buffer.from(JSON.stringify({ v: sortValueOf(last) ?? null, id: last.entityId }), 'utf8').toString('base64url')
      : undefined;
  return { entities: page, total: filtered.length, ...(nextCursor ? { nextCursor } : {}) };
}

// ---- Import / export (ADR 0386 Phase 3) ----

const MAX_IMPORT_ROWS = 2000;

/** Bounded export of every entity of a type (the per-type slice). */
export async function exportEntities(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
}): Promise<EntityRecord[]> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.typeName });
  const rows = await records.listByPrefix(`${type.typeId}|`);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entityId.localeCompare(b.entityId));
}

export interface ImportResult {
  created: number;
  existing: number;
  errors: Array<{ line: number; message: string }>;
}

/** Canonical-JSON hash → a deterministic per-row idempotency id (a re-run of
 *  the same file never double-creates — the CRM import precedent). */
function contentIdOf(values: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
  return `imp-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** NDJSON import — every row goes through the SAME closed-world validator as
 *  the routes (one validation choke point, no drift between entry points). */
export async function importEntities(input: {
  tenantId: string;
  projectId?: string;
  typeName: string;
  ndjson: string;
  /** ADR 0406 — the route passes the `entities-localization` toggle state;
   *  rows carrying overlays while it's off error PER-ROW (never a silent drop). */
  allowLocalizations?: boolean;
  actor: string;
}): Promise<ImportResult> {
  const type = await getEntityType(input.tenantId, input.projectId, input.typeName);
  if (!type) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.typeName });
  const lines = input.ndjson.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > MAX_IMPORT_ROWS) {
    throw new OpenwopError('validation_error', `Import is capped at ${MAX_IMPORT_ROWS} rows per request.`, 400, {
      rows: lines.length,
      cap: MAX_IMPORT_ROWS,
    });
  }
  const result: ImportResult = { created: 0, existing: 0, errors: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    let parsed: { entityId?: unknown; values?: unknown; termIds?: unknown; status?: unknown; localizations?: unknown };
    try {
      parsed = JSON.parse(lines[i] ?? '') as typeof parsed;
    } catch {
      result.errors.push({ line: lineNo, message: 'Invalid JSON.' });
      continue;
    }
    if (parsed.values === null || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
      result.errors.push({ line: lineNo, message: 'Row must carry a `values` object.' });
      continue;
    }
    const values = parsed.values as Record<string, unknown>;
    if (parsed.localizations !== undefined && !input.allowLocalizations) {
      result.errors.push({ line: lineNo, message: 'Row carries `localizations` but entity localization is not enabled (`entities-localization` toggle).' });
      continue;
    }
    const entityId = typeof parsed.entityId === 'string' && parsed.entityId.trim() ? parsed.entityId.trim() : contentIdOf(values);
    try {
      const before = await getEntity({ tenantId: input.tenantId, projectId: input.projectId, typeName: input.typeName, entityId });
      await createEntity({
        tenantId: input.tenantId,
        projectId: input.projectId,
        typeName: input.typeName,
        values,
        ...(parsed.termIds !== undefined ? { termIds: parsed.termIds } : {}),
        // ADR 0407 — export→import round-trips the entry status losslessly.
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        // ADR 0406 — overlays round-trip too (toggle-off rows errored above).
        ...(parsed.localizations !== undefined ? { localizations: parsed.localizations } : {}),
        entityId,
        createdBy: input.actor,
      });
      if (before) result.existing += 1;
      else result.created += 1;
    } catch (err) {
      result.errors.push({ line: lineNo, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// ---- Relationships (ADR 0386 Phase 2) ----

const CARDINALITIES: RelationshipCardinality[] = ['one-one', 'one-many', 'many-many'];
const ON_DELETES: RelationshipOnDelete[] = ['restrict', 'cascade', 'set-null'];

export async function createRelationship(input: {
  tenantId: string;
  projectId?: string;
  fromTypeName: string;
  toTypeName: string;
  cardinality?: string;
  onDelete?: string;
}): Promise<RelationshipRecord> {
  const from = await getEntityType(input.tenantId, input.projectId, input.fromTypeName);
  if (!from) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.fromTypeName });
  const to = await getEntityType(input.tenantId, input.projectId, input.toTypeName);
  if (!to) throw new OpenwopError('not_found', 'Entity type not found.', 404, { typeName: input.toTypeName });
  const cardinality = (input.cardinality ?? 'many-many') as RelationshipCardinality;
  if (!CARDINALITIES.includes(cardinality)) {
    throw new OpenwopError('validation_error', `cardinality must be one of: ${CARDINALITIES.join(', ')}`, 400, { field: 'cardinality' });
  }
  const onDelete = (input.onDelete ?? 'restrict') as RelationshipOnDelete;
  if (!ON_DELETES.includes(onDelete)) {
    throw new OpenwopError('validation_error', `onDelete must be one of: ${ON_DELETES.join(', ')}`, 400, { field: 'onDelete' });
  }
  const rec: RelationshipRecord = {
    relId: `${from.typeId}->${to.typeId}`,
    tenantId: input.tenantId,
    projectId: from.projectId,
    fromTypeId: from.typeId,
    toTypeId: to.typeId,
    cardinality,
    onDelete,
    createdAt: new Date().toISOString(),
  };
  const won = await relationships.compareAndSwap(null, rec);
  if (!won) {
    throw new OpenwopError('conflict', 'A relationship for this type pair already exists — delete it first.', 409, {
      fromTypeName: input.fromTypeName,
      toTypeName: input.toTypeName,
    });
  }
  return rec;
}

export async function listRelationships(tenantId: string, projectId?: string): Promise<RelationshipRecord[]> {
  const all = await relationships.listForTenantIndexed(tenantId);
  const filtered = projectId === undefined ? all : all.filter((r) => r.projectId === projectKeyOf(projectId));
  return filtered.sort((a, b) => a.relId.localeCompare(b.relId));
}

export async function deleteRelationship(input: {
  tenantId: string;
  projectId?: string;
  fromTypeName: string;
  toTypeName: string;
}): Promise<boolean> {
  const from = await getEntityType(input.tenantId, input.projectId, input.fromTypeName);
  const to = await getEntityType(input.tenantId, input.projectId, input.toTypeName);
  if (!from || !to) return false;
  const rec = await relationships.get(`${from.typeId}->${to.typeId}`);
  if (!rec || rec.tenantId !== input.tenantId) return false;
  return relationships.delete(rec.relId);
}
