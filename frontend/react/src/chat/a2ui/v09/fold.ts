/**
 * The A2UI v0.9 surface fold (RFC 0209 §C.9, ADR 0749) — pure.
 *
 * A surface's state is the fold, in order, of the messages of every version-2
 * envelope recorded for its `surfaceId`: `createSurface` starts it,
 * `updateComponents` upserts components by `id`, `updateDataModel` replaces or
 * removes the value at a JSON Pointer, `deleteSurface` ends it.
 *
 * The host refuses an invalid fold at record time, but a renderer never trusts
 * that: a message for a surface that is not live is ignored, and a fold that
 * never gains exactly one `root` is `renderable: false` — a consumer MUST NOT
 * render the surface or enable any action on it until it is.
 */
import type { V09Component, V09Message, V09Payload } from './profile.js';

export interface SurfaceState {
  readonly surfaceId: string;
  readonly live: boolean;
  /** Was the surface created and then deleted (as opposed to never created)? */
  readonly deleted: boolean;
  readonly components: ReadonlyMap<string, V09Component>;
  readonly dataModel: unknown;
  readonly agentDisplayName?: string;
  /** Exactly one component has `id: "root"` and the surface is live. */
  readonly renderable: boolean;
}

/** RFC 6901 — decode one reference token. */
function unescapeToken(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}
export function pointerTokens(path: string | undefined): string[] {
  if (path === undefined || path === '' || path === '/') return [];
  return path.slice(1).split('/').map(unescapeToken);
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === 'object' && v !== null;
/** Tokens that would reach the prototype chain — refused, never walked. */
const UNSAFE_TOKENS = new Set(['__proto__', 'prototype', 'constructor']);

/** Read the value at `path`; `undefined` when absent. */
export function getAt(model: unknown, path: string | undefined): unknown {
  let cur: unknown = model;
  for (const tok of pointerTokens(path)) {
    if (UNSAFE_TOKENS.has(tok) || !isContainer(cur) || !Object.prototype.hasOwnProperty.call(cur, tok)) return undefined;
    cur = (cur as Record<string, unknown>)[tok];
  }
  return cur;
}

/** Immutable set (or, with `value === undefined`, remove) at `path`. */
export function setAt(model: unknown, path: string | undefined, value: unknown): unknown {
  const tokens = pointerTokens(path);
  if (tokens.some((t) => UNSAFE_TOKENS.has(t))) return model;
  const write = (node: unknown, i: number): unknown => {
    if (i === tokens.length) return value;
    const tok = tokens[i]!;
    if (Array.isArray(node)) {
      const idx = tok === '-' ? node.length : Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx > node.length) return node;
      const copy = node.slice();
      const next = write(node[idx], i + 1);
      if (next === undefined && i === tokens.length - 1) copy.splice(idx, 1);
      else copy[idx] = next;
      return copy;
    }
    // Removing below a missing parent is a no-op — it must not conjure `{}` parents.
    if (value === undefined && (!isContainer(node) || !Object.prototype.hasOwnProperty.call(node, tok))) return node;
    const obj: Record<string, unknown> = isContainer(node) ? { ...(node as Record<string, unknown>) } : {};
    const next = write(obj[tok], i + 1);
    if (next === undefined && i === tokens.length - 1) delete obj[tok];
    else obj[tok] = next;
    return obj;
  };
  return write(model, 0);
}

function bodyOf(m: V09Message): [string, Record<string, unknown>] {
  const k = Object.keys(m).find((x) => x !== 'version')!;
  return [k, (m as unknown as Record<string, Record<string, unknown>>)[k]!];
}

/** Fold the messages of one or more version-2 payloads for ONE surface, in order. */
export function foldSurface(payloads: readonly V09Payload[]): SurfaceState {
  const surfaceId = payloads[0]?.surfaceId ?? '';
  let live = false;
  let deleted = false;
  let components = new Map<string, V09Component>();
  let dataModel: unknown = {};
  let agentDisplayName: string | undefined;
  for (const p of payloads) {
    if (p.surfaceId !== surfaceId) continue;
    for (const m of p.messages) {
      const [kind, body] = bodyOf(m);
      if (kind === 'createSurface') {
        if (live) continue;
        live = true; deleted = false; components = new Map(); dataModel = {};
        const theme = body.theme as { agentDisplayName?: unknown } | undefined;
        agentDisplayName = typeof theme?.agentDisplayName === 'string' ? theme.agentDisplayName : undefined;
        continue;
      }
      if (!live) continue;
      if (kind === 'updateComponents') {
        const next = new Map(components);
        for (const c of body.components as V09Component[]) next.set(c.id, c);
        components = next;
      } else if (kind === 'updateDataModel') {
        dataModel = setAt(dataModel, body.path as string | undefined, body.value);
        if (dataModel === undefined) dataModel = {};
      } else if (kind === 'deleteSurface') {
        live = false; deleted = true; components = new Map(); dataModel = {};
      }
    }
  }
  return {
    surfaceId,
    live,
    deleted,
    components,
    dataModel,
    ...(agentDisplayName !== undefined ? { agentDisplayName } : {}),
    renderable: live && components.has('root'),
  };
}
