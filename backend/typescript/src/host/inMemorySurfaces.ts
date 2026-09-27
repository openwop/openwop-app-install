/**
 * In-memory host surfaces (non-durable).
 *
 * Wires the `ctx.*` surfaces that core packs delegate to (RFCs
 * 0014–0019 + queueBus + observability) so the workflow-engine sample
 * can actually run the most common pack-authored nodes. All state is
 * process-local — restart wipes everything. Tenant isolation is
 * enforced by keying every Map / sqlite-row on `tenantId`.
 *
 * What's NOT here:
 *   - NoSQL (`ctx.db.nosql`) — pack defines insert/find/update/delete
 *     but the demo doesn't pick a document shape; a real impl would
 *     wire Mongo/Firestore.
 *   - Full-text search (`ctx.db.search`) — needs a real index.
 *   - File-system image / pdf / archive helpers — out of scope.
 *   - FTP / SFTP / SSH transports — out of scope.
 *
 * Path to real backends (Phase 6):
 *   The surface interfaces below are the same the real-backend hosts
 *   will satisfy. Swap each `create*InMemory()` with a `create*Postgres`
 *   / `create*Redis` / `create*S3` / etc. in `examples/hosts/postgres`
 *   (which already exists) and re-export through this module's
 *   `HostSurfaceBundle`. NodeContext typing doesn't change.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { assertEffectAllowed } from './runEffectContext.js';
import Database from 'better-sqlite3';
import { createLogger } from '../observability/logger.js';
import { registerHostSurface } from '../bootstrap/hostSurfaceRegistry.js';
import {
  resolveSurface,
  effectiveImplementation,
  assertSelectedBackendsAvailable,
  assertDurableSurfacesInEnterprise,
  type SurfaceKey,
} from './surfaceBackends.js';
import { redactForCompaction, redactRunSecretsForMemory } from '../byok/textRedaction.js';
import { getRunSecrets } from '../byok/ephemeralRunSecrets.js';
// `import type` only — erased at compile time, so this cannot form a runtime
// cycle with turnRunDispatch's own imports (conversation/exchange modules).
import type { TurnRunDispatchSink } from './turnRunDispatch.js';
import { budgetByChars } from './memoryBudget.js';
import { MEMORY_UNTRUSTED_TAG, isUntrustedMemoryRow } from './memoryTrust.js';
import { DurableCollection } from './hostExtPersistence.js';
import { createA2aSurface, type A2aSurface } from './a2aSurface.js';
import type { TraceContext } from './traceContext.js';
import { createKanbanSurface, type KanbanSurface } from './kanbanSurface.js';
import { createKnowledgeSurface, type KnowledgeSurface } from './knowledgeSurface.js';
import { buildFeatureSurfaces, type FeatureSurface } from './featureSurfaces.js';
import { createChatSurface, type ChatSurface } from './chatSurface.js';
import { createCanvasSurface, type CanvasSurface } from './canvasSurface.js';
import { createWebResearchSurface, type WebResearchSurface } from './webResearchSurface.js';
import { createLaunchStudioSurface, type LaunchStudioSurface } from './launchStudioSurface.js';
import { registerVectorTenantPurger, registerVectorNamespacePurger } from './vector/vectorTenantPurge.js';

const log = createLogger('host.inMemorySurfaces');

// ───────────────────────────────────────────────────────────────────
// Surface bundle. Each field matches the pack-side delegate target
// exactly:
//   core.openwop.storage  → ctx.storage.<surface>.<method>
//   core.openwop.db       → ctx.db.<surface>.<method>
//   core.openwop.files    → ctx.fs.<method>  (+ ctx.fs.<sub>.<method> for image/pdf — NOT wired)
//   core.openwop.messaging → ctx.queueBus.<method>
//   core.openwop.obs      → ctx.observability.<method>
// ───────────────────────────────────────────────────────────────────

export interface HostSurfaceBundle {
  storage: {
    kv: KvSurface;
    table: TableSurface;
    cache: CacheSurface;
    blob: BlobSurface;
    queue: QueueSurface;
  };
  db: {
    sql: SqlSurface;
    vector: VectorSurface;
    /** RFC 0018 §A.searchIndex — full-text / BM25 search surface.
     *  Distinct from `vector` (semantic) and `sql` (relational). */
    search: SearchSurface;
    /** RFC 0018 §A.nosql — document store. */
    nosql: NoSqlSurface;
  };
  fs: FsSurface;
  queueBus: QueueBusSurface;
  observability: ObservabilitySurface;
  /** RFC 0076 §A `host.a2a` — the A2A (Agent-to-Agent) client the
   *  `core.openwop.a2a` pack delegates to. See `host/a2aSurface.ts`. */
  a2a: A2aSurface;
  /** `host.kanban` — bridges the `vendor.myndhyve.kanban` pack to the demo's
   *  durable kanban store (`kanbanService.ts`). See `host/kanbanSurface.ts`. */
  kanban: KanbanSurface;
  /** `host.knowledge` — lexical RAG retrieval over a seeded demo corpus for the
   *  `vendor.myndhyve.knowledge-tools` pack. See `host/knowledgeSurface.ts`. */
  knowledge: KnowledgeSurface;
  /** `host.chat` — bridges the `vendor.myndhyve.chat` pack to the demo chat
   *  store (the same tables the UI reads). See `host/chatSurface.ts`. */
  chat: ChatSurface;
  /** `host.canvas` — durable versioned shared-canvas store for the
   *  `vendor.myndhyve.canvas` pack. See `host/canvasSurface.ts`. */
  canvas: CanvasSurface;
  /** `host.webResearch` — search/fetch/research for the
   *  `vendor.myndhyve.web-research` pack. See `host/webResearchSurface.ts`. */
  webResearch: WebResearchSurface;
  /** `host.launchStudio` — multi-canvas studio backbone for the
   *  `vendor.myndhyve.launch-studio` pack. See `host/launchStudioSurface.ts`. */
  launchStudio: LaunchStudioSurface;
  /** `host.sample.<feature>` — typed surfaces a BackendFeature contributes for
   *  workflow nodes (ADR 0014 Phase 1). Populated from the feature-surface
   *  registry; `ctx.features.<id>.<method>(args)`. Empty when no feature
   *  registered a surface. See `host/featureSurfaces.ts`. */
  features: Record<string, FeatureSurface>;
}

/** Inputs all surface methods receive. Pack delegates spread
 *  `{ ...ctx.config, ...ctx.inputs }` onto the call, so the host sees
 *  one flat record with both. The host must know its own field names
 *  (matches the schemas under packs/<name>/schemas/). */
export type SurfaceArgs = Record<string, unknown>;
/** All surface methods are async + return a free-form result that the
 *  pack delegate forwards as `outputs`. */
export type SurfaceFn = (args: SurfaceArgs) => Promise<Record<string, unknown>>;

export type KvSurface = {
  get: SurfaceFn;
  set: SurfaceFn;
  delete: SurfaceFn;
  list: SurfaceFn;
  atomicIncrement: SurfaceFn;
  cas: SurfaceFn;
};
export type TableSurface = {
  insert: SurfaceFn;
  update: SurfaceFn;
  upsert: SurfaceFn;
  delete: SurfaceFn;
  query: SurfaceFn;
  count: SurfaceFn;
};
export type CacheSurface = {
  get: SurfaceFn;
  put: SurfaceFn;
  evict: SurfaceFn;
};
export type BlobSurface = {
  put: SurfaceFn;
  get: SurfaceFn;
  presign: SurfaceFn;
};
export type QueueSurface = {
  enqueue: SurfaceFn;
  dequeue: SurfaceFn;
};
export type SqlSurface = {
  query: SurfaceFn;
  execute: SurfaceFn;
  transaction: SurfaceFn;
};
export type VectorSurface = {
  upsert: SurfaceFn;
  query: SurfaceFn;
  delete: SurfaceFn;
};
/** RFC 0018 §A.searchIndex — full-text search surface. The in-memory
 *  reference impl uses a naive bag-of-words relevance score (token
 *  frequency in the indexed fields); production hosts back this with
 *  Elasticsearch / OpenSearch / Meilisearch / Typesense per the
 *  advertised `backends[]` list. */
export type SearchSurface = {
  index: SurfaceFn;
  query: SurfaceFn;
  delete: SurfaceFn;
};
/** RFC 0018 §A.nosql — document-store surface. The `core.openwop.db` pack's
 *  nodes call `find` / `insert` / `update` / `delete`. (The spec prose under
 *  `host-capabilities.md §host.db.nosql` names `get`/`query` alongside; the
 *  shipped pack uses `find` and has no `get` node — a pre-existing spec↔pack
 *  divergence. This surface implements exactly what the nodes call.) The
 *  in-memory reference impl is a nested Map (tenant → datasource/collection →
 *  doc) with exact-match filters; production hosts back it with MongoDB /
 *  DynamoDB / Firestore / CosmosDB. */
export type NoSqlSurface = {
  find: SurfaceFn;
  insert: SurfaceFn;
  update: SurfaceFn;
  delete: SurfaceFn;
};
export type FsSurface = {
  read: SurfaceFn;
  write: SurfaceFn;
  delete: SurfaceFn;
  stat: SurfaceFn;
  list: SurfaceFn;
};
export type QueueBusSurface = {
  publish: SurfaceFn;
  /** RFC 0017 §B point 2 — consume one message from the named `subject`.
   *  Returns `{ found, deliveryToken, payload, subject, id }` on hit;
   *  `{ found: false }` on empty. Consumed messages move to an
   *  in-flight tracking map keyed by `deliveryToken`; `ack` removes
   *  the entry, `nack` re-queues, `deadLetter` routes to a `.dlq`
   *  subject. */
  consume: SurfaceFn;
  ack: SurfaceFn;
  nack: SurfaceFn;
  deadLetter: SurfaceFn;
  streamPublish: SurfaceFn;
  /** RFC 0017 §A `stream` sub-block — subscribe to the named stream.
   *  When `fromBeginning: true` returns a snapshot of all records
   *  currently on the stream; when `false` (or absent) returns an
   *  empty snapshot (in-memory impl has no buffered new-record
   *  delivery — real impls would back the surface with a true
   *  log-style storage like Kafka / NATS JetStream). */
  streamSubscribe: SurfaceFn;
};
export type ObservabilitySurface = {
  log: SurfaceFn;
  metric: SurfaceFn;
  startSpan: SurfaceFn;
  endSpan: SurfaceFn;
  alert: SurfaceFn;
};

// ───────────────────────────────────────────────────────────────────
// Tenant-scoping helpers
// ───────────────────────────────────────────────────────────────────

/** Every surface method receives args + an implicit tenantId context.
 *  Because the pack delegates spread inputs+config flat, the host
 *  resolver injects tenantId via a closure: the executor builds one
 *  surface bundle PER RUN, with its tenantId baked in. */
