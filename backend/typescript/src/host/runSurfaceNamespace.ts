/**
 * ADR 0998 — runs and host features never share a name on the named data surfaces.
 *
 * `host.db.vector`, `host.db.search`, `host.db.nosql` and `host.blobStorage` are
 * scoped per TENANT only. Host features write member- and org-private data into
 * them under names they choose (subject memory under `user:<id>`, KB chunks under
 * `<orgId>/<collectionId>`, chat search under `chat-search`), and each feature
 * applies its own member or org predicate on its own reads. A run receives the
 * same tenant's surfaces, and the `core.openwop.db` / `core.openwop.storage`
 * nodes pass a caller-chosen name straight through, so any member's workflow
 * could name a host feature's index and read, overwrite or delete it.
 *
 * The fix is closed-world rather than a blocklist of host names:
 *  - the RUN lane (`runNamespacedBundle`, applied once at the executor's bundle)
 *    prefixes every name it is handed with `RUN_SURFACE_PREFIX`, on every verb,
 *    and strips the prefix from keys it hands back — a run sees its own names.
 *    The return path FAILS CLOSED: a name outside the run keyspace is dropped
 *    (rows) or refused (a single value), never passed through;
 *  - the HOST lane (`hostLaneSurfaces`, applied inside `buildHostSurfaceBundle`)
 *    refuses any name that starts with the prefix, so a host feature can never
 *    land in (or read) the run keyspace either.
 * The two keyspaces are therefore disjoint by construction, whatever name either
 * side picks. Every function on each surface is wrapped, so a verb added later is
 * covered without touching this file.
 */
import type { BlobSurface, HostSurfaceBundle, NoSqlSurface, SearchSurface, SurfaceArgs, SurfaceFn, VectorSurface } from './inMemorySurfaces.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runSurfaceNamespace');

/** The run keyspace. Every run-supplied name on the four named surfaces lives under it. */
export const RUN_SURFACE_PREFIX = 'wf:';

interface NamedSurfaces {
  vector: VectorSurface;
  search: SearchSurface;
  nosql: NoSqlSurface;
  blob: BlobSurface;
}

/** The argument that names the store on each name-keyed surface. The fallback
 *  mirrors each backend's own `?? 'default'`, so an omitted name lands in the
 *  run's `default`, never the host's. */
const NAME_ARG = { vector: 'namespace', search: 'index', nosql: 'datasource' } as const;

/** The result arrays whose ROWS are store records that may carry the name back.
 *  nosql has none on purpose: `find` returns the caller's own documents, whose
 *  top-level fields are user data, so a document with its own `datasource` field
 *  must reach the run untouched. */
const ROW_ARRAYS = { vector: ['matches'], search: ['hits'], nosql: [], blob: ['entries'] } as const;

/** The unprefixed surfaces behind each host-lane bundle — the run lane reads them here. */
const RAW = new WeakMap<object, NamedSurfaces>();

function mapVerbs<S extends Record<string, SurfaceFn>>(surface: S, wrap: (verb: string, fn: SurfaceFn) => SurfaceFn): S {
  const out: Record<string, unknown> = {};
  for (const [verb, fn] of Object.entries(surface)) {
    out[verb] = typeof fn === 'function' ? wrap(verb, (fn as SurfaceFn).bind(surface)) : fn;
  }
  return out as S;
}

function reserved(surface: string, verb: string, field: string): Error {
  return Object.assign(
    new Error(`host.${surface}.${verb}: ${field} names starting '${RUN_SURFACE_PREFIX}' are reserved for workflow runs (ADR 0998).`),
    { code: 'RESERVED_NAMESPACE' },
  );
}

const isRunName = (v: unknown): boolean => typeof v === 'string' && v.startsWith(RUN_SURFACE_PREFIX);

// ── argument canonicalization (ADR 0998 P2) ───────────────────────────────────

/** Fold `alias` into `canonical` when the canonical key is absent, then delete the
 *  alias either way. The canonical key always wins when both are given. */
function fold(a: Record<string, unknown>, canonical: string, ...aliases: string[]): void {
  for (const alias of aliases) {
    if (a[canonical] === undefined && a[alias] !== undefined) a[canonical] = a[alias];
    delete a[alias];
  }
}

