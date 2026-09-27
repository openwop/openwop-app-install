/**
 * Connection credential injection at the HTTP egress seam (ADR 0024 §4 / D1,
 * Option C). The host's `ctx.http.safeFetch` (RFC 0076 §B) attaches the run's
 * acting human's credential to an outbound call — host-side, AFTER the pack's
 * `sanitizeHeaders` stripped any author-supplied `Authorization`, never via
 * workflow `config.headers` (D1).
 *
 * OPT-IN + DOUBLE GATE (Option C, ratified by /architect):
 *   1. The run consents by allow-listing providers in `configurable.connections`
 *      (`["google", …]`); this fn is only built for such runs.
 *   2. The token attaches ONLY when the outbound URL's host matches a HOST-CURATED
 *      `ProviderManifest.apiHosts` for an allow-listed provider — an eTLD+1
 *      boundary match (exact or subdomain), NEVER substring. An author-supplied
 *      URL cannot widen the manifest, so a token can only reach the provider's
 *      real hosts (`https://attacker.com` ⇒ no injection).
 *   3. The credential is resolved as the run's `actingUserId` (the broker enforces
 *      `connections:use` for org connections, fail-closed).
 *
 * SECURITY: token only over https; a token-bearing request MUST NOT follow a
 * redirect (could resend `Authorization` to another host); SSRF defense reuses
 * the audited RFC 0093 guard (denied-range predicate + pinned-resolution
 * dispatcher) — never reimplemented. The token never lands in `ctx.config`, an
 * event, the run doc, or a log.
 */

import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch, type Agent } from 'undici';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { HostSafeFetch } from '../executor/types.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { isDeniedWebhookHost, makeGuardedAgent, safeFetchPrivateEgressAllowed } from './webhookEgressGuard.js';
import { assertEffectAllowed } from './runEffectContext.js';
import { scrubSecretShaped } from './redactSecrets.js';
import { extractToolErrorCode } from './toolHooks.js';
import { getEventLog } from '../executor/eventLog.js';

const log = createLogger('connections.inject');

/**
 * `httpClient` clamps — the SINGLE source of truth shared by the enforcement
 * here and the `/.well-known/openwop` `capabilities.httpClient` advertisement
 * (routes/discovery.ts). Advertise/enforce MUST agree (the repo-wide rule);
 * `test/safefetch-hardening.test.ts` pins the pairing.
 */
export const SAFE_FETCH_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB
export const SAFE_FETCH_REQUEST_TIMEOUT_MS = 30_000;

let safeFetchAgent: Agent | null = null;
function safeFetchDispatcher(): Agent {
  // ADR 0531/0533 — THE replay effect seam for `ctx.http.safeFetch`, and the
  // reason this getter carries the guard rather than the cached Agent.
  //
  // CORRECTION (found deriving the replay.md req-4 floor): this guard was
  // MISSING, and `webhookEgressGuard.ts` claimed the opposite — its docblock
  // said `ctx.http.safeFetch` "calls this function INLINE in the fetch init"
  // and named leaving safeFetch unguarded during a replay as "a fail-open hole
  // in precisely the paths a pack node can reach". It did not pass
  // `webhookEgressDispatcher()`; it passes THIS dispatcher, built by
  // `makeGuardedAgent`, which shares the SSRF posture and nothing else. So the
  // hole the comment described as closed was open on the single widest path a
  // pack node has: ten `core.openwop.http.*` nodes declare `role:
  // "side-effect"` in their manifest, route through `ctx.http.safeFetch`, and
  // are absent from `SIDE_EFFECTING_TYPE_PATTERNS` (only `http.fetch` is
  // listed) — so a replay fork re-executed all ten with neither mechanism in
  // the way. Of the ten, `openapi-call` is the one that ships in chains (four:
  // people-hr, data-ops, exec-ops, marketing) and it issues arbitrary REST
  // including POST/PUT/DELETE, so that is the live radius; the other nine are
  // reachable only from a user-authored workflow. Same shape as ADR 0563's
  // blob-put, with BOTH the fast path and the backstop absent rather than one.
  //
  // The `run-effect-context.test.ts` tripwire could not catch it: it scanned
  // for `const x = webhookEgressDispatcher()`, and this site hoists an Agent
  // from a DIFFERENT factory. Widened there to bind the property that matters —
  // every `dispatcher:` getter must reach `assertEffectAllowed`.
  //
  // Caching the Agent is still correct (connection reuse of an already-validated
  // address); only the guard must not be cached with it.
  assertEffectAllowed('network-egress', 'ctx.http.safeFetch');
  if (!safeFetchAgent) {
    safeFetchAgent = makeGuardedAgent({
      maxResponseSize: SAFE_FETCH_MAX_RESPONSE_BODY_BYTES,
      headersTimeout: SAFE_FETCH_REQUEST_TIMEOUT_MS,
      bodyTimeout: SAFE_FETCH_REQUEST_TIMEOUT_MS,
      // The connect-time SSRF guard honors safeFetch's OWN relaxation flag —
      // NOT the webhook worker's — so a boot that relaxes webhook delivery
      // (loopback subscriber) keeps the advertised safeFetch guard active.
      allowPrivate: safeFetchPrivateEgressAllowed,
    });
  }
  return safeFetchAgent;
}

