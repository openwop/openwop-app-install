/**
 * Host-side `ui-plugin/1` RPC dispatcher + capability constants (OpenWOP RFC 0117 —
 * front-end plugin packs; normative surface merged in openwop/openwop PR #782).
 *
 * A downloadable front-end plugin runs ONLY in a cross-origin sandboxed iframe and talks
 * to the host exclusively through this request/response/event channel. The host honors
 * ONLY the methods in its closed `hostApi` allowlist (`HOST_UI_PLUGIN_API`) — anything
 * else is rejected, never executed. This module is the single source of truth for both:
 *   - what the host ADVERTISES at `/.well-known/openwop` (`uiPluginsCapability()`), and
 *   - what the witness seam `POST /v1/host/openwop-app/ui-plugin/rpc` actually SERVES
 *     (`createUiPluginDispatcher`),
 * so advertise/serve can never drift (the ADR 0085 honest-witness discipline).
 *
 * The `artifact.write` leg maps 1:1 onto the host's existing `host.canvas` optimistic-
 * concurrency seam (`updateCanvasForTenant` → `canvas_version_conflict`): a stale write
 * surfaces as the normative `artifact_conflict` envelope with `currentVersion` and the
 * host MUST NOT persist. The envelope shape matches `schemas/ui-plugin-message.schema.json`.
 *
 * @see docs/adr/0153-canvas-projects-program.md (Track 2)
 * @see RFC 0117 §3 (ui-plugin/1), §4 (manifest), SECURITY/invariants.yaml 139→143
 */

export const UI_PLUGIN_PROTOCOL = 'ui-plugin/1';

/** Isolation is a schema `const` in `frontend-plugin-manifest.schema.json` — it MUST be
 *  exactly this string. In-process loading is a protocol-tier MUST NOT
 *  (`frontend-plugin-isolation`). */
export const UI_PLUGIN_ISOLATION = 'cross-origin-iframe' as const;

/** The plugin-facing surfaces a manifest may declare (RFC 0117 §4). */
export const UI_PLUGIN_SURFACES = ['artifact-viewer', 'route', 'settings-panel'] as const;

/** The CLOSED host-API allowlist (RFC 0117 §3). A plugin may call only these methods,
 *  and only those it also declared in its manifest `hostApi[]`. NOTHING credential-/
 *  secret-bearing is here — a plugin can never read BYOK material
 *  (`frontend-plugin-no-byok`). */
export const HOST_UI_PLUGIN_API = ['artifact.read', 'artifact.write', 'host.toast', 'host.navigate'] as const;
export type HostUiPluginMethod = (typeof HOST_UI_PLUGIN_API)[number];

/** Max bytes of a plugin's `entry` bundle the host will load (RFC 0117 §4). Mirrors the
 *  capability advertisement so a manifest declaring a larger entry is rejected at load. */
export const UI_PLUGIN_MAX_ENTRY_BYTES = 2_097_152;

/** The exact `uiPlugins` block advertised at the `/.well-known/openwop` discovery root
 *  (RFC 0117 §6). Single source of truth — discovery imports this verbatim. */
export function uiPluginsCapability(): {
  supported: true; isolation: typeof UI_PLUGIN_ISOLATION; surfaces: readonly string[]; hostApi: readonly string[]; maxEntryBytes: number;
} {
  return {
    supported: true,
    isolation: UI_PLUGIN_ISOLATION,
    surfaces: [...UI_PLUGIN_SURFACES],
    hostApi: [...HOST_UI_PLUGIN_API],
    maxEntryBytes: UI_PLUGIN_MAX_ENTRY_BYTES,
  };
}

/**
 * The Content-Security-Policy the host applies to the plugin iframe document
 * (`frontend-plugin-egress`). `default-src 'none'` + the absence of any `connect-src`
 * means the sandboxed plugin can make NO network requests — its only channel to the
 * outside is the `ui-plugin/1` postMessage RPC, which is the whole point of the closed
 * allowlist. The Track-2 front-end loader sets this on the iframe; it is a pure host
 * primitive so the egress invariant is testable without a browser.
 */
export function pluginIframeCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'", // the plugin's own bundle, no remote scripts
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    // NO connect-src / form-action / frame-src → deny all egress.
  ].join('; ');
}

/**
 * The iframe `sandbox` token set (`frontend-plugin-isolation`). `allow-scripts` lets the
 * plugin run; the deliberate ABSENCE of `allow-same-origin` keeps it in a unique opaque
 * origin (cross-origin), so it can never reach the host's cookies, storage, or DOM — the
 * isolation that makes `cross-origin-iframe` honest. `allow-same-origin` MUST NOT appear.
 */
export function pluginSandboxTokens(): readonly string[] {
  return ['allow-scripts'];
}

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

/** A host handler MAY throw this (or an object shaped like it) from `artifact.write` when
 *  the plugin's opaque `version` token is stale — the dispatcher maps it to the normative
 *  `artifact_conflict` envelope. Mirrors `host.canvas`'s `canvas_version_conflict`. */
export interface ArtifactConflictError {
  code: 'artifact_conflict';
  currentVersion?: string;
}

export function isArtifactConflict(e: unknown): e is ArtifactConflictError {
  return Boolean(e) && typeof e === 'object' && (e as { code?: unknown }).code === 'artifact_conflict';
}

/** Stable host-mediated error codes a handler MAY throw (via `{ code }`) for the dispatcher
 *  to surface verbatim — the `ui-plugin-message.schema.json` error enum minus the two the
 *  dispatcher mints itself (`method_not_allowed`, `handler_error`). `artifact_conflict` is
 *  handled separately because it also carries `currentVersion`. */
export const UI_PLUGIN_ERROR_CODES: ReadonlySet<string> = new Set(['artifact_not_found', 'unauthorized', 'internal']);

/** A host-RPC handler: receives the request `params`, returns the `result` (or throws —
 *  an `ArtifactConflictError` becomes `artifact_conflict`, anything else `handler_error`). */
export type UiPluginHandler = (params: unknown) => Promise<unknown>;

export interface UiPluginDispatcherOptions {
  /** The methods the host will honor for THIS plugin = its declared `hostApi` ∩ the
   *  host-recognized set (`HOST_UI_PLUGIN_API`). A call to anything outside it is rejected. */
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

/** Create the host dispatcher. Returns a function the seam (or postMessage handler) calls
 *  with the raw inbound message; it returns the response envelope to post back, or `null`
 *  when the message is not a recognized `ui-plugin/1` request. */
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
      // Version-token concurrency contract (RFC 0117 §Concurrency): a stale/unknown write
      // version surfaces as `artifact_conflict` + `currentVersion`; the host MUST NOT persist.
      if (isArtifactConflict(err)) {
        return response(id, false, undefined, { code: 'artifact_conflict', ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}) });
      }
      // Other host-mediated failures pass their stable code through verbatim (the schema's
      // error enum: artifact_not_found / unauthorized / internal). Unrecognized → handler_error.
      const code = (err as { code?: unknown })?.code;
      if (typeof code === 'string' && UI_PLUGIN_ERROR_CODES.has(code)) {
        return response(id, false, undefined, { code, ...(err instanceof Error ? { message: err.message } : {}) });
      }
      return response(id, false, undefined, { code: 'handler_error', message: err instanceof Error ? err.message : String(err) });
    }
  };
}
