/**
 * Thin run-lifecycle client. Wraps `OpenwopClient` from `@openwop/openwop`
 * (major 2) for the protocol surfaces the UI needs, and the pinned 1.x client
 * (`@openwop/openwop-v1`) for the two reads that have no major-2 home.
 *
 * ADR 0647 — TWO CLIENTS DURING THE OVERLAP, ONE SEAM.
 *   - `client` speaks major 2: unversioned path keys + `OpenWOP-Version: 2.0` on
 *     every request. Every result passes through `unbindRunIds` (`v2Wire.ts`)
 *     so the rest of the app keeps the bare run ids it was written against.
 *   - `v1Client` speaks major 1 for exactly ONE thing now:
 *     `discovery.capabilities()`. 14 modules read the v1 document's shape
 *     (`caps.auth.profiles`, `caps.feedback.supported`, `demoMode`, …) and the
 *     v2 root is a different, CLOSED document. C.3 retired this client on the
 *     strength of C.3a advertising five families at major 2; that was not
 *     enough, and the correction note on `getCapabilities` records exactly which
 *     reads have no v2 home yet. `runs.debugBundle()` has moved for good — C.1
 *     gave it a host-extension twin, and `path-manifest.json` names no v2
 *     debug-bundle operation.
 *   `deleteRun`, `listMyRuns` and `setRunPinned` are host surfaces with no v2
 *   operation either; they stay raw fetches on `/v1/...`.
 *
 * If these wrappers prove broadly useful, promote them to a published
 * `@openwop/openwop-browser` package per the analysis plan §6.1.
 */
import { OpenwopClient } from '@openwop/openwop';
import type {
  CreateRunRequest,
  CreateRunResponse,
  ForkRunRequest,
  ForkRunResponse,
  MutationOptions,
  PollEventsResponse,
  RunSnapshot,
} from '@openwop/openwop';
// ADR 0730 C.3, CORRECTED — `v1Client` is back, for `discovery.capabilities()`
// ONLY. `runs.debugBundle()` stays on the host-extension twin (C.1), which is
// verified and has no v2 path. See the correction note on `getCapabilities`.
import { OpenwopClient as OpenwopV1Client } from '@openwop/openwop-v1';
import type { Capabilities, DebugBundle } from '@openwop/openwop-v1';
import { toClientEvent } from './eventVocabulary.js';
import { unbindRunIds, bindRunId, resetWireTenant, VENDOR_BASE } from './v2Wire.js';
import { listMyWorkspaces } from './workspaceClient.js';
import { authedHeaders, config, fetchOpts, onAuthChange } from './config.js';
import { handleSessionRefusal } from './sessionRefusal.js';
import { withSessionBootstrap } from './anonBootstrap.js';
import { ApiError } from './requestJson.js';
import { assertArrayField } from './parse.js';

// Pass an explicitly-bound `fetch` to work around an SDK bug — the
// client stores `opts.fetch ?? fetch` and later calls `this.#fetch(...)`,
// which strips the bound `this`. In Node that's harmless; browsers throw
// "Illegal invocation" because window.fetch refuses unbound calls.
// Filed-equivalent: @openwop/openwop v1.1.1 client.js:184. Safe to
// remove this workaround once the SDK lands `this.#fetch.call(globalThis, ...)`.
// In cookie auth mode we don't actually use the apiKey, but the SDK
// validates it as non-empty at construction. Pass a placeholder so
// `new OpenwopClient` succeeds, then strip the SDK-added
// `Authorization` header in the fetch wrapper before it hits the
// backend (the openwop.session cookie carries auth instead, rolling
// with `credentials: 'include'`).
/** The one fetch wrapper both clients share — auth-mode handling identical to
 *  the raw-fetch clients (strip the SDK's placeholder bearer, apply
 *  `authedHeaders()`, carry the session cookie in cookie mode, ride the
 *  session-refusal choke on 401). */
const sdkFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete('authorization');
  headers.delete('Authorization');
  for (const [k, v] of Object.entries(authedHeaders())) {
    headers.set(k, v);
  }
  const cleanInit: RequestInit = { ...init, headers };
  if (config.authMode === 'cookie' || headers.has('authorization')) {
    cleanInit.credentials = 'include';
  }
  // ADR 0750 — a major-2 request with no credential is refused 401 (RFC 0200
  // §B.1) instead of minting an anonymous session; bootstrap one on `/me` and
  // retry once. Only the no-credential challenge is retried (see anonBootstrap).
  return withSessionBootstrap(() => globalThis.fetch(input, cleanInit)).then((res) => {
    // ADR 0621 D5 — the SDK lane rides the same session-refusal choke as the
    // raw-fetch clients. Reads a CLONE, only on 401; the SDK's own parse is
    // untouched.
    if (res.status === 401) void handleSessionRefusal(res);
    return res;
  });
};
const sdkOptions = {
  baseUrl: config.baseUrl,
  apiKey: config.authMode === 'cookie' ? 'cookie-mode-placeholder' : config.apiKey,
  // Single fetch wrapper that handles all three auth modes
  // consistently with the rest of the SPA's clients:
  //   - Strip the SDK-injected Authorization (the placeholder)
  //   - Inject whatever authedHeaders() says we should send (cached
  //     Firebase ID token, or apiKey in bearer mode, or nothing in
  //     cookie mode)
  //   - In cookie or signed-in modes, attach credentials: 'include'
  //     so the session cookie travels for auth-fallback paths.
  fetch: sdkFetch,
};
/** Major 2 — the protocol client. */
export const client = new OpenwopClient({ ...sdkOptions, major: 2 });
/** Major 1, for the discovery read only (see `getCapabilities`). */
const v1Client = new OpenwopV1Client(sdkOptions);
/** Major 1 — discovery + debug bundle only (see the header). */

export interface RunListItem {
  runId: string;
  workflowId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  /** ADR 0482 §6 — the terminal per-node cost stamp (host-extension additive
   *  field; absent for pre-stamp / zero-spend runs). */
  costByNode?: Record<string, number>;
}

// Capabilities cache (GAP-ANALYSIS A-3). The discovery payload is a host-boot
// decision (`capabilities.md`), so ~12 call sites re-fetching it on every
// run-detail page (4-6× per load) is pure waste that helps blow the per-IP
// read budget. Cache the result with an in-flight promise so concurrent
// callers share one request, time-bound to the endpoint's advertised
// `Cache-Control: max-age=300` (not a permanent pin — per A-3), and drop it on
// an auth/tenant change via the documented `setCurrentIdToken` seam.
const CAPS_TTL_MS = 300_000;
let capsCache: { value: Capabilities & Record<string, unknown>; at: number } | null = null;
let capsInFlight: Promise<Capabilities & Record<string, unknown>> | null = null;
// Generation guard: bumped on every clear (auth/tenant change) so a fetch that
// was already in flight when the tenant changed does NOT write the prior
// tenant's capabilities into the cache (review finding — mid-flight race).
let capsGeneration = 0;

/** Drop the capabilities cache so the next read re-negotiates. */
export function clearCapabilitiesCache(): void {
  capsCache = null;
  capsInFlight = null;
  capsGeneration += 1;
}
onAuthChange(clearCapabilitiesCache);
onAuthChange(resetWireTenant);
/** identity.md §5 — a run id leaves for the major-2 wire tenant-bound (ADR 0647 § Correction). */
export const bound = (runId: string): Promise<string> => bindRunId(runId, listMyWorkspaces);