/**
 * §host.http requires safeFetch to REFUSE a `Connection: upgrade` attempt (no
 * 101 socket-hijack escape from the guarded dispatcher). Headers may arrive as
 * a record, an entries array, or a Headers instance — normalize and check both
 * the `Connection` token list and a bare `Upgrade` header.
 */
function hasUpgradeIntent(headers: unknown): boolean {
  const entries: Array<[string, string]> = [];
  if (!headers) return false;
  if (typeof (headers as Headers).forEach === 'function' && !(Array.isArray(headers))) {
    (headers as Headers).forEach((v, k) => entries.push([k, v]));
  } else if (Array.isArray(headers)) {
    for (const pair of headers as Array<[string, string]>) {
      if (Array.isArray(pair) && pair.length >= 2) entries.push([String(pair[0]), String(pair[1])]);
    }
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) entries.push([k, String(v)]);
  }
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (key === 'upgrade') return true;
    if (key === 'connection' && v.toLowerCase().split(',').some((t) => t.trim() === 'upgrade')) return true;
  }
  return false;
}

/** Content-free RFC 0064 audit-pair emission for one `ctx.http.safeFetch`
 *  invocation (host-capabilities.md §host.http: when `toolHooks.prePostEvents`
 *  + `httpClient.safeFetch` are both advertised, EVERY call — including a
 *  blocked one — MUST land a `agent.toolCalled`/`agent.toolReturned` pair,
 *  `transport: "http"`, in the durable run event log). No URL, headers, or
 *  body ever enter the payload (content-free per RFC 0064 §B). */
const SAFE_FETCH_TOOL = 'ctx.http.safeFetch';
const SAFE_FETCH_AGENT_ID = 'openwop-app.host.http';

async function emitToolCalled(runId: string): Promise<string> {
  const callId = randomUUID();
  await getEventLog().append({
    runId,
    type: 'agent.toolCalled',
    payload: { agentId: SAFE_FETCH_AGENT_ID, toolName: SAFE_FETCH_TOOL, callId, transport: 'http' },
  });
  return callId;
}

async function emitToolReturned(runId: string, callId: string, status: 'ok' | 'forbidden' | 'error', error?: { code: string; message: string }): Promise<void> {
  await getEventLog().append({
    runId,
    type: 'agent.toolReturned',
    // RFC 0064 §E — a `status:'error'` return MUST carry `error` populated (a bare
    // `status:'error'` is a failure a consumer cannot tell from an empty success).
    // `error` ⊥ `outcome`; this path never sets `outcome`. `message` is SR-1-redacted.
    // `transport` rides `agent.toolCalled` only (RFC 0064; `agentToolReturned` declares no such key).
    payload: { agentId: SAFE_FETCH_AGENT_ID, toolName: SAFE_FETCH_TOOL, callId, status, ...(error ? { error } : {}) },
  });
}