export interface BundleScope {
  tenantId: string;
  scopeId?: string;
  /** RFC 0207 §B — the W3C trace context the RUN was created under
   *  (`ctx.traceContext`, from the reserved `run.metadata.traceContext` key).
   *  `createA2aSurface` carries a CHILD of it on every outbound message, in
   *  `Message.metadata.openwop.traceparent` and in the HTTP header.
   *  Correlation only; never authority. Absent for surface-direct callers and
   *  for runs started with no inbound trace. */
  traceContext?: TraceContext;
  /** The current run's id. Surfaces that spawn child runs (host.canvas
   *  crossCanvasInvoke) use it as the child's `parentRunId` + to walk the
   *  ancestor chain for the recursion/depth guard. Absent for surface-direct
   *  (non-run) callers. */
  runId?: string;
  /** The run owner's DURABLE principal (ADR 0024 §4 — the same value as
   *  `ctx.actingUserId`, stamped on `run.metadata.actingUserId` at creation
   *  and re-stamped on `:fork`). Absent for system runs (schedule / inbound
   *  webhook — no human), which is the correct fail-closed signal. Surfaces
   *  use it to apply MEMBER-scoped narrowing filters (e.g. the CMS translator
   *  locale grants, ADR 0205) to workflow writes exactly as the HTTP editor
   *  path does. */
  actingUserId?: string;
  /** ADR 0627 D3 (review S2) — the run owner's OWN personal tenant
   *  (`anon:<sid>` / `user:<hash>`), the value the auth middleware set as
   *  `req.personalTenant` on the creating request and `routes/runs.ts` stamped
   *  on `run.metadata.personalTenant` (host-authoritative, a reserved key —
   *  never client-supplied). Threaded on the TOOL lane only — the chat tool
   *  loop reads it off the run row, the voice bridge off the mint-time session,
   *  redrive/debug runs stamp it from their request; the executor does NOT
   *  thread it into in-run node scopes (review N2). A req-less tenant
   *  gate (`assertTenantScope`) uses it for the implicit-owner short-circuit
   *  the HTTP lane gets from `isOwnPersonalWorkspace(req)`; an anon session's
   *  principal (`session:<sid>`) has no user row, so this is the ONLY way the
   *  tool lane can know the caller owns the `anon:` sandbox it is acting in.
   *  Absent for system runs, API-key bearers, and surface-direct callers. */
  personalTenant?: string;
  /** ADR 0617 D1a — the executing run's WORKFLOW id (`run.workflowId`), so a
   *  feature surface that emits a host event from inside a run can stamp
   *  `origin.workflowId` and the dispatcher can refuse to start a second run of
   *  the very workflow that is executing (the self-trigger guard). Absent for
   *  surface-direct (non-run) callers, like `runId`. */
  workflowId?: string;
  /** ADR 0617 D1a (review BLOCKER-1) — the chain the executing run's definition
   *  was expanded from (`definition.metadata.expandedFrom.chainId`), so a
   *  surface-emitted host event can carry `origin.chainId` and the dispatcher
   *  can refuse to start a SIBLING from-chain instance of the same chain (one
   *  instance is minted per parameter set — per departing employee for
   *  `people-hr.offboarding`). Absent for authored workflows and non-run callers. */
  chainId?: string;
  /** ADR 0277 P2 — the EXECUTING agent's profile id (the rosterId for standing
   *  agents), when a tool call runs on behalf of a specific agent. The
   *  knowledge tools use it to scope retrieval to the agent's bound
   *  collections (`agentProfile.knowledge.collectionIds` — the advisory-board
   *  "Shared knowledge" grant); absent ⇒ tenant-wide retrieval (agent-less
   *  workflow nodes, unchanged legacy behavior). */
  agentProfileId?: string;
  /** ADR 0309 — the chat conversation (sessionId) a tool call runs inside, when
   *  it runs inside one (threaded from `run.metadata.chatSessionId` by the
   *  conversation tool loop). The schedule-followup tool uses it as the ONLY
   *  delivery destination — unforgeable because it is never a tool input. */
  conversationId?: string;
  /** The turn-scoped sink a tool records an ignited workflow run on, so the
   *  EXCHANGE (the one turnIndex allocator + the owner of the response)
   *  materializes the `workflow_run` bubble instead of the tool racing it
   *  out-of-band. Present only on the conversation transport; absent ⇒ the
   *  tool falls back to a direct append. See `host/turnRunDispatch.ts`. */
  onRunDispatched?: TurnRunDispatchSink;
}

// ───────────────────────────────────────────────────────────────────
// kv / table / cache / blob / queue (all Map-backed)
// ───────────────────────────────────────────────────────────────────

/** Tenant-namespaced map. The outer Map keys are tenantIds; the inner
 *  Maps are per-key state. Re-allocated only when missing — no leaks
 *  for tenants that come and go. */
class TenantMap<V> {
  private readonly inner = new Map<string, Map<string, V>>();
  bucket(tenantId: string): Map<string, V> {
    let b = this.inner.get(tenantId);
    if (!b) { b = new Map(); this.inner.set(tenantId, b); }
    return b;
  }
  /** ADR 0395 — read-only iteration for the operator DLQ snapshot. */
  tenants(): IterableIterator<[string, Map<string, V>]> {
    return this.inner.entries();
  }
  /** KB-2 — drop a tenant's whole bucket (account teardown). Returns the number of
   *  entries removed so teardown can report what it actually reclaimed. */
  drop(tenantId: string): number {
    const b = this.inner.get(tenantId);
    if (!b) return 0;
    const n = b.size;
    this.inner.delete(tenantId);
    return n;
  }
}

interface KvEntry { value: unknown; expiresAtMs?: number; }

function createKv(state: TenantMap<KvEntry>, scope: BundleScope): KvSurface {
  const bucket = () => state.bucket(scope.tenantId);
  const now = () => Date.now();
  const fresh = (e: KvEntry | undefined) =>
    !e ? null : (e.expiresAtMs && e.expiresAtMs <= now() ? null : e);
  return {
    async get({ key }) {
      const entry = fresh(bucket().get(String(key)));
      const ttlRemainingMs = entry?.expiresAtMs ? Math.max(0, entry.expiresAtMs - now()) : null;
      return { value: entry?.value ?? null, found: !!entry, ttlRemainingMs };
    },
    async set({ key, value, ttlSeconds }) {
      const entry: KvEntry = { value };
      if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
        entry.expiresAtMs = now() + ttlSeconds * 1000;
      }
      bucket().set(String(key), entry);
      return { ok: true };
    },
    async delete({ key }) {
      const existed = bucket().delete(String(key));
      return { ok: true, existed };
    },
    async list({ prefix }) {
      const p = typeof prefix === 'string' ? prefix : '';
      const keys: string[] = [];
      for (const [k, e] of bucket().entries()) {
        if (!fresh(e)) continue;
        if (!p || k.startsWith(p)) keys.push(k);
      }
      return { keys };
    },
    async atomicIncrement({ key, delta }) {
      const b = bucket();
      const existing = fresh(b.get(String(key)));
      const prev = typeof existing?.value === 'number' ? existing.value : 0;
      const next = prev + (typeof delta === 'number' ? delta : 1);
      b.set(String(key), { value: next });
      return { value: next };
    },
    async cas(args) {
      // RFC 0015 §B point 5 canonical CAS shape: input `{key, expect,
      // set}`, output `{swapped: boolean, actual?: unknown}` (the live
      // value at the call). Accept legacy `{expected, value}` from older
      // sample call sites for backward compatibility; emit only the
      // canonical output shape.
      const a = args as { key?: unknown; expect?: unknown; expected?: unknown; set?: unknown; value?: unknown };
      const key = String(a.key);
      const expectVal = 'expect' in a ? a.expect : a.expected;
      const setVal = 'set' in a ? a.set : a.value;
      const b = bucket();
      const cur = fresh(b.get(key))?.value ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(expectVal ?? null)) {
        // Spec field name is `actual` (the live value at miss-time) per
        // `kv-cas.test.ts`. The legacy `currentValue` alias had no remaining
        // readers (src, packs, conformance) so it's dropped.
        return { swapped: false, actual: cur };
      }
      b.set(key, { value: setVal });
      return { swapped: true, actual: setVal };
    },
  };
}

interface TableRow { id: string; [field: string]: unknown; }
/** RFC 0016 §B point 2 — schema declared on first insert; subsequent
 *  rows MUST conform. Per-tenant + per-table column-type registry. */
type TableColType = 'string' | 'number' | 'boolean' | 'object';
const _tableSchemas = new Map<string /* tenantId::tableName */, Map<string, TableColType>>();
function inferColType(v: unknown): TableColType {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}
function createTable(state: TenantMap<TableRow>, scope: BundleScope): TableSurface {
  // Tenant-bucket is a Map<rowId, row>. `args.table` namespaces by
  // table name via a prefix on the row id (since we only have one Map).
  const key = (table: unknown, id: unknown) => `${String(table)}::${String(id)}`;
  const bucket = () => state.bucket(scope.tenantId);
  const schemaKey = (table: unknown) => `${scope.tenantId}::${String(table)}`;
  return {
    async insert({ table, row }) {
      const r = row as TableRow;
      const sKey = schemaKey(table);
      let schema = _tableSchemas.get(sKey);
      if (!schema) {
        // First insert — declare the schema from this row's columns.
        schema = new Map();
        for (const [col, val] of Object.entries(r)) {
          if (col === 'id') continue;
          schema.set(col, inferColType(val));
        }
        _tableSchemas.set(sKey, schema);
      } else {
        // Subsequent insert — every column MUST conform.
        for (const [col, val] of Object.entries(r)) {
          if (col === 'id') continue;
          const declared = schema.get(col);
          if (declared === undefined) continue; // new column — additive, allowed
          const got = inferColType(val);
          if (got !== declared) {
            throw Object.assign(new Error(`Column '${col}' declared as '${declared}', got '${got}'`), {
              code: 'table_schema_violation',
            });
          }
        }
      }
      bucket().set(key(table, r.id), { ...r });
      return { id: r.id };
    },
    async update({ table, id, patch }) {
      const b = bucket();
      const k = key(table, id);
      const cur = b.get(k);
      if (!cur) return { updated: 0 };
      b.set(k, { ...cur, ...(patch as Record<string, unknown>) });
      return { updated: 1 };
    },
    async upsert({ table, row }) {
      const r = row as TableRow;
      const b = bucket();
      const k = key(table, r.id);
      const existed = b.has(k);
      b.set(k, { ...b.get(k), ...r });
      return { upserted: 1, created: !existed };
    },
    async delete({ table, id }) {
      const b = bucket();
      const k = key(table, id);
      const existed = b.delete(k);
      return { deleted: existed ? 1 : 0 };
    },
    async query({ table, filter, limit, cursor }) {
      const t = String(table);
      // RFC 0016 §B point 3 — cursor pagination. The cursor is an
      // opaque token; the in-memory impl uses base64(after_id) so the
      // caller can resume after the last-returned row deterministically.
      const afterId = typeof cursor === 'string' && cursor.length > 0
        ? Buffer.from(cursor, 'base64').toString('utf8')
        : '';
      const lim = typeof limit === 'number' && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
      // Collect all matching rows in deterministic order (sorted by id),
      // skipping anything ≤ afterId, capped at `lim`.
      const allMatching: TableRow[] = [];
      for (const [k, row] of bucket().entries()) {
        if (!k.startsWith(`${t}::`)) continue;
        if (filter && typeof filter === 'object') {
          let ok = true;
          for (const [fk, fv] of Object.entries(filter as Record<string, unknown>)) {
            if (row[fk] !== fv) { ok = false; break; }
          }
          if (!ok) continue;
        }
        allMatching.push(row);
      }
      allMatching.sort((a, b) => a.id.localeCompare(b.id));
      const rows: TableRow[] = [];
      for (const row of allMatching) {
        if (afterId && row.id <= afterId) continue;
        rows.push(row);
        if (rows.length >= lim) break;
      }
      const last = rows[rows.length - 1];
      // `nextCursor` is null when we've reached the end of the result set;
      // otherwise it encodes the last-returned id for resumption.
      const consumedThroughId = last ? last.id : afterId;
      const hasMore = allMatching.some((r) => r.id > consumedThroughId);
      const nextCursor = hasMore && last ? Buffer.from(last.id, 'utf8').toString('base64') : null;
      return { rows, count: rows.length, nextCursor };
    },
    async count({ table }) {
      const t = String(table);
      let n = 0;
      for (const k of bucket().keys()) if (k.startsWith(`${t}::`)) n++;
      return { count: n };
    },
  };
}

