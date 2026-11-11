/**
 * CDP event schema registry (ADR 0269 / CDP-G) — a versioned, per-tenant store of
 * JSON Schemas for event types, with validate-at-ingest. Promotes the fail-open,
 * per-workflow `runInputValidation` to a first-class ingest contract: a registered
 * event type is validated against its schema; an unregistered one passes (no
 * contract ⇒ no rejection), surfaced honestly via `hasSchema`.
 *
 * Versioned: each `registerEventSchema` mints the next integer version for that
 * event type; `getEventSchema`/`validateEvent` use the latest unless a version is
 * pinned. Host-ext (no wire): the ingest contract is a host courtesy until an RFC
 * makes rejection semantics wire-normative.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

// `addUsedSchema: false` (closing grade M4): ajv is one instance for every tenant, and by
// default it indexes each compiled schema under its `$id`, so tenant A's `$id` made tenant
// B's registration of the same `$id` fail to compile.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, addUsedSchema: false });

/** ADR 1024 D4.4 (`CDP2WF-11`) — compiled validators by `(tenant, eventType, version)`.
 *  It used to be a `WeakMap` keyed by the schema OBJECT, but every read parses a fresh
 *  object, so it never hit: each ingest recompiled, and ajv keeps every compiled schema in
 *  its own strong map, so memory grew with every collected event that had a schema. A
 *  record key is immutable (a new version is a new key), so a bounded LRU by key is exact. */
const COMPILED_CACHE_MAX = 500;
const compiled = new Map<string, ValidateFunction | null>();
function compiledFor(rec: EventSchemaRecord): ValidateFunction | null {
  const hit = compiled.get(rec.key);
  if (hit !== undefined) { compiled.delete(rec.key); compiled.set(rec.key, hit); return hit; }
  let fn: ValidateFunction | null;
  try {
    fn = ajv.compile(rec.schema);
  } catch {
    fn = null; // a stored schema that no longer compiles ⇒ do not block ingest
  }
  compiled.set(rec.key, fn);
  if (compiled.size > COMPILED_CACHE_MAX) {
    const oldest = compiled.keys().next().value as string;
    const old = compiled.get(oldest);
    compiled.delete(oldest);
    if (old) ajv.removeSchema(old.schema as object);
  }
  return fn;
}

/** ADR 1024 D4.4 — registration bounds. */
export const MAX_SCHEMA_VERSIONS = 20;
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** Keywords refused on NEW registrations: this host runs ajv on JS regexes (no RE2), so a
 *  catastrophic-backtracking `pattern` blocks the event loop on every ingest of that type.
 *  Schemas stored before ADR 1024 keep compiling: refusing them would 422 every ingest. */
const REFUSED_KEYWORDS = new Set(['pattern', 'patternProperties']);
/** Keywords whose value is a MAP of names to subschemas: the names are data, not keywords
 *  (a property called `pattern` is fine). */
const NAME_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(['const', 'default', 'examples', 'enum']);
/** Deeper than this is refused outright (closing grade H1: a walk that GAVE UP at its depth
 *  limit returned "allowed", so a 65-deep `items` chain carried a pattern through). */
const MAX_SCHEMA_DEPTH = 32;
type RefusedReason = { keyword: string } | { tooDeep: true } | null;
function findRefusedKeyword(v: unknown, depth = 0): RefusedReason {
  if (!v || typeof v !== 'object') return null;
  if (depth > MAX_SCHEMA_DEPTH) return { tooDeep: true };
  if (Array.isArray(v)) {
    for (const item of v) { const hit = findRefusedKeyword(item, depth + 1); if (hit) return hit; }
    return null;
  }
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (REFUSED_KEYWORDS.has(k)) return { keyword: k };
    if (DATA_KEYWORDS.has(k)) continue;
    if (NAME_MAP_KEYWORDS.has(k) && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const sub of Object.values(child as Record<string, unknown>)) { const hit = findRefusedKeyword(sub, depth + 1); if (hit) return hit; }
      continue;
    }
    const hit = findRefusedKeyword(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export interface EventSchemaRecord {
  /** `${tenantId}::${eventType}::${version}` */
  key: string;
  tenantId: string;
  eventType: string;
  version: number;
  schema: Record<string, unknown>;
  createdAt: string;
}

const store = new DurableCollection<EventSchemaRecord>('cdp:event-schema', (r) => r.key, undefined, (r) => r.tenantId);
const keyOf = (tenantId: string, eventType: string, version: number): string => `${tenantId}::${eventType}::${version}`;

const MAX_EVENT_TYPE_LEN = 120;

function assertCompiles(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new OpenwopError('validation_error', 'schema must be a JSON Schema object.', 400, {});
  }
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) {
    throw new OpenwopError('validation_error', `schema must be at most ${MAX_SCHEMA_BYTES / 1024} KB.`, 400, { maxBytes: MAX_SCHEMA_BYTES });
  }
  const refused = findRefusedKeyword(schema);
  if (refused && 'tooDeep' in refused) {
    throw new OpenwopError('validation_error', `schema nesting deeper than ${MAX_SCHEMA_DEPTH} levels is not supported here.`, 400, { maxDepth: MAX_SCHEMA_DEPTH });
  }
  if (refused) {
    throw new OpenwopError('validation_error', `schema keyword \`${refused.keyword}\` is not supported here (regular expressions run on every ingest).`, 400, { keyword: refused.keyword });
  }
  try {
    ajv.compile(schema as object);
    ajv.removeSchema(schema as object); // a compile CHECK; the cache owns compiled copies
  } catch (err) {
    throw new OpenwopError('validation_error', `schema does not compile: ${err instanceof Error ? err.message : String(err)}`, 400, {});
  }
  return schema as Record<string, unknown>;
}