/**
 * Does `requestHost` belong to `apiHost` at an eTLD+1 boundary? True iff it is
 * exactly `apiHost` or a subdomain (`*.apiHost`). Rejects substring spoofs like
 * `googleapis.com.evil.com`. (The security-critical predicate — unit-tested.)
 */
export function hostMatchesApi(requestHost: string, apiHost: string): boolean {
  const h = requestHost.toLowerCase().replace(/\.$/, '');
  const a = apiHost.toLowerCase().replace(/\.$/, '');
  return h === a || h.endsWith(`.${a}`);
}

/** The first allow-listed provider whose curated apiHosts match this URL host.
 *  `adapterOnly` providers (ADR 0292 — e.g. `bigquery-write`, a GOVERNED write) are SKIPPED:
 *  they are reachable only through their host adapter's `brokeredPost` (approval-gated), never
 *  the generic `ctx.http.safeFetch` — otherwise an opted-in run could POST the governed write
 *  ungated through `core.openwop.http.fetch`, defeating the ADR 0028 separation-of-duty gate. */
function matchAllowedProvider(requestHost: string, allowed: readonly string[]): string | null {
  for (const provider of allowed) {
    const manifest = getProvider(provider);
    if (!manifest || manifest.adapterOnly) continue;
    const hosts = manifest.apiHosts;
    if (hosts && hosts.some((ah) => hostMatchesApi(requestHost, ah))) return provider;
  }
  return null;
}

export interface ConnectionEgressDeps {
  storage: Storage;
  tenantId: string;
  runId: string;
  /** The acting human (run.metadata.actingUserId). Absent ⇒ system run ⇒ the
   *  broker withholds user/org connections (fail-closed). */
  actingUserId?: string;
  /** Org context for the resolver (the workspace-root org; org connections + the
   *  connections:use gate resolve against it). */
  orgId?: string;
  /** Providers the run consented to (run.configurable.connections). */
  allowedProviders: readonly string[];
}

/** Build the per-run `ctx.http.safeFetch`. Provided only for opted-in runs, so
 *  non-Connections runs keep the pack's own egress fallback unchanged. */
