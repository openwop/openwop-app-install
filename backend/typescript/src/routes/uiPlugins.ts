/**
 * The RFC 0117 / RFC 0238 front-end-plugin RPC dispatcher (`ui-plugin/1`).
 *
 * Served over HTTP ONLY per plugin, at the RFC 0238 operation
 * `POST /host/ui-plugins/{pack}/{plugin}/rpc` (`features/ui-plugins/routes.ts` →
 * `dispatchForPlugin`), allowlisted to that plugin's declared `hostApi` ∩ the host's.
 * ADR 0840 D7 deleted the host-global vendor route `/host/openwop-app/ui-plugin/rpc`
 * and its v1 conformance alias `/host/sample/ui-plugin/rpc`: a host-global path cannot
 * know which plugin is calling, so it could only enforce the host half.
 *
 * `artifact.read`/`artifact.write` are bound to the host's `host.canvas` store
 * (the live single-source canvas, ADR 0153) — the opaque `version` token is the canvas
 * version stringified. `host.toast`/`host.navigate`/`host.announce` are client-only UI
 * ops: over HTTP they are accepted no-ops (the allowlist must still honor them).
 *
 * Tenant-scoped: a plugin reads/writes only canvases in the caller's tenant (no cross-
 * tenant access, no existence leak).
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import {
  createUiPluginDispatcher,
  isUiPluginRequest,
  HOST_UI_PLUGIN_API,
  type UiPluginHandler,
  type UiPluginResponse,
} from '../host/uiPluginRpc.js';
import { canvasReadAllowed, getCanvasForTenant, updateCanvasForTenant, type CanvasRecordView } from '../host/canvasSurface.js';
import type { SubjectCaller } from '../host/subjectAccess.js';
import { callerSubject } from '../host/requestSubject.js';
import { resolveCanvasTypeAccess } from '../host/canvasTypeOwnership.js';
import type { ToggleSubject } from '../host/featureToggles/types.js';
import { toggleSubjectOf } from '../features/featureRoute.js';
import { assertTenantScope } from '../host/accessControlService.js';
import { personalTenantOf } from '../host/requestSubject.js';
import { validateAppDoc } from '../features/app-builder/validateAppDoc.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { locateRepoSchemasDir } from '../host/_repoPath.js';

/** ADR 0835 D7 — the request facts the write-authority check needs (the same
 *  two `requireTenantScope` threads through): the wildcard operator principal
 *  and the caller's personal tenant. A caller with neither is judged by
 *  membership alone. */
export interface UiPluginWriteAuthority { personalTenant?: string; wildcardOperator?: boolean }


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
/**
 * Canvas-access fix (ADR 0768 Phase 0): this RPC resolved ANY canvas of ANY type
 * by id, gated only by tenant — so a plugin (or any authenticated caller) could
 * read or overwrite a private project's canvas, or a canvas of another type.
 * Now: TYPE-PINNED to the app-builder canvas (the only type ui-plugins edit) and
 * gated by THE shared canvas predicate with the real caller. Refusal and absence
 * are the same `artifact_not_found` (no existence leak).
 */
async function resolveArtifact(tenantId: string, canvasId: string, caller: SubjectCaller, access: ToggleSubject, planExemptArtifactId?: string): Promise<CanvasRecordView> {
  // ADR 0820 G5 — the app-builder FEATURE (toggle + plan) through the canvas
  // type's owning toggle, the gate the app-builder editor routes apply. This RPC
  // reads and writes app-builder canvases, so without it a tenant whose plan
  // does not include app-builder could edit one through a plugin. Refusal is the
  // same `artifact_not_found` as absence (no existence leak, the rule above).
  // ADR 0840 D6 correction — the operator-trusted RFC 0238 fixture artifact, read in
  // the tenant the operator installed the fixture for, is conformance plumbing, not
  // product content: the plan paywall does not apply to that ONE id. ADR 0821's rule
  // (an exempt tenant is still paywalled for features) holds for every other canvas.
  if (canvasId !== planExemptArtifactId && !(await resolveCanvasTypeAccess(CANVAS_TYPE, access)).allowed) {
    throw { code: 'artifact_not_found', message: `artifact '${canvasId}' not found` };
  }
  const c = await getCanvasForTenant(tenantId, canvasId);
  if (!c || c.canvasTypeId !== CANVAS_TYPE || !(await canvasReadAllowed(tenantId, c, caller))) {
    throw { code: 'artifact_not_found', message: `artifact '${canvasId}' not found` };
  }
  return c;
}

/** Build the per-request handler map. The allowlist is the full host API; each plugin's
 *  manifest `hostApi[]` would further narrow it, but the witness exercises the host-
 *  recognized set. Handlers close over the caller's tenant for isolation. */