/**
 * ADR 0998 P2 — three contracts name these arguments differently: the spec
 * (`spec/v1/host-capabilities.md` §host.vectorStore / §host.searchIndex:
 * `collection`, `vectors[].embedding`, `embedding`, `k`), the
 * `core.openwop.db@1.0.1` pack (`collection`, `records`, `query`, `limit`,
 * `id`+`document`) and this host's backends (`namespace`, `items[].vector`,
 * `vector`, `topK`, `q`, `k`, `docs`). Every alias is folded into the backend's
 * name here and then DELETED, so a backend only ever sees canonical args.
 *
 * Runs BEFORE the run lane's prefix: the prefix rewrites the canonical name, so
 * an alias can never carry an unprefixed name past it (`collection:'user:x'`
 * from a run lands in `wf:user:x`). Folding after the prefix would let a backend
 * that preferred the alias read a host namespace.
 */
function canonicalArgs(kind: keyof typeof NAME_ARG, args: SurfaceArgs | undefined): Record<string, unknown> {
  const a: Record<string, unknown> = { ...(args ?? {}) };
  if (kind === 'vector') {
    fold(a, 'namespace', 'collection');
    fold(a, 'items', 'vectors', 'records');
    if (Array.isArray(a.items)) {
      a.items = a.items.map((it: unknown) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
        const row: Record<string, unknown> = { ...(it as Record<string, unknown>) };
        fold(row, 'vector', 'embedding');
        return row;
      });
    }
    fold(a, 'vector', 'embedding');
    fold(a, 'topK', 'k');
  } else if (kind === 'search') {
    // The pack's single-document form `{id, document}`; `id` is only an alias when `document` rides with it.
    if (a.document !== undefined) {
      if (a.docs === undefined && typeof a.id === 'string' && a.document && typeof a.document === 'object') {
        a.docs = [{ id: a.id, fields: a.document }];
      }
      delete a.id;
      delete a.document;
    }
    fold(a, 'q', 'query');
    fold(a, 'k', 'limit');
  }
  return a;
}

/** The pack's vector-query output schema names the result `hits`; the backends and
 *  the spec name it `matches`. Both keys hold the SAME array, never two copies. */
function aliasResult(kind: keyof typeof NAME_ARG, res: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'vector' || !res || typeof res !== 'object' || !Array.isArray(res.matches)) return res;
  return { ...res, hits: res.matches };
}

// ── host lane ──────────────────────────────────────────────────────────────────

function hostNamed<S extends Record<string, SurfaceFn>>(surface: S, kind: keyof typeof NAME_ARG): S {
  const field = NAME_ARG[kind];
  return mapVerbs(surface, (verb, fn) => async (args: SurfaceArgs) => {
    const a = canonicalArgs(kind, args);
    if (isRunName(a[field])) throw reserved(`db.${kind}`, verb, field);
    return aliasResult(kind, await fn(a));
  });
}

function hostBlob(blob: BlobSurface): BlobSurface {
  return mapVerbs(blob, (verb, fn) => async (args: SurfaceArgs) => {
    if (isRunName(args?.key)) throw reserved('storage.blob', verb, 'key');
    if (isRunName(args?.prefix)) throw reserved('storage.blob', verb, 'prefix');
    return fn(args);
  });
}

/** Host lane: the bundle `buildHostSurfaceBundle` returns. Refuses run-keyspace
 *  names and remembers the raw surfaces so `runNamespacedBundle` can reach them. */
export function hostLaneSurfaces(raw: NamedSurfaces): NamedSurfaces & { bind(bundle: object): void } {
  return {
    vector: hostNamed(raw.vector, 'vector'),
    search: hostNamed(raw.search, 'search'),
    nosql: hostNamed(raw.nosql, 'nosql'),
    blob: hostBlob(raw.blob),
    bind(bundle: object) { RAW.set(bundle, raw); },
  };
}

// ── run lane ───────────────────────────────────────────────────────────────────

const runName = (v: unknown): string => `${RUN_SURFACE_PREFIX}${String(v ?? 'default')}`;

/** Thrown when a backend hands a run something outside the run keyspace. Names
 *  no key: the foreign value is never echoed to the run or the log. */