export function makeConnectionSafeFetch(deps: ConnectionEgressDeps): HostSafeFetch {
  return async (rawUrl, init = {}) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`invalid URL: ${rawUrl}`);
    }

    // RFC 0064 content-free audit — the `agent.toolCalled` half of the pair is
    // appended BEFORE any egress effect (audit-before-effect), and the
    // `agent.toolReturned` half lands on EVERY exit path below (ok / blocked /
    // network error). §host.http makes the pair a MUST once
    // `httpClient.safeFetch` + `toolHooks.prePostEvents` are co-advertised.
    const callId = await emitToolCalled(deps.runId);

    // §host.http — refuse a `Connection: upgrade` attempt outright (a 101
    // switch would hand the pack a raw socket outside the guarded dispatcher).
    if (hasUpgradeIntent(init.headers)) {
      await emitToolReturned(deps.runId, callId, 'forbidden');
      throw new Error('connection upgrade refused: ctx.http.safeFetch does not permit protocol upgrades');
    }

    // SSRF (RFC 0093): reject a denied hostname up front; the pinned dispatcher
    // re-validates the resolved address at connect time (anti-rebinding TOCTOU).
    // Gated on safeFetch's OWN relaxation flag (default off) so the advertised
    // guard is never weakened by the webhook worker's ALLOW_PRIVATE.
    if (!safeFetchPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
      await emitToolReturned(deps.runId, callId, 'forbidden');
      throw new Error(`destination blocked: ${url.hostname}`);
    }

    // The pack hands a plain, already-sanitized headers object (Authorization
    // stripped). Copy it, then host-inject the credential on top.
    const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    let injected = false;

    // Tokens go over https only — EXCEPT when private egress is explicitly
    // enabled (local dev / tests), where loopback http is allowed. Production
    // (env unset) stays strictly https.
    const transportOk = url.protocol === 'https:' || safeFetchPrivateEgressAllowed();
    const provider = transportOk ? matchAllowedProvider(url.hostname, deps.allowedProviders) : null;
    if (provider) {
      const resolved = await resolveConnectionCredential({
        tenantId: deps.tenantId,
        provider,
        ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
        ...(deps.orgId ? { orgId: deps.orgId } : {}),
      });
      if (resolved && (resolved.connection.kind === 'oauth2' || resolved.connection.kind === 'bearer')) {
        headers.authorization = `Bearer ${resolved.secret}`;
        injected = true;
        await stampConnectionUse(deps.storage, deps.runId, resolved.provenance);
      } else if (resolved) {
        // api_key/basic carry provider-specific header shapes — deferred (v1
        // auto-injects oauth2/bearer only); the connection still exists + works
        // via an explicit author header if they have the secret out-of-band.
        log.info('connection matched but kind is not auto-injectable in v1', { provider, kind: resolved.connection.kind });
      }
    }

    // Wall-clock request timeout (`httpClient.requestTimeoutMs`): compose the
    // caller's signal (if any) with the host clamp so neither can widen the other.
    const timeoutSignal = AbortSignal.timeout(SAFE_FETCH_REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

    try {
      const res = await undiciFetch(rawUrl, {
        ...init,
        headers,
        signal,
        // Dedicated guarded dispatcher: SAME pinned-resolution SSRF lookup as the
        // webhook dispatcher, plus the advertised response-body ceiling + timeouts
        // (`httpClient.maxResponseBodyBytes` — advertise/enforce agree by sharing
        // the exported constants above).
        dispatcher: safeFetchDispatcher(),
        // A token-bearing request must not follow a redirect (it could resend the
        // Authorization to another host). Un-injected calls keep default behavior.
        ...(injected ? { redirect: 'error' as const } : {}),
      });
      await emitToolReturned(deps.runId, callId, 'ok');
      return res;
    } catch (err) {
      // Connect-time guard denial (pinned resolution landed in a denied range —
      // the DNS-rebinding defeat) is a policy refusal; anything else is a plain
      // network error. Both still complete the audit pair.
      const cause = (err as { cause?: { code?: string } }).cause;
      const denied = cause?.code === 'OPENWOP_WEBHOOK_EGRESS_DENIED'
        || (err as { code?: string }).code === 'OPENWOP_WEBHOOK_EGRESS_DENIED';
      await emitToolReturned(
        deps.runId, callId, denied ? 'forbidden' : 'error',
        // RFC 0064 §E — a plain network failure (not an egress-policy refusal) is a
        // ran-and-threw error: populate `error` so it is not an empty success. A
        // `forbidden` gate carries no `error` (it never left the host).
        denied ? undefined : { code: extractToolErrorCode(err), message: scrubSecretShaped(err instanceof Error ? err.message : String(err)) },
      );
      throw err;
    }
  };
}

export interface ConnectionUseProvenance {
  connectionId: string;
  provider: string;
  [k: string]: unknown;
}

/**
 * Stamp RFC 0079 provenance onto `run.metadata.connectionUse[]` (ADR 0024 D2 —
 * "which human used which org credential, for what"). Best-effort + deduped by
 * connectionId; a read-modify-write race across parallel nodes is acceptable at
 * sample scale (worst case: one duplicate stamp dropped). Replay-safe — read
 * verbatim on `:fork`, never recomputed. Shared by every broker consumer (the
 * http egress seam + the integration adapters).
 */
export async function stampConnectionUse(storage: Storage, runId: string, prov: ConnectionUseProvenance): Promise<void> {
  try {
    const run = await storage.getRun(runId);
    if (!run) return;
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const uses = Array.isArray(meta.connectionUse) ? (meta.connectionUse as ConnectionUseProvenance[]) : [];
    if (uses.some((u) => u.connectionId === prov.connectionId)) return;
    // Single-key atomic merge (grade-code H2): this can no longer clobber a
    // concurrent writer's OTHER metadata keys (the terminal cost stamp, the
    // retention pin). Two simultaneous appends to connectionUse itself remain
    // last-writer-wins on this one key — the pre-existing ADR 0024 residual;
    // an array-append storage primitive is the recorded follow-on.
    await storage.mergeRunMetadata(runId, { connectionUse: [...uses, prov] });
  } catch (err) {
    log.warn('connectionUse stamp failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}
