/**
 * Thin run-lifecycle client. Wraps `OpenwopClient` from `@openwop/openwop`
 * (major 2) for the protocol surfaces the UI needs.
 *
 * ADR 0647 — ONE CLIENT, ONE SEAM. `client` speaks major 2: unversioned path
 * keys + `OpenWOP-Version: 2.0` on every request. Every result passes through
 * `unbindRunIds` (`v2Wire.ts`) so the rest of the app keeps the bare run ids it
 * was written against. Discovery is read at major 2 too and re-expressed in the
 * shape the consumers read by `capabilitiesV2Adapter.ts` (the v1 client that
 * used to serve it is gone; see the note on `getCapabilities`).
 *   `listMyRuns` reads the RFC 0182 `GET /runs` at major 2. `deleteRun`,
 *   `setRunPinned`, `getDebugBundle` and `listWorkflowRunCosts` are host
 *   surfaces with no v2 operation (or, for the last, no v2 field); they stay
 *   raw fetches on the host routes.
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
import { adaptV2Capabilities, type HostCapabilities } from './capabilitiesV2Adapter.js';
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
let capsCache: { value: HostCapabilities; at: number } | null = null;
let capsInFlight: Promise<HostCapabilities> | null = null;
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

export async function getCapabilities(): Promise<HostCapabilities> {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) return capsCache.value;
  if (capsInFlight) return capsInFlight;
  const generation = capsGeneration;
  capsInFlight = (async () => {
    try {
      // CORRECTED 2026-09-18, then RE-MOVED 2026-09-28. C.3 moved this read to
      // the v2 root with the consumers still reading v1 paths, and shipped five
      // silent UI regressions (each consumer fails into a `catch` that renders
      // nothing). It was moved back to v1 and the gaps named: demoMode and
      // hostSurfaces live in `extensions`, v2 drops every `supported` flag, and
      // `memory` / `envelopes` / `aiProviders.input` had no v2 family yet.
      //
      // Those families exist at major 2 now, and the shape difference is owned
      // in ONE place, `adaptV2Capabilities`, instead of in fourteen consumers.
      // What makes this move different from C.3 is the gate, not the intent:
      // `test/discovery-v2-adapter-parity.test.ts` (backend) serves BOTH
      // majors from one host and asserts every consumer-read path comes out of
      // the adapter with the value v1 gave it. A new consumer read belongs in
      // that test's path list.
      const value = adaptV2Capabilities(await client.discovery.capabilities());
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

export interface RunRetention { pinned: boolean; removalAt?: string }

/** Read a run's retention pin and sweep deadline (ADR 0812 — host-extension
 *  `GET /host/openwop-app/runs/{runId}/pin`). The major-2 RunSnapshot is closed
 *  and carries neither field, so `getRun` can never answer these. */
