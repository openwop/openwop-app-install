/**
 * v2 wire adaptation — the ONE place the SPA knows major 2 differs from major 1
 * (ADR 0647).
 *
 * `@openwop/openwop@2` sends `OpenWOP-Version: 2.0` on every request and speaks
 * the unversioned path space. Two things come back shaped differently from the
 * v1 wire the rest of the app was written against, and both are undone HERE so
 * no page has to know which major fetched its data:
 *
 *  1. RUN IDS ARE TENANT-BOUND. `identity.md` §5 (ADR 0629): every run id on the
 *     major-2 wire is `<tenantId>/<opaque>`. The host does NOT re-mint ids — it
 *     projects at the boundary in both directions, and its inbound check is
 *     `if (idPart.includes('/'))` (`middleware/v2Identity.ts:95`), so a BARE
 *     opaque id is accepted unchanged on a major-2 request. The SPA therefore
 *     keeps ids bare everywhere (they are path segments in `/runs/:runId`, keys
 *     in local state, and arguments to the 543 `/host/openwop-app/*` calls
 *     that have no v2 home) and strips the tenant segment from every id the v2
 *     wire hands back. Sending bare is a host-verified property, not a spec
 *     guarantee — `unbindRunIds` is the single seam to change if that moves.
 *
 *  2. ERROR CODES ARE NAMESPACED. `protocolVersion.ts v2ErrorCode`: a code not
 *     in `spec/v2/errors.json` travels as `<vendorOrg>.<code>`, and this host's
 *     org is `openwop-app`. The SPA branches on 14 bare codes (`approval_required`,
 *     `deep_run_budget_exceeded`, …); `normalizeErrorCode` strips THIS host's
 *     vendor prefix so those branches keep matching. Two v1 spellings are
 *     ALIASED rather than prefixed (`run_not_found` / `workflow_not_found` →
 *     `not_found`) — a lossy rename the SPA meets with `isNotFoundCode`.
 */

/** This host's vendor org, as it namespaces error codes on the v2 wire. */
export const VENDOR_ORG = 'openwop-app';
/**
 * RFC 0181 / ADR 0652 — this host's proprietary path namespace root, served
 * version-agnostically (the OpenWOP-Version header selects nothing under it).
 * Host-extension operations at protocol-shaped paths (`GET /v1/runs` list,
 * `DELETE /v1/runs/{id}`, the events token) live here from ADR 0654 on; the
 * `/host/openwop-app/` twin stays through the overlap and retires with `/v1`.
 */
export const VENDOR_BASE = `/host/${VENDOR_ORG}`;

/** `ids.schema.json#/$defs/runId` — the tenant-bound composite. The tenant
 *  half is lenient on purpose (ADR 0726): this host's personal-workspace
 *  tenants are `user:<hash>` in the host-ext dialect and `user~3A<hash>` on
 *  the major-2 wire; both must read as "bound". */
const TENANT_BOUND_RUN_ID = /^[^/\s]{1,128}\/[A-Za-z0-9._~-]{16,128}$/;

/**
 * RFC 0184 — the bound-id PATH projection: every UTF-8 byte outside
 * `[A-Za-z0-9._-]` becomes `~` + two uppercase hex digits, so `acme/r-9f3c…`
 * travels as `acme~2Fr-9f3c…`. Byte-for-byte the host's `boundIdProjection.ts`.
 *
 * Why the SPA projects rather than percent-encodes (ADR 0726, MEASURED in
 * production 2026-09-17): the SPA reaches the host through the Firebase `/api`
 * rewrite, which normalises `%2F` back to `/` before the request arrives, so
 * `/runs/user%3Ax%2F<id>` became `/runs/user:x/<id>` — a path Express routes
 * as `runs/:runId` = `user:x` and answers 404 (40 such reads in three days,
 * every one a personal workspace). The projected form is all-unreserved and
 * survives any intermediary, which is exactly what RFC 0184 exists for.
 */
