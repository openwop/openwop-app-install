/**
 * `POST /v1/host/openwop-app/ui-plugin/rpc` — the RFC 0117 front-end-plugin RPC witness
 * seam (host-extension, non-normative path; the contract it exercises IS normative).
 *
 * The conformance suite (`conformance/src/scenarios/frontend-plugin-packs.test.ts`) drives
 * this seam server-side with `{ message: <ui-plugin/1 envelope> }` so the closed allowlist
 * + version-token concurrency are testable without a browser:
 *   - an undeclared method → `{ ok:false, error:{ code:"method_not_allowed" } }`
 *   - a stale `artifact.write` → `{ ok:false, error:{ code:"artifact_conflict", currentVersion } }`,
 *     with NO persist.
 * The runtime FE path (a sandboxed iframe → postMessage) routes through the SAME
 * `createUiPluginDispatcher`; this seam just binds it to HTTP for the witness.
 *
 * `artifact.read`/`artifact.write` are bound to the host's `host.canvas` store
 * (the live single-source canvas, ADR 0153) — the opaque `version` token is the canvas
 * version stringified. `host.toast`/`host.navigate` are client-only UI ops: on the
 * server witness they are accepted no-ops (the allowlist must still honor them).
 *
 * Tenant-scoped: a plugin reads/writes only canvases in the caller's tenant (no cross-
 * tenant access, no existence leak). Always mounted — the host honestly advertises
 * `uiPlugins.supported` (discovery.ts), so the seam MUST be reachable.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../types.js';
import {
  createUiPluginDispatcher,
  HOST_UI_PLUGIN_API,
  type UiPluginHandler,
  type UiPluginResponse,
} from '../host/uiPluginRpc.js';
import { getCanvasForTenant, updateCanvasForTenant, ensureCanvasForTenant, type CanvasRecordView } from '../host/canvasSurface.js';

const RPC_PATH = '/v1/host/openwop-app/ui-plugin/rpc';

/** The conformance suite addresses a fixed host-provided artifact id to exercise the
 *  optimistic-concurrency leg (`frontend-plugin-packs.test.ts §Concurrency`). The host
 *  provisions it (version 1) ONLY under the test seam so a stale/unknown write token
 *  conflicts against a real current version — production never auto-creates it. */
const CONFORMANCE_CANARY_ID = 'conformance-canary';
const CANVAS_TYPE = 'canvas.app-builder';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new OpenwopError('invalid_request', `'${key}' must be a non-empty string`, 400);
  return v;
}

/** Resolve an artifact id → its `host.canvas` record. Under the test seam, the
 *  `conformance-canary` id is provisioned on first touch (idempotent, version 1). Absent
 *  (and not the seeded canary) → throws the schema-stable `artifact_not_found`. */
async function resolveArtifact(tenantId: string, canvasId: string): Promise<CanvasRecordView> {
  if (canvasId === CONFORMANCE_CANARY_ID && process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    return ensureCanvasForTenant(tenantId, canvasId, { canvasTypeId: CANVAS_TYPE });
  }
  const c = await getCanvasForTenant(tenantId, canvasId);
  if (!c) throw { code: 'artifact_not_found', message: `artifact '${canvasId}' not found` };
  return c;
}

/** Build the per-request handler map. The allowlist is the full host API; each plugin's
 *  manifest `hostApi[]` would further narrow it, but the witness exercises the host-
 *  recognized set. Handlers close over the caller's tenant for isolation. */
function handlersForTenant(tenantId: string): Record<string, UiPluginHandler> {
  return {
    // Read an artifact → { payload, version }. `version` is the opaque token the plugin
    // echoes back on write. Absent/cross-tenant → artifact_not_found (no existence leak).
    'artifact.read': async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const canvasId = requireString(p, 'artifactId');
      const c = await resolveArtifact(tenantId, canvasId);
      return { payload: c.state, version: String(c.version) };
    },
    // Optimistic write (RFC 0117 §Concurrency). `params.payload` is the new state;
    // `params.version` is the opaque token last minted by read/write. A token the host did
    // NOT mint (stale OR unknown) → artifact_conflict + currentVersion, with NO persist.
    'artifact.write': async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const canvasId = requireString(p, 'artifactId');
      const token = typeof p.version === 'string' ? p.version : undefined;
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const c = await resolveArtifact(tenantId, canvasId);
      // Opaque-token compare: the host mints String(version). Anything else (stale, unknown,
      // or absent) conflicts — the host MUST NOT persist and returns its current token.
      if (token !== String(c.version)) {
        throw { code: 'artifact_conflict', currentVersion: String(c.version) };
      }
      const out = await updateCanvasForTenant(tenantId, canvasId, payload, { expectedVersion: c.version });
      if (!out) throw { code: 'artifact_not_found', message: `artifact '${canvasId}' not found` };
      return { version: String(out.newVersion) };
    },
    // Client-only UI ops — accepted no-ops on the server witness.
    'host.toast': async () => ({ ok: true }),
    'host.navigate': async () => ({ ok: true }),
  };
}

const ALLOWLIST = new Set<string>(HOST_UI_PLUGIN_API);

/** The host dispatcher scoped to one tenant — the exact object the witness seam serves.
 *  Exported so the conformance-mirroring host tests drive the real allowlist + the real
 *  `host.canvas`-backed handlers without standing up an HTTP server. */
export function dispatcherForTenant(tenantId: string): (msg: unknown) => Promise<UiPluginResponse | null> {
  return createUiPluginDispatcher({ allowlist: ALLOWLIST, handlers: handlersForTenant(tenantId) });
}

/** The single seam handler — shared by the product path and the conformance alias so the
 *  two can't drift (single-source off `host/uiPluginRpc.ts`). */
async function handleRpc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = body.message;
    if (message === undefined) throw new OpenwopError('invalid_request', "body must carry a 'message' (ui-plugin/1 envelope)", 400);

    const response = await dispatcherForTenant(tenantOf(req))(message);
    // A non-`ui-plugin/1` message yields null (host posts nothing) — surface 400 over HTTP
    // rather than an empty body, so the witness caller gets a clear signal.
    if (response === null) throw new OpenwopError('invalid_request', 'not a recognized ui-plugin/1 request', 400);
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export function registerUiPluginRoutes(app: Express): void {
  // Product surface — always mounted (the host honestly advertises uiPlugins.supported).
  app.post(RPC_PATH, handleRpc);

  // Conformance alias — the pinned `@openwop/openwop-conformance` suite drives the fixed
  // canonical `/v1/host/sample/ui-plugin/rpc` (capability-gated on uiPlugins.supported;
  // there is no discoverable path field). Mounting the SAME handler here makes the witness
  // non-vacuous under OPENWOP_REQUIRE_BEHAVIOR=true. Gated to OPENWOP_TEST_SEAM_ENABLED so
  // it 404s in production — mirroring routes/testSeam.ts's `/v1/host/sample/*` convention,
  // and registered BEFORE that module's catch-all rewrite so it resolves directly.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    app.post('/v1/host/sample/ui-plugin/rpc', handleRpc);
  }
}
