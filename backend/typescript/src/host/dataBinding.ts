/**
 * ADR 0865 P1 — `ctx.dataIntegration.applyBinding`: write one value into a
 * canvas's state at an RFC 6901 JSON Pointer (B9–B15).
 *
 * It owns no canvas logic. The canvas is reached through the run lane's ONE gate
 * (`assertCanvasRunAccess`, B17) and written through the editor's own write path
 * (`updateCanvasForTenant`: CAS, the live-room veto, the after-write fan-out and
 * the type's validator). Undo is the canvas's existing version history: with
 * `preserveUndo` the PRIOR state is captured first, and a failed capture stops
 * the write (B12), because a promised undo that was not kept is worse than none.
 */
import {
  assertCanvasRunAccess,
  getCanvasForTenant,
  getCanvasVersionAt,
  snapshotCanvas,
  updateCanvasForTenant,
} from './canvasSurface.js';
import type { BundleScope } from './inMemorySurfaces.js';

/** The one target type this host serves (B9). */
export const BINDING_TARGET_TYPES = ['canvas.state'] as const;

/** A lost CAS race re-reads at most this many times (B11). */
const MAX_ATTEMPTS = 8;

/** Segments that would reach an object's prototype instead of its data. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export interface ApplyBindingArgs {
  targetType?: unknown;
  targetPath?: unknown;
  value?: unknown;
  transform?: unknown;
  fallback?: unknown;
  canvasId?: unknown;
  updateMode?: unknown;
  preserveUndo?: unknown;
}

export interface ApplyBindingResult {
  applied: boolean;
  previousValue?: unknown;
  resolvedValue?: unknown;
}

type Json = Record<string, unknown>;

function bindingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** RFC 6901 → its reference tokens. The whole-document pointer (`""`) is refused:
 *  a binding sets a value inside a canvas, it does not replace the canvas. */