function handlersForTenant(tenantId: string, caller: SubjectCaller, access: ToggleSubject, authority: UiPluginWriteAuthority, planExemptArtifactId?: string): Record<string, UiPluginHandler> {
  return {
    // Read an artifact → { payload, version }. `version` is the opaque token the plugin
    // echoes back on write. Absent/cross-tenant → artifact_not_found (no existence leak).
    'artifact.read': async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const canvasId = requireString(p, 'artifactId');
      const c = await resolveArtifact(tenantId, canvasId, caller, access, planExemptArtifactId);
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
      const c = await resolveArtifact(tenantId, canvasId, caller, access, planExemptArtifactId);
      // ADR 0835 D7 — a write is the editor's write: READ visibility (above) let a
      // Viewer overwrite any canvas they could open. The RPC names no org, so the
      // check is the workspace union (`requireTenantScope`'s predicate).
      try {
        await assertTenantScope(tenantId, caller.subject, 'workspace:write', authority);
      } catch {
        // `unauthorized` is the RPC's closed wire code for this (UI_PLUGIN_ERROR_CODES).
        throw Object.assign(new Error('writing an artifact requires workspace:write'), { code: 'unauthorized' });
      }
      // Opaque-token compare: the host mints String(version). Anything else (stale, unknown,
      // or absent) conflicts — the host MUST NOT persist and returns its current token.
      if (token !== String(c.version)) {
        throw { code: 'artifact_conflict', currentVersion: String(c.version) };
      }
      // ADR 0835 D7 — and through the app-builder save validator, like PATCH:
      // plugin output must not become state the editor would refuse (and a
      // later export would ship).
      const v = validateAppDoc(payload);
      if (v.errors.length) throw new OpenwopError('validation_error', `payload violates the app-builder component catalog: ${v.errors[0]!.message}`, 422, { errors: v.errors.slice(0, 10) });
      const out = await updateCanvasForTenant(tenantId, canvasId, payload, { expectedVersion: c.version });
      if (!out) throw { code: 'artifact_not_found', message: `artifact '${canvasId}' not found` };
      return { version: String(out.newVersion) };
    },
    // Client-only UI ops — accepted no-ops on the server witness.
    'host.toast': async () => ({ ok: true }),
    'host.navigate': async () => ({ ok: true }),
    // RFC 0130: the live-region relay is FE-local (PluginFrame); the witness
    // accepts + length-caps like the FE does so advertise/serve can't drift.
    'host.announce': async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (typeof p.message !== 'string') throw new OpenwopError('invalid_request', "'message' must be a string", 400);
      return {};
    },
  };
}

const ALLOWLIST = new Set<string>(HOST_UI_PLUGIN_API);

/** The host dispatcher scoped to one tenant — the exact object the witness seam serves.
 *  Exported so the conformance-mirroring host tests drive the real allowlist + the real
 *  `host.canvas`-backed handlers without standing up an HTTP server. */
/** `caller` is REQUIRED in spirit: omitting it is `{ subject: undefined }`, which
 *  the shared predicate REFUSES for any member-owned canvas (fail-closed). */
/** `access` is the feature-access subject (the HTTP lane passes `toggleSubjectOf(req)`
 *  so a listed operator keeps the person-level plan exemption); it defaults to the
 *  tenant + the caller's principal. */
/** `allowlist` defaults to the host's whole set (the vendor route, which does not
 *  know the calling plugin). ADR 0840: the per-plugin RFC 0238 route passes the
 *  plugin's served `hostApi` (manifest ∩ host), so both halves hold server-side. */
export function dispatcherForTenant(tenantId: string, caller: SubjectCaller = {}, access?: ToggleSubject, authority: UiPluginWriteAuthority = {}, allowlist: ReadonlySet<string> = ALLOWLIST, planExemptArtifactId?: string): (msg: unknown) => Promise<UiPluginResponse | null> {
  const subject: ToggleSubject = access ?? { tenantId, ...(caller.subject ? { userId: caller.subject } : {}) };
  return createUiPluginDispatcher({ allowlist, handlers: handlersForTenant(tenantId, caller, subject, authority, planExemptArtifactId) });
}

// ADR 0840 (RFC 0238 §C.2) — the v2 request schema. A body that does not validate,
// including a `method` outside the closed `ui-plugin/1` enum, is `400 validation_error`.
let v2MessageValidator: ValidateFunction | undefined;
function validateV2Message(message: unknown): boolean {
  if (!v2MessageValidator) {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const ajv = new Ajv2020({ allErrors: false, strict: false });
    v2MessageValidator = ajv.compile(JSON.parse(readFileSync(join(dir, 'v2', 'ui-plugin-message.schema.json'), 'utf8')));
  }
  return v2MessageValidator(message) === true;
}

/**
 * ADR 0840 — the RFC 0238 `dispatchUiPluginRequest` body for ONE plugin, through
 * the same dispatcher and handlers as the vendor route. The caller has already
 * resolved the plugin (an unknown one is 404 before the body is read) and checked
 * the route's scope. Throws `validation_error` (400) for a body outside the v2
 * request schema; otherwise returns the `ui-plugin/1` response envelope.
 */
export async function dispatchForPlugin(req: Request, allowlist: ReadonlySet<string>, planExemptArtifactId?: string): Promise<UiPluginResponse> {
  const message = ((req.body ?? {}) as Record<string, unknown>).message;
  if (message === undefined) throw new OpenwopError('validation_error', "body must carry a 'message' (ui-plugin/1 request)", 400);
  if (!validateV2Message(message) || !isUiPluginRequest(message)) {
    throw new OpenwopError('validation_error', 'message is not a valid ui-plugin/1 request', 400);
  }
  const personalTenant = personalTenantOf(req);
  const response = await dispatcherForTenant(tenantOf(req), { subject: callerSubject(req) }, { ...toggleSubjectOf(req), tenantId: tenantOf(req) }, {
    ...(personalTenant ? { personalTenant } : {}),
    wildcardOperator: req.principal?.tenants?.includes('*') === true,
  }, allowlist, planExemptArtifactId)(message);
  // Unreachable after the checks above; kept so a future dispatcher change fails loudly.
  if (response === null) throw new OpenwopError('validation_error', 'message is not a valid ui-plugin/1 request', 400);
  return response;
}