export async function getCapabilities(): Promise<Capabilities & Record<string, unknown>> {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) return capsCache.value;
  if (capsInFlight) return capsInFlight;
  const generation = capsGeneration;
  capsInFlight = (async () => {
    try {
      // CORRECTED 2026-09-18 — this read was moved to the v2 root by C.3 and is
      // moved BACK. The comment this replaced said C.3a had given "the families
      // the SPA reads" a v2 home. It gave FIVE of them one. The rest are still
      // v1-only, and MEASURED against the served v2 document:
      //
      //   demoMode                          -> extensions[openwop-app.host]
      //   capabilities.hostSurfaces         -> extensions[openwop-app.host-surfaces]
      //   capabilities.modelCapabilities    -> root.modelCapabilities
      //   capabilities.aiProviders.input    -> ABSENT
      //   capabilities.memory.attribution   -> ABSENT (no `memory` family at all)
      //   envelopes.tierOneSubsetCompliance -> ABSENT (no `envelopes` family at all)
      //   feedback.supported                -> v2 dropped `supported` from every facet
      //
      // The code being replaced had ALREADY warned about this in as many words —
      // "14 modules read the v1 document's shape … and the v2 root is a
      // different, closed document" — and C.3 overrode that warning with a
      // partial migration. It shipped five silent UI regressions that every unit
      // test, both conformance lanes and 16k backend tests passed over; only a
      // browser found them, because each consumer's failure mode is a `catch`
      // that renders nothing.
      //
      // The v2 ADVERTS from C.3a stay — they are additive and correct, and they
      // are what a v2 client reads. What is not yet true is that this SPA can
      // read the v2 document INSTEAD of the v1 one. That needs every consumer
      // re-derived against the v2 shape, plus the two missing families, and it
      // is tracked separately rather than half-done here.
      const value = (await v1Client.discovery.capabilities()) as Capabilities & Record<string, unknown>;
      // Only cache if no clear() happened while this request was in flight.
      if (generation === capsGeneration) capsCache = { value, at: Date.now() };
      return value;
    } finally {
      if (generation === capsGeneration) capsInFlight = null;
    }
  })();
  return capsInFlight;
}

/** Forwards an optional `MutationOptions` so callers can supply the
 *  `Idempotency-Key` (per spec/v1/idempotency.md Layer 1) and any other
 *  knob the SDK exposes on mutation requests (`dedup`, etc.). */
export async function createRun(
  req: CreateRunRequest,
  opts?: MutationOptions,
): Promise<CreateRunResponse> {
  return unbindRunIds(await client.runs.create(req, opts));
}

export async function getRun(runId: string): Promise<RunSnapshot> {
  return unbindRunIds(await client.runs.get(await bound(runId)));
}

export async function cancelRun(runId: string, reason?: string): Promise<void> {
  await client.runs.cancel(await bound(runId), reason ? { reason } : {});
}

/** Permanently delete a run (host-extension `DELETE /v1/runs/{runId}`; not a
 *  v1 protocol surface). The SDK client has no delete method, so this is a
 *  raw fetch reusing the app's auth headers. 204 = deleted; 404 = already
 *  gone — both treated as success. */
export async function deleteRun(runId: string): Promise<void> {
  const res = await fetch(`${config.baseUrl}${VENDOR_BASE}/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    headers: { ...authedHeaders() },
    credentials: config.authMode === 'cookie' ? 'include' : 'same-origin',
  });
  if (!res.ok && res.status !== 404) throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `Delete failed (${res.status})` });
}

export async function forkRun(runId: string, req: ForkRunRequest): Promise<ForkRunResponse> {
  return unbindRunIds(await client.runs.fork(await bound(runId), req));
}

/** Pin/unpin a run against retention (ADR 0371 — host-extension
 *  `POST /host/openwop-app/runs/{runId}/pin`). Pinned runs are exempt
 *  from the retention sweep. Returns the resolved pinned state. */
export async function setRunPinned(runId: string, pinned: boolean): Promise<boolean> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/runs/${encodeURIComponent(runId)}/pin`, {
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    credentials: config.authMode === 'cookie' ? 'include' : 'same-origin',
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `Pin failed (${res.status})` });
  return ((await res.json()) as { pinned?: boolean }).pinned === true;
}

/** Fetch the debug bundle for a run per `spec/v1/debug-bundle.md`.
 *  Routes through the published SDK's `client.runs.debugBundle()`
 *  (parity row SDK-4, closed 2026-05-15 — see `sdk/PARITY.md`).
 *  The SDK returns `null` when the host doesn't advertise
 *  `capabilities.debugBundle.supported: true`; we throw a typed error
 *  in that case so the calling button can surface a "not supported"
 *  message instead of saving a `null.json` file. */
