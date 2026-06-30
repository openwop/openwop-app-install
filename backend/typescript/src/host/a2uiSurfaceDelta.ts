/**
 * RFC 0114 — A2UI surface delta TRANSPORT.
 *
 * The recorded/durable `ui.a2ui-surface` envelope is ALWAYS the full tree
 * (schema unchanged, validated once, replay-safe). This module is a pure,
 * host-side TRANSPORT optimization: when a subscriber opts in (`?a2uiDelta=1`)
 * and a surface for a `surfaceRef` it has already seen is re-emitted, the host
 * sends an RFC 6902 patch frame instead of the full tree. The consumer applies
 * the patch and MUST re-validate the post-patch surface against the closed
 * catalog before render (fail-closed) — see `materializeOrThrow` callers.
 *
 * Honesty: the differ emits the `add`/`remove`/`replace` subset of RFC 6902
 * (a valid, reconstructing patch — `move`/`copy` are OPTIONAL optimizations, not
 * required of a differ). `applyPatch` accepts `add`/`remove`/`replace`/`move`/
 * `copy` so it can consume any conformant patch; `test` is rejected (the task
 * forbids it on the wire). Both functions are pure + non-mutating.
 */

/**
 * Single source of truth for "is the a2ui delta transport ON for this host?"
 *
 * Both the capability advert (`discovery.ts` → `a2uiSurface.deltaTransport`) and
 * the serving path (`streams.ts` → `?a2uiDelta=1`) MUST read this one predicate
 * so they can never drift (advertising what isn't served, or vice-versa — the
 * honest-advert rule).
 *
 * Gate (default OFF — honest, the RFC 0114 wire capability stays dark in prod
 * until an operator opts in):
 *  - `OPENWOP_A2UI_DELTA_TRANSPORT=true` — the dedicated production lever. This
 *    makes the delta transport a REAL operator-controllable capability rather
 *    than something welded to the test-seam machinery. Unlike ADR 0148's
 *    host-internal context-economy levers, this one is WIRE-facing (it changes
 *    subscriber bytes + advertises a capability), so it lives here, not in
 *    `contextEconomy()`.
 *  - `OPENWOP_TEST_SEAM_ENABLED=true` — also enables it, so the emit-surface
 *    seam (`/v1/host/sample/a2ui/emit-surface`) can drive a non-vacuous witness
 *    in one env flip (and so an in-flight conformance witness keeps working).
 */
export function a2uiDeltaTransportEnabled(): boolean {
  return (
    process.env.OPENWOP_A2UI_DELTA_TRANSPORT === 'true' ||
    process.env.OPENWOP_TEST_SEAM_ENABLED === 'true'
  );
}

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string };

/** Encode one JSON Pointer reference token (RFC 6901 §3): `~`→`~0`, `/`→`~1`. */
function encodeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}
function pointer(segments: readonly string[]): string {
  return segments.length === 0 ? '' : '/' + segments.map(encodeToken).join('/');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Structural deep-equal (JSON value semantics). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * RFC 6902 diff producing a reconstructing patch (add/remove/replace subset).
 * Objects diff per-key; equal-length arrays diff per-index; an array that
 * changed length is replaced whole (correct, and rare for a stable surface);
 * primitives replace when unequal.
 */
export function diffSurface(prev: unknown, next: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(prev, next, [], ops);
  return ops;
}

function walk(prev: unknown, next: unknown, path: string[], ops: PatchOp[]): void {
  if (deepEqual(prev, next)) return;

  if (isObject(prev) && isObject(next)) {
    for (const key of Object.keys(prev)) {
      if (!(key in next)) ops.push({ op: 'remove', path: pointer([...path, key]) });
    }
    for (const key of Object.keys(next)) {
      if (!(key in prev)) ops.push({ op: 'add', path: pointer([...path, key]), value: next[key] });
      else walk(prev[key], next[key], [...path, key], ops);
    }
    return;
  }

  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    for (let i = 0; i < next.length; i++) walk(prev[i], next[i], [...path, String(i)], ops);
    return;
  }

  // Type change, primitive change, or array length change → replace the node.
  ops.push({ op: 'replace', path: pointer(path), value: next });
}

/** Split a JSON Pointer into decoded path segments. `''` → `[]`. */
function parsePointer(ptr: string): string[] {
  if (ptr === '') return [];
  if (ptr[0] !== '/') throw new Error(`invalid JSON Pointer: ${ptr}`);
  return ptr.slice(1).split('/').map(decodeToken);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Resolve the parent container + final key for a pointer within `doc`. */
function locate(doc: unknown, segments: string[]): { parent: any; key: string } {
  let parent: any = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (Array.isArray(parent)) parent = parent[Number(seg)];
    else if (isObject(parent)) parent = parent[seg];
    else throw new Error(`patch path not found: ${segments.join('/')}`);
    if (parent === undefined) throw new Error(`patch path not found: ${segments.join('/')}`);
  }
  return { parent, key: segments[segments.length - 1]! };
}