/** All versions of one event type for a tenant (ascending). */
async function versionsOf(tenantId: string, eventType: string): Promise<EventSchemaRecord[]> {
  return (await store.listForTenantIndexed(tenantId))
    .filter((r) => r.eventType === eventType)
    .sort((a, b) => a.version - b.version);
}

/** Livelock/DoS backstop for the version-mint CAS retry. A CAS loss is not a real
 *  conflict — the loser just takes the NEXT version — and each loss is forward progress
 *  (a peer advanced the counter), so the loop always terminates; under N simultaneous
 *  registrations of ONE event type a writer needs at most ~N attempts. This cap only has
 *  to exceed realistic burst concurrency (schema registration is rare + off-hot-path);
 *  the terminal 409 fires solely under pathological/abusive same-instant contention,
 *  bounding per-request storage work. */
const MAX_REGISTER_ATTEMPTS = 25;

/**
 * Register the next version of an event type's schema. Concurrency-safe: the version
 * counter is minted with an insert-if-absent compare-and-swap, NOT a read→put (which
 * lets two concurrent registrations of the same eventType both compute version N+1 and
 * silently clobber each other on the shared key). The CAS — not `versionsOf()` — is the
 * correctness guard: `versionsOf()` only hints the next version, and each attempt re-reads
 * it fresh so a lost race recomputes against the winner's just-written version.
 */
export async function registerEventSchema(tenantId: string, eventType: string, schema: unknown): Promise<EventSchemaRecord> {
  const et = eventType.trim();
  if (!et || et.length > MAX_EVENT_TYPE_LEN) {
    throw new OpenwopError('validation_error', 'eventType is required (<= 120 chars).', 400, { eventType });
  }
  const valid = assertCompiles(schema);
  for (let attempt = 0; attempt < MAX_REGISTER_ATTEMPTS; attempt++) {
    const existing = await versionsOf(tenantId, et); // re-read each attempt — the CAS backstops staleness
    // ADR 1024 D4.4 — every ingest of the type reads all its versions, so the count is a
    // cost bound as well as hygiene. A type already over the cap keeps its versions.
    if (existing.length >= MAX_SCHEMA_VERSIONS) {
      throw new OpenwopError('validation_error', `at most ${MAX_SCHEMA_VERSIONS} versions per event type.`, 400, { eventType: et, max: MAX_SCHEMA_VERSIONS });
    }
    const version = (existing.at(-1)?.version ?? 0) + 1;
    const rec: EventSchemaRecord = { key: keyOf(tenantId, et, version), tenantId, eventType: et, version, schema: valid, createdAt: new Date().toISOString() };
    // insert-if-absent: swaps only if the version key is still unclaimed. A false means a
    // concurrent writer took this version — recompute against the next one and retry.
    if (await store.compareAndSwap(null, rec)) return rec;
  }
  throw new OpenwopError('conflict', 'Could not mint a schema version under concurrent registration; retry.', 409, { eventType: et });
}

/** The latest (or a pinned) schema version for an event type; null when unregistered. */
export async function getEventSchema(tenantId: string, eventType: string, version?: number): Promise<EventSchemaRecord | null> {
  if (version !== undefined) return store.get(keyOf(tenantId, eventType.trim(), version));
  const all = await versionsOf(tenantId, eventType.trim());
  return all.at(-1) ?? null;
}

/** Every registered event type's latest schema for a tenant. */
export async function listEventSchemas(tenantId: string): Promise<EventSchemaRecord[]> {
  const latest = new Map<string, EventSchemaRecord>();
  for (const r of await store.listForTenantIndexed(tenantId)) {
    const cur = latest.get(r.eventType);
    if (!cur || r.version > cur.version) latest.set(r.eventType, r);
  }
  return [...latest.values()].sort((a, b) => a.eventType.localeCompare(b.eventType));
}

export interface ValidateResult {
  valid: boolean;
  hasSchema: boolean;
  version?: number;
  errors?: { path: string; message: string }[];
}

/**
 * Validate an event payload against its registered schema. An UNREGISTERED event
 * type passes (`hasSchema:false`) — no contract, no rejection (honest fail-open).
 * A registered one is validated against the latest (or pinned) version.
 */
export async function validateEvent(tenantId: string, eventType: string, payload: unknown, version?: number): Promise<ValidateResult> {
  const rec = await getEventSchema(tenantId, eventType, version);
  if (!rec) return { valid: true, hasSchema: false };
  const validate = compiledFor(rec);
  if (!validate) return { valid: true, hasSchema: true, version: rec.version };
  const ok = validate(payload) as boolean;
  if (ok) return { valid: true, hasSchema: true, version: rec.version };
  const errors = (validate.errors ?? []).slice(0, 20).map((e) => ({ path: e.instancePath || '(root)', message: e.message ?? 'invalid' }));
  return { valid: false, hasSchema: true, version: rec.version, errors };
}