export function parsePointer(pointer: unknown): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw bindingError('validation_error', 'targetPath must be an RFC 6901 JSON Pointer starting with "/" (e.g. "/sections/0/title")');
  }
  const tokens = pointer.slice(1).split('/').map((t) => {
    if (/~[^01]|~$/.test(t)) throw bindingError('validation_error', `targetPath has an invalid escape in "${t}"`);
    return t.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  for (const t of tokens) {
    if (FORBIDDEN_SEGMENTS.has(t)) throw bindingError('validation_error', `targetPath may not name "${t}"`);
  }
  return tokens;
}

const isIndex = (t: string): boolean => /^(0|[1-9][0-9]*)$/.test(t);
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value at `tokens`, or undefined when any step is absent. */
function readAt(state: unknown, tokens: readonly string[]): unknown {
  let cur: unknown = state;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (!isIndex(t)) return undefined;
      cur = cur[Number(t)];
    } else if (isObject(cur)) {
      cur = Object.prototype.hasOwnProperty.call(cur, t) ? cur[t] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** A copy of `state` with `value` set at `tokens`. A missing intermediate object
 *  is created; an array index must name an existing element; a scalar in the
 *  way is refused (B9). The input is never mutated. */
function writeAt(state: Json, tokens: readonly string[], value: unknown): Json {
  const set = (node: unknown, i: number): unknown => {
    const t = tokens[i]!;
    const last = i === tokens.length - 1;
    if (Array.isArray(node)) {
      if (!isIndex(t) || Number(t) >= node.length) {
        throw bindingError('validation_error', `targetPath "/${tokens.slice(0, i + 1).join('/')}" is not an element of the array (length ${node.length})`);
      }
      const copy = node.slice();
      copy[Number(t)] = last ? value : set(copy[Number(t)], i + 1);
      return copy;
    }
    if (node === undefined) node = {};
    if (!isObject(node)) {
      throw bindingError('validation_error', `targetPath "/${tokens.slice(0, i).join('/')}" is not an object, so "${t}" cannot be set inside it`);
    }
    const prior = Object.prototype.hasOwnProperty.call(node, t) ? node[t] : undefined;
    return { ...node, [t]: last ? value : set(prior, i + 1) };
  };
  return set(state, 0) as Json;
}

/** Structural equality over JSON values (key order does not matter). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
  }
  return false;
}

/** B13 — the value to write: `transform` (JSONata, the transform method's own
 *  engine and budget, which throws its own codes) over `value`, then `fallback`
 *  when the result is null or undefined. A throwing transform never falls back. */
/** The JSONata evaluator `ctx.dataIntegration.transform` uses, injected by the
 *  adapter (so this module does not import it back). */
export type BindingEvaluator = (expression: unknown, language: unknown, input: unknown) => Promise<unknown>;

async function resolveValue(args: ApplyBindingArgs, evaluate: BindingEvaluator): Promise<unknown> {
  let v = args.value;
  if (args.transform !== undefined) {
    if (typeof args.transform !== 'string' || args.transform.trim() === '') {
      throw bindingError('validation_error', 'transform must be a non-empty JSONata expression');
    }
    v = await evaluate(args.transform, 'jsonata', v);
  }
  if ((v === undefined || v === null) && args.fallback !== undefined) v = args.fallback;
  if (v === undefined) throw bindingError('validation_error', 'there is no value to bind (value, transform and fallback all gave undefined)');
  return v;
}

/** The binding's own refusal for "this target is not usable by this run": the
 *  spec's `binding_target_not_found`, for a missing canvas and a refused one alike. */
function targetNotFound(): never {
  throw bindingError('binding_target_not_found', 'The binding target was not found.');
}

export async function applyBinding(scope: BundleScope | undefined, args: ApplyBindingArgs, evaluate: BindingEvaluator): Promise<ApplyBindingResult> {
  if (!scope) throw bindingError('host_capability_missing', 'this host exposes no canvas scope to the run');
  if (!(BINDING_TARGET_TYPES as readonly unknown[]).includes(args.targetType)) {
    throw bindingError('validation_error', `targetType must be one of: ${BINDING_TARGET_TYPES.join(', ')}`);
  }
  const updateMode = args.updateMode ?? 'immediate';
  if (updateMode === 'batched') {
    // B14 — nothing in this host defers a canvas write; accepting it as
    // `immediate` would make the node's promise false.
    throw bindingError('unsupported_operation', "updateMode 'batched' is not supported by this host; use 'immediate'");
  }
  if (updateMode !== 'immediate') throw bindingError('validation_error', "updateMode must be 'immediate'");
  if (typeof args.canvasId !== 'string' || args.canvasId === '') {
    throw bindingError('validation_error', 'canvasId is required: a run is not bound to a canvas on this host');
  }
  const canvasId = args.canvasId;
  const tokens = parsePointer(args.targetPath);
  const preserveUndo = args.preserveUndo !== false;
  const resolvedValue = await resolveValue(args, evaluate);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
    if (!canvas) targetNotFound();
    try {
      await assertCanvasRunAccess(scope, canvas, 'write');
    } catch (err) {
      if ((err as { code?: string }).code === 'canvas_not_found') targetNotFound();
      throw err; // the type gate and the role floor say nothing about existence
    }
    const previousValue = readAt(canvas.state, tokens);
    if (previousValue !== undefined && sameJson(previousValue, resolvedValue)) {
      // B15 — nothing changes, so nothing is written, versioned or snapshotted.
      return { applied: false, previousValue, resolvedValue };
    }
    const next = writeAt(canvas.state, tokens, resolvedValue);
    if (preserveUndo) {
      try {
        await snapshotCanvas({ tenantId: scope.tenantId, canvasId, state: canvas.state, version: canvas.version }, `binding:${scope.runId ?? 'surface'}`, { force: true });
      } catch (err) {
        throw bindingError('binding_undo_unavailable', `the prior state could not be captured, so the binding was not applied: ${err instanceof Error ? err.message : String(err)}`);
      }
      // B12 review correction — the capture is proved, not assumed: the version
      // this write replaces must be readable from history, holding this state.
      const kept = await getCanvasVersionAt(scope.tenantId, canvasId, canvas.version);
      if (!kept || !sameJson(kept.snapshot, canvas.state)) {
        throw bindingError('binding_undo_unavailable', 'the prior state was not found in the canvas history after capture, so the binding was not applied');
      }
    }
    try {
      const out = await updateCanvasForTenant(scope.tenantId, canvasId, next, { merge: 'replace', expectedVersion: canvas.version, validate: true });
      if (!out) targetNotFound();
      return { applied: true, ...(previousValue !== undefined ? { previousValue } : {}), resolvedValue };
    } catch (err) {
      // A concurrent writer won: re-read, re-authorize, recompute the value at
      // the pointer and capture the NEW prior state before the next CAS (B11).
      // The live-room veto is `canvas_room_live` — a refusal, never retried.
      if ((err as { code?: string }).code === 'canvas_version_conflict' && attempt < MAX_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw bindingError('canvas_version_conflict', `canvas ${canvasId} write contention — retry`);
}