export function projectBoundId(id: string): string {
  return Array.from(new TextEncoder().encode(id), (b) => (b < 0x80 && /[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
}

/**
 * The keys the host projects (`host/v2Ids.ts deriveRunIdKeys`): every property
 * whose schema is `$ref: ids.schema.json#/$defs/runId`, with a floor of the three
 * everyone has. Mirrored as a predicate rather than a list so a new `*RunId`
 * key on the wire is unbound without a release here; the parity test pins the
 * floor against the vendored schemas.
 */
export function isBoundIdKey(key: string): boolean {
  // Singular AND plural: the schemas type `sourceRunIds` / `contributingRunIds`
  // (arrays) as run ids too. The first version matched only `*RunId` and the
  // parity test below named the two it would have left tenant-bound.
  //
  // ADR 0723 — ALL FIVE tenant-bound kinds of `identity.md` §5, not runId alone.
  // The host now binds `interruptId`, `subscriptionId` /
  // `triggerSubscriptionId` / `webhookId`, `deliveryId` and `effectId` on every
  // major-2 channel (`host/v2Ids.ts`), so
  // an SPA predicate that unbound only the run family would leave the other four
  // tenant-bound in local state — and `workflowRunSubscription.ts` compares
  // `interruptId` by equality across events. The parity test walks the vendored
  // schemas for every kind and names any key this predicate would miss.
  return /^(runIds?|interruptId|subscriptionId|webhookId|deliveryId|effectId)$|(RunIds?|SubscriptionId)$/.test(key);
}
/** @deprecated alias — the predicate covers every bound kind (ADR 0723), not runs alone. */
export const isRunIdKey = isBoundIdKey;

/** `<tenant>/<opaque>` → `<opaque>`; anything else unchanged. Every bound id
 *  the wire hands back also tells us the caller's tenant, so it is remembered
 *  for `bindRunId` — the cheapest possible source, and always current. */
export function fromWireRunId(id: string): string {
  if (!TENANT_BOUND_RUN_ID.test(id)) return id;
  const slash = id.indexOf('/');
  rememberWireTenant(id.slice(0, slash));
  return id.slice(slash + 1);
}

// ── Outbound: the request side of identity.md §5 ────────────────────────────
//
// CORRECTED 2026-09-10 (corpus steward, crosstalk `2b5a`). The first version
// sent BARE ids on major-2 requests because this host's inbound check gates
// on `includes('/')` and lets a bare id through. That is a property of this
// host, and it is NON-CONFORMANT: `api/v2/openapi.yaml` types the `runId` path
// parameter as `ids.schema.json#/$defs/runId` — the tenant-bound grammar, "no
// legacy branch, and it MUST NOT acquire one" — and `versioning.md` §5 says
// why: a bare id has no tenant segment, so the mandatory `403
// id_tenant_mismatch` check is structurally inapplicable to it. The fix is
// ENCODE, not un-bind: the SPA still keeps bare ids in its own state (they are
// path segments and host-extension arguments), and binds them at the ONE seam
// where a major-2 request leaves.

let wireTenant: string | null = null;
let tenantInflight: Promise<string | null> | null = null;
let warnedUnbound = false;

/** Learned from any bound id the wire returned, or from `switchWorkspace`. */
export function rememberWireTenant(tenant: string): void {
  if (tenant && wireTenant !== tenant) { wireTenant = tenant; tenantInflight = null; }
}
/** Auth or workspace changed: the next bind re-resolves. */
export function resetWireTenant(): void { wireTenant = null; tenantInflight = null; }

/**
 * The caller's active tenant for binding. Remembered from the wire when we
 * have it; otherwise resolved ONCE (single-flight) from
 * `GET /host/openwop-app/me/workspaces` `.active` — the host's own statement
 * of which tenant the session is bound to. `null` only when the host cannot
 * say (unauthenticated): the request that follows is refused anyway.
 */
export function ensureWireTenant(loader: () => Promise<{ active: string }>): Promise<string | null> {
  if (wireTenant) return Promise.resolve(wireTenant);
  if (!tenantInflight) {
    tenantInflight = loader()
      .then((w) => { if (typeof w.active === 'string' && w.active) rememberWireTenant(w.active); return wireTenant; })
      .catch(() => { tenantInflight = null; return null; });
  }
  return tenantInflight;
}

/** `<opaque>` → `<tenant>/<opaque>`; an already-bound id passes through. */
export function toWireRunId(id: string, tenant: string): string {
  if (TENANT_BOUND_RUN_ID.test(id)) return id;
  return `${tenant}/${id}`;
}

/**
 * The value to hand the SDK for a `{runId}` path parameter. The SDK
 * `encodeURIComponent`s it, so the `/` travels as `%2F` exactly as
 * `v2-created-run-readable` sends it.
 */
export const bindRunId = async (id: string, loader: () => Promise<{ active: string }>): Promise<string> => projectBoundId(await bindRunIdValue(id, loader));

/** The bound VALUE (`<tenant>/<opaque>`), unprojected — for a request BODY field, never a path segment. */
export async function bindRunIdValue(id: string, loader: () => Promise<{ active: string }>): Promise<string> {
  if (TENANT_BOUND_RUN_ID.test(id)) return id;
  const tenant = await ensureWireTenant(loader);
  if (!tenant) {
    if (!warnedUnbound) { warnedUnbound = true; console.warn('[v2Wire] sending an UNBOUND run id on a major-2 request — the tenant could not be resolved; identity.md §5 requires the bound form'); }
    return id;
  }
  return toWireRunId(id, tenant);
}

/** Depth bound: `variables` / `metadata` bags are caller-supplied and unbounded. */
const MAX_DEPTH = 12;

/**
 * Deep-unbind every run id in a v2 response so the rest of the SPA sees the
 * bare ids it has always seen. Arrays of ids (`runIds: [...]`) are handled;
 * absolute `eventsUrl` / `statusUrl` links are left alone (the SPA never
 * dereferences them).
 */
/**
 * ADR 0725 D3 — the host's boxed carry. On the major-2 wire every key this
 * host writes that a closed corpus def leaves undeclared travels under ONE
 * `vendor.openwop-app` object (RFC 0185 §C: carried, never dropped). The SPA
 * was written against the v1 wire where those keys sit at the top level
 * (`conversation.opened.initialTurn`, `run.failed.error.userMessage`, …), so
 * the box is opened HERE — the one seam — and never in a page.
 */
export const VENDOR_CARRY_KEY = 'vendor.openwop-app';

export function unbindRunIds<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => unbindRunIds(v, depth + 1)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const { [VENDOR_CARRY_KEY]: box, ...rest } = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === 'string' && isBoundIdKey(k)) out[k] = fromWireRunId(v);
    else if (Array.isArray(v) && isBoundIdKey(k) && v.every((e) => typeof e === 'string')) out[k] = (v as string[]).map(fromWireRunId);
    else out[k] = unbindRunIds(v, depth + 1);
  }
  if (box !== null && typeof box === 'object' && !Array.isArray(box)) {
    // Unbox after every seated key is placed: the box holds only keys the def
    // did not declare, and a seated key wins regardless of wire key order.
    // ADR 0725 — a host-only interrupt kind travels as `custom` with the host
    // spelling boxed; the SPA speaks the v1 dialect, so restore it here.
    const opened = unbindRunIds(box as Record<string, unknown>, depth + 1) as Record<string, unknown>;
    for (const [bk, bv] of Object.entries(opened)) if (!(bk in out) || (bk === 'kind' && out['kind'] === 'custom')) out[bk] = bv;
  } else if (box !== undefined) out[VENDOR_CARRY_KEY] = box;
  return out as T;
}

/** `openwop-app.<code>` → `<code>`; registered and foreign vendor codes unchanged. */
export function normalizeErrorCode(code: string): string {
  const prefix = `${VENDOR_ORG}.`;
  return code.startsWith(prefix) ? code.slice(prefix.length) : code;
}

/** The v2 alias collapses `run_not_found` / `workflow_not_found` into `not_found`. */
export function isNotFoundCode(code: string | null | undefined): boolean {
  return code === 'not_found' || code === 'run_not_found' || code === 'workflow_not_found';
}