function getAt(doc: unknown, segments: string[]): unknown {
  let cur: any = doc;
  for (const seg of segments) {
    cur = Array.isArray(cur) ? cur[Number(seg)] : isObject(cur) ? cur[seg] : undefined;
    if (cur === undefined) throw new Error(`patch from-path not found: ${segments.join('/')}`);
  }
  return cur;
}
function setAt(parent: any, key: string, value: unknown): void {
  if (Array.isArray(parent)) {
    const idx = key === '-' ? parent.length : Number(key);
    parent.splice(idx, 0, value);
  } else parent[key] = value;
}
function removeAt(parent: any, key: string): void {
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
}

/**
 * Apply an RFC 6902 patch to a deep clone of `doc` and return the result.
 * Supports add/remove/replace/move/copy; `test` is rejected (forbidden on the
 * wire). Throws on any malformed op or missing path → the caller falls back to
 * re-materializing the full surface (fail-closed).
 */
export function applyPatch(doc: unknown, ops: readonly PatchOp[]): unknown {
  const out = clone(doc);
  for (const op of ops) {
    if ((op as { op: string }).op === 'test') throw new Error('`test` op not permitted (RFC 0114)');
    const segs = parsePointer(op.path);
    if (op.op === 'add') {
      if (segs.length === 0) return clone(op.value);
      const { parent, key } = locate(out, segs);
      setAt(parent, key, clone(op.value));
    } else if (op.op === 'remove') {
      const { parent, key } = locate(out, segs);
      removeAt(parent, key);
    } else if (op.op === 'replace') {
      if (segs.length === 0) return clone(op.value);
      const { parent, key } = locate(out, segs);
      if (Array.isArray(parent)) parent[Number(key)] = clone(op.value);
      else parent[key] = clone(op.value);
    } else if (op.op === 'move') {
      const fromSegs = parsePointer(op.from);
      const moved = clone(getAt(out, fromSegs));
      const fromLoc = locate(out, fromSegs);
      removeAt(fromLoc.parent, fromLoc.key);
      const { parent, key } = locate(out, segs);
      setAt(parent, key, moved);
    } else if (op.op === 'copy') {
      const copied = clone(getAt(out, parsePointer(op.from)));
      const { parent, key } = locate(out, segs);
      setAt(parent, key, copied);
    } else {
      throw new Error(`unknown patch op: ${JSON.stringify(op)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-connection transport projection (RFC 0114 §"Stream frames").
// ---------------------------------------------------------------------------

/** The recorded `ui.a2ui-surface` envelope payload (schema unchanged). */
export interface A2uiSurfacePayload {
  catalogVersion: string;
  surface: unknown;
  reasoning?: string;
}

/** A delta frame carried ONLY on a `?a2uiDelta=1` stream (never recorded). */
export interface A2uiDeltaFrame {
  surfaceRef: string;
  catalogVersion: string;
  patch: PatchOp[];
}

/**
 * Per-connection delta state: the last full surface DELIVERED to this
 * subscriber under `surfaceRef`. `surfaceRef` is the event id of the baseline
 * full surface (the recorded envelope id this delta chain patches). Reset when
 * `catalogVersion` changes (a version bump MUST start from a fresh full).
 */
export interface A2uiDeltaState {
  last?: { surfaceRef: string; tree: unknown; catalogVersion: string };
}

/**
 * Decide how to deliver an a2ui surface to ONE subscriber:
 *  - `full`   → deliver the materialized full surface (and record it as the new
 *               baseline). Always the choice for the first surface, a
 *               catalogVersion change, when the client did not opt in, or when
 *               the diff is empty.
 *  - `delta`  → deliver `{ surfaceRef, catalogVersion, patch }` patching the
 *               last-delivered tree → this surface. The caller still records the
 *               recorded FULL envelope in the durable log; this only changes
 *               what bytes go to THIS subscriber.
 *
 * `eventId` is the recorded envelope's event id (used as the baseline
 * `surfaceRef`). Mutates `state`. Pure aside from `state`.
 */
export function projectA2uiDelivery(
  state: A2uiDeltaState,
  eventId: string,
  payload: A2uiSurfacePayload,
  deltaEnabled: boolean,
): { kind: 'full' } | { kind: 'delta'; frame: A2uiDeltaFrame } {
  const prior = state.last;
  const sameCatalog = prior !== undefined && prior.catalogVersion === payload.catalogVersion;

  if (!deltaEnabled || !prior || !sameCatalog) {
    // Fresh baseline: first surface, no opt-in, or a catalogVersion change.
    state.last = { surfaceRef: eventId, tree: payload.surface, catalogVersion: payload.catalogVersion };
    return { kind: 'full' };
  }

  const patch = diffSurface(prior.tree, payload.surface);
  // Record the new tree as the next baseline; the chain's surfaceRef is stable.
  state.last = { surfaceRef: prior.surfaceRef, tree: payload.surface, catalogVersion: payload.catalogVersion };
  if (patch.length === 0) {
    // No change → nothing useful to delta; deliver full (harmless, rare).
    return { kind: 'full' };
  }
  return { kind: 'delta', frame: { surfaceRef: prior.surfaceRef, catalogVersion: payload.catalogVersion, patch } };
}