function createCache(state: TenantMap<KvEntry>, scope: BundleScope): CacheSurface {
  // Cache shares the KV shape but is a separate namespace per tenant.
  const kv = createKv(state, scope);
  return {
    // Cache `get` wraps kv.get's `{value, found, ttlRemainingMs}`
    // shape into the canonical `{hit, value, ttlRemainingMs}` per
    // RFC 0019 §B point 2 — `hit` is the cache-semantic flag the
    // conformance suite gates on (a miss MUST surface `hit: false`,
    // not just an absent value).
    get: async (args) => {
      const out = await kv.get(args) as { value: unknown; found?: boolean; ttlRemainingMs?: number | null };
      return { hit: !!out.found, value: out.value, ttlRemainingMs: out.ttlRemainingMs ?? null, found: !!out.found };
    },
    put: async (args) => kv.set({ key: args.key, value: args.value, ttlSeconds: args.ttlSeconds ?? 60 }),
    evict: kv.delete,
  };
}

interface BlobEntry { contentBase64: string; contentType?: string; }
/** RFC 0019 §B point 1 — presigned URLs MUST expire at the advertised
 *  TTL. The token map below pairs each issued token with the resource
 *  + expiry; the HTTP route at `/v1/host/openwop-app/blob/presigned/:token`
 *  (registered by `registerTestSeamRoutes`) resolves it, returning 200
 *  inside the window and 403 after. */
interface PresignToken { tenantId: string; key: string; contentBase64: string; contentType?: string; expiresAtMs: number; }
const _blobPresignTokens = new Map<string, PresignToken>();
export function resolvePresignToken(token: string, now: number = Date.now()):
  | { ok: true; entry: PresignToken }
  | { ok: false; reason: 'not_found' | 'expired' } {
  const entry = _blobPresignTokens.get(token);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.expiresAtMs <= now) return { ok: false, reason: 'expired' };
  return { ok: true, entry };
}
/**
 * ADR 0563 — route blob WRITES through the ADR 0531 effect chokepoint.
 *
 * THE GAP THIS CLOSES. `core.storage.blob-put` (a shipped pack node, declared
 * `role: "side-effect"` in its own manifest) reaches `ctx.storage.blob.put` and,
 * on the `s3` backend, performs a real presigned `PUT`. Nothing stopped it on
 * replay: no `assertEffectAllowed` call anywhere in the blob path, and no entry
 * in `executor/sideEffects.ts`, so BOTH the ADR 0341 fast path and the ADR 0531
 * backstop were blind. A replay or fork re-executed a live external write in
 * silence. `examples/workflow-chain-packs/starters` ships a chain that sits on
 * this node, so it was reachable, not theoretical.
 *
 * WRAPPED AT THE SEAM, NOT IN EACH ADAPTER, deliberately. The guard belongs
 * where the surface is RESOLVED so a future adapter (GCS, R2) inherits it by
 * construction instead of having to remember. Guarding `s3Blob.put` alone would
 * make effect coverage depend on which backend an operator selected — exactly
 * the conditional coverage ADR 0531 exists to eliminate.
 *
 * THE MEMORY BACKEND IS GUARDED TOO, and that is a real trade rather than an
 * oversight. Its writes are process-local, so counting them slightly inflates
 * the ADR 0533 effect tally. The alternative — guard only "real" egress — makes
 * the invariant backend-conditional and re-opens the same hole for the next
 * adapter. A uniform guard is the property worth having; a marginally
 * over-counted tally is the price.
 *
 * READS ARE NOT GUARDED. `get`/`presign` do not mutate external state and are
 * safe to re-run on replay. (`presign` hands out a URL that may already have
 * been used, which is a compensation concern for ADR 0554 — it is not a write.)
 */
function guardBlobWrites(surface: BlobSurface): BlobSurface {
  return {
    ...surface,
    async put(args) {
      // First statement, before any I/O — the shape `smtpEgress`/`webhookEgressGuard`
      // use. Outside a run this is a no-op, so the retention sweeper and the
      // test-seam route are unaffected.
      assertEffectAllowed('blob-write', 'storage.blob.put');
      return surface.put(args);
    },
  };
}