export async function getDebugBundle(runId: string): Promise<DebugBundle> {
  // ADR 0730 C.1 — the HOST-EXTENSION twin, not the v1 SDK client. The operation
  // has no v2 path (absent from the 43-path manifest), so `/host/openwop-app/…`
  // is its home through the overlap and after it; reaching it through
  // `v1Client` would have kept a v1 protocol dependency alive for a surface the
  // v2 wire never adopted. The bare run id is correct here: host-extension
  // routes run in the v1 dialect (RFC 0181), so no tenant binding applies.
  const res = await fetch(
    `${config.baseUrl}${VENDOR_BASE}/runs/${encodeURIComponent(runId)}/debug-bundle`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (res.status === 404) {
    throw new Error('Debug-bundle download is not supported by this host (capabilities.debugBundle.supported is not advertised).');
  }
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `getDebugBundle returned ${res.status}` });
  }
  return (await res.json()) as DebugBundle;
}


export async function pollEvents(runId: string, lastSequence = 0): Promise<PollEventsResponse> {
  // v2 renamed the cursor: `lastSequence` (v1) → `afterSequence` (v2). The
  // wrapper keeps the app-facing name so nine call sites are untouched.
  // Major 2 also renames 36 event TYPES (`schemas/v2/event-codemap.json`);
  // the SPA keeps its v1 dialect, so every inbound event is translated at
  // this seam — see `eventVocabulary.ts`.
  const page = unbindRunIds(await client.runs.pollEvents(await bound(runId), { afterSequence: lastSequence }));
  return { ...page, events: page.events.map(toClientEvent) };
}

/**
 * List recent runs scoped to the authenticated tenant. The backend
 * derives the tenant from the bearer / cookie, so this client doesn't
 * need to pass a tenantId. Returns at most `limit` rows (default 50).
 */
export async function listMyRuns(opts: { status?: string; workflowId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<RunListItem[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  // ADR 0482 review M2 — server-side workflow filter so "this workflow's
  // latest run" never depends on the tenant's global recent-runs page.
  if (opts.workflowId) params.set('workflowId', opts.workflowId);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const url = `${config.baseUrl}${VENDOR_BASE}/runs${query ? `?${query}` : ''}`;
  const headers = authedHeaders({ accept: 'application/json' });
  const includeCreds = config.authMode === 'cookie' || Boolean(headers.authorization);
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: includeCreds ? 'include' : 'same-origin',
    // AbortSignal threaded from the caller's effect cleanup (GAP-ANALYSIS E15)
    // so an in-flight read is cancelled on unmount rather than completing and
    // burning the per-IP budget.
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `listMyRuns failed: ${res.status} ${res.statusText}` });
  }
  // Host-extension endpoint (`/host/openwop-app/*`) the SDK does not wrap —
  // validate the list shape before the cast (A-2 / E4).
  const body: unknown = await res.json();
  assertArrayField(body, 'runs', 'listMyRuns response');
  return (body as { runs: RunListItem[] }).runs;
}

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  expiresAt?: string;
}

/**
 * List the authenticated tenant's memory entries (RFC 0004 read-side, via
 * the host-extension `GET /host/openwop-app/memory`). Tenant is derived from
 * the bearer / cookie server-side (CTI-1). `memoryRef` defaults to the
 * demo's per-tenant namespace when omitted.
 */
export async function listMemory(
  opts: { memoryRef?: string; tag?: string; limit?: number } = {},
): Promise<{ memoryRef: string; entries: MemoryEntry[] }> {
  const params = new URLSearchParams();
  if (opts.memoryRef) params.set('memoryRef', opts.memoryRef);
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const url = `${config.baseUrl}/host/openwop-app/memory${query ? `?${query}` : ''}`;
  const headers = authedHeaders({ accept: 'application/json' });
  const includeCreds = config.authMode === 'cookie' || Boolean(headers.authorization);
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: includeCreds ? 'include' : 'same-origin',
  });
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `listMemory failed: ${res.status} ${res.statusText}` });
  }
  const body: unknown = await res.json();
  assertArrayField(body, 'entries', 'listMemory response');
  return body as { memoryRef: string; entries: MemoryEntry[] };
}

/** Returns the underlying SDK client for surfaces not yet wrapped here. */
export function getSdkClient(): OpenwopClient {
  return client;
}