function foreign(surface: string, verb: string): Error {
  return Object.assign(new Error(`host.${surface}.${verb}: the store returned a value outside this run's keyspace (ADR 0998).`), { code: 'RUN_KEYSPACE_VIOLATION' });
}

/**
 * FAIL CLOSED on the way back. Anything a backend returns that carries a name
 * (`field`) must be in the run keyspace; it is stripped to the run's own name,
 * and anything else never reaches the run. A row in a result array is DROPPED
 * (logged by count only); a top-level value is a hard error. Rows that carry no
 * name pass unchanged: the name was fixed on the way in.
 */
function strip(surface: string, verb: string, field: string, rowArrays: readonly string[], res: Record<string, unknown>): Record<string, unknown> {
  if (!res || typeof res !== 'object') return res;
  const out: Record<string, unknown> = { ...res };
  if (field in out && out[field] !== undefined) {
    const v = out[field];
    if (typeof v !== 'string' || !v.startsWith(RUN_SURFACE_PREFIX)) throw foreign(surface, verb);
    out[field] = v.slice(RUN_SURFACE_PREFIX.length);
  }
  for (const k of rowArrays) {
    const rows = out[k];
    if (!Array.isArray(rows)) continue;
    let dropped = 0;
    const kept: unknown[] = [];
    for (const row of rows) {
      if (row && typeof row === 'object' && field in row && (row as Record<string, unknown>)[field] !== undefined) {
        const v = (row as Record<string, unknown>)[field];
        if (typeof v !== 'string' || !v.startsWith(RUN_SURFACE_PREFIX)) { dropped++; continue; }
        kept.push({ ...(row as Record<string, unknown>), [field]: v.slice(RUN_SURFACE_PREFIX.length) });
      } else kept.push(row);
    }
    if (dropped > 0) log.warn('run_surface_foreign_rows_dropped', { surface, verb, dropped });
    out[k] = kept;
  }
  return out;
}

function runNamed<S extends Record<string, SurfaceFn>>(surface: S, kind: keyof typeof NAME_ARG): S {
  const field = NAME_ARG[kind];
  return mapVerbs(surface, (verb, fn) => async (args: SurfaceArgs) => {
    // Canonicalize FIRST, then prefix the canonical name (see canonicalArgs).
    const a = canonicalArgs(kind, args);
    return aliasResult(kind, strip(`db.${kind}`, verb, field, ROW_ARRAYS[kind], await fn({ ...a, [field]: runName(a[field]) })));
  });
}

function runBlob(blob: BlobSurface): BlobSurface {
  return mapVerbs(blob, (verb, fn) => async (args: SurfaceArgs) => {
    const a = args ?? {};
    // Every key a run names — put, get, delete and the key a presigned URL is
    // minted for — is the prefixed one; list is pinned under the prefix.
    // `String(key)` is what every blob backend does with the key; mirror it.
    return strip('storage.blob', verb, 'key', ROW_ARRAYS.blob, await fn({
      ...a,
      key: `${RUN_SURFACE_PREFIX}${String(a.key)}`,
      prefix: `${RUN_SURFACE_PREFIX}${typeof a.prefix === 'string' ? a.prefix : ''}`,
    }));
  });
}

/** Run lane: the ONLY bundle the executor hands a node (`executor.ts`). Every
 *  name on vector/search/nosql/blob is moved under `RUN_SURFACE_PREFIX`. Throws
 *  for a bundle that did not come from `buildHostSurfaceBundle`, rather than
 *  handing a run unprefixed surfaces. */
export function runNamespacedBundle<B extends HostSurfaceBundle>(bundle: B): B {
  const raw = RAW.get(bundle);
  if (!raw) throw new Error('runNamespacedBundle: not a buildHostSurfaceBundle() bundle (ADR 0998).');
  return {
    ...bundle,
    storage: { ...bundle.storage, blob: runBlob(raw.blob) },
    db: {
      ...bundle.db,
      vector: runNamed(raw.vector, 'vector'),
      search: runNamed(raw.search, 'search'),
      nosql: runNamed(raw.nosql, 'nosql'),
    },
  };
}
