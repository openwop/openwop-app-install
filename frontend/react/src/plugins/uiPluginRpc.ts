/**
 * Host-side `ui-plugin/1` RPC dispatcher (OpenWOP RFC 0117 §3 — front-end plugin packs).
 * A sandboxed plugin (cross-origin iframe) talks to the host ONLY through this
 * request/response/event channel over `postMessage`; the host exposes ONLY the methods
 * the plugin declared in `hostApi` AND that the host recognizes — anything else is
 * rejected (never silently executed). This module is the pure protocol layer (no DOM /
 * postMessage wiring) so the allowlist + the artifact version-token concurrency contract
 * are unit-tested in isolation.
 *
 * Pre-stage for ADR 0153 Track 2 (the host evidence that graduates RFC 0117). It depends
 * only on the merged §2–§4 contract + the version-token decision pinned with openwop-1
 * (error code `artifact_conflict`, field `currentVersion`) — no dependency on the
 * still-pending manifest schema.
 */

export const UI_PLUGIN_PROTOCOL = 'ui-plugin/1';

export interface UiPluginRequest {
  openwop: typeof UI_PLUGIN_PROTOCOL;
  /** Monotonic id for response correlation. */
  id: number;
  type: 'request';
  method: string;
  params?: unknown;
}

export interface UiPluginError {
  /** `method_not_allowed` | `artifact_conflict` | `handler_error` (+ host extensions). */
  code: string;
  message?: string;
  /** Present on `artifact_conflict`: the host's current opaque version token (RFC 0117 §3). */
  currentVersion?: string;
}

export interface UiPluginResponse {
  openwop: typeof UI_PLUGIN_PROTOCOL;
  id: number;
  type: 'response';
  ok: boolean;
  result?: unknown;
  error?: UiPluginError;
}

export interface UiPluginEvent {
  openwop: typeof UI_PLUGIN_PROTOCOL;
  type: 'event';
  event: string;
  data?: unknown;
}

/** A host handler MAY throw this (or an object shaped like it) from `artifact.write`
 *  when the plugin's opaque `version` token is stale — the dispatcher maps it to the
 *  normative `artifact_conflict` error envelope. Mirrors the host's existing
 *  `host.canvas` optimistic-concurrency seam (`canvas_version_conflict`). */
export interface ArtifactConflictError {
  code: 'artifact_conflict';
  currentVersion?: string;
}

export function isArtifactConflict(e: unknown): e is ArtifactConflictError {
  return Boolean(e) && typeof e === 'object' && (e as { code?: unknown }).code === 'artifact_conflict';
}

/** A host-RPC handler: receives the request `params`, returns the `result` (or throws —
 *  an `ArtifactConflictError` becomes `artifact_conflict`, anything else `handler_error`). */
export type UiPluginHandler = (params: unknown) => Promise<unknown>;

export interface UiPluginDispatcherOptions {
  /** The methods the host will honor for THIS plugin = its declared `hostApi` ∩ the
   *  host-recognized set. A call to anything outside it is rejected. */
  allowlist: ReadonlySet<string>;
  handlers: Readonly<Record<string, UiPluginHandler>>;
}

/** True when `msg` is a well-formed `ui-plugin/1` request (else the host ignores it —
 *  RFC 0117 §5: a host MUST ignore messages whose protocol tag it doesn't recognize). */
export function isUiPluginRequest(msg: unknown): msg is UiPluginRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.openwop === UI_PLUGIN_PROTOCOL && m.type === 'request' && typeof m.id === 'number' && typeof m.method === 'string';
}

function response(id: number, ok: boolean, result?: unknown, error?: UiPluginError): UiPluginResponse {
  return { openwop: UI_PLUGIN_PROTOCOL, id, type: 'response', ok, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) };
}

/** Build a host→plugin event envelope (e.g. `host.themeChanged`). */
export function uiPluginEvent(event: string, data?: unknown): UiPluginEvent {
  return { openwop: UI_PLUGIN_PROTOCOL, type: 'event', event, ...(data !== undefined ? { data } : {}) };
}

/** Create the host dispatcher. Returns a function the postMessage handler calls with the
 *  raw inbound message; it returns the response envelope to post back, or `null` when the
 *  message is not a recognized `ui-plugin/1` request (post nothing). */
export function createUiPluginDispatcher(opts: UiPluginDispatcherOptions): (msg: unknown) => Promise<UiPluginResponse | null> {
  return async (msg: unknown): Promise<UiPluginResponse | null> => {
    if (!isUiPluginRequest(msg)) return null;
    const { id, method, params } = msg;

    // Closed allowlist — the load-bearing security gate (RFC 0117 §3, invariant
    // `frontend-plugin-rpc-allowlist`): reject any undeclared/unrecognized method.
    if (!opts.allowlist.has(method) || !opts.handlers[method]) {
      return response(id, false, undefined, { code: 'method_not_allowed', message: `method '${method}' is not allowed` });
    }

    try {
      const result = await opts.handlers[method]!(params);
      return response(id, true, result);
    } catch (err) {
      // Version-token concurrency contract (RFC 0117 §3, pinned with openwop-1): a stale
      // write surfaces as `artifact_conflict` + `currentVersion`; the host MUST NOT persist.
      if (isArtifactConflict(err)) {
        return response(id, false, undefined, { code: 'artifact_conflict', ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}) });
      }
      return response(id, false, undefined, { code: 'handler_error', message: err instanceof Error ? err.message : String(err) });
    }
  };
}