export async function getRunRetention(runId: string): Promise<RunRetention> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/runs/${encodeURIComponent(runId)}/pin`, {
    headers: authedHeaders(),
    credentials: config.authMode === 'cookie' ? 'include' : 'same-origin',
  });
  if (!res.ok) throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `Retention read failed (${res.status})` });
  const body = (await res.json()) as { pinned?: boolean; removalAt?: string };
  return { pinned: body.pinned === true, ...(body.removalAt ? { removalAt: body.removalAt } : {}) };
}

/** Fetch the debug bundle for a run per `spec/v1/debug-bundle.md`.
 *  Routes through the published SDK's `client.runs.debugBundle()`
 *  (parity row SDK-4, closed 2026-05-15 — see `sdk/PARITY.md`).
 *  The SDK returns `null` when the host doesn't advertise
 *  `capabilities.debugBundle.supported: true`; we throw a typed error
 *  in that case so the calling button can surface a "not supported"
 *  message instead of saving a `null.json` file. */
/** The debug-bundle document, served by the host-extension twin (ADR 0730 C.1). */
export interface DebugBundle {
  bundleVersion: string;
  generatedAt: string;
  host: { name?: string; version?: string; vendor?: string };
  run: Record<string, unknown>;
  events: ReadonlyArray<Record<string, unknown>>;
  redactionApplied: boolean;
  redactionMode: 'mask' | 'omit' | 'hash' | 'passthrough';
  truncated?: boolean;
  truncatedReason?: string;
  [key: string]: unknown;
}

export async function getDebugBundle(runId: string): Promise<DebugBundle> {
  // ADR 0730 C.1 — the HOST-EXTENSION twin, not the v1 SDK client. The operation
  // has no v2 path (absent from the 43-path manifest), so `/host/openwop-app/…`
  // is its home through the overlap and after it. The bare run id is correct here: host-extension
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
  // RFC 0182 — the normative `GET /runs` at major 2. It used to read the host
  // alias, which ADR 0654 kept only because major 2 had no list operation then.
  //
  // A RAW fetch, not `client.runs.list()`, for one reason: the SDK method takes
  // no AbortSignal, and the signal is load-bearing here (GAP-ANALYSIS E15: an
  // unmounted tile must cancel its read rather than burn the per-IP budget).
  // The wire is identical: unversioned path, `OpenWOP-Version: 2.0`, and every
  // row passes `unbindRunIds` like every other major-2 result.
  //
  // v2 pages are clamped to `runList.maxPageSize` (100) and chained by an
  // opaque `nextCursor`, where the alias returned up to 200 at once. The runs
  // page grows its limit by 20 per "load more" without bound, so this walks
  // the cursor until it has `limit` rows or the list ends.
  //
  // Rows carry no `costByNode`: that is a host-extension stamp the closed v2
  // snapshot does not admit. Its one reader uses `listWorkflowRunCosts` below.
  const want = opts.limit ?? 50;
  const rows: RunListItem[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    // ADR 0482 review M2 — server-side workflow filter so "this workflow's
    // latest run" never depends on the tenant's global recent-runs page.
    if (opts.workflowId) params.set('workflowId', opts.workflowId);
    params.set('limit', String(Math.min(want - rows.length, RUN_LIST_PAGE_MAX)));
    if (cursor) params.set('cursor', cursor);
    const body = await readRunList(`${config.baseUrl}/runs?${params.toString()}`, { 'OpenWOP-Version': '2.0' }, opts.signal);
    rows.push(...unbindRunIds((body as { runs: RunListItem[] }).runs));
    cursor = typeof (body as { nextCursor?: unknown }).nextCursor === 'string' ? (body as { nextCursor: string }).nextCursor : undefined;
  } while (cursor && rows.length < want);
  return rows.slice(0, want);
}

/** `runList.maxPageSize` as this host advertises it; a page request above it is clamped anyway. */
const RUN_LIST_PAGE_MAX = 100;

/**
 * ADR 0482 §6 — the terminal per-node cost stamp, for the builder's cost paint.
 * A HOST-EXTENSION read on purpose: `costByNode` is not a v2 snapshot field, so
 * the normative list cannot carry it, and moving this caller to `listMyRuns`
 * would make the paint silently vanish (the ADR 0730 C.3 failure class).
 */
export async function listWorkflowRunCosts(workflowId: string, limit = 25): Promise<RunListItem[]> {
  const params = new URLSearchParams({ workflowId, limit: String(limit) });
  const body = await readRunList(`${config.baseUrl}${VENDOR_BASE}/runs?${params.toString()}`, {});
  return (body as { runs: RunListItem[] }).runs;
}

async function readRunList(url: string, extra: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const headers = authedHeaders({ accept: 'application/json', ...extra });
  const includeCreds = config.authMode === 'cookie' || Boolean(headers.authorization);
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: includeCreds ? 'include' : 'same-origin',
    // AbortSignal threaded from the caller's effect cleanup (GAP-ANALYSIS E15)
    // so an in-flight read is cancelled on unmount rather than completing and
    // burning the per-IP budget.
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `listMyRuns failed: ${res.status} ${res.statusText}` });
  }
  // Validate the list shape before the cast (A-2 / E4).
  const body: unknown = await res.json();
  assertArrayField(body, 'runs', 'listMyRuns response');
  return body;
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