function createBlob(state: TenantMap<BlobEntry>, scope: BundleScope): BlobSurface {
  const bucket = () => state.bucket(scope.tenantId);
  return {
    async put({ key, contentBase64, contentType }) {
      bucket().set(String(key), { contentBase64: String(contentBase64), contentType: contentType as string | undefined });
      return { ok: true, key };
    },
    async get({ key }) {
      const e = bucket().get(String(key));
      if (!e) return { found: false };
      return { found: true, contentBase64: e.contentBase64, contentType: e.contentType };
    },
    async presign({ key, expiresInSeconds }) {
      const e = bucket().get(String(key));
      if (!e) return { found: false };
      const ttlSec = Number(expiresInSeconds) > 0 ? Number(expiresInSeconds) : 300;
      const expiresAtMs = Date.now() + ttlSec * 1000;
      const token = `pre-${scope.tenantId}-${String(key)}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      _blobPresignTokens.set(token, {
        tenantId: scope.tenantId,
        key: String(key),
        contentBase64: e.contentBase64,
        contentType: e.contentType,
        expiresAtMs,
      });
      const url = `/v1/host/openwop-app/blob/presigned/${encodeURIComponent(token)}`;
      return { url, expiresAtMs, token, expiresInSeconds: ttlSec };
    },
  };
}

interface QueueEntry { id: string; payload: unknown; enqueuedAtMs: number; }
function createQueue(state: TenantMap<QueueEntry[]>, scope: BundleScope): QueueSurface {
  const bucket = (queueName: string) => {
    const t = state.bucket(scope.tenantId);
    let arr = t.get(queueName);
    if (!arr) { arr = []; t.set(queueName, arr); }
    return arr;
  };
  let seq = 0;
  return {
    async enqueue({ queue, payload }) {
      const id = `q-${++seq}`;
      bucket(String(queue)).push({ id, payload, enqueuedAtMs: Date.now() });
      return { id, enqueued: true };
    },
    async dequeue({ queue }) {
      const arr = bucket(String(queue));
      const e = arr.shift();
      if (!e) return { found: false };
      return { found: true, id: e.id, payload: e.payload };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// SQL — better-sqlite3, one in-memory DB per tenant.
// ───────────────────────────────────────────────────────────────────

// Sample-grade injection heuristic. Flags template-literal interpolation
// (`${`) and the classic `OR '1'='1'` shape. A real parser belongs in the
// pack delegate when this is wired to a production SQL impl.
const PARAM_REJECT_RE = /\$\{|\b(?:OR|AND)\b\s+(?:'[^']*'|"[^"]*")\s*=\s*(?:'[^']*'|"[^"]*")/i;

function createSql(dbPool: Map<string, Database.Database>, scope: BundleScope): SqlSurface {
  const dbFor = () => {
    let db = dbPool.get(scope.tenantId);
    if (!db) {
      db = new Database(':memory:');
      dbPool.set(scope.tenantId, db);
    }
    return db;
  };
  /** RFC 0018 §"SQL injection invariant": only parametric queries.
   *  Heuristic: if the input contains template literals (`${`) or
   *  obvious string-concat shapes, refuse. Real hosts wire a real
   *  parser; this is best-effort defense in depth. */
  const requireParametric = (sql: string) => {
    if (PARAM_REJECT_RE.test(sql)) {
      throw Object.assign(
        new Error('Non-parametric SQL rejected by host (RFC 0018).'),
        { code: 'SQL_NON_PARAMETRIC' },
      );
    }
  };
  return {
    async query(args: Record<string, unknown>) {
      const sqlStr = String(args.sql);
      requireParametric(sqlStr);
      const stmt = dbFor().prepare(sqlStr);
      const params = args.params;
      const rows = Array.isArray(params) ? stmt.all(...(params as unknown[])) : stmt.all();
      return { rows: rows as unknown[], count: (rows as unknown[]).length };
    },
    async execute(args: Record<string, unknown>) {
      const sqlStr = String(args.sql);
      requireParametric(sqlStr);
      const stmt = dbFor().prepare(sqlStr);
      const params = args.params;
      const info = Array.isArray(params) ? stmt.run(...(params as unknown[])) : stmt.run();
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async transaction({ statements }) {
      const db = dbFor();
      const txn = db.transaction((stmts: Array<{ sql: string; params?: unknown[] }>) => {
        for (const s of stmts) {
          requireParametric(s.sql);
          db.prepare(s.sql).run(...(s.params ?? []));
        }
      });
      txn((statements as Array<{ sql: string; params?: unknown[] }>) ?? []);
      return { ok: true };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Vector — brute-force cosine over an in-memory Map.
// ───────────────────────────────────────────────────────────────────

interface VectorEntry { id: string; vector: number[]; metadata?: Record<string, unknown>; }
function createVector(state: TenantMap<Map<string, VectorEntry>>, scope: BundleScope): VectorSurface {
  const ns = (namespace: unknown) => {
    const t = state.bucket(scope.tenantId);
    const k = String(namespace ?? 'default');
    let m = t.get(k);
    if (!m) { m = new Map(); t.set(k, m); }
    return m;
  };
  return {
    async upsert({ namespace, items }) {
      const m = ns(namespace);
      const arr = items as VectorEntry[];
      for (const it of arr) m.set(it.id, it);
      return { upserted: arr.length };
    },
    async query({ namespace, vector, topK }) {
      const m = ns(namespace);
      const q = vector as number[];
      const results: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];
      for (const e of m.values()) {
        const s = cosine(q, e.vector);
        results.push({ id: e.id, score: s, metadata: e.metadata });
      }
      results.sort((a, b) => b.score - a.score);
      const k = typeof topK === 'number' && topK > 0 ? topK : 10;
      return { matches: results.slice(0, k) };
    },
    async delete({ namespace, ids }) {
      const m = ns(namespace);
      let n = 0;
      for (const id of ids as string[]) {
        if (m.delete(id)) n++;
      }
      return { deleted: n };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Search — naive token-frequency bag-of-words score.
// ───────────────────────────────────────────────────────────────────

interface SearchDoc { id: string; fields: Record<string, string | number | boolean>; }
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,.!?;:\-_/\\()[\]{}<>"']+/)
    .filter((t) => t.length > 0);
}
function createSearch(state: TenantMap<Map<string, SearchDoc>>, scope: BundleScope): SearchSurface {
  const idx = (indexName: unknown) => {
    const t = state.bucket(scope.tenantId);
    const k = String(indexName ?? 'default');
    let m = t.get(k);
    if (!m) { m = new Map(); t.set(k, m); }
    return m;
  };
  return {
    async index({ index, docs }) {
      const m = idx(index);
      const arr = docs as SearchDoc[];
      for (const d of arr) m.set(d.id, d);
      return { indexed: arr.length };
    },
    async query({ index, q, k }) {
      const m = idx(index);
      const queryTokens = tokenize(String(q ?? ''));
      if (queryTokens.length === 0) return { hits: [] };
      const hits: Array<{ id: string; score: number; fields: Record<string, unknown> }> = [];
      for (const d of m.values()) {
        // Concatenate all field values into one bag-of-tokens.
        const haystack = Object.values(d.fields)
          .map((v) => String(v))
          .join(' ');
        const docTokens = tokenize(haystack);
        if (docTokens.length === 0) continue;
        let score = 0;
        for (const qt of queryTokens) {
          // Naive TF: count occurrences in the doc.
          const tf = docTokens.filter((t) => t === qt).length;
          if (tf > 0) score += 1 + Math.log(1 + tf); // weight + diminishing returns
        }
        if (score > 0) hits.push({ id: d.id, score, fields: d.fields });
      }
      hits.sort((a, b) => b.score - a.score);
      const limit = typeof k === 'number' && k > 0 ? k : 10;
      return { hits: hits.slice(0, limit) };
    },
    async delete({ index, ids }) {
      const m = idx(index);
      let n = 0;
      for (const id of ids as string[]) if (m.delete(id)) n++;
      return { deleted: n };
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ───────────────────────────────────────────────────────────────────
// NoSQL — document store (tenant → datasource/collection → doc)
// ───────────────────────────────────────────────────────────────────
//
// Demo-grade: exact-match filters only (field === value, deep-equal for
// nested values). Per `host-capabilities.md §host.db.nosql` the host MUST
// reject injection-style filter operators — any `$`-prefixed filter key is
// refused (a real MongoDB host blocks `$where` JS eval; here the whole
// operator family is unsupported, so refusing them is both safe and honest).
// Updates accept Mongo-style `$set` / `$unset`, or a plain field-merge object.

type NoSqlDoc = Record<string, unknown>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as NoSqlDoc)[k], (b as NoSqlDoc)[k]));
}

/** Reject `$`-prefixed keys ANYWHERE in a filter (injection guard,
 *  §host.db.nosql). The Mongo operator form is nested (`{field:{$gt:1}}`), so
 *  the guard recurses — a top-level-only check would let `$where`/`$gt` slip
 *  through a field value. */
function assertSafeFilter(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(assertSafeFilter); return; }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$')) {
      throw Object.assign(new Error(`nosql filter operator '${k}' is not supported (exact-match filters only)`), { code: 'nosql_filter_unsupported' });
    }
    assertSafeFilter(v);
  }
}

function matchesFilter(doc: NoSqlDoc, filter: NoSqlDoc): boolean {
  return Object.keys(filter).every((k) => deepEqual(doc[k], filter[k]));
}

/** Apply a `{field:1|0}` projection. Any included (truthy) field → inclusion
 *  mode (only those + always `_id`); otherwise exclusion mode. */
function project(doc: NoSqlDoc, projection: NoSqlDoc | undefined): NoSqlDoc {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const includes = Object.entries(projection).filter(([, v]) => v).map(([k]) => k);
  if (includes.length > 0) {
    const out: NoSqlDoc = {};
    if ('_id' in doc) out._id = doc._id;
    for (const k of includes) if (k in doc) out[k] = doc[k];
    return out;
  }
  const out: NoSqlDoc = { ...doc };
  for (const k of Object.keys(projection)) delete out[k];
  return out;
}

function applySort(docs: NoSqlDoc[], sort: NoSqlDoc | undefined): NoSqlDoc[] {
  if (!sort || Object.keys(sort).length === 0) return docs;
  const keys = Object.entries(sort).map(([k, v]) => ({ k, dir: Number(v) < 0 ? -1 : 1 }));
  return [...docs].sort((a, b) => {
    for (const { k, dir } of keys) {
      const av = a[k], bv = b[k];
      if (av === bv) continue;
      if (av === undefined || av === null) return -dir;
      if (bv === undefined || bv === null) return dir;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
}

function createNosql(state: TenantMap<Map<string, NoSqlDoc>>, scope: BundleScope): NoSqlSurface {
  const coll = (datasource: unknown, collection: unknown): Map<string, NoSqlDoc> => {
    const t = state.bucket(scope.tenantId);
    const key = `${String(datasource ?? 'default')}::${String(collection ?? 'default')}`;
    let m = t.get(key);
    if (!m) { m = new Map(); t.set(key, m); }
    return m;
  };
  return {
    async insert({ datasource, collection, docs }) {
      const m = coll(datasource, collection);
      const ids: string[] = [];
      const arr = Array.isArray(docs) ? (docs as NoSqlDoc[]) : [docs as NoSqlDoc];
      for (const raw of arr) {
        const id = typeof raw._id === 'string' ? raw._id : `doc_${randomUUID()}`;
        const stored: NoSqlDoc = { ...raw, _id: id };
        m.set(id, stored);
        ids.push(id);
      }
      return { inserted: ids.length, ids };
    },
    async find({ datasource, collection, filter, projection, sort, limit }) {
      const f = (filter as NoSqlDoc) ?? {};
      assertSafeFilter(f);
      const m = coll(datasource, collection);
      let hits = [...m.values()].filter((d) => matchesFilter(d, f));
      hits = applySort(hits, sort as NoSqlDoc | undefined);
      if (typeof limit === 'number' && limit >= 0) hits = hits.slice(0, limit);
      return { docs: hits.map((d) => project(d, projection as NoSqlDoc | undefined)) };
    },
    async update({ datasource, collection, filter, update, upsert }) {
      const f = (filter as NoSqlDoc) ?? {};
      assertSafeFilter(f);
      const u = (update as NoSqlDoc) ?? {};
      const set = (u.$set as NoSqlDoc | undefined) ?? (Object.keys(u).some((k) => k.startsWith('$')) ? {} : u);
      const unset = u.$unset as NoSqlDoc | undefined;
      const m = coll(datasource, collection);
      const matches = [...m.values()].filter((d) => matchesFilter(d, f));
      for (const d of matches) {
        Object.assign(d, set);
        if (unset) for (const k of Object.keys(unset)) delete d[k];
      }
      if (matches.length === 0 && upsert === true) {
        const id = `doc_${randomUUID()}`;
        m.set(id, { ...f, ...set, _id: id });
        return { matched: 0, modified: 0, upsertedId: id };
      }
      return { matched: matches.length, modified: matches.length };
    },
    async delete({ datasource, collection, filter }) {
      const f = (filter as NoSqlDoc) ?? {};
      assertSafeFilter(f);
      const m = coll(datasource, collection);
      let deleted = 0;
      for (const [id, d] of [...m.entries()]) if (matchesFilter(d, f)) { m.delete(id); deleted++; }
      return { deleted };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// FS — sandboxed under <dataDir>/host-fs/<tenant>/
// ───────────────────────────────────────────────────────────────────

function createFs(rootDir: string, scope: BundleScope): FsSurface {
  const tenantRoot = join(rootDir, sanitizeSegment(scope.tenantId));
  mkdirSync(tenantRoot, { recursive: true });
  /** Resolve a user-supplied relative path INSIDE the tenant root.
   *  Reject anything that escapes the sandbox after normalization. */
  const safePath = (relRaw: unknown): string => {
    const rel = String(relRaw ?? '');
    // Absolute paths (POSIX `/foo` or Windows `C:\foo`) MUST be
    // rejected up-front per `SECURITY/invariants.yaml fs-path-
    // traversal` + RFC 0014 §C. Stripping the leading slash and
    // re-resolving against tenantRoot would silently REINTERPRET
    // an absolute path as relative, which loses the security
    // violation (a request for `/etc/passwd` would land at
    // `<tenantRoot>/etc/passwd` and ENOENT — that's a bug, not a
    // reject). Catch both POSIX absolute (`/`) and Windows drive
    // letters (`C:`) here.
    if (/^[/\\]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
      throw Object.assign(new Error('Absolute paths escape the tenant sandbox.'), { code: 'path_outside_sandbox' });
    }
    const normalized = normalize(rel).replace(/^[/\\]+/, '');
    const abs = resolve(tenantRoot, normalized);
    if (!abs.startsWith(tenantRoot + sep) && abs !== tenantRoot) {
      // Canonical per RFC 0014 §B + SECURITY/invariants.yaml fs-path-traversal.
      throw Object.assign(new Error('Path escapes tenant sandbox.'), { code: 'path_outside_sandbox' });
    }
    return abs;
  };
  return {
    async read({ path }) {
      const abs = safePath(path);
      const buf = readFileSync(abs);
      return { contentBase64: buf.toString('base64'), size: buf.byteLength };
    },
    async write({ path, contentBase64, createOnly }) {
      const abs = safePath(path);
      if (createOnly && existsSync(abs)) {
        return { ok: false, reason: 'already_exists' };
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from(String(contentBase64 ?? ''), 'base64'));
      return { ok: true, path: String(path) };
    },
    async delete({ path }) {
      const abs = safePath(path);
      if (!existsSync(abs)) return { deleted: false };
      rmSync(abs, { recursive: true, force: true });
      return { deleted: true };
    },
    async stat({ path }) {
      const abs = safePath(path);
      if (!existsSync(abs)) return { found: false };
      const s = statSync(abs);
      return { found: true, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs };
    },
    async list({ path }) {
      const abs = safePath(path ?? '.');
      if (!existsSync(abs)) return { entries: [] };
      const entries = readdirSync(abs, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
      return { entries };
    },
  };
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

// ───────────────────────────────────────────────────────────────────
// queueBus + observability
// ───────────────────────────────────────────────────────────────────

interface BusMessage { id: string; payload: unknown; subject: string; deliveryCount: number; }
/** RFC 0017 ack/nack/dlq state machine: messages move from the per-
 *  subject queue → in-flight map on `consume`. `ack` drops the entry;
 *  `nack(requeue=true)` puts it back at the head of the subject queue;
 *  `deadLetter` appends it to a per-tenant `<subject>.dlq` subject. */
const _busInFlight = new Map<string /* tenantId */, Map<string /* deliveryToken */, BusMessage>>();
function createQueueBus(state: TenantMap<BusMessage[]>, scope: BundleScope): QueueBusSurface {
  const subj = (subject: unknown) => {
    const t = state.bucket(scope.tenantId);
    const k = String(subject ?? 'default');
    let arr = t.get(k);
    if (!arr) { arr = []; t.set(k, arr); }
    return arr;
  };
  const inflightForTenant = () => {
    let m = _busInFlight.get(scope.tenantId);
    if (!m) { m = new Map(); _busInFlight.set(scope.tenantId, m); }
    return m;
  };
  let seq = 0;
  return {
    async publish({ subject, payload }) {
      const id = `m-${++seq}`;
      subj(subject).push({ id, payload, subject: String(subject), deliveryCount: 1 });
      return { id, published: true };
    },
    async consume({ subject }) {
      const arr = subj(subject);
      const msg = arr.shift();
      if (!msg) return { found: false };
      const deliveryToken = `dt-${++seq}`;
      inflightForTenant().set(deliveryToken, msg);
      return {
        found: true,
        deliveryToken,
        id: msg.id,
        subject: msg.subject,
        payload: msg.payload,
        deliveryCount: msg.deliveryCount,
      };
    },
    async ack({ deliveryToken }) {
      const m = inflightForTenant();
      const existed = m.delete(String(deliveryToken));
      return { acked: existed, deliveryToken };
    },
    async nack({ deliveryToken, requeue }) {
      const m = inflightForTenant();
      const key = String(deliveryToken);
      const msg = m.get(key);
      if (!msg) return { nacked: false, reason: 'unknown_delivery_token' };
      m.delete(key);
      if (requeue === false) {
        return { nacked: true, requeued: false };
      }
      const arr = subj(msg.subject);
      arr.unshift({ ...msg, deliveryCount: msg.deliveryCount + 1 });
      return { nacked: true, requeued: true };
    },
    async deadLetter({ deliveryToken, reason }) {
      const m = inflightForTenant();
      const key = String(deliveryToken);
      const msg = m.get(key);
      if (!msg) return { deadLettered: false, reason: 'unknown_delivery_token' };
      m.delete(key);
      const dlqSubject = `${msg.subject}.dlq`;
      subj(dlqSubject).push({ ...msg, payload: { original: msg.payload, deadLetterReason: String(reason ?? 'unspecified') } });
      return { deadLettered: true, dlqSubject };
    },
    async streamPublish({ stream, record }) {
      const id = `r-${++seq}`;
      subj(stream).push({ id, payload: record, subject: String(stream), deliveryCount: 1 });
      return { id, published: true };
    },
    async streamSubscribe({ stream, fromBeginning }) {
      if (fromBeginning !== true) {
        return { records: [], fromBeginningSnapshot: false };
      }
      // Return the full snapshot of records currently on the stream.
      const records = subj(stream).map((m) => ({ id: m.id, payload: m.payload }));
      return { records, fromBeginningSnapshot: true, count: records.length };
    },
  };
}

function createObservability(scope: BundleScope): ObservabilitySurface {
  return {
    async log({ level, message, attributes }) {
      const lvl = String(level || 'info');
      const msg = String(message ?? '');
      const attrs = (attributes as Record<string, unknown>) ?? {};
      const payload = { tenantId: scope.tenantId, ...attrs };
      if (lvl === 'error') log.error(msg, payload);
      else if (lvl === 'warn') log.warn(msg, payload);
      else if (lvl === 'debug') log.debug(msg, payload);
      else log.info(msg, payload);
      return { logged: true };
    },
    async metric({ kind, name, value, attributes, unit }) {
      // In-memory demo: just log. Real impl wires OTel meters.
      log.debug('metric', { kind, name, value, unit, attributes, tenantId: scope.tenantId });
      return { recorded: true };
    },
    async startSpan({ name, attributes }) {
      const handle = `span-${Math.random().toString(36).slice(2, 10)}`;
      log.debug('span.start', { name, handle, attributes });
      return { spanHandle: handle };
    },
    async endSpan({ spanHandle, status, attributes }) {
      log.debug('span.end', { spanHandle, status, attributes });
      return { ok: true };
    },
    async alert(event) {
      log.warn('alert.fired', { ...event, tenantId: scope.tenantId });
      return { fired: true };
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Singleton state — created once per process, scope-bound per call.
// ───────────────────────────────────────────────────────────────────

const _kvState = new TenantMap<KvEntry>();
const _tableState = new TenantMap<TableRow>();
const _cacheState = new TenantMap<KvEntry>();
const _blobState = new TenantMap<BlobEntry>();
const _queueState = new TenantMap<QueueEntry[]>();
const _busState = new TenantMap<BusMessage[]>();
const _vectorState = new TenantMap<Map<string, VectorEntry>>();

/**
 * KB-2 — the in-memory/durable-default vector backend's tenant purger.
 *
 * Registered unconditionally at module load, exactly like the state it clears. On a
 * host running the ephemeral backend the residue dies with the process anyway, so
 * this is mostly about the invariant being TESTABLE with both backends rather than
 * pgvector-only (which would be a coverage claim resting on an environment CI does
 * not have). Counts the namespaces dropped, not the individual vectors — the bucket
 * is one Map per namespace.
 */
// ADR 0664 D1 — the namespace-scoped sibling of the tenant purge below. Counts the
// individual vectors dropped (not namespaces), because the caller reports "what was
// reclaimed for this agent" and a namespace count would always be 1 or 0.
registerVectorNamespacePurger('memory', async (tenantId, namespace) => {
  const ns = _vectorState.bucket(tenantId).get(namespace);
  if (!ns) return 0;
  const rows = ns.size;
  _vectorState.bucket(tenantId).delete(namespace);
  return rows;
});

registerVectorTenantPurger('memory', async (tenantId) => {
  let rows = 0;
  const bucket = _vectorState.tenants();
  for (const [t, namespaces] of bucket) {
    if (t !== tenantId) continue;
    for (const ns of namespaces.values()) rows += ns.size;
  }
  _vectorState.drop(tenantId);
  return rows;
});

// ── ADR 0395 Phase B — operator DLQ snapshot + gated replay ─────────────────
// Reads/writes THIS instance's RFC 0017 bus state (the surface is in-memory —
// per-instance, point-in-time; the panel renders that honestly, OQ-3). The
// snapshot projects depth + reason + ids ONLY — never message payloads (they
// may carry tenant PII). Replay re-publishes the ORIGINAL payload back onto
// the base subject through the same array the surface `publish` uses.

export interface DlqSubjectSnapshot {
  tenantId: string;
  /** The dead-letter subject (`<base>.dlq`). */
  subject: string;
  depth: number;
  /** Distinct dead-letter reasons present (bounded). */
  reasons: string[];
  /** Message ids only (bounded) — payloads never leave the surface. */
  messageIds: string[];
}

const DLQ_SNAPSHOT_LIMIT = 50;

export function snapshotDlqSubjects(tenantId?: string): DlqSubjectSnapshot[] {
  const out: DlqSubjectSnapshot[] = [];
  for (const [t, bucket] of _busState.tenants()) {
    if (tenantId !== undefined && t !== tenantId) continue;
    for (const [subject, messages] of bucket) {
      if (!subject.endsWith('.dlq') || messages.length === 0) continue;
      const reasons = new Set<string>();
      for (const m of messages) {
        const p = m.payload as { deadLetterReason?: unknown } | null;
        if (p && typeof p === 'object' && typeof p.deadLetterReason === 'string') reasons.add(p.deadLetterReason);
        if (reasons.size >= 10) break;
      }
      out.push({
        tenantId: t,
        subject,
        depth: messages.length,
        reasons: [...reasons],
        messageIds: messages.slice(0, DLQ_SNAPSHOT_LIMIT).map((m) => m.id),
      });
    }
  }
  return out.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.subject.localeCompare(b.subject));
}

/** Re-publish one dead-lettered message onto its base subject (the D4 gated
 *  replay). Idempotent per call — the message leaves the DLQ; a second call
 *  with the same id is `not_found`. */
export function replayDlqMessage(tenantId: string, dlqSubject: string, messageId: string): { replayed: boolean; reason?: 'not_found' | 'bad_subject' } {
  if (!dlqSubject.endsWith('.dlq')) return { replayed: false, reason: 'bad_subject' };
  const bucket = _busState.bucket(tenantId);
  const messages = bucket.get(dlqSubject);
  const idx = messages?.findIndex((m) => m.id === messageId) ?? -1;
  if (!messages || idx < 0) return { replayed: false, reason: 'not_found' };
  const [msg] = messages.splice(idx, 1);
  const base = dlqSubject.slice(0, -'.dlq'.length);
  const payload = msg!.payload as { original?: unknown } | null;
  const original = payload && typeof payload === 'object' && 'original' in payload ? payload.original : msg!.payload;
  let arr = bucket.get(base);
  if (!arr) { arr = []; bucket.set(base, arr); }
  arr.push({ id: msg!.id, payload: original, subject: base, deliveryCount: msg!.deliveryCount + 1 });
  return { replayed: true };
}
const _searchState = new TenantMap<Map<string, SearchDoc>>();
const _nosqlState = new TenantMap<Map<string, NoSqlDoc>>();
const _sqlPool = new Map<string, Database.Database>();
// RFC 0004 memory: tenant → memoryRef → entries. Host-internal write side
// (run-summary on completion); read side exposed via GET /v1/host/openwop-app/memory.
const _memoryState = new TenantMap<MemoryRow[]>();

let _fsRoot: string | null = null;
let _initialized = false;

/** RFC 0014 §A — exposed for /.well-known/openwop discovery so the
 *  spec-canonical `capabilities.fs.sandboxRoot` matches the in-memory
 *  surface's actual root. Returns null before initInMemorySurfaces() runs. */
export function getFsSandboxRoot(): string | null {
  return _fsRoot;
}

/** Initialize the surfaces module + advertise each surface. Idempotent. */
export function initInMemorySurfaces(deps: { dataDir: string }): void {
  if (_initialized) return;
  _fsRoot = join(deps.dataDir, 'host-fs');
  mkdirSync(_fsRoot, { recursive: true });

  // Flip each surface to supported=true in the advertisement. The portable
  // surfaces advertise their *effective* backend (the demo tag below when the
  // default 'memory' backend is selected, else the chosen real backend id) so
  // /.well-known/openwop stays honest and the UI non-durable badge self-clears
  // once a real backend is wired. See host/surfaceBackends.ts.
  const inmem = 'in-memory';
  const impl = (key: SurfaceKey, demoTag: string): string => effectiveImplementation(key, demoTag);
  registerHostSurface({ name: 'host.kvStorage', supported: true, implementation: impl('kv', inmem), note: 'Demo only. Restarts wipe state.' });
  registerHostSurface({ name: 'host.tableStorage', supported: true, implementation: impl('table', inmem), note: 'Demo only. No indexes; query is O(n).' });
  registerHostSurface({ name: 'host.cache', supported: true, implementation: impl('cache', inmem) });
  registerHostSurface({ name: 'host.blobStorage', supported: true, implementation: impl('blob', inmem), note: 'In-memory tier: presign() returns a synthetic data: URL (select OPENWOP_SURFACE_BLOB=s3 for real SigV4 presigns; the enterprise/auth posture boot guard requires a real backend).' });
  registerHostSurface({ name: 'host.queue', supported: true, implementation: impl('queue', inmem) });
  registerHostSurface({ name: 'host.fs', supported: true, implementation: impl('fs', 'sandboxed-local-fs'), note: `Sandboxed under ${_fsRoot}.` });
  registerHostSurface({ name: 'host.db.sql', supported: true, implementation: impl('sql', 'sqlite-in-memory'), note: 'better-sqlite3, one in-memory DB per tenant.' });
  registerHostSurface({ name: 'host.db.vector', supported: true, implementation: impl('vector', 'brute-force-cosine'), note: 'O(n) cosine over an in-memory Map.' });
  registerHostSurface({ name: 'host.db.search', supported: true, implementation: impl('search', 'naive-bag-of-words'), note: 'Token-frequency relevance score. Real impls use Elasticsearch / OpenSearch / Meilisearch / Typesense.' });
  registerHostSurface({ name: 'host.db.nosql', supported: true, implementation: impl('nosql', 'nested-map-document-store'), note: 'tenant → datasource/collection → doc. Exact-match filters only ($-operators refused); $set/$unset updates. Real impls use MongoDB / DynamoDB / Firestore / CosmosDB.' });
  registerHostSurface({ name: 'host.messaging', supported: true, implementation: impl('queueBus', inmem) });
  registerHostSurface({ name: 'host.observability', supported: true, implementation: impl('observability', 'structured-logger'), note: 'Routes through the workflow-engine logger.' });
  registerHostSurface({
    name: 'host.memory', supported: true, implementation: impl('memory', inmem),
    note: effectiveImplementation('memory', inmem) === inmem
      ? 'RFC 0004 read-side (list/get); host writes a run-summary on completion. In-memory tier: restarts wipe state (select OPENWOP_SURFACE_MEMORY=durable to persist).'
      : 'RFC 0004 read-side (list/get); host writes a run-summary on completion. Durable: survives restarts (DUR-2, ADR 0195).',
  });

  // Fail fast if a deployment selected a real backend (OPENWOP_SURFACE_*) that
  // has no registered adapter — never silently serve the ephemeral demo store
  // when production durability was requested.
  const DURABILITY_REQUIRED_SURFACES: readonly SurfaceKey[] = [
    'kv', 'table', 'cache', 'blob', 'queue',
    'sql', 'vector', 'search', 'nosql',
    'fs', 'queueBus', 'observability', 'memory',
  ];
  assertSelectedBackendsAvailable(DURABILITY_REQUIRED_SURFACES);
  // LEAK-2 / ADR 0195 + ADR 0636: in the enterprise (auth) posture, refuse to boot on the
  // ephemeral in-memory tier — tenant data would silently reset on restart. Only
  // surfaces that HAVE a registered durable adapter are asserted; the acknowledgement
  // (OPENWOP_ALLOW_INMEMORY_SURFACES) names surfaces, or `true` for all.
  assertDurableSurfacesInEnterprise(DURABILITY_REQUIRED_SURFACES);

  _initialized = true;
}

// ───────────────────────────────────────────────────────────────────
// RFC 0004 memory (host-internal write side + read side)
//
// The wire contract (agent-memory.md) is read-only: `list(memoryRef,
// options)` + `get(memoryRef, memoryId)`. Writes are host-internal — for
// the demo the host writes a run-summary entry on completion (the
// "session-end write" the spec sanctions). Tenant-scoped per CTI-1;
// content is plain (no BYOK secrets flow through summaries, so SR-1 holds
// trivially here).
// ───────────────────────────────────────────────────────────────────

/** One stored memory entry (matches schemas/memory-entry.schema.json). */
export interface MemoryRow {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  /** RFC 0004 TTL — entries past this MUST NOT surface in list/get. */
  expiresAt?: string;
}

export interface MemoryListOpts {
  limit?: number;
  tag?: string;
  /** RFC 0113 — bound the cumulative SIZE of the returned set. An entry whose
   *  inclusion would exceed the budget is OMITTED whole (never truncated);
   *  ≥1 entry is always kept. The unit is content chars (advertised as
   *  `memory.injectionBudget.tokenCounter: "chars"`) — the SAME `budgetByChars`
   *  primitive ADR 0148 A4 uses, so there is one budget model, not two. */
  tokenBudget?: number;
  /** RFC 0113 — ranking before the budget cut. Only `'recency'` is honored:
   *  this host does not advertise `memory.search` `modes:["semantic"]`, so per
   *  RFC 0113 it offers recency-only and does NOT expose `'relevance'`. An
   *  unknown value falls back to recency (graceful, never errors). */
  rank?: 'recency';
}

/** The demo's single per-tenant memoryRef. Real hosts derive memoryRefs
 *  from agent manifests (RFC 0004 §C); the sample uses one shared ref so
 *  the ledger shows a tenant's accumulating run history. */
export const MEMORY_DEMO_REF = 'tenant-memory';

const MEMORY_HARD_MAX = 500;
/** Heap backstop: max entries retained per memory scope before oldest are evicted
 *  (bounds unbounded turn-summary growth). Above MEMORY_HARD_MAX so reads are
 *  unaffected; curated notes are separately count-capped at the feature layer. */
const MEMORY_SCOPE_HARD_CAP = 2000;

/** Upper bound on a `memoryRef` string. Generous enough for every ref this host
 *  mints (the longest is `agent:<uuid>:no-actor`) while refusing a payload-sized
 *  ref, which per CTI-1(1) is one of the named malformed shapes. */
const MEMORY_REF_MAX_LENGTH = 512;

/**
 * CTI-1(1) — `memoryRef` SHAPE validation at resolution time (normative).
 *
 * > *"Hosts validate `memoryRef` path shape at resolution time. Malformed refs
 * > (path traversal, embedded null, oversize) MUST return `[]` / `null` rather
 * > than fall through to a permissive lookup."*
 * > — `spec/v1/agent-memory.md` §CTI-1
 *
 * The `memoryRef` is an OPAQUE host-defined string (§"`memoryRef` resolution"),
 * so this validator is deliberately a SHAPE check and not a grammar: it refuses
 * the three malformed classes the spec names and accepts everything else. It
 * MUST stay permissive enough for every ref this host actually mints —
 * `MEMORY_DEMO_REF` (`tenant-memory`), `subjectScope` (`agent:<id>` /
 * `user:<id>`), the fail-closed `agent:<id>:no-actor` sentinel
 * (`agentMemoryAdapter.ts`), and the corpus fixtures' slash-bearing refs
 * (`conformance/agent-memory-roundtrip`). So colons and slashes are both legal;
 * only traversal SEGMENTS are refused, never a bare `..` inside a name.
 *
 * Pinned by `test/memory-ref-validation.test.ts`, which derives the accept-set
 * by exercising the real minters rather than restating a list of literals.
 */
export function isWellFormedMemoryRef(memoryRef: string): boolean {
  if (typeof memoryRef !== 'string') return false;
  if (memoryRef.length === 0 || memoryRef.length > MEMORY_REF_MAX_LENGTH) return false;
  // Embedded null + any other C0/C1 control character. A NUL in particular
  // truncates in several storage backends, which is how a "valid" ref reaches a
  // different key than the one that was authorized.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(memoryRef)) return false;
  // Path traversal. Split on BOTH separators — a backslash form must not slip
  // past a forward-slash-only check on a host whose store is path-backed.
  if (memoryRef.split(/[/\\]/).some((segment) => segment === '..')) return false;
  return true;
}

function memoryBucket(tenantId: string): Map<string, MemoryRow[]> {
  return _memoryState.bucket(tenantId);
}

function notExpired(row: MemoryRow, nowMs: number): boolean {
  if (!row.expiresAt) return true;
  const t = Date.parse(row.expiresAt);
  return !Number.isFinite(t) || t > nowMs;
}

/**
 * DUR-2 (ADR 0195) — the dumb-rows storage seam behind the memory API. ALL
 * policy (TTL filter, ranking, RFC 0113 budget, cap eviction, compaction
 * redaction) stays in THIS module — the store only reads/replaces the ordered
 * row array for one (tenant, memoryRef) scope. Two impls: the in-memory
 * default below, and `host/durable/durableMemory.ts` over the shared Storage
 * (selected via OPENWOP_SURFACE_MEMORY / OPENWOP_SURFACE_BACKEND — the same
 * seam as every other surface, so the boot guard + honest advertisement apply).
 */
export interface MemoryScopeStore {
  getRows(memoryRef: string): Promise<MemoryRow[]>;
  /** Atomic read-modify-write of a scope's rows. The mutator MUST be pure —
   *  the durable impl re-invokes it on CAS retry. Returns the new rows. */
  mutateRows(memoryRef: string, mutator: (rows: MemoryRow[]) => MemoryRow[]): Promise<MemoryRow[]>;
  /** Drop the whole scope; returns the number of rows removed. */
  clearScope(memoryRef: string): Promise<number>;
}

function createInMemoryMemoryStore(scope: BundleScope): MemoryScopeStore {
  const bucket = () => memoryBucket(scope.tenantId);
  return {
    async getRows(memoryRef) {
      return bucket().get(memoryRef) ?? [];
    },
    async mutateRows(memoryRef, mutator) {
      const next = mutator(bucket().get(memoryRef) ?? []);
      bucket().set(memoryRef, next);
      return next;
    },
    async clearScope(memoryRef) {
      const n = bucket().get(memoryRef)?.length ?? 0;
      bucket().delete(memoryRef);
      return n;
    },
  };
}

/** Per-call store resolution (cheap closure build; same pattern as the bundle
 *  surfaces, just invoked from the module-level API instead of a run bundle). */
function memoryStore(tenantId: string): MemoryScopeStore {
  return resolveSurface('memory', createInMemoryMemoryStore, { tenantId });
}

/** The write-side input shape. `expiresAt` (RFC 3339 UTC) is the ABSOLUTE form
 *  of `ttlSeconds`; supply at most one. Absolute is required to write an entry
 *  that is ALREADY expired — which no relative `ttlSeconds` can express, and
 *  which is exactly what a TTL read-side witness has to construct. When both are
 *  present the absolute value wins (it is the more specific instruction). */
export interface MemoryWriteInput {
  content: string;
  tags?: string[];
  ttlSeconds?: number;
  expiresAt?: string;
  id?: string;
  createdAt?: string;
}

function resolveExpiresAt(input: MemoryWriteInput, nowMs: number): { expiresAt: string } | Record<string, never> {
  if (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))) {
    return { expiresAt: input.expiresAt };
  }
  if (typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0) {
    return { expiresAt: new Date(nowMs + input.ttlSeconds * 1000).toISOString() };
  }
  return {};
}

/** Host-internal write. Appends a tenant-scoped entry under `memoryRef`.
 *  IDEMPOTENT on an explicit `id`: a row with the same id is REPLACED, not
 *  duplicated — so a crash-retry / re-dispatch (e.g. the executor's
 *  `runsummary:<runId>` completion write) never accretes duplicates in the
 *  durable store.
 *
 *  SR-1: a write made DURING A RUN must go through `writeMemoryEntryRedacted`
 *  instead — see that function. This bare form stays for writes with no run in
 *  scope (curated notes, seeds), where there is no per-run keyring to redact
 *  against. Enforced by the call-site ratchet in
 *  `test/memory-sr1-chokepoint.test.ts`. */
export async function writeMemoryEntry(
  tenantId: string,
  memoryRef: string,
  input: MemoryWriteInput,
): Promise<MemoryRow> {
  if (!_initialized) throw new Error('initInMemorySurfaces() must be called first');
  const now = Date.now();
  const row: MemoryRow = {
    // An explicit `id`/`createdAt` lets a durable-backed caller (subject-memory
    // notes, ADR 0041) keep the recall row aligned with its durable
    // source-of-truth row, so a later delete hits the same id across both stores.
    id: input.id ?? `mem_${randomUUID().slice(0, 12)}`,
    content: input.content,
    tags: input.tags ?? [],
    createdAt: input.createdAt ?? new Date(now).toISOString(),
    ...resolveExpiresAt(input, now),
  };
  await memoryStore(tenantId).mutateRows(memoryRef, (rows) => {
    // Upsert on explicit id (idempotency); append otherwise.
    const next = input.id ? rows.filter((r) => r.id !== row.id) : [...rows];
    next.push(row);
    // Bound unbounded per-scope growth (turn summaries accrue every run): retain the
    // most-recent MEMORY_SCOPE_HARD_CAP, evicting oldest (a heap backstop above the
    // read cap; user-curated notes are additionally count-capped at the feature layer).
    return next.length > MEMORY_SCOPE_HARD_CAP ? next.slice(next.length - MEMORY_SCOPE_HARD_CAP) : next;
  });
  return row;
}

/**
 * SR-1 CHOKEPOINT (`agent-memory.md` §SR-1, normative) — the form EVERY memory
 * write made during a run must use.
 *
 * > *"When a memory write would persist content containing a value the run's
 * > BYOK vault resolved during the run, the persisted entry MUST carry
 * > `[REDACTED:<secretId>]` in place of the plaintext."*
 *
 * This is the spec's `writeAgentMemoryRedacted` reference pattern, wired to the
 * registry this host already had: `byok/ephemeralRunSecrets.ts` IS the spec's
 * `MemorySecretRegistry` (*"in-process map keyed by `runId`"*), so no second
 * registry was introduced. The substitution rules (substring not regex,
 * descending value length, 8-char floor) live in `byok/textRedaction.ts` with
 * the spec citation.
 *
 * Redaction happens at WRITE time, before persistence — which is what makes the
 * read side safe by construction rather than by a second check: a budgeted or
 * ranked read (RFC 0113 clause 4) ranks over already-redacted content and
 * therefore cannot leak plaintext, and `MemoryAdapter.get`/`list` surface the
 * redacted form because it is the only form that was ever stored.
 *
 * An unknown/absent `runId` yields an empty keyring, so this degrades to
 * `writeMemoryEntry` rather than failing the write — SR-1 constrains what may be
 * PERSISTED, and a run with no resolved secrets has nothing to redact.
 */
export async function writeMemoryEntryRedacted(
  tenantId: string,
  memoryRef: string,
  input: MemoryWriteInput,
  runId: string,
): Promise<MemoryRow> {
  const secrets = getRunSecrets(runId);
  const content = redactRunSecretsForMemory(input.content, secrets);
  return writeMemoryEntry(tenantId, memoryRef, { ...input, content });
}

/** Host-internal: drop an ENTIRE memory scope (all entries under `memoryRef`).
 *  Tenant-scoped (CTI-1). Used by cascade delete (a roster agent's `agent:<id>`
 *  namespace when the agent is removed) so memory does not orphan. Returns the
 *  number of entries removed. */
export async function clearMemoryScope(tenantId: string, memoryRef: string): Promise<number> {
  return memoryStore(tenantId).clearScope(memoryRef);
}

/** RFC 0004 read side. Tenant-scoped; TTL-filtered; newest first. */
export async function listMemoryEntries(
  tenantId: string,
  memoryRef: string,
  opts: MemoryListOpts = {},
): Promise<MemoryRow[]> {
  // CTI-1(1) — refuse a malformed ref here, at RESOLUTION time, rather than
  // letting it fall through to a permissive store lookup. Fail CLOSED: `[]`,
  // never an error carrying the ref back to the caller (CTI-1(3): errors must
  // not leak). Placed before the store call so no backend ever sees the ref.
  if (!isWellFormedMemoryRef(memoryRef)) return [];
  const now = Date.now();
  const all = (await memoryStore(tenantId).getRows(memoryRef)).filter((r) => notExpired(r, now));
  const tagged = opts.tag ? all.filter((r) => r.tags.includes(opts.tag!)) : all;
  // Recency rank (newest first). `rank` only honors 'recency' (see MemoryListOpts).
  const sorted = [...tagged].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = Math.min(opts.limit ?? MEMORY_HARD_MAX, MEMORY_HARD_MAX);
  const limited = sorted.slice(0, limit);
  // RFC 0113 — apply the injection budget AFTER ranking+limit, reusing the SAME
  // primitive as ADR 0148 A4 (one budget model). Drops over-budget entries whole;
  // keeps ≥1. SR-1 redaction + CTI-1 tenant-scoping already hold on these rows
  // (write-time redaction + tenant bucket), and budgeting only NARROWS the set,
  // so neither invariant is widened.
  if (typeof opts.tokenBudget === 'number' && opts.tokenBudget > 0) {
    // `keepAtLeastOne: false` is REQUIRED here, not a preference. RFC 0113
    // clause 1: "A single entry exceeding the budget on its own MUST be omitted
    // (not truncated mid-entry)." The primitive's DEFAULT is the ADR 0148 A4
    // soft budget (never starve a turn of context), which is the right policy
    // for knowledge retrieval and the wrong one for a capability this host
    // advertises as `memory.injectionBudget.supported: true`. See H49's
    // correction note on `budgetByChars`.
    return budgetByChars(limited, opts.tokenBudget, (r) => r.content.length, { keepAtLeastOne: false });
  }
  return limited;
}

/** RFC 0004 read side. Single tenant-scoped entry, or null when absent/expired. */
export async function getMemoryEntry(tenantId: string, memoryRef: string, memoryId: string): Promise<MemoryRow | null> {
  // CTI-1(1) — same fail-closed shape check as the list side, returning `null`
  // (this surface's empty) rather than falling through to the store.
  if (!isWellFormedMemoryRef(memoryRef)) return null;
  const now = Date.now();
  const row = (await memoryStore(tenantId).getRows(memoryRef)).find((r) => r.id === memoryId);
  return row && notExpired(row, now) ? row : null;
}

/**
 * Host-internal delete. Removes a tenant-scoped entry under `memoryRef`.
 * Returns true when an entry was removed, false when none matched.
 *
 * Tenant-scoped exactly like the read side — the caller passes the
 * principal-derived `tenantId`, never a query value, so a delete can never
 * cross a tenant boundary (CTI-1). Demo-only convenience for the CLI/inspector;
 * the agent-memory wire contract keeps writes/deletes host-internal.
 */
export async function removeMemoryEntry(tenantId: string, memoryRef: string, memoryId: string): Promise<boolean> {
  let removed = false;
  await memoryStore(tenantId).mutateRows(memoryRef, (rows) => {
    const next = rows.filter((r) => r.id !== memoryId);
    removed = next.length !== rows.length;
    return next;
  });
  return removed;
}

// ───────────────────────────────────────────────────────────────────
// RFC 0012 memory compaction (host-managed + client-requested)
//
// Compaction collapses many short-lived `longTerm` entries into one
// distilled entry. Derived content is routed through the BYOK redaction
// harness (`redactForCompaction`) so SR-1 carry-forward holds — a distilled
// archive MUST NOT re-expose a source-side leak (RFC 0012 §D). The distilled
// entry carries a `compacted-from:<id>` provenance tag (§C). These helpers
// back the `/v1/test/memory/{seed,compact}` conformance seam.
//
// AGMEM-3 (ADR 0587 §6) — TRUST carry-forward, the other half of SR-1
// carry-forward. This block used to name only the SR-1 half, which is exactly why
// the missing half read as covered: the archive was built with
// `tags: ['compacted-from:<id>', 'compacted']`, DISCARDING every source's
// `derived-from-untrusted` marker. N entries of which any were untrusted-derived
// collapsed into ONE entry that `trustOf` reads as TRUSTED — re-opening at the
// compaction layer the exact second-order launder the ADR 0038 §C review fix
// closed in `agentDispatch`. Trust is MONOTONE under compaction: if ANY source is
// untrusted, the archive is untrusted, because the archive's content is derived
// from all of them and nothing can un-derive it.
//
// Reachability, stated honestly: `compactMemory` has exactly one non-test caller,
// the env-gated conformance seam (`routes/memoryCompactionSeam.ts`, default off),
// so this was LATENT rather than live. Fixed at the primitive anyway — the next
// caller inherits whatever this does.
// ───────────────────────────────────────────────────────────────────

/** Host-internal write with a caller-supplied id (compaction seed seam). */
export async function seedMemoryEntry(
  tenantId: string,
  memoryRef: string,
  input: { id: string; content: string; tags?: string[] },
): Promise<MemoryRow> {
  if (!_initialized) throw new Error('initInMemorySurfaces() must be called first');
  const row: MemoryRow = {
    id: input.id,
    content: input.content,
    tags: input.tags ?? [],
    createdAt: new Date().toISOString(),
  };
  await memoryStore(tenantId).mutateRows(memoryRef, (rows) => [...rows, row]);
  return row;
}

export interface CompactionResult {
  /** Id of the distilled entry. */
  outputId: string;
  /** Number of source entries collapsed. */
  sourceCount: number;
  /** Exhaustive source ids (RFC 0012 §B: omit upstream when > 100). */
  sourceIds: string[];
  /** UTF-8 byte size of the distilled content. */
  byteSize: number;
  /** The persisted distilled content, SR-1-redacted (non-wire; for the
   *  seam's §D verification — the wire `memory.compacted` event omits it). */
  outputContent: string;
}

/**
 * Collapse every live entry under `(tenantId, memoryRef)` into a single
 * SR-1-redacted distilled entry, replacing the sources. Returns null when
 * there is nothing to compact.
 */
export async function compactMemory(tenantId: string, memoryRef: string): Promise<CompactionResult | null> {
  if (!_initialized) throw new Error('initInMemorySurfaces() must be called first');
  const now = Date.now();
  const compactionId = `cmp_${randomUUID().slice(0, 12)}`;
  const outputId = `mem_${randomUUID().slice(0, 12)}`;
  // Result captured from inside the mutator — on a CAS retry the mutator
  // recomputes against the fresh rows (redaction is a pure transform), so the
  // captured value always reflects the attempt that actually committed.
  let result: CompactionResult | null = null;
  await memoryStore(tenantId).mutateRows(memoryRef, (rows) => {
    const sources = rows.filter((r) => notExpired(r, now));
    if (sources.length === 0) {
      result = null;
      return rows; // nothing to compact — leave the scope untouched
    }
    const sourceIds = sources.map((r) => r.id);
    // §D: redact derived content through the BYOK harness — never echo a
    // source-side leak, never silently strip it.
    const outputContent = redactForCompaction(sources.map((r) => r.content).join('\n'));
    // AGMEM-3 — trust is MONOTONE under compaction: any untrusted source makes the
    // derived archive untrusted. Carried as the same tag the recall fences read, so
    // no consumer needs to learn a new shape.
    //
    // BOTH halves of untrustedness, via the shared `isUntrustedMemoryRow` (review
    // finding F2). Reading the tag alone was not merely incomplete here, it was
    // DESTRUCTIVE: a pre-0587 legacy row is fenced ONLY by the `[auto-extracted] `
    // content prefix, and this function joins source contents — so unless the
    // legacy row happened to sort first, the archive no longer STARTS with the
    // prefix and was written with no tag either. The one signal such a row will
    // ever have was destroyed by the same operation that dropped its fence, and a
    // permanently-trusted row is not recoverable. Compaction is the only path in
    // the codebase that can do this, which is exactly why it must ask the whole
    // question.
    const anyUntrusted = sources.some((r) => isUntrustedMemoryRow(r.tags, r.content));
    const archive: MemoryRow = {
      id: outputId,
      content: outputContent,
      // §C provenance tag — lets consumers detect compacted entries without
      // the event stream. Shape: `compacted-from:<id>` (no whitespace).
      tags: anyUntrusted
        ? [`compacted-from:${compactionId}`, 'compacted', MEMORY_UNTRUSTED_TAG]
        : [`compacted-from:${compactionId}`, 'compacted'],
      createdAt: new Date(now).toISOString(),
    };
    result = {
      outputId,
      sourceCount: sourceIds.length,
      sourceIds,
      byteSize: Buffer.byteLength(outputContent, 'utf8'),
      outputContent,
    };
    return [archive];
  });
  return result;
}

// ───────────────────────────────────────────────────────────────────
// RFC 0055 §C media assets — tenant-scoped, non-guessable asset URLs
//
// An emitted `media.{image,audio,file}` envelope references its asset by a
// host-served URL (above the inline cap). We mint a capability token the
// interrupt way (32 random bytes, base64url — opaque, not guessable) and
// key the store by token; the entry carries its own tenantId so a token
// minted for tenant A never resolves to tenant B's bytes (the
// `media-asset-url-tenant-scoped` SECURITY invariant).
//
// Durable + read-through (the same hardening PR #395 applied to the other
// host-extension stores, now extended here): each asset is one row in the
// generic `host_ext_kv` table keyed `hostext:media:asset:<token>`, so a URL
// minted on one Cloud Run instance resolves on every instance, survives a
// restart, and — critically — survives a `POST /v1/runs/{runId}:fork` replay
// of a chat turn that referenced the asset by URL (see replay.md). Inline
// `dataBase64` attachments are replay-safe by construction (they live in
// `run.inputs`, copied verbatim on fork); URL-referenced attachments are
// replay-safe only because this store is now durable with a retention window
// (≥ run lifetime) that outlives the run.
// ───────────────────────────────────────────────────────────────────

interface MediaAssetEntry {
  /** ADR 0579 — when the bytes landed (absent on pre-0579 rows). */
  storedAtMs?: number;
  /** The capability token — also the durable row id (`idOf`). */
  token: string;
  tenantId: string;
  contentBase64: string;
  contentType: string;
  /** Decoded asset size in bytes. */
  bytes: number;
  expiresAtMs: number;
}

/** token → entry, one durable row per asset (read-through, multi-instance
 *  correct). Tokens are globally unique + carry their own tenantId.
 *
 *  Collection name `media:bytes` (ADR 0083 review #2): the byte-store previously
 *  shared the `media:asset` name with `mediaService.assets` (the assetId-keyed library
 *  metadata), overlapping one KV prefix. The byte-store now owns `media:bytes`; existing
 *  rows under the legacy `media:asset` prefix are read-fallback'd + migrated-on-read by
 *  `resolveMediaAsset` (zero-downtime, self-healing — no big-bang migration that could
 *  orphan a served URL). */
const _mediaAssets = new DurableCollection<MediaAssetEntry>('media:bytes', (e) => e.token);
/** LEGACY byte-store location (pre-#2) — read-fallback + drain only. A `.get(token)` here
 *  matches only a byte-store row (token-keyed); the assetId-keyed metadata rows that also
 *  live under `media:asset` never collide with a capability token, so this is safe. */
const _legacyMediaBytes = new DurableCollection<MediaAssetEntry>('media:asset', (e) => e.token);
/** LLM-emitted media (RFC 0055) is ephemeral — a short TTL keeps the store
 *  small. User-uploaded chat attachments override this with a longer TTL
 *  (see UPLOADED_ASSET_TTL_MS in routes/mediaAssets.ts) so a fork/replay of
 *  the turn within a reasonable window can still re-resolve the URL. */
const MEDIA_ASSET_DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

// Unlike the old in-memory Map (which every restart cleared), the durable
// store keeps expired rows until something touches them — `resolveMediaAsset`
// only deletes lazily on access, so an asset never re-fetched after its TTL
// would linger forever in the shared host_ext_kv table. Reclaim them with a
// throttled background sweep kicked off on store (idempotent across instances;
// each prunes independently). Demo-grade — a production host would expire at
// the storage layer (TTL column / object-store lifecycle rule).
const MEDIA_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // at most once / 10 min / process
let _lastMediaSweepMs = 0;

async function sweepExpiredMediaAssets(): Promise<void> {
  const now = Date.now();
  const all = await _mediaAssets.list();
  for (const e of all) {
    if (e.expiresAtMs <= now) await _mediaAssets.delete(e.token);
  }
}

function maybeSweepExpiredMediaAssets(): void {
  const now = Date.now();
  if (now - _lastMediaSweepMs < MEDIA_SWEEP_INTERVAL_MS) return;
  _lastMediaSweepMs = now;
  // Fire-and-forget: never let GC bookkeeping delay or fail a store.
  void sweepExpiredMediaAssets().catch((err) => {
    log.warn('media-asset sweep failed', { error: err instanceof Error ? err.message : String(err) });
  });
}

/** Store an asset for `tenantId` and mint a tenant-scoped capability URL.
 *  Returns the relative serve URL + decoded byte size + expiry. */
/** ADR 0579 — tenant-scoped byte enumeration for the media orphan sweep.
 *  Returns token + size + the STORED-AT the sweep's grace window needs
 *  (derived from expiresAtMs − ttl is unreliable across ttls, so entries now
 *  carry storedAtMs; legacy rows without it report null and the sweep treats
 *  them as OLD — a pre-0579 orphan has waited long enough). */
export async function listMediaAssetTokens(tenantId: string): Promise<Array<{ token: string; bytes: number; storedAtMs: number | null }>> {
  return (await _mediaAssets.list())
    .filter((e) => e.tenantId === tenantId)
    .map((e) => ({ token: e.token, bytes: e.bytes, storedAtMs: e.storedAtMs ?? null }));
}

export async function storeMediaAsset(
  tenantId: string,
  input: { contentBase64: string; contentType: string; ttlSeconds?: number },
): Promise<{ token: string; url: string; bytes: number; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const bytes = Buffer.byteLength(input.contentBase64, 'base64');
  const ttlMs =
    typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0
      ? input.ttlSeconds * 1000
      : MEDIA_ASSET_DEFAULT_TTL_MS;
  const expiresAtMs = Date.now() + ttlMs;
  await _mediaAssets.put({ token, tenantId, contentBase64: input.contentBase64, contentType: input.contentType, bytes, expiresAtMs, storedAtMs: Date.now() });
  maybeSweepExpiredMediaAssets();
  return { token, url: `/v1/host/openwop-app/assets/${token}`, bytes, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Resolve a media-asset token. Returns null when unknown or expired (the
 *  token IS the capability — a caller without it cannot reach the bytes).
 *  The returned entry carries its own `tenantId`; callers that resolve on
 *  behalf of a request MUST check it against `req.tenantId` to uphold the
 *  `media-asset-url-tenant-scoped` invariant (the token is unguessable, so a
 *  cross-tenant read requires already holding tenant A's token). */
export async function resolveMediaAsset(token: string): Promise<MediaAssetEntry | null> {
  let e = await _mediaAssets.get(token);
  if (!e) {
    // #2 — fall back to the legacy `media:asset` byte-store + MIGRATE on read: an asset
    // minted before the rename keeps serving, and is moved into `media:bytes` so the legacy
    // prefix drains over time. Migration failure is non-fatal (we still serve the legacy row).
    const legacy = await _legacyMediaBytes.get(token);
    if (!legacy) return null;
    e = legacy;
    if (e.expiresAtMs > Date.now()) {
      try { await _mediaAssets.put(e); await _legacyMediaBytes.delete(token); } catch { /* serve anyway */ }
    }
  }
  if (e.expiresAtMs <= Date.now()) {
    await _mediaAssets.delete(token).catch(() => undefined);
    await _legacyMediaBytes.delete(token).catch(() => undefined);
    return null;
  }
  return e;
}

/** PROF-1 — extend a stored asset's expiry IN PLACE (tenant-checked, monotonic:
 *  never shortens). Keeping the SAME token is what makes promotion idempotent —
 *  a re-minted token would break token-keyed idempotent adds and remove-by-token
 *  routes (the caller still holds the original token). Returns false when the
 *  token is unknown, expired, or foreign-tenant (fail-closed). */
export async function extendMediaAssetExpiry(tenantId: string, token: string, expiresAtMs: number): Promise<boolean> {
  const e = await resolveMediaAsset(token); // also migrates a legacy-prefix row
  if (!e || e.tenantId !== tenantId) return false;
  if (e.expiresAtMs >= expiresAtMs) return true; // already at/past the target — monotonic no-op
  await _mediaAssets.put({ ...e, expiresAtMs });
  return true;
}

/** PROF-1 review F1 — the DOCUMENTED demote exception to the monotonic rule
 *  above: CAP a stored asset's expiry (never lengthen). The byte-reclaim lane
 *  for promoted refs the last referent let go of — capping back to a scratch
 *  window (instead of hard-deleting) means bytes die naturally unless someone
 *  re-references them in the window, and a referent this host failed to
 *  enumerate gets a grace window instead of an instantly broken image.
 *  Tenant-guarded; returns false for an unknown/expired/foreign token. */
export async function capMediaAssetExpiry(tenantId: string, token: string, expiresAtMs: number): Promise<boolean> {
  const e = await resolveMediaAsset(token);
  if (!e || e.tenantId !== tenantId) return false;
  if (e.expiresAtMs <= expiresAtMs) return true; // already at/under the cap
  await _mediaAssets.put({ ...e, expiresAtMs });
  return true;
}

/** Explicitly free a stored asset's bytes (the media library deletes durable
 *  assets on demand rather than waiting for TTL expiry). Tenant-checked: a token
 *  is only removable by its owning tenant. No-op for an unknown/foreign token. */
export async function deleteMediaAsset(tenantId: string, token: string): Promise<boolean> {
  const e = (await _mediaAssets.get(token)) ?? (await _legacyMediaBytes.get(token)); // #2 — both locations
  if (!e || e.tenantId !== tenantId) return false;
  await _mediaAssets.delete(token).catch(() => undefined);
  await _legacyMediaBytes.delete(token).catch(() => undefined);
  return true;
}

/** Build a per-run scoped surface bundle. Inject into NodeContext at
 *  run kickoff. Each call gives the run a tenant-scoped view of the
 *  shared process-local state. */
export function buildHostSurfaceBundle(scope: BundleScope): HostSurfaceBundle {
  if (!_initialized) {
    throw new Error('initInMemorySurfaces() must be called before buildHostSurfaceBundle()');
  }
  const fsRoot = _fsRoot!;
  // Portable surfaces resolve through the backend seam: 'memory' (default)
  // uses the in-memory factory below; a selected real backend uses its
  // registered adapter, or throws (already caught at boot). The wire shape is
  // identical either way — see host/surfaceBackends.ts.
  return {
    storage: {
      kv: resolveSurface('kv', (s) => createKv(_kvState, s), scope),
      table: resolveSurface('table', (s) => createTable(_tableState, s), scope),
      cache: resolveSurface('cache', (s) => createCache(_cacheState, s), scope),
      blob: guardBlobWrites(resolveSurface('blob', (s) => createBlob(_blobState, s), scope)),
      queue: resolveSurface('queue', (s) => createQueue(_queueState, s), scope),
    },
    db: {
      sql: resolveSurface('sql', (s) => createSql(_sqlPool, s), scope),
      vector: resolveSurface('vector', (s) => createVector(_vectorState, s), scope),
      search: resolveSurface('search', (s) => createSearch(_searchState, s), scope),
      nosql: resolveSurface('nosql', (s) => createNosql(_nosqlState, s), scope),
    },
    fs: resolveSurface('fs', (s) => createFs(fsRoot, s), scope),
    queueBus: resolveSurface('queueBus', (s) => createQueueBus(_busState, s), scope),
    observability: resolveSurface('observability', (s) => createObservability(s), scope),
    a2a: createA2aSurface(scope),
    kanban: createKanbanSurface(scope),
    knowledge: createKnowledgeSurface(scope),
    chat: createChatSurface(scope),
    canvas: createCanvasSurface(scope),
    webResearch: createWebResearchSurface(scope),
    launchStudio: createLaunchStudioSurface(scope),
    features: buildFeatureSurfaces(scope),
  };
}
