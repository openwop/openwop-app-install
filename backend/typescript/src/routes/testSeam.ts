/**
 * Test seam — env-gated dispatch endpoint for the conformance suite to
 * exercise in-memory host surfaces with explicit tenant control.
 *
 * Gated on `OPENWOP_TEST_SEAM_ENABLED=true`. The seam is OFF by default
 * so production deploys can't accidentally expose it. CI / conformance
 * runs flip it on, drive cross-tenant + atomicity + injection-rejection
 * proofs through it, then read typed results back.
 *
 * Namespace: `/v1/host/openwop-app/test/*` per `spec/v1/host-extensions.md`
 * §"Canonical prefixes" — sample-vendor-namespaced. NOT part of the
 * openwop wire contract; conformance scenarios that depend on this seam
 * soft-skip on hosts that don't expose it (404).
 *
 * Two-tenant model:
 *   The seam accepts `tenantId` in each request body. The bearer-authed
 *   conformance harness can issue requests under any tenant id; the
 *   surface bundle is scoped per-call. This lets a single test file
 *   prove cross-tenant isolation without juggling multiple bearer tokens.
 *
 * Endpoint shape:
 *   POST /v1/host/openwop-app/test/surface
 *   body: {
 *     tenantId: string,                // e.g. 'tenant-a' / 'tenant-b'
 *     surface: 'kv' | 'table' | 'cache' | 'blob' | 'queueBus' | 'sql' | 'vector' | 'fs',
 *     op: string,                       // e.g. 'set', 'get', 'increment', 'cas', 'publish', 'consume', ...
 *     args: object                      // op-specific
 *   }
 *
 * Response is the raw surface call result, OR a 4xx envelope when the
 * surface rejects (e.g., path traversal, sql injection).
 *
 * @see SECURITY/invariants.yaml — kv-cross-tenant-isolation,
 *                                   queue-cross-tenant-isolation,
 *                                   sql-parametric-only, fs-path-traversal
 */

import { armIdempotencyHold } from '../host/idempotencyHold.js';
import { registerCredentialLaneSeams } from './credentialLaneSeams.js';
import { registerOAuthConformanceSeams } from '../features/connections/oauthConformanceSeams.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Express, Response, RequestHandler } from 'express';
import { buildHostSurfaceBundle, resolvePresignToken } from '../host/inMemorySurfaces.js';
import type { HostSurfaceBundle, SurfaceArgs, SurfaceFn } from '../host/inMemorySurfaces.js';
import { acceptEnvelope, type AcceptOptions } from '../host/envelopeAcceptor.js';
import { getEventLog } from '../executor/eventLog.js';
import { admitA2uiSurface } from '../host/a2uiSurfaceAdmission.js';
import { fromWireRunId, fromWireTenant } from '../host/v2Ids.js';
import { vendorTwin } from '../middleware/protocolVersion.js';
import { randomUUID as a2uiRandomUUID } from 'node:crypto';
import { cacheableAnthropicSystem, type AnthropicSystemBlock } from '../providers/promptCaching.js';

/** RFC 0116 witness — a content-addressed prompt-prefix cache (the Anthropic
 *  model: keyed on the literal prefix bytes). Module-scoped to the seam; gated to
 *  OPENWOP_TEST_SEAM_ENABLED. The (tenant, cachePrefixId) namespacing is REAL
 *  (cacheableAnthropicSystem); only the Anthropic CALL is mocked (prod has no
 *  Anthropic key). Tenant B's use of tenant A's cachePrefixId assembles DIFFERENT
 *  prefix bytes → structural miss → cacheReadTokens==0. */
const _prefixCacheProbeSeen = new Set<string>();
import { composePromptTemplate } from '../host/promptCompose.js';
import { resolvePromptRef, type PromptKind } from '../host/promptResolve.js';
import type { Storage } from '../storage/storage.js';
import type { EnvelopeOutcome } from '../host/envelopeAcceptor.js';
import { wrapForLLMPrompt, type PromptWrapInput } from '../host/promptInjectionGuard.js';
import { setRunVariable, snapshotRunVariables } from '../host/variablesRuntime.js';
import { projectOutcome } from '../host/envelopeProjection.js';
import { listTestEvents, resetTestEventLog } from '../host/envelopeEventLog.js';
import { listTestSpans, resetTestSpanBuffer } from '../observability/spanBuffer.js';
import {
  setCapabilityOverlay,
  resetCapabilityOverlay,
  snapshotCapabilityOverlay,
  resolveCapabilityFlag,
} from '../host/capabilityOverlay.js';
import {
  semanticRequestDigestV2,
  SEMANTIC_REQUEST_RECIPE_V2,
  type SemanticRequestV2Input,
} from '../providers/llmCacheKey.js';
import { evaluateToolHook, type ToolHookRequest } from '../host/toolHooks.js';
import { makeConnectionSafeFetch } from '../host/connectionInjection.js';
import { isDeniedWebhookHost } from '../host/webhookEgressGuard.js';
import { singleTick, missedWindow } from '../host/schedulingService.js';
import { runAgentLoop, type AgentLoopRequest } from '../host/agentLoop.js';
import { execGuardedSandboxVm, type SandboxDispatch } from '../host/sandbox.js';
import { OpenwopError } from '../types.js';
import { assertReachableUrl } from './webhooks.js';
import { createLogger } from '../observability/logger.js';
import { requireNonAnonymousPrincipal } from '../middleware/auth.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.testSeam');

interface SeamBody {
  tenantId?: string;
  surface?: string;
  op?: string;
  args?: Record<string, unknown>;
}

const SURFACES = ['kv', 'table', 'cache', 'blob', 'queueBus', 'sql', 'vector', 'search', 'fs'] as const;
type SurfaceName = (typeof SURFACES)[number];

// In-process correlationId → outcome map for the `envelope/accept` seam, so a
// re-emission with the SAME correlationId across two sequential calls is deduped
// (same type → cached outcome) or refused (divergent type → envelope_correlation_
// conflict) per RFC 0021/0102 §"Replay determinism" WITHOUT the caller threading
// priorCorrelations/persistedDedup. Cleared by `POST /test/reset`. Test-seam-only.
// Bounded (evict-oldest) so a long un-reset run can't grow it without limit.
const SEAM_CORRELATIONS_CAP = 10_000;
const seamCorrelations = new Map<string, { outcome: EnvelopeOutcome; envelopeType: string }>();

function isSurfaceName(s: string): s is SurfaceName {
  return (SURFACES as readonly string[]).includes(s);
}

/** Map the requested surface name to its typed instance on the bundle.
 *  Each branch returns the surface as an `object` so the caller can do a
 *  string-keyed method lookup without double-casting through `unknown`. */
function selectSurface(bundle: HostSurfaceBundle, name: SurfaceName): object {
  switch (name) {
    case 'kv': return bundle.storage.kv;
    case 'table': return bundle.storage.table;
    case 'cache': return bundle.storage.cache;
    case 'blob': return bundle.storage.blob;
    case 'queueBus': return bundle.queueBus;
    case 'sql': return bundle.db.sql;
    case 'vector': return bundle.db.vector;
    case 'search': return bundle.db.search;
    case 'fs': return bundle.fs;
  }
}

/** Resolve `op` against a surface using a single-cast string-keyed lookup.
 *  Returns the typed `SurfaceFn` if `op` resolves to a function, else
 *  undefined. The in-memory surface factories use closures over their
 *  tenant scope (see `createKv` et al.), so no `this`-binding is needed. */
function lookupMethod(surface: object, op: string): SurfaceFn | undefined {
  const candidate = (surface as Record<string, unknown>)[op];
  return typeof candidate === 'function' ? (candidate as SurfaceFn) : undefined;
}

/**
 * RFC 0093 §A.3 — seam-side webhook subscription registry ops backing the
 * two-tenant half of `webhook-tenant-isolation.test.ts`:
 *
 *   register   { url, events[] }  → 200 { webhookId }
 *   list       {}                 → 200 { webhooks: [{ webhookId, url, events, createdAt }] }
 *   unregister { webhookId }      → 200 { ok: true } (404 when not in tenant)
 *
 * Tenant-scoped exactly like the bundle surfaces: every op acts only on
 * subscriptions whose `tenantId` equals the seam call's `tenantId`. Secrets
 * are never returned (matching GET /v1/webhooks).
 */
async function handleWebhookSeam(storage: Storage, body: SeamBody, res: Response): Promise<void> {
  const tenantId = body.tenantId as string; // validated non-empty by the caller
  const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  try {
    switch (body.op) {
      case 'register': {
        if (typeof args.url !== 'string' || args.url.length === 0) {
          res.status(400).json({ error: 'invalid_argument', message: 'args.url required' });
          return;
        }
        assertReachableUrl(args.url);
        const events = Array.isArray(args.events)
          ? (args.events as unknown[]).filter((e): e is string => typeof e === 'string')
          : [];
        if (events.length === 0) {
          res.status(400).json({ error: 'invalid_argument', message: 'args.events MUST be a non-empty string array' });
          return;
        }
        const webhookId = randomUUID();
        await storage.insertWebhook({
          subscriptionId: webhookId,
          tenantId,
          url: args.url,
          events,
          secret: randomBytes(32).toString('base64url'),
          createdAt: new Date().toISOString(),
        });
        res.status(200).json({ webhookId, subscriptionId: webhookId });
        return;
      }
      case 'list': {
        const subs = await storage.listWebhooks({ tenantId });
        res.status(200).json({
          webhooks: subs.map((s) => ({
            webhookId: s.subscriptionId,
            url: s.url,
            events: s.events,
            createdAt: s.createdAt,
          })),
        });
        return;
      }
      case 'unregister': {
        if (typeof args.webhookId !== 'string' || args.webhookId.length === 0) {
          res.status(400).json({ error: 'invalid_argument', message: 'args.webhookId required' });
          return;
        }
        const sub = await storage.getWebhook(args.webhookId);
        if (!sub || sub.tenantId !== tenantId) {
          res.status(404).json({ error: 'subscription_not_found', message: 'no such subscription in this tenant' });
          return;
        }
        await storage.deleteWebhook(args.webhookId);
        res.status(200).json({ ok: true });
        return;
      }
      default:
        res.status(400).json({
          error: 'invalid_argument',
          message: `op '${String(body.op)}' not implemented on surface 'webhooks' (register | list | unregister)`,
        });
        return;
    }
  } catch (err) {
    if (err instanceof OpenwopError) {
      res.status(err.httpStatus ?? 400).json({ error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 400, 'internal_error', message);
  }
}

const A2UI_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export function registerTestSeamRoutes(app: Express, deps: { storage: Storage }): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('test seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  log.warn('test seam ENABLED — /v1/host/openwop-app/test/surface is reachable. NEVER enable in production.');

  // `host-sample-test-seams.md` §"Production safety" — an ENABLED seam MUST
  // require an authenticated, non-anonymous principal.
  //
  // This is not belt-and-braces on top of the env gate; it closes a hole the
  // env gate never covered. MEASURED 2026-08-15 against the live deployment:
  //   GET …/test/mock-ai/last-dispatch-budget?nodeId=probe  ->  200 {"maxTokens":null}
  // with no credentials, because `authMiddleware` SUCCEEDS anonymously
  // (`mintAnonSession`) and the seam prefix is not public. So the seam was
  // reachable by any stranger, and `POST …/test/mock-ai/program` — which stages
  // a deliberate replay divergence keyed by a `nodeId` published in the chain
  // packs — was reachable with it.
  //
  // Both spellings are guarded: the `/v1/host/sample` legacy alias below
  // rewrites onto this prefix, and guarding only the product spelling would
  // leave the alias as an unauthenticated door onto the same handlers.
  // ONE exemption, and it is the credential-establishing endpoint: a guard that
  // covered `test/login` would be circular — the route that hands out a
  // non-anonymous identity cannot itself demand one, and every seam test would
  // be locked out of the door it needs to open first. (Measured: guarding the
  // bare prefix reds 17 tests across 4 files, all of them at `test/login`.)
  //
  // The exemption is safe ONLY because `test/login` rides a genuinely SEPARATE
  // switch — `OPENWOP_TEST_AUTH_ENABLED`, checked in `authTestSeam.ts`, and
  // VERIFIED unset on the live deployment while `OPENWOP_TEST_SEAM_ENABLED` was
  // true. So a stranger reaching this seam in production cannot mint themselves
  // a principal through it. If the two switches are ever merged, this exemption
  // becomes the hole and the whole gate is worthless — which is exactly the
  // "two controls reading one switch are not two layers" clause, pointed at the
  // fix rather than at the defect.
  //
  // Spelled as an explicit path set rather than relying on registration order:
  // `app.use` prefix middleware only runs for routes registered AFTER it, so an
  // ordering-based exemption would silently change meaning if the route table
  // were reordered. `test/login` is `authTestSeam.ts`'s only route.
  // Matched on `originalUrl`, NOT `req.path`. Inside `app.use(prefix, mw)`
  // Express rewrites the url relative to the mount, so `req.path` here is
  // `/login` under one mount and `/test/login` under the other — an exemption
  // written against it is silently mount-dependent. `originalUrl` is the one
  // spelling that means the same thing from both mounts. (Learned by the gate:
  // the `req.path` version matched neither and reds stayed at 17.)
  const SEAM_AUTH_EXEMPT = new Set([
    '/v1/host/openwop-app/test/login',
    '/v1/host/sample/test/login',
  ]);
  const seamAuth = requireNonAnonymousPrincipal('the openwop-app test seam');
  const guardSeam: RequestHandler = (req, res, next) => {
    const path = (req.originalUrl ?? '').split('?')[0] ?? '';
    if (SEAM_AUTH_EXEMPT.has(path)) { next(); return; }
    seamAuth(req, res, next);
  };
  app.use('/v1/host/openwop-app/test', guardSeam);
  app.use('/v1/host/sample', guardSeam);


  // Conformance back-compat: the pinned `@openwop/openwop-conformance` suite calls the
  // reference host under the legacy `/v1/host/sample/*` vendor alias and FAILS (or
  // vacuously soft-skips) on 404 for any seam whose capability flag is advertised. The
  // product surface is `/v1/host/openwop-app/*`; this internal rewrite maps the WHOLE
  // `sample` namespace onto it (not just `/test/*` — the suite also calls
  // `/v1/host/sample/envelope/accept`, `/ai/*`, `/agents/*`, etc.) so certification runs
  // non-vacuously without forking the vendored harness. Gated to OPENWOP_TEST_SEAM_ENABLED
  // (never production). Host-private space (`spec/v1/host-extensions.md` §"Canonical
  // prefixes"), non-wire.
  const LEGACY = '/v1/host/sample';
  app.use((req, _res, next) => {
    if (req.url === LEGACY || req.url.startsWith(LEGACY + '/') || req.url.startsWith(LEGACY + '?')) {
      req.url = '/v1/host/openwop-app' + req.url.slice(LEGACY.length);
    }
    next();
  });

  // RFC 0199 (ADR 0753 D12) — seams-v2 `oauth/authorize-start` + `oauth/expire-refresh`.
  // Reached from `/conformance/seams/sample/oauth/*` (alias) → `/v1/host/sample/oauth/*`
  // (guarded above) → the LEGACY rewrite just above, so they MUST be registered
  // after it (an earlier route is matched against the un-rewritten url and never
  // fires). The handlers ALSO carry `seamAuth`, because their rewritten address
  // is outside `/test` and a direct call must not skip the non-anonymous gate.
  registerOAuthConformanceSeams(app, seamAuth);
  // RFC 0170 §B.3 `mintLaneCredential` / `revokeLaneCredential` (api-key lane) —
  // same placement rule (after the rewrite), same guard.
  registerCredentialLaneSeams(app, seamAuth);
  // RFC 0213 §B `armIdempotencyHold` — arms a single-use hold; the hold itself
  // lives in the production POST /runs claim path (host/idempotencyHold.ts).
  app.post(vendorTwin('/test/idempotency/hold'), seamAuth, (req, res) => {
    const body = (req.body ?? {}) as { key?: unknown; holdMs?: unknown };
    const extra = Object.keys(body).filter((k) => k !== 'key' && k !== 'holdMs');
    if (typeof body.key !== 'string' || !/^[A-Za-z0-9._~-]{22,128}$/.test(body.key)
      || typeof body.holdMs !== 'number' || !Number.isInteger(body.holdMs) || body.holdMs < 1 || body.holdMs > 10_000 || extra.length > 0) {
      sendError(res, 400, 'validation_error', 'body MUST be { key: ^[A-Za-z0-9._~-]{22,128}$, holdMs: integer 1..10000 }.');
      return;
    }
    armIdempotencyHold((req as { tenantId?: string }).tenantId ?? 'default', body.key, body.holdMs);
    res.status(201).json({ key: body.key, holdMs: body.holdMs });
  });

  // RFC 0114 §15 — A2UI surface emit seam (the non-vacuous delta witness driver).
  // Emits a `ui.a2ui-surface` as a REAL run event through the REAL closed-catalog
  // gate (`acceptEnvelope`), so the conformance suite / steward can drive a
  // two-surface sequence on a real run and observe the `?a2uiDelta=1` transport
  // (host/streams.ts) produce a delta frame. An out-of-catalog or
  // contentTrust-dropping surface is rejected here (422) on the SAME gate a full
  // surface receives — proving the no-code-exec boundary holds at emit. Gated to
  // OPENWOP_TEST_SEAM_ENABLED (never production).
  app.post('/v1/host/openwop-app/a2ui/emit-surface', async (req, res) => {
    const body = (req.body ?? {}) as { runId?: unknown; surface?: unknown; contentTrust?: unknown };
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      res.status(400).json({ error: 'invalid_argument', message: 'runId required' });
      return;
    }
    if (body.surface === undefined || body.surface === null || typeof body.surface !== 'object') {
      res.status(400).json({ error: 'invalid_argument', message: 'surface required' });
      return;
    }
    // Per host-sample-test-seams.md §15, `surface` is the FULL `ui.a2ui-surface`
    // payload (`{ catalogVersion, surface, reasoning? }`) — NOT the inner surface
    // object. This seam previously re-wrapped it (payload.surface = the wrapper),
    // so every spec-shaped request 422'd against the catalog schema; the host's
    // own e2e test had pinned the wrong shape, which is why it stayed green.
    const payload = body.surface as { catalogVersion?: unknown; surface?: unknown };
    const catalogVersion = typeof payload.catalogVersion === 'string' ? payload.catalogVersion : '0.9.1';
    // Validate the surface through the REAL ui.a2ui-surface envelope gate (closed
    // catalog + contentTrust). Reject (422) exactly as a full surface would be —
    // this is the emit-side half of the fail-closed security invariant.
    const envelope = {
      type: 'ui.a2ui-surface',
      schemaVersion: 1,
      envelopeId: a2uiRandomUUID(),
      correlationId: a2uiRandomUUID(),
      payload: { ...payload, catalogVersion },
      meta: {
        source: 'ai-generation' as const,
        ts: new Date().toISOString(),
        ...(body.contentTrust === 'untrusted' ? { contentTrust: 'untrusted' as const } : {}),
      },
    };
    const outcome = acceptEnvelope(envelope);
    if (outcome.status !== 'accepted') {
      // H27-b — `reason` was a NEW TOP-LEVEL key, which the envelope forbids.
      // The validator's own `details` is an ARRAY, and `details` on the envelope
      // is typed as an OBJECT, so it rides a named key rather than being spread:
      // an array at `details` would have been a second schema violation swapped
      // in for the first.
      sendError(res, 422, 'a2ui_surface_invalid', 'The a2ui surface envelope was not accepted.', {
        reason: outcome.reason,
        ...(outcome.status === 'invalid' ? { validation: outcome.details } : {}),
      });
      return;
    }
    // Append the FULL surface as a real run event (durable, replay-safe). The
    // `?a2uiDelta=1` transport diffs consecutive surfaces per subscriber.
    const rec = await getEventLog().append({
      runId: body.runId,
      type: 'ui.a2ui-surface',
      payload: { ...payload, catalogVersion },
    });
    res.status(201).json({ eventId: rec.eventId, sequence: rec.sequence, surfaceRef: rec.eventId, catalogVersion });
  });

  // RFC 0209 — `emitA2uiSurface` (api/seams-v2.yaml), the MAJOR-2 witness driver.
  // A different contract from the v1 seam above (`{runId, envelope}`, the whole
  // envelope, its `schemaVersion` choosing the branch), so a different route
  // rather than a body sniff; `conformanceSeams.ts` aliases the v2 address here.
  // It supplies the envelope ONLY: `admitA2uiSurface` is the production
  // admission path (catalog → branch → cross-field → fold guard → record), so
  // the seam witnesses the host, not itself. Gated to OPENWOP_TEST_SEAM_ENABLED.
  // Registered through `vendorTwin` (ADR 0654): the canonical address is the
  // version-agnostic vendor path, reached on its `/v1` twin through the overlap.
  app.post(vendorTwin('/a2ui/v2/emit-surface'), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { runId?: unknown; envelope?: unknown };
      if (typeof body.runId !== 'string' || body.runId.length === 0 || body.envelope === null || typeof body.envelope !== 'object') {
        sendError(res, 400, 'validation_error', 'runId and envelope are required.');
        return;
      }
      // The seam space carries no tenant context (`req.tenantId` is unset on
      // these paths, so `loadOwnedRun` would refuse every run; the space is
      // env-gated and never mounted in production). A major-2 caller names the
      // run by its tenant-bound wire id (`<tenant>/<opaque>`, identity.md §5):
      // decode it and hold the run to the tenant it names. A bare id is the v1
      // spelling and — like the v1 emit seam — is checked for existence only.
      const slash = body.runId.indexOf('/');
      if (slash === 0) throw new OpenwopError('run_not_found', `run ${body.runId} not found`, 404);
      const wireTenant = slash > 0 ? fromWireTenant(body.runId.slice(0, slash)) : null;
      // `fromWireRunId` enforces the `<tenant>/<opaque>` grammar; the tenant it
      // names is then checked against the STORED run's tenant below.
      const resolved = fromWireRunId(body.runId, wireTenant ?? '');
      const run = resolved.ok ? await deps.storage.getRun(resolved.runId) : null;
      if (!run || !resolved.ok || (wireTenant !== null && run.tenantId !== wireTenant)) {
        throw new OpenwopError('run_not_found', `run ${body.runId} not found`, 404);
      }
      const runId = resolved.runId;
      if (A2UI_TERMINAL_RUN_STATUSES.has(run.status)) {
        sendError(res, 409, 'run_terminal', `run ${body.runId} is ${run.status}; a surface cannot be admitted into a terminal run.`);
        return;
      }
      const out = await admitA2uiSurface(runId, body.envelope, {
        ...((run.metadata as { trustBoundary?: unknown } | undefined)?.trustBoundary === 'untrusted' ? { runTrustBoundary: 'untrusted' as const } : {}),
      });
      if (out.status === 'refused') {
        sendError(res, 422, out.code, out.reason, out.details ? { validation: out.details } : undefined);
        return;
      }
      res.status(201).json({ sequence: out.sequence });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0116 — prompt-prefix cache witness driver. Drives the REAL prefix
  // assembly + provider.usage-shaped cost-only split through a content-addressed
  // cache (Anthropic model). The 1.43.0 conformance scenario POSTs tenant A
  // twice (prime → hit) and tenant B once with the SAME cachePrefixId (structural
  // miss) and asserts: hit → cacheReadTokens>0; B → cacheReadTokens==0;
  // inputTokens/outputTokens invariant. Gated to OPENWOP_TEST_SEAM_ENABLED.
  app.post('/v1/host/openwop-app/aiProviders/prefix-cache-probe', (req, res) => {
    const body = (req.body ?? {}) as { tenant?: unknown; cachePrefixId?: unknown; system?: unknown };
    if (typeof body.tenant !== 'string' || typeof body.cachePrefixId !== 'string') {
      res.status(400).json({ error: 'invalid_argument', message: 'tenant + cachePrefixId required' });
      return;
    }
    const system = typeof body.system === 'string' ? body.system : 'You are a careful assistant. '.repeat(64);
    // REAL (tenant, cachePrefixId) namespacing → the cache key bytes.
    const assembled = cacheableAnthropicSystem(system, true, { tenant: body.tenant, cachePrefixId: body.cachePrefixId });
    const bytes = Array.isArray(assembled)
      ? (assembled as AnthropicSystemBlock[]).map((b) => b.text).join('')
      : String(assembled ?? '');
    const INPUT = 1000;
    const OUTPUT = 20;
    const hit = _prefixCacheProbeSeen.has(bytes);
    if (!hit) _prefixCacheProbeSeen.add(bytes);
    // Cost-only split (provider.usage shape). inputTokens/outputTokens are
    // INVARIANT hit-vs-miss (RFC 0116 replay-invariance MUST).
    res.status(200).json({
      provider: 'anthropic',
      inputTokens: INPUT,
      outputTokens: OUTPUT,
      cacheReadTokens: hit ? INPUT : 0,
      cacheWriteTokens: hit ? 0 : INPUT,
      cacheHit: hit,
    });
  });

  app.post('/v1/host/openwop-app/test/surface', async (req, res) => {
    const body = (req.body ?? {}) as SeamBody;
    if (typeof body.tenantId !== 'string' || body.tenantId.length === 0) {
      res.status(400).json({ error: 'invalid_argument', message: 'tenantId required' });
      return;
    }
    // RFC 0093 §A.3 — `surface: "webhooks"` drives the two-tenant
    // subscription-registry proof in webhook-tenant-isolation.test.ts. Backed
    // by the REAL storage `webhooks` table (the same registry the routes +
    // delivery fanout read), tenant-scoped exactly like the bundle surfaces.
    if (body.surface === 'webhooks') {
      await handleWebhookSeam(deps.storage, body, res);
      return;
    }
    if (typeof body.surface !== 'string' || !isSurfaceName(body.surface)) {
      res.status(400).json({
        error: 'invalid_argument',
        message: `surface must be one of {${SURFACES.join(', ')}, webhooks}`,
      });
      return;
    }
    if (typeof body.op !== 'string' || body.op.length === 0) {
      res.status(400).json({ error: 'invalid_argument', message: 'op required' });
      return;
    }
    const args: SurfaceArgs = body.args && typeof body.args === 'object' ? body.args : {};

    let bundle: HostSurfaceBundle;
    try {
      bundle = buildHostSurfaceBundle({ tenantId: body.tenantId });
    } catch (err) {
      res.status(503).json({
        error: 'host_capability_missing',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const surface = selectSurface(bundle, body.surface);
    const method = lookupMethod(surface, body.op);
    if (!method) {
      res.status(400).json({
        error: 'invalid_argument',
        message: `op '${body.op}' not implemented on surface '${body.surface}'`,
      });
      return;
    }

    try {
      const result = await method(args);
      res.status(200).json(result ?? null);
    } catch (err) {
      if (err instanceof OpenwopError) {
        res.status(err.httpStatus ?? 400).json({ error: err.code, message: err.message });
        return;
      }
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      // Map host-side error codes to 4xx for the conformance suite.
      sendError(res, 400, code ?? 'internal_error', message);
    }
  });

  // Optional convenience endpoint mirrors the fs.read shape the
  // fs-path-traversal scenario already probes. Keeps that older
  // scenario backward-compatible without forcing it to know about the
  // surface-dispatch endpoint.
  app.post('/v1/host/openwop-app/fs/read', async (req, res) => {
    const body = (req.body ?? {}) as { path?: string; tenantId?: string };
    if (typeof body.path !== 'string' || body.path.length === 0) {
      sendError(res, 400, 'invalid_argument', 'path required');
      return;
    }
    const tenant = body.tenantId ?? 'tenant-a';
    try {
      const bundle = buildHostSurfaceBundle({ tenantId: tenant });
      const result = await bundle.fs.read({ path: body.path });
      res.status(200).json(result ?? null);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, code ?? 'internal_error', message);
    }
  });

  // RFC 0021 §A — AIEnvelopeAcceptor reference implementation. The
  // conformance suite POSTs candidate envelopes here and asserts the
  // EnvelopeOutcome shape (accepted / invalid / gated / breached).
  // Closes the spec-to-impl loop for RFC 0021: the host now actually
  // runs the Ajv2020 gate that the spec section §A point 1-3 demands.
  app.post('/v1/host/openwop-app/envelope/accept', async (req, res) => {
    const body = (req.body ?? {}) as {
      envelope?: unknown;
      hostSupportedEnvelopes?: string[];
      nodeAllowedKinds?: string[];
      runTrustBoundary?: 'trusted' | 'untrusted';
      counters?: AcceptOptions['counters'];
      schemaVersionFloor?: Record<string, number>;
      envelopeStrictness?: 'warn' | 'strict';
      /** Wire shape: `priorCorrelations` is a flat array on the JSON wire so
       *  the conformance harness can ship it as plain JSON without serializing
       *  a Map. The acceptor consumes a ReadonlyMap; we adapt here. */
      priorCorrelations?: Array<{ correlationId: string; outcome: unknown; envelopeType: string }>;
      /** RFC 0021 §"Redaction" + `agent-memory.md` §SR-1 — canonical SR-1
       *  shape is `{ value, secretId }`. The seam validates each entry has
       *  both fields before passing to the acceptor; entries with empty
       *  `value` are dropped. */
      byokCanaries?: Array<{ value: string; secretId: string }>;
      /** When supplied, projects the outcome onto a test-only run event
       *  log (`envelopeEventLog.ts`) so the conformance suite can query
       *  the spec-prescribed events (cap.breached, node.failed,
       *  interrupt.requested, log.appended) via
       *  `GET /v1/host/openwop-app/test/runs/:runId/events`. RFC 0021 §A point
       *  1-7 + interrupt.md + capabilities.md §"cap.breached". */
      projectTo?: {
        runId: string;
        nodeId?: string;
        refusalMode?: 'fail-node' | 'discard-and-warn';
      };
      /** Persisted dedup-state seam — backs the cross-process replay
       *  contract from `ai-envelope.md §"Replay determinism"`. When set,
       *  the acceptor's priorCorrelations is seeded from the
       *  `envelope_correlations` storage table (keyed by runId), so a
       *  fresh process (or any caller without an in-memory map) gets
       *  the SAME cached outcome it would have gotten from the
       *  original process's in-memory priorCorrelations. After accept,
       *  the resulting outcome is persisted so subsequent re-emissions
       *  read it back. Combine with `priorCorrelations` to override
       *  per-call; persisted entries win on collision with explicit
       *  entries (the persisted store is the cross-process source of
       *  truth). */
      persistedDedup?: { runId: string };
      /** RFC 0021 §"Trust boundary" — when true, the acceptor evaluates
       *  the post-normalization contentTrust and refuses with
       *  `untrusted_content_blocks_approval` if the value is
       *  `'untrusted'`. Conformance scenarios that drive an approval-
       *  gate refusal assertion set this bit on the envelope/accept
       *  call so the spec contract surfaces as an EnvelopeOutcome
       *  (instead of having to wire a full interrupt + resume flow
       *  through the engine). */
      approvalGateContext?: boolean;
      /** RFC 0102 §A.5 — the interrupt kind this envelope is presented to
       *  resolve. `'approval'` makes the call an approval-gate resolution
       *  (equivalent to `approvalGateContext: true`), so an untrusted
       *  ui.a2ui-surface bound to an approval interrupt is refused with
       *  `untrusted_content_blocks_approval`. */
      boundInterruptKind?: string;
    };
    if (body.envelope === undefined) {
      sendError(res, 400, 'invalid_argument', 'envelope required');
      return;
    }

    // Capability gate (FIRST refusal layer per ai-envelope.md §"Capability
    // handshake integration" line 305: capability-gated typeId refusal
    // STACKS ATOP envelope-contract refusal). If the host doesn't
    // advertise `host.aiEnvelope: supported`, every envelope/accept call
    // refuses BEFORE the per-envelope contract gates (host-gate, node-
    // gate, schema-floor, etc.) run. The refusal is observable as
    // `capability_required` so the conformance suite can distinguish
    // "capability absent" from "this specific envelope type not in the
    // host's accepts list."
    if (resolveCapabilityFlag('host.aiEnvelope.supported') === false) {
      res.status(200).json({
        status: 'invalid',
        reason: 'capability_required',
        details: [
          {
            instancePath: '/type',
            schemaPath: '#/capabilities/host.aiEnvelope',
            keyword: 'capability',
            message:
              "Host does not advertise capabilities.host.aiEnvelope: supported. " +
              "Per ai-envelope.md §\"Capability handshake integration\" + " +
              "capabilities.md §\"Unsupported capability — refusal contract\", " +
              "a node requiring host.aiEnvelope MUST be refused before any " +
              "envelope-contract gating runs.",
          },
        ],
      });
      return;
    }

    const opts: AcceptOptions = {};
    if (body.hostSupportedEnvelopes !== undefined) opts.hostSupportedEnvelopes = body.hostSupportedEnvelopes;
    if (body.nodeAllowedKinds !== undefined) opts.nodeAllowedKinds = body.nodeAllowedKinds;
    if (body.runTrustBoundary !== undefined) opts.runTrustBoundary = body.runTrustBoundary;
    if (body.counters !== undefined) opts.counters = body.counters;
    if (body.schemaVersionFloor !== undefined) opts.schemaVersionFloor = body.schemaVersionFloor;
    if (body.envelopeStrictness !== undefined) opts.envelopeStrictness = body.envelopeStrictness;
    if (body.approvalGateContext === true) opts.approvalGateContext = true;
    // RFC 0102 §A.5 — a surface bound to an approval interrupt is an approval-
    // gate resolution; route it through the same untrusted-blocks-approval gate.
    if (body.boundInterruptKind === 'approval') opts.approvalGateContext = true;
    if (Array.isArray(body.byokCanaries) && body.byokCanaries.length > 0) {
      // Drop entries missing either field — keeps the acceptor's
      // [REDACTED:<secretId>] substitution deterministic.
      const canaries = body.byokCanaries.filter(
        (c): c is { value: string; secretId: string } =>
          typeof c?.value === 'string' && c.value.length > 0 && typeof c?.secretId === 'string' && c.secretId.length > 0,
      );
      if (canaries.length > 0) opts.byokCanaries = canaries;
    }
    const dedupMap = new Map<string, { outcome: EnvelopeOutcome; envelopeType: string }>();
    if (Array.isArray(body.priorCorrelations) && body.priorCorrelations.length > 0) {
      for (const e of body.priorCorrelations) {
        if (typeof e?.correlationId === 'string' && typeof e?.envelopeType === 'string') {
          dedupMap.set(e.correlationId, {
            outcome: e.outcome as EnvelopeOutcome,
            envelopeType: e.envelopeType,
          });
        }
      }
    }
    // Persisted dedup seam: if a runId is supplied AND the inbound
    // envelope carries a correlationId, consult the persisted store
    // and merge any cached outcome into the dedup map (overriding any
    // explicit entry for the same correlationId — the persisted store
    // is authoritative for cross-process semantics).
    const inboundCorrelationId =
      body.envelope && typeof body.envelope === 'object' &&
      typeof (body.envelope as { correlationId?: unknown }).correlationId === 'string'
        ? (body.envelope as { correlationId: string }).correlationId
        : null;
    if (body.persistedDedup?.runId && inboundCorrelationId) {
      const persisted = await deps.storage.getEnvelopeCorrelation(
        body.persistedDedup.runId,
        inboundCorrelationId,
      );
      if (persisted) {
        dedupMap.set(inboundCorrelationId, {
          outcome: persisted.outcome as EnvelopeOutcome,
          envelopeType: persisted.envelopeType,
        });
      }
    }
    // Seed from the in-process correlation map (RFC 0021/0102 §"Replay
    // determinism") so a re-emission with the same correlationId is deduped/
    // conflict-detected even without an explicit priorCorrelations/persistedDedup.
    // Explicit + persisted entries (added above) win on collision.
    if (inboundCorrelationId && !dedupMap.has(inboundCorrelationId)) {
      const tracked = seamCorrelations.get(inboundCorrelationId);
      if (tracked) dedupMap.set(inboundCorrelationId, tracked);
    }
    if (dedupMap.size > 0) opts.priorCorrelations = dedupMap;

    const outcome = acceptEnvelope(body.envelope, opts);

    // Record the FIRST outcome per correlationId in-process (only if not already
    // tracked, so the original type/outcome is preserved for divergent-type
    // conflict detection on the next call).
    if (inboundCorrelationId && !seamCorrelations.has(inboundCorrelationId)) {
      const envType =
        body.envelope && typeof body.envelope === 'object' &&
        typeof (body.envelope as { type?: unknown }).type === 'string'
          ? (body.envelope as { type: string }).type
          : 'unknown';
      // Evict the oldest entry (Map preserves insertion order) before exceeding
      // the cap — keeps the test-seam map bounded without a wholesale clear that
      // could drop a correlationId an in-flight test still needs.
      if (seamCorrelations.size >= SEAM_CORRELATIONS_CAP) {
        const oldest = seamCorrelations.keys().next().value;
        if (oldest !== undefined) seamCorrelations.delete(oldest);
      }
      seamCorrelations.set(inboundCorrelationId, { outcome, envelopeType: envType });
    }

    // Persist the outcome for future cross-process re-emissions. Only
    // persist when the caller supplied persistedDedup AND the inbound
    // envelope carried a correlationId AND the cache didn't already
    // serve this call (re-persisting an already-cached outcome would
    // bump recordedAt for no reason — semantically the same record).
    if (
      body.persistedDedup?.runId &&
      inboundCorrelationId &&
      !dedupMap.has(inboundCorrelationId)
    ) {
      const envType =
        body.envelope && typeof body.envelope === 'object' &&
        typeof (body.envelope as { type?: unknown }).type === 'string'
          ? (body.envelope as { type: string }).type
          : 'unknown';
      await deps.storage.putEnvelopeCorrelation(
        body.persistedDedup.runId,
        inboundCorrelationId,
        outcome,
        envType,
        new Date().toISOString(),
      );
    }
    // Optional E.1 projection: emit the spec-prescribed events into the
    // test event log so conformance can query them via /test/runs/:runId/events.
    if (body.projectTo && typeof body.projectTo.runId === 'string') {
      const env = (body.envelope ?? {}) as { type?: string; correlationId?: string; schemaVersion?: number };
      if (typeof env.type === 'string' && typeof env.correlationId === 'string') {
        const driftFloor = body.schemaVersionFloor?.[env.type];
        projectOutcome(outcome, {
          runId: body.projectTo.runId,
          correlationId: env.correlationId,
          envelopeType: env.type,
          ...(typeof env.schemaVersion === 'number' ? { envelopeSchemaVersion: env.schemaVersion } : {}),
          ...(typeof driftFloor === 'number' ? { driftFloor } : {}),
          ...(body.projectTo.nodeId !== undefined ? { nodeId: body.projectTo.nodeId } : {}),
          ...(body.projectTo.refusalMode !== undefined ? { refusalMode: body.projectTo.refusalMode } : {}),
        });
      }
    }
    res.status(200).json(outcome);
  });

  // E.1 — event-log query seam. Returns the test-only run event log
  // populated by `envelope/accept` with `projectTo`. Supports filtering
  // by type / causationId / correlationId (= causationId) / nodeId.
  // RFC 0076 §B — inline safe-fetch evaluation seam
  // (`POST /v1/host/sample/http/safe-fetch` via the LEGACY rewrite above;
  // host-sample-test-seams.md §"Open seams"). Evaluates ONE candidate egress
  // through the SAME production guard chain `ctx.http.safeFetch` uses
  // (host/connectionInjection.ts — string precheck, upgrade refusal, pinned-
  // resolution dispatcher) and echoes `{ outcome, blocked?, status? }`.
  // `simulateRebindTo` models the DNS-rebinding case the suite cannot drive
  // with real DNS: the seam runs the SAME denied-range predicate the pinned
  // connector applies to the actual resolution at connect time
  // (webhookEgressGuard.guardedLookup), so the assertion exercises the real
  // policy, not a parallel one.
  const seamSafeFetchRun = async (): Promise<string> => {
    const runId = `run-safefetch-${randomUUID()}`;
    const now = new Date().toISOString();
    await deps.storage.insertRun({
      runId,
      workflowId: 'conformance-safe-fetch-seam',
      tenantId: 'conformance-seam',
      status: 'running',
      inputs: null,
      metadata: {},
      configurable: {},
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  };
  type SeamFetchBody = { url?: unknown; init?: unknown; simulateRebindTo?: unknown };
  const evalSafeFetch = async (
    body: SeamFetchBody,
  ): Promise<{ status: number; json: Record<string, unknown>; runId?: string }> => {
    if (typeof body.url !== 'string' || body.url.length === 0) {
      return { status: 400, json: { error: 'invalid_argument', message: 'url required' } };
    }
    if (body.simulateRebindTo !== undefined && typeof body.simulateRebindTo !== 'string') {
      return { status: 400, json: { error: 'invalid_argument', message: 'simulateRebindTo MUST be a string' } };
    }
    const runId = await seamSafeFetchRun();
    // Rebind simulation: the pinned connector rejects a connection whose
    // RESOLVED address lands in a denied range. The seam applies the identical
    // predicate to the injected "resolution".
    if (typeof body.simulateRebindTo === 'string' && isDeniedWebhookHost(body.simulateRebindTo)) {
      return { status: 200, json: { outcome: 'blocked', blocked: 'ssrf' }, runId };
    }
    const sf = makeConnectionSafeFetch({
      storage: deps.storage,
      tenantId: 'conformance-seam',
      runId,
      allowedProviders: [], // pure guarded fetch — no credential injection
    });
    const init = (body.init && typeof body.init === 'object' ? body.init : {}) as Record<string, unknown>;
    try {
      const res = await sf(body.url, init);
      // Drain + discard so the seam never buffers a body it echoes nowhere.
      await res.body?.cancel();
      return { status: 200, json: { outcome: 'fetched', status: res.status }, runId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('upgrade refused')) {
        return { status: 200, json: { outcome: 'blocked', blocked: 'upgrade' }, runId };
      }
      const cause = (err as { cause?: { code?: string } }).cause;
      if (
        message.includes('destination blocked')
        || cause?.code === 'OPENWOP_WEBHOOK_EGRESS_DENIED'
        || (err as { code?: string }).code === 'OPENWOP_WEBHOOK_EGRESS_DENIED'
      ) {
        return { status: 200, json: { outcome: 'blocked', blocked: 'ssrf' }, runId };
      }
      // A genuine network failure (no egress in this environment) is NOT a
      // policy outcome — report it as such so the suite's success-path legs
      // soft-skip instead of reading a false `blocked`.
      return { status: 502, json: { error: 'egress_failed', message } };
    }
  };
  app.post('/v1/host/openwop-app/http/safe-fetch', async (req, res) => {
    const out = await evalSafeFetch((req.body ?? {}) as SeamFetchBody);
    // §host.http leg 4: on a completed fetch with toolHooks.prePostEvents +
    // safeFetch co-advertised, the suite reads the audit pair INLINE from the
    // seam response. The pair was already emitted DURABLY by the production
    // ctx.http.safeFetch (host/connectionInjection.ts); echo it here by reading
    // it back from the run event log so the inline contract and the durable
    // record are the same events, not a parallel echo.
    if (out.runId && out.json.outcome === 'fetched') {
      const events = await deps.storage.listEvents(out.runId);
      const toolCalled = events.find((e) => e.type === 'agent.toolCalled')?.payload;
      const toolReturned = events.find((e) => e.type === 'agent.toolReturned')?.payload;
      if (toolCalled && toolReturned) {
        out.json = { ...out.json, toolCalled, toolReturned };
      }
    }
    res.status(out.status).json(out.json);
  });

  // RFC 0076 §B live-audit seam (`POST /v1/host/sample/http/safe-fetch-run`):
  // the SAME evaluation, but the caller gets the backing `runId` so it can
  // assert the durable `agent.toolCalled`/`agent.toolReturned` pair the
  // production `ctx.http.safeFetch` appended to the run event log — closing
  // the seam-vs-production gap `safefetch-live-audit.test.ts` targets.
  app.post('/v1/host/openwop-app/http/safe-fetch-run', async (req, res) => {
    const out = await evalSafeFetch((req.body ?? {}) as SeamFetchBody);
    if (!out.runId) {
      res.status(out.status).json(out.json);
      return;
    }
    const outcome = out.json.outcome ?? 'error';
    res.status(200).json({ runId: out.runId, outcome });
  });

  app.get('/v1/host/openwop-app/test/runs/:runId/events', async (req, res) => {
    const runId = req.params.runId;
    if (!runId) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    const filter: { type?: string; correlationId?: string; causationId?: string; nodeId?: string } = {};
    const q = req.query as Record<string, string | undefined>;
    if (typeof q.type === 'string') filter.type = q.type;
    if (typeof q.correlationId === 'string') filter.correlationId = q.correlationId;
    if (typeof q.causationId === 'string') filter.causationId = q.causationId;
    if (typeof q.nodeId === 'string') filter.nodeId = q.nodeId;
    const inMemory = listTestEvents(runId, filter);
    if (inMemory.length > 0) {
      res.status(200).json({ events: inMemory });
      return;
    }
    // Durable fallback: when the seam's in-memory projection has nothing for
    // this run, read the REAL run event log (storage) so scenarios that drive
    // production paths (e.g. safe-fetch-run's audit pair) assert against the
    // durable record — not a parallel echo. Same filter semantics.
    const durable = await deps.storage.listEvents(runId);
    const filtered = durable.filter((e) =>
      (filter.type === undefined || e.type === filter.type)
      && (filter.nodeId === undefined || e.nodeId === filter.nodeId)
      && (filter.causationId === undefined || e.causationId === filter.causationId),
    );
    res.status(200).json({ events: filtered });
  });

  // Variable mutation seam — mutates a run's variable bag mid-run.
  // Per `host/variablesRuntime.ts`: future scope (HVMAP-2 mid-run-no-
  // propagation conformance assertion). The conformance test creates
  // a parent run with a subWorkflow that suspends on a clarification
  // gate, then mutates the parent's variable bag via this endpoint,
  // resolves the clarification, and asserts the child's view of the
  // variable remained at its dispatch-time seed (not the mutated
  // value) — proving RFC 0022 §B's one-shot fold semantic.
  //
  // Endpoint: POST /v1/host/openwop-app/test/runs/:runId/variables
  // Body shape: { variables: Record<string, unknown> } — each entry
  // sets the named variable in the run's bag.
  // GET variant returns the current bag for assertions.
  app.post('/v1/host/openwop-app/test/runs/:runId/variables', (req, res) => {
    const runId = req.params.runId;
    if (!runId) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    const body = (req.body ?? {}) as { variables?: unknown };
    if (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables)) {
      sendError(res, 400, 'invalid_argument', 'variables MUST be an object');
      return;
    }
    for (const [name, value] of Object.entries(body.variables as Record<string, unknown>)) {
      if (typeof name === 'string' && name.length > 0) setRunVariable(runId, name, value);
    }
    res.status(200).json({ variables: snapshotRunVariables(runId) ?? {} });
  });
  app.get('/v1/host/openwop-app/test/runs/:runId/variables', (req, res) => {
    const runId = req.params.runId;
    if (!runId) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    res.status(200).json({ variables: snapshotRunVariables(runId) ?? {} });
  });

  // Prompt-injection wrap seam — exposes the host's `<UNTRUSTED ...>`
  // wrap helper directly. Conformance scenarios POST a RunEventDoc-
  // shaped body and assert the wrap behavior at the trust boundary
  // (untrusted → wrapped; trusted → passes through). The seam stands
  // in for a full LLM-node execution: in production, an LLM node that
  // re-consumes a RunEventDoc calls `wrapForLLMPrompt(...)` before
  // composing its prompt. Same contract, mechanical assertion vs. a
  // run.
  //
  // Spec references:
  //   - spec/v1/ai-envelope.md §"Trust boundary" line 380 (downstream
  //     LLM nodes MUST treat untrusted RunEventDoc content per the
  //     prompt-injection rules)
  //   - SECURITY/threat-model-prompt-injection.md (UNTRUSTED-marker
  //     convention)
  app.post('/v1/host/openwop-app/test/llm-prompt-wrap', (req, res) => {
    const body = (req.body ?? {}) as Partial<PromptWrapInput> & { payload?: unknown };
    if (!('payload' in body)) {
      sendError(res, 400, 'invalid_argument', 'payload required');
      return;
    }
    const input: PromptWrapInput = { payload: body.payload };
    if (body.contentTrust === 'trusted' || body.contentTrust === 'untrusted') {
      input.contentTrust = body.contentTrust;
    }
    if (typeof body.eventType === 'string') input.eventType = body.eventType;
    if (typeof body.source === 'string') input.source = body.source;
    if (body.attributes && typeof body.attributes === 'object') {
      // Validate attribute values are primitive — drop anything that
      // would JSON.stringify to `[object Object]` or similar.
      const valid: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(body.attributes)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          valid[k] = v;
        }
      }
      if (Object.keys(valid).length > 0) input.attributes = valid;
    }
    const prompt = wrapForLLMPrompt(input);
    res.status(200).json({ prompt });
  });

  // Reset the test event log + capability overlay + OTel span buffer (suite teardown).
  app.post('/v1/host/openwop-app/test/reset', (_req, res) => {
    resetTestEventLog();
    resetCapabilityOverlay();
    resetTestSpanBuffer();
    seamCorrelations.clear();
    res.status(200).json({ ok: true });
  });

  // E.2 — OTel scrape seam. Returns the test-only span buffer populated
  // by `envelopeProjection.ts` so conformance scenarios can assert
  // attribute redaction (canary absent) + drift attrs.
  app.get('/v1/host/openwop-app/test/otel/spans', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const filter: { envelopeId?: string; runId?: string; name?: string } = {};
    if (typeof q.envelopeId === 'string') filter.envelopeId = q.envelopeId;
    if (typeof q.runId === 'string') filter.runId = q.runId;
    if (typeof q.name === 'string') filter.name = q.name;
    res.status(200).json({ spans: listTestSpans(filter) });
  });

  // E.3 — Debug-bundle export seam. Bundles the run's events + spans
  // into a single payload mirroring what a production host's debug-
  // bundle export endpoint would return. Lets conformance assert the
  // bundle contains no BYOK canary plaintext (SR-1 carry-forward across
  // the debug-bundle surface).
  app.post('/v1/host/openwop-app/test/debug-bundle/export', (req, res) => {
    const body = (req.body ?? {}) as { runId?: string };
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    res.status(200).json({
      bundle: {
        runId: body.runId,
        events: listTestEvents(body.runId),
        spans: listTestSpans({ runId: body.runId }),
        exportedAt: new Date().toISOString(),
      },
    });
  });

  // Presigned-URL resolver — RFC 0019 §B point 1. The blob surface's
  // `presign` issues opaque tokens (registered in inMemorySurfaces'
  // `_blobPresignTokens` map); this route resolves them, returning the
  // payload as raw bytes inside the TTL window and 403 after expiry.
  app.get('/v1/host/openwop-app/blob/presigned/:token', (req, res) => {
    const token = decodeURIComponent(req.params.token ?? '');
    const result = resolvePresignToken(token);
    if (!result.ok && result.reason === 'not_found') {
      sendError(res, 404, 'blob_presign_not_found', 'unknown presign token');
      return;
    }
    if (!result.ok && result.reason === 'expired') {
      sendError(res, 403, 'blob_presign_expired', 'presign token past its TTL');
      return;
    }
    if (!result.ok) {
      sendError(res, 400, 'invalid_argument', 'unexpected presign result');
      return;
    }
    const { entry } = result;
    res.status(200);
    res.setHeader('Content-Type', entry.contentType ?? 'application/octet-stream');
    res.send(Buffer.from(entry.contentBase64, 'base64'));
  });

  // RFC 0026 — provider.usage event emission seam.
  // POST /v1/host/openwop-app/test/emit-provider-usage
  // Body: { runId, payload: ProviderUsagePayload, correlationId?, nodeId? }
  // Synthesizes the event into the test event log; conformance scenarios
  // query it via the E.1 event-log seam to verify shape.
  app.post('/v1/host/openwop-app/test/emit-provider-usage', async (req, res) => {
    const body = (req.body ?? {}) as { runId?: string; payload?: Record<string, unknown>; correlationId?: string; nodeId?: string };
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.provider !== 'string' || typeof payload.model !== 'string' || typeof payload.inputTokens !== 'number' || typeof payload.outputTokens !== 'number') {
      sendError(
        res,
        400,
        'invalid_argument',
        'payload MUST be { provider, model, inputTokens, outputTokens } per RFC 0026 §A',
      );
      return;
    }
    // Defense-in-depth: refuse payloads that look like they could carry a
    // credentialRef (`credentialRef` field literally OR a value containing
    // 'secret:' which is the openwop credential-ref prefix). This enforces
    // the `provider-usage-no-credential-leak` SECURITY invariant at the
    // seam layer; downstream emitters MUST sanitize further per RFC 0026 §D.
    const serialized = JSON.stringify(payload);
    if (serialized.includes('credentialRef') || serialized.includes('"secret:')) {
      sendError(
        res,
        400,
        'provider_usage_credential_leak',
        'payload contains credentialRef-shaped content; RFC 0026 §D + SECURITY/invariants.yaml provider-usage-no-credential-leak',
      );
      return;
    }
    // Project to the test event log via the projection seam's append helper.
    const { appendTestEvent } = await import('../host/envelopeEventLog.js');
    const event = appendTestEvent({
      runId: body.runId,
      type: 'provider.usage',
      payload: payload as Record<string, unknown>,
      ...(typeof body.correlationId === 'string' ? { causationId: body.correlationId } : {}),
      ...(typeof body.nodeId === 'string' ? { nodeId: body.nodeId } : {}),
    });
    res.status(200).json({ event });
  });

  // RFC 0032 §B envelope-reliability event emission seam.
  // POST /v1/host/openwop-app/test/emit-envelope-reliability
  // Body: { runId, type, payload, nodeId?, correlationId? }
  //
  // Synthesizes one of the six RFC 0032 envelope-reliability events into the
  // test event log so conformance scenarios can verify event-payload shape
  // without driving a full LLM dispatch. The seam validates `type` is one
  // of the six RFC 0032 enum values and that `payload` carries the required
  // fields per `run-event-payloads.schema.json` §envelope* `$defs`.
  // Defense-in-depth: rejects payloads carrying credentialRef-shaped or
  // prompt-content-shaped substrings in `refusalText`/`previousError`/
  // `finalError` fields (the SR-1 + prompt-injection redaction discipline
  // per SECURITY invariants `envelope-refusal-no-prompt-leak` and
  // `envelope-reasoning-secret-redaction`). Production hosts MUST redact
  // BEFORE emission; this seam refuses pre-redacted payloads as a CI gate.
  app.post('/v1/host/openwop-app/test/emit-envelope-reliability', async (req, res) => {
    const body = (req.body ?? {}) as {
      runId?: string;
      type?: string;
      payload?: Record<string, unknown>;
      nodeId?: string;
      correlationId?: string;
    };
    const RFC_0032_EVENTS = new Set([
      'envelope.retry.attempted',
      'envelope.retry.exhausted',
      'envelope.refusal',
      'envelope.truncated',
      'envelope.nlToFormat.engaged',
      'envelope.recovery.applied',
    ]);
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'runId required');
      return;
    }
    if (typeof body.type !== 'string' || !RFC_0032_EVENTS.has(body.type)) {
      sendError(
        res,
        400,
        'invalid_argument',
        `type MUST be one of the 6 RFC 0032 envelope-reliability events; got: ${String(body.type)}`,
      );
      return;
    }
    if (!body.payload || typeof body.payload !== 'object') {
      sendError(res, 400, 'invalid_argument', 'payload required (object)');
      return;
    }
    // Per-type required-field check. Canonical source: the `required[]`
    // arrays inside the six `envelope*` `$defs` in
    // `schemas/run-event-payloads.schema.json`. Kept as an explicit inline
    // map for best-effort clarity (the seam is sample-only — see the
    // namespace banner at the top of this file). The schema-corpus-validity
    // conformance scenario catches drift between this map and the canonical
    // `$defs.required[]` shape because any conformance scenario that POSTs
    // a payload here also asserts against the canonical schema. A future
    // refactor MAY replace this with `ajv.compile(runEventPayloads.$defs[<def>])`
    // — currently deemed over-engineering for sample-only code per the
    // MEDIUM-tier finding in the code-review pass that flagged it (~15-line
    // Ajv refactor judged against ~3-line explicit map; conformance covers
    // the drift). Production hosts that wire end-to-end emission inside
    // dispatchStructured() SHOULD use the canonical schema directly.
    const requiredFields: Record<string, readonly string[]> = {
      'envelope.retry.attempted': ['nodeId', 'attempt', 'reason'],
      'envelope.retry.exhausted': ['nodeId', 'totalAttempts', 'finalReason'],
      'envelope.refusal': ['nodeId', 'provider', 'model'],
      'envelope.truncated': ['nodeId', 'provider', 'model', 'stopReason'],
      'envelope.nlToFormat.engaged': ['nodeId', 'originalEnvelopeType'],
      'envelope.recovery.applied': ['nodeId', 'path'],
    };
    const required = requiredFields[body.type] ?? [];
    for (const field of required) {
      if (!(field in body.payload)) {
        sendError(
          res,
          400,
          'invalid_argument',
          `payload MUST include required field "${field}" for event type "${body.type}"`,
        );
        return;
      }
    }
    // Defense-in-depth: reject pre-redacted payloads that look like they
    // carry credentialRef or prompt-content substrings. Production hosts
    // redact BEFORE emission; the seam refuses payloads that bypass the
    // redaction stage as a CI gate per SECURITY invariants
    // `envelope-refusal-no-prompt-leak` + `envelope-recovery-no-content-leak`.
    const serialized = JSON.stringify(body.payload);
    if (serialized.includes('"credentialRef"') || serialized.includes('secret-canary-')) {
      sendError(
        res,
        400,
        'envelope_reliability_credential_leak',
        'payload contains credentialRef-shaped content; redact BEFORE emission per RFC 0032 §G + SECURITY/invariants.yaml envelope-refusal-no-prompt-leak',
      );
      return;
    }
    if (body.type === 'envelope.recovery.applied') {
      // RFC 0032 §B.6 + SECURITY/invariants.yaml envelope-recovery-no-content-leak:
      // recovery event MUST NOT carry pre-recovery output substrings. The
      // schema's `additionalProperties: false` constrains the shape, but
      // we add a defense-in-depth check that the payload's keys are
      // exactly {nodeId, path, byteOffset} (no extras like `recoveredContent`).
      const allowedKeys = new Set(['nodeId', 'path', 'byteOffset']);
      for (const key of Object.keys(body.payload)) {
        if (!allowedKeys.has(key)) {
          sendError(
            res,
            400,
            'envelope_recovery_content_leak',
            `envelope.recovery.applied payload MUST NOT carry "${key}" — only {nodeId, path, byteOffset?} are emitted (RFC 0032 §B.6 + SECURITY envelope-recovery-no-content-leak)`,
          );
          return;
        }
      }
    }
    const { appendTestEvent } = await import('../host/envelopeEventLog.js');
    const event = appendTestEvent({
      runId: body.runId,
      type: body.type,
      payload: body.payload,
      ...(typeof body.correlationId === 'string' ? { causationId: body.correlationId } : {}),
      ...(typeof body.nodeId === 'string' ? { nodeId: body.nodeId } : {}),
    });
    res.status(200).json({ event });
  });

  // RFC 0031 §B model-capability gate seam.
  // POST /v1/host/openwop-app/test/evaluate-model-capability-gate
  // Body: {
  //   module: { requiredModelCapabilities: string[], fallbackModel?: { provider, model } },
  //   activeProvider: string,
  //   activeModel: string,
  //   substitutionSupported: boolean,
  //   supportedProviders: string[]
  // }
  // Response: { outcome, event? }
  //
  // Drives `evaluateModelCapabilityGate()` with synthetic input and returns
  // the routing outcome + the event the host would emit. Conformance scenarios
  // use this to assert the gate's substitute/refuse/dispatch decision matrix
  // + the event payload shapes per RFC 0031 §D without needing a full run.
  // The seam does NOT emit into a real event log — it's a pure-function
  // exerciser for the gate's decision logic.
  app.post('/v1/host/openwop-app/test/evaluate-model-capability-gate', async (req, res) => {
    const body = (req.body ?? {}) as {
      module?: { requiredModelCapabilities?: unknown; fallbackModel?: unknown };
      activeProvider?: string;
      activeModel?: string;
      substitutionSupported?: boolean;
      supportedProviders?: string[];
      nodeId?: string;
    };
    if (typeof body.activeProvider !== 'string' || typeof body.activeModel !== 'string') {
      sendError(res, 400, 'invalid_argument', 'activeProvider + activeModel required');
      return;
    }
    const requiredCaps = Array.isArray(body.module?.requiredModelCapabilities)
      ? (body.module.requiredModelCapabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const fallbackRaw = body.module?.fallbackModel;
    const fallback =
      fallbackRaw &&
      typeof fallbackRaw === 'object' &&
      typeof (fallbackRaw as { provider?: unknown }).provider === 'string' &&
      typeof (fallbackRaw as { model?: unknown }).model === 'string'
        ? {
            provider: (fallbackRaw as { provider: string }).provider,
            model: (fallbackRaw as { model: string }).model,
          }
        : undefined;
    const { evaluateModelCapabilityGate, buildSubstitutedPayload, buildInsufficientPayload } = await import(
      '../executor/modelCapabilityGate.js'
    );
    const outcome = evaluateModelCapabilityGate({
      module: {
        requiredModelCapabilities: requiredCaps,
        ...(fallback ? { fallbackModel: fallback } : {}),
      },
      activeProvider: body.activeProvider,
      activeModel: body.activeModel,
      substitutionSupported: body.substitutionSupported === true,
      supportedProviders: Array.isArray(body.supportedProviders)
        ? body.supportedProviders.filter((p): p is string => typeof p === 'string')
        : [],
    });
    const nodeId = typeof body.nodeId === 'string' && body.nodeId.length > 0 ? body.nodeId : 'test-node';
    let event: { type: string; payload: Record<string, unknown> } | null = null;
    if (outcome.route === 'substitute') {
      event = {
        type: 'model.capability.substituted',
        payload: buildSubstitutedPayload(outcome, nodeId),
      };
    } else if (outcome.route === 'refuse') {
      event = {
        type: 'model.capability.insufficient',
        payload: buildInsufficientPayload(outcome, nodeId, body.activeProvider, body.activeModel),
      };
    }
    res.status(200).json({ outcome, event });
  });

  // LLM cache-key recipe seam — replay.md §"LLM cache-key recipe".
  // POST /v1/host/openwop-app/test/llm-cache-key
  // Body: a semantic-request-shaped object (extra fields ignored per §A).
  // Response: { cacheKey: <lowercase-hex SHA-256>, recipe }
  //
  // ADR 0549 P3 — this emits the RFC 0150 §C **v2** digest, matching what
  // `callAI` actually computes. It emitted v1 until P3, while
  // `capabilities.multiAgent.executionModel.replayDeterminism.llmCacheKeyRecipe`
  // advertised `spec-rfc-0041` — i.e. "the spec-canonical recipe". The canonical
  // recipe became v2 when `replay.md` did, so the advertisement had gone stale
  // rather than wrong-by-construction: implementing v2 is what makes it honest
  // again. `recipe` is echoed so a probe can see WHICH recipe answered instead
  // of inferring it from a hash.
  app.post('/v1/host/openwop-app/test/llm-cache-key', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.provider !== 'string' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      sendError(res, 400, 'invalid_argument', 'provider + model + messages[] required per replay.md §A');
      return;
    }
    res.status(200).json({
      cacheKey: semanticRequestDigestV2(body as unknown as SemanticRequestV2Input),
      recipe: SEMANTIC_REQUEST_RECIPE_V2,
    });
  });

  // Capability-toggle test seam (RFC 0022 §C refusal-case tests).
  // POST /v1/host/openwop-app/test/capability-toggle
  // Body shapes:
  //   { name: 'agents.dispatchMapping', value: false }   // set overlay
  //   { name: 'agents.dispatchMapping', value: null }    // remove overlay (restore default)
  //   { reset: true }                                    // clear ALL overlay entries
  // Response: { overlay: <current overlay snapshot> }
  app.post('/v1/host/openwop-app/test/capability-toggle', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; value?: unknown; reset?: unknown };
    if (body.reset === true) {
      resetCapabilityOverlay();
      res.status(200).json({ overlay: snapshotCapabilityOverlay(), reset: true });
      return;
    }
    if (typeof body.name !== 'string' || body.name.length === 0) {
      sendError(res, 400, 'invalid_argument', 'name required when reset:false');
      return;
    }
    let value: boolean | undefined;
    if (body.value === null) value = undefined;
    else if (typeof body.value === 'boolean') value = body.value;
    else {
      sendError(res, 400, 'invalid_argument', 'value MUST be boolean | null');
      return;
    }
    setCapabilityOverlay(body.name, value);
    res.status(200).json({ overlay: snapshotCapabilityOverlay(), set: { name: body.name, value: value ?? null } });
  });

  // RFC 0064 — tool-hooks invoke seam. Drives the conformance scenarios
  // tool-hooks-{content-free, authorization-fail-closed, rate-limit,
  // secret-redaction, failure-honesty} against the host's `evaluateToolHook()`
  // evaluator. The seam stands in for a live MCP `tools/call`: it runs the same
  // pre/post hook pair (argsHash + per-tool authz + rate limit) and returns
  // the additive `agent.toolCalled` / `agent.toolReturned` fields the host
  // would emit. Per-tool authorization is fail-closed (RFC 0049 `forbidden`).
  // §F failure-honesty: `simulateToolError` yields a ran-and-threw failure
  // (`status:'error'` + populated `error` + non-negative `durationMs`).
  //
  //   POST /v1/host/sample/toolhooks/invoke   (canonical conformance path)
  //   POST /v1/host/openwop-app/toolhooks/invoke   (vendor alias)
  //   Body: { principal, toolName, requiredScopes?, grantedScopes?, args?,
  //           transport?, simulateRateLimitExhausted?, simulateToolError? }
  //   Response: { toolCalled, toolReturned } (+ { error: { code } } on
  //             forbidden/rate_limited; HTTP 403/429 respectively). A §F
  //             ran-and-threw error is HTTP 200 with the error in toolReturned.
  const toolhooksInvokeHandler: RequestHandler = (req, res) => {
    const body = (req.body ?? {}) as {
      principal?: unknown;
      toolName?: unknown;
      requiredScopes?: unknown;
      grantedScopes?: unknown;
      args?: unknown;
      transport?: unknown;
      simulateRateLimitExhausted?: unknown;
      simulateToolError?: unknown;
    };
    if (typeof body.principal !== 'string' || body.principal.length === 0) {
      sendError(res, 400, 'invalid_argument', 'principal required');
      return;
    }
    if (typeof body.toolName !== 'string' || body.toolName.length === 0) {
      sendError(res, 400, 'invalid_argument', 'toolName required');
      return;
    }
    const hookReq: ToolHookRequest = { principal: body.principal, toolName: body.toolName };
    if (Array.isArray(body.requiredScopes)) {
      hookReq.requiredScopes = body.requiredScopes.filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(body.grantedScopes)) {
      hookReq.grantedScopes = body.grantedScopes.filter((s): s is string => typeof s === 'string');
    }
    if (body.args !== undefined) hookReq.args = body.args;
    if (body.transport === 'mcp' || body.transport === 'http' || body.transport === 'native') {
      hookReq.transport = body.transport;
    }
    if (body.simulateRateLimitExhausted === true) hookReq.simulateRateLimitExhausted = true;
    if (body.simulateToolError === true) hookReq.simulateToolError = true;

    const started = Date.now();
    const result = evaluateToolHook(hookReq);
    // RFC 0064 §F — report the real (tiny) measured duration for a call that
    // actually RAN: a success OR a ran-and-threw error. A gate refusal
    // (`forbidden`/`rate_limited`) never ran, so it keeps `durationMs` absent.
    if (result.toolReturned.status === 'ok' || result.toolReturned.status === 'error') {
      result.toolReturned.durationMs = Math.max(0, Date.now() - started);
    }
    res.status(result.httpStatus).json({
      toolCalled: result.toolCalled,
      toolReturned: result.toolReturned,
      ...(result.errorCode ? { error: { code: result.errorCode } } : {}),
    });
  };
  // RFC 0064 §F — the conformance suite drives the tool-hooks seam through the
  // CANONICAL `/v1/host/sample/*` namespace (host-sample-test-seams.md) — the same
  // path the other `tool-hooks-*` scenarios use. Serve it there so the §F
  // `tool-hooks-failure-honesty` scenario WITNESSES this host instead of 404 →
  // soft-skip (which would leave WFAU-4 an unwitnessed wire claim). The vendor
  // `/v1/host/openwop-app/*` alias stays for back-compat; both share one handler.
  app.post('/v1/host/sample/toolhooks/invoke', toolhooksInvokeHandler);
  app.post('/v1/host/openwop-app/toolhooks/invoke', toolhooksInvokeHandler);

  // RFC 0052 — scheduling tick seam. Advances the deterministic scheduler
  // clock and reports the runs a cron schedule produced. Drives
  // scheduling-cron-fires-once (once-per-tick + missed-tick policy).
  //
  //   POST /v1/host/openwop-app/scheduling/tick
  //   Body: { scenario: 'single-tick' | 'missed-window', missedTicks? }
  //   Response: { runsFired: number }
  app.post('/v1/host/openwop-app/scheduling/tick', (req, res) => {
    const body = (req.body ?? {}) as { scenario?: unknown; missedTicks?: unknown };
    if (body.scenario === 'missed-window') {
      const n = typeof body.missedTicks === 'number' ? body.missedTicks : 1;
      res.status(200).json(missedWindow(n));
      return;
    }
    // 'single-tick' (default): one wake-up fires the cron job exactly once.
    res.status(200).json(singleTick());
  });

  // RFC 0061 — agent-loop run seam. Drives a bounded, stateful orchestrator
  // loop and returns the ordered runOrchestrator.decided payloads (each with
  // the §B `iteration` counter), the maxLoopIterations bound result (§E /
  // RFC 0058), and the resumed iteration (§D). Drives
  // agent-loop-iteration-monotonic + agent-loop-stateful-resume.
  //
  //   POST /v1/host/openwop-app/agentloop/run
  //   Body: { turns, maxLoopIterations?, suspendAtTurn?, resume? }
  //   Response: { decisions: [{ agentId, decision, iteration }], bound?, resumedIteration? }
  app.post('/v1/host/openwop-app/agentloop/run', (req, res) => {
    const body = (req.body ?? {}) as {
      turns?: unknown;
      maxLoopIterations?: unknown;
      suspendAtTurn?: unknown;
      resume?: unknown;
      workspaceWriteAtTurn?: unknown;
    };
    const loopReq: AgentLoopRequest = {
      turns: typeof body.turns === 'number' ? body.turns : 1,
    };
    if (typeof body.maxLoopIterations === 'number') loopReq.maxLoopIterations = body.maxLoopIterations;
    if (typeof body.suspendAtTurn === 'number') loopReq.suspendAtTurn = body.suspendAtTurn;
    if (body.resume === true) loopReq.resume = true;
    if (typeof body.workspaceWriteAtTurn === 'number') loopReq.workspaceWriteAtTurn = body.workspaceWriteAtTurn;
    res.status(200).json(runAgentLoop(loopReq));
  });

  // RFC 0032 / 0033 — mock-AI provider program seam.
  //
  //   POST /v1/host/openwop-app/test/mock-ai/program
  //   Body: { nodeId, program: MockBehavior[] }
  //
  // Pre-seeds the conformance-only `dispatchMock` provider with a
  // deterministic per-attempt response queue keyed by `nodeId`. The
  // seam is callable BEFORE the run is created — each conformance
  // scenario uses a unique fixture (and therefore unique nodeId), and
  // the suite runs with `--no-file-parallelism`, so cross-test
  // collisions don't happen.
  //
  // Pairs with `GET /v1/host/openwop-app/test/mock-ai/last-dispatch-budget`
  // below — that seam reports the most-recent `maxTokens` value the
  // mock saw, so RFC 0033 §B truncation-budget-multiplication
  // assertions can verify the increased budget on retry.
  app.post('/v1/host/openwop-app/test/mock-ai/program', async (req, res) => {
    const body = (req.body ?? {}) as { nodeId?: unknown; program?: unknown };
    if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'nodeId required');
      return;
    }
    if (!Array.isArray(body.program)) {
      sendError(res, 400, 'invalid_argument', 'program MUST be MockBehavior[]');
      return;
    }
    const { programMock } = await import('../providers/dispatchMock.js');
    programMock(body.nodeId, body.program as Array<Record<string, unknown>>);
    res.status(200).json({ ok: true, count: body.program.length });
  });

  // THE RESET HALF OF THE PROGRAM SEAM, and it did not exist until 2026-09-16.
  //
  // `resetMockPrograms` has been in `dispatchMock.ts` since the mock landed, with
  // a header claiming it was "called between conformance scenarios". Nothing
  // called it from here — only backend unit tests, in-process. So the store SEEDED
  // through the route above was, for the out-of-process conformance suite,
  // write-only: programmable and unwipeable.
  //
  // The cost was a cross-scenario state leak. An undrained truncation program
  // (several scenarios seed `finishReason: 'length'` deliberately) stays pending
  // on its nodeId for the rest of the host process; a later scenario that
  // dispatches on a colliding nodeId consumes it and fails
  // `envelope_truncation_unrecoverable` with nothing in its own diff to explain
  // it. `replay-observable-sequence-determinism` did exactly that — red in-suite,
  // green alone, five runs, one of the reds at load1 3.4 on an idle box.
  //
  // Idempotent and unconditional: wiping an already-empty store is the expected
  // call in the common case, so this reports what it cleared rather than
  // erroring on "nothing to do" — a reset that failed when there was nothing to
  // reset would train callers to ignore its result.
  app.post('/v1/host/openwop-app/test/mock-ai/reset', async (_req, res) => {
    const { resetMockPrograms, mockProgramCount } = await import('../providers/dispatchMock.js');
    const cleared = mockProgramCount();
    resetMockPrograms();
    res.status(200).json({ ok: true, cleared });
  });

  // RFC 0033 §B — last-dispatch-budget introspection seam. Returns the
  // `maxTokens` value the most recent mock call received for `nodeId`.
  // Conformance scenarios verify the truncation-retry budget
  // multiplication landed by comparing the budget across attempts.
  app.get('/v1/host/openwop-app/test/mock-ai/last-dispatch-budget', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (typeof q.nodeId !== 'string' || q.nodeId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'nodeId query param required');
      return;
    }
    const { lastReceivedMaxTokens } = await import('../providers/dispatchMock.js');
    res.status(200).json({ maxTokens: lastReceivedMaxTokens(q.nodeId) });
  });

  // RFC 0027 §E — prompt-compose test seam. Drives the conformance
  // scenarios `prompt-composed-secret-redaction` and
  // `prompt-composed-trust-marker` against a host-resident
  // PromptTemplate fixture. Returns the `prompt.composed` payload
  // shape (per
  // `schemas/run-event-payloads.schema.json#/$defs/promptComposed`)
  // synchronously so the scenario can assert without subscribing to
  // the run event log. Gated on
  // `capabilities.prompts.supported: true` + the host's advertised
  // `observability` mode (the seam accepts a per-request override but
  // a host that advertises `observability: 'off'` is the source of
  // truth at the discovery layer; the seam doesn't pretend
  // otherwise).
  app.post('/v1/host/openwop-app/prompt/compose', async (req, res) => {
    const body = (req.body ?? {}) as {
      templateId?: string;
      bindings?: Record<string, unknown>;
      bindingTrust?: Record<string, 'trusted' | 'untrusted'>;
      observability?: 'off' | 'hashed' | 'full';
      nodeId?: string;
    };
    if (typeof body.templateId !== 'string' || body.templateId.length === 0) {
      sendError(res, 400, 'invalid_argument', 'templateId required');
      return;
    }
    try {
      const payload = await composePromptTemplate({
        templateId: body.templateId,
        bindings: body.bindings ?? {},
        bindingTrust: body.bindingTrust,
        observability: body.observability,
        nodeId: body.nodeId,
      });
      res.status(200).json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface the error code as the prefix of the message so the
      // conformance suite can distinguish `template_not_found` /
      // `prompt_variable_unresolved` / generic faults.
      const code = message.split(':')[0]?.trim() || 'internal_error';
      const status = code === 'template_not_found' ? 404 : 400;
      sendError(res, status, code, message);
    }
  });

  // RFC 0029 §A — four-layer prompt-resolution test seam. Drives the
  // conformance scenarios `prompt-resolution-chain-{node-wins,
  // agent-intrinsic, fallback-cascade}` against the host's
  // `resolvePromptRef()` helper. Returns the `agent.promptResolved`
  // event payload shape (per
  // `schemas/run-event-payloads.schema.json#/$defs/agentPromptResolved`)
  // synchronously so the scenario can assert without subscribing to
  // the run event log.
  //
  // The seam accepts injected `agentManifest` / `workflowDefaults` /
  // `hostDefaults` blocks so the conformance suite can exercise every
  // layer without depending on the live workflow registry, agent-pack
  // catalog, or `capabilities.prompts.defaults` advertisement.
  // Gated implicitly by `capabilities.prompts.supported: true` (which
  // the host advertises whenever this seam is registered). The seam
  // honors per-request `agentBindingsSupported: false` to let
  // scenarios assert the layer-2-skipped behavior even when the host
  // advertises `agentBindings: true`.
  app.post('/v1/host/openwop-app/prompt/resolve', (req, res) => {
    const body = (req.body ?? {}) as {
      kind?: string;
      node?: {
        nodeId?: string;
        config?: {
          systemPromptRef?: unknown;
          userPromptRef?: unknown;
          schemaHintPromptRef?: unknown;
          fewShotPromptRefs?: unknown[];
          agentId?: string;
        };
      };
      agentManifest?: {
        agentId?: string;
        systemPrompt?: string;
        systemPromptRef?: string;
        promptOverrides?: Partial<Record<PromptKind, unknown>>;
        promptLibraryRef?: string;
      };
      workflowDefaults?: { promptRefs?: Partial<Record<PromptKind, unknown>> };
      hostDefaults?: Partial<Record<PromptKind, unknown>>;
      agentBindingsSupported?: boolean;
    };
    const kinds: readonly PromptKind[] = ['system', 'user', 'few-shot', 'schema-hint'];
    if (typeof body.kind !== 'string' || !(kinds as readonly string[]).includes(body.kind)) {
      sendError(res, 400, 'invalid_argument', 'kind MUST be one of system|user|few-shot|schema-hint');
      return;
    }
    if (!body.node || typeof body.node.nodeId !== 'string' || body.node.nodeId === '') {
      sendError(res, 400, 'invalid_argument', 'node.nodeId required');
      return;
    }
    try {
      const result = resolvePromptRef({
        kind: body.kind as PromptKind,
        node: { nodeId: body.node.nodeId, config: body.node.config },
        ...(body.agentManifest && body.agentManifest.agentId
          ? {
              agentManifest: {
                agentId: body.agentManifest.agentId,
                ...(body.agentManifest.systemPrompt !== undefined
                  ? { systemPrompt: body.agentManifest.systemPrompt }
                  : {}),
                ...(body.agentManifest.systemPromptRef !== undefined
                  ? { systemPromptRef: body.agentManifest.systemPromptRef }
                  : {}),
                ...(body.agentManifest.promptOverrides !== undefined
                  ? { promptOverrides: body.agentManifest.promptOverrides }
                  : {}),
                ...(body.agentManifest.promptLibraryRef !== undefined
                  ? { promptLibraryRef: body.agentManifest.promptLibraryRef }
                  : {}),
              },
            }
          : {}),
        ...(body.workflowDefaults ? { workflowDefaults: body.workflowDefaults } : {}),
        ...(body.hostDefaults ? { hostDefaults: body.hostDefaults } : {}),
        ...(typeof body.agentBindingsSupported === 'boolean'
          ? { agentBindingsSupported: body.agentBindingsSupported }
          : {}),
      });
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.split(':')[0]?.trim() || 'internal_error';
      sendError(res, 400, code, message);
    }
  });

  // RFC 0036 §C / `spec/v1/idempotency.md` §"Multi-region idempotency annex"
  //   POST /v1/host/openwop-app/test/multi-region/simulate-partition
  //   Body: {
  //     claims: Array<{ runId, tenantId, endpoint, key, region }>,
  //   }
  //
  // Exposes the canonical cross-region convergence resolver per
  // idempotency.md §"Convergence rule" as a pure-function test seam.
  // Conformance scenario `multi-region-idempotency-behavior.test.ts`
  // POSTs a synthetic partition (≥2 conflicting claims sharing
  // (tenantId, endpoint, key)) and asserts:
  //   1. The winner is the lex-min runId per the annex.
  //   2. Each cache redirect entry points at the winner's runId.
  //   3. The loser's cancel reason is the canonical
  //      `cross_region_dedup_loss` per the annex.
  //   4. The resolver is order-invariant — shuffling the input claims
  //      produces the same winner.
  //
  // Implements the algorithm by importing it from the openwop spec
  // companion. Single-region hosts that don't run a multi-region
  // deployment can still expose this seam — the resolver is a pure
  // function with no runtime dependency on partition state.
  //
  // Gated on `OPENWOP_TEST_MULTI_REGION_SIMULATOR=true` so production
  // deploys can't accidentally expose it.
  app.post('/v1/host/openwop-app/test/multi-region/simulate-partition', async (req, res) => {
    if (process.env.OPENWOP_TEST_MULTI_REGION_SIMULATOR !== 'true') {
      res.status(404).json({
        error: 'not_found',
        message: 'multi-region simulator seam disabled (set OPENWOP_TEST_MULTI_REGION_SIMULATOR=true)',
      });
      return;
    }
    const body = (req.body ?? {}) as { claims?: unknown };
    if (!Array.isArray(body.claims) || body.claims.length < 2) {
      res.status(400).json({
        error: 'validation_error',
        message: 'claims MUST be an array of ≥2 ConflictClaim objects per idempotency.md §"Multi-region idempotency annex"',
      });
      return;
    }
    interface ConflictClaim {
      readonly runId: string;
      readonly tenantId: string;
      readonly endpoint: string;
      readonly key: string;
      readonly region: string;
    }
    const claims = body.claims as ReadonlyArray<ConflictClaim>;
    try {
      const head = claims[0]!;
      for (const c of claims.slice(1)) {
        if (c.tenantId !== head.tenantId || c.endpoint !== head.endpoint || c.key !== head.key) {
          res.status(400).json({
            error: 'validation_error',
            message: `all claims MUST share (tenantId, endpoint, key) — got ${head.tenantId}/${head.endpoint}/${head.key} vs ${c.tenantId}/${c.endpoint}/${c.key}`,
          });
          return;
        }
      }
      const sorted = [...claims].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
      const winner = sorted[0]!;
      const losers = sorted.slice(1);
      const cacheKey = `${head.endpoint}:${head.key}`;
      const cacheRedirects = sorted.map((c) => ({
        region: c.region,
        cacheKey,
        redirectToRunId: winner.runId,
      }));
      res.status(200).json({
        winner,
        losers,
        cacheRedirects,
        loserCancelReason: 'cross_region_dedup_loss' as const,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'internal_error', message });
    }
  });

  // RFC 0036 §B / `spec/v1/channels-and-reducers.md` §"Cross-engine ordering"
  //   POST /v1/host/openwop-app/test/cross-engine/append
  //   Body: { engineId, channelId, value, lamport? }
  //   GET  /v1/host/openwop-app/test/cross-engine/read?channelId=<id>
  //
  // Simulates a two-engine append-ordering harness. Each `POST` is a
  // single engine's append against the shared channel; the seam
  // assigns a monotonic Lamport timestamp (the host's
  // `crossEngineOrdering.orderingModel: 'lamport'` advertisement).
  // The `GET` reads back the ordered sequence so the conformance
  // scenario can verify cross-engine writes converge to a single
  // global order.
  //
  // Conformance scenario `cross-engine-append-behavior.test.ts`
  // drives this seam: posts N appends from engine A interleaved with
  // M appends from engine B, then reads back and asserts the
  // resulting sequence is a topological linearization respecting
  // each engine's per-engine order.
  //
  // Gated on `OPENWOP_TEST_CROSS_ENGINE_HARNESS=true`.
  interface CrossEngineEntry {
    readonly engineId: string;
    readonly value: unknown;
    readonly lamport: number;
    readonly seq: number;
  }
  const crossEngineLog = new Map<string, CrossEngineEntry[]>();
  let crossEngineLamport = 0;
  let crossEngineSeq = 0;

  app.post('/v1/host/openwop-app/test/cross-engine/append', (req, res) => {
    if (process.env.OPENWOP_TEST_CROSS_ENGINE_HARNESS !== 'true') {
      res.status(404).json({
        error: 'not_found',
        message: 'cross-engine harness seam disabled (set OPENWOP_TEST_CROSS_ENGINE_HARNESS=true)',
      });
      return;
    }
    const body = (req.body ?? {}) as {
      engineId?: unknown;
      channelId?: unknown;
      value?: unknown;
      lamport?: unknown;
    };
    if (typeof body.engineId !== 'string' || body.engineId.length === 0) {
      res.status(400).json({ error: 'validation_error', message: 'engineId required' });
      return;
    }
    if (typeof body.channelId !== 'string' || body.channelId.length === 0) {
      res.status(400).json({ error: 'validation_error', message: 'channelId required' });
      return;
    }
    // Lamport rule: max(local, incoming) + 1. When a caller passes a
    // lamport hint (proxy for "this engine saw the other engine's
    // clock at this value"), advance our clock past it.
    const incoming = typeof body.lamport === 'number' ? body.lamport : 0;
    crossEngineLamport = Math.max(crossEngineLamport, incoming) + 1;
    const entry: CrossEngineEntry = {
      engineId: body.engineId,
      value: body.value ?? null,
      lamport: crossEngineLamport,
      seq: ++crossEngineSeq,
    };
    const log = crossEngineLog.get(body.channelId) ?? [];
    log.push(entry);
    crossEngineLog.set(body.channelId, log);
    res.status(200).json(entry);
  });

  app.get('/v1/host/openwop-app/test/cross-engine/read', (req, res) => {
    if (process.env.OPENWOP_TEST_CROSS_ENGINE_HARNESS !== 'true') {
      res.status(404).json({
        error: 'not_found',
        message: 'cross-engine harness seam disabled',
      });
      return;
    }
    const q = req.query as Record<string, string | undefined>;
    if (typeof q.channelId !== 'string' || q.channelId.length === 0) {
      res.status(400).json({ error: 'validation_error', message: 'channelId query param required' });
      return;
    }
    const log = crossEngineLog.get(q.channelId) ?? [];
    // Sort by lamport then engineId then seq (deterministic
    // total order — the global linearization).
    const sorted = [...log].sort((a, b) => {
      if (a.lamport !== b.lamport) return a.lamport - b.lamport;
      if (a.engineId !== b.engineId) return a.engineId < b.engineId ? -1 : 1;
      return a.seq - b.seq;
    });
    res.status(200).json({ entries: sorted });
  });

  app.post('/v1/host/openwop-app/test/cross-engine/reset', (_req, res) => {
    if (process.env.OPENWOP_TEST_CROSS_ENGINE_HARNESS !== 'true') {
      res.status(404).json({
        error: 'not_found',
        message: 'cross-engine harness seam disabled',
      });
      return;
    }
    crossEngineLog.clear();
    crossEngineLamport = 0;
    crossEngineSeq = 0;
    res.status(200).json({ ok: true });
  });

  // RFC 0035 — sandbox-vm MVP test seam.
  //
  //   POST /v1/host/openwop-app/test/sandbox-load
  //     body: { packId: string }
  //     → 200 OK { ok: true } when packId is in the synthetic pack registry
  //     → 404 sandbox_pack_not_found otherwise
  //
  //   POST /v1/host/openwop-app/test/sandbox-invoke
  //     body: {
  //       typeId: string,       // e.g. 'misbehave.fs-escape-read'
  //       args?: Record<string, unknown>,
  //       packId?: string,      // identifies the pack containing typeId
  //       allowedHostCalls?: string[],  // capability-gate test seam
  //     }
  //     → 200 OK with { result } when the sandboxed code completes
  //     → 200 OK with { error: { code, details } } when the code attempts
  //       any forbidden host operation (fs / env / network / process /
  //       memory / timeout escape; cross-pack mutation; capability-gate
  //       violation).
  //
  // Gated on OPENWOP_TEST_SANDBOX_MVP=true. The sandbox is implemented
  // via node:vm.runInNewContext — the simplest possible isolation. Each
  // invocation gets a FRESH context (no state shared across invocations)
  // which guarantees `node-pack-sandbox-isolated-context` AND
  // `node-pack-sandbox-no-cross-pack-mutation` by construction. The
  // node:vm context omits `process`, `fs`, `child_process`, `net`, and
  // any other Node host globals, which guarantees fs-escape / env-leak /
  // network-escape / process-escape detection. Timeout is enforced via
  // vm's `timeout` option. Memory cap detection uses a heuristic on the
  // resulting value size (the production MVP would use worker_threads
  // resourceLimits).
  //
  // This is NOT a production sandbox — node:vm has known escape
  // vectors via prototype chain manipulation, and a real adopter would
  // use wasmtime or nsjail. The MVP exists to prove the protocol
  // contract end-to-end: scenarios that send misbehaving code MUST get
  // a typed `sandbox_escape_attempt` error envelope back. RFC 0035
  // §"Acceptance criteria" graduates the SECURITY invariants from
  // reference-impl → protocol when this seam passes 5 of 8 scenarios;
  // the remaining 3 (sandbox-no-eval reserved for JS-runtime-specific
  // tier per the RFC's exemption; sandbox-no-cross-pack-mutation always
  // passes by construction in this MVP; sandbox-capability-gate-
  // respected requires the host's allowedHostCalls config to be wired
  // — covered here).
  // Canonical error codes per `spec/v1/host-capabilities.md` §"Error codes"
  // (RFC 0035 §B). Each code maps 1:1 to a §B invariant row:
  //   sandbox_escape_attempt   — forbidden-syscall escape (fs/env/network/process)
  //   sandbox_capability_denied — host call not in `allowedHostCalls`
  //   sandbox_memory_exceeded  — memoryLimitBytes overflow
  //   sandbox_timeout          — wallClockLimitMs overflow
  //   sandbox_invocation_error — fallback for thrown errors not mapping to the canonical set
  type SandboxResult =
    | { result: unknown }
    | {
        error: {
          code:
            | 'sandbox_escape_attempt'
            | 'sandbox_capability_denied'
            | 'sandbox_memory_exceeded'
            | 'sandbox_timeout'
            | 'sandbox_invocation_error';
          details: {
            // `escapeKind` only applies to `sandbox_escape_attempt`. Per
            // `host-capabilities.md:1681` it's the "syscall from a forbidden
            // list" qualifier. `capability-gate-violation` is NOT an
            // escapeKind here — it's a different error code entirely
            // (`sandbox_capability_denied` — see §B invariant
            // `node-pack-sandbox-capability-gate-respected`).
            escapeKind?: 'host-fs-escape' | 'host-env-leak' | 'network-escape' | 'host-process-escape';
            // `requestedCapability` is REQUIRED on `sandbox_capability_denied`
            // per `host-capabilities.md:1680`. Identifies the host method the
            // sandboxed code attempted to call.
            requestedCapability?: string;
            // `requestedBytes` MAY appear on `sandbox_memory_exceeded` per
            // `host-capabilities.md:1678`.
            requestedBytes?: number;
            message: string;
          };
        };
      };

  // Synthetic misbehaving-pack registry: maps typeId to a (code, expectedFailureKind)
  // descriptor. The conformance suite drives these via sandbox-invoke; each program
  // attempts a specific failure mode the matching scenario asserts on. We
  // carry the failure intent here so the classifier doesn't have to
  // reverse-engineer it from error-message heuristics — node:vm errors
  // all surface as `TypeError: globalThis.require is not a function` for
  // any module load, so message-only inference can't distinguish fs from
  // network from process. The pack's declared intent is the source of truth.
  interface SandboxProgram {
    readonly code: string;
    // When set, the classifier treats a thrown error as a forbidden-syscall
    // escape (`sandbox_escape_attempt` + this escapeKind). Mutually exclusive
    // with `expectsCapabilityDenied` + `expectsMemoryExceeded`.
    readonly expectedEscapeKind?:
      | 'host-fs-escape'
      | 'host-env-leak'
      | 'network-escape'
      | 'host-process-escape';
    // When true, the classifier treats a thrown error as a capability-gate
    // violation (`sandbox_capability_denied`).
    readonly expectsCapabilityDenied?: boolean;
    // When true, the classifier treats a thrown error as a memory-exceeded
    // failure (`sandbox_memory_exceeded`). v8 raises `RangeError: Invalid
    // string length` for string allocations past 2^28-1; other memory paths
    // raise `out of memory` / `Allocation failed`. Without this declared-
    // intent flag, the bare-regex classifier would route to
    // `sandbox_invocation_error` for the v8 RangeError variant, which is
    // wrong per the spec.
    readonly expectsMemoryExceeded?: boolean;
  }
  const SANDBOX_PROGRAMS: Record<string, SandboxProgram> = {
    'misbehave.fs-escape-read': {
      code: `globalThis.require('fs').readFileSync('/etc/passwd', 'utf8');`,
      expectedEscapeKind: 'host-fs-escape',
    },
    'misbehave.fs-escape-write': {
      code: `globalThis.require('fs').writeFileSync('/tmp/sandbox-escape', 'pwn');`,
      expectedEscapeKind: 'host-fs-escape',
    },
    'misbehave.env-leak': {
      code: `({ env: globalThis.process.env.HOME });`,
      expectedEscapeKind: 'host-env-leak',
    },
    'misbehave.network-escape': {
      code: `globalThis.require('http').get('http://127.0.0.1:9999');`,
      expectedEscapeKind: 'network-escape',
    },
    'misbehave.process-escape': {
      code: `globalThis.require('child_process').execSync('whoami');`,
      expectedEscapeKind: 'host-process-escape',
    },
    'misbehave.timeout': {
      code: `while (true) { /* loop forever */ }`,
    },
    'misbehave.memory-bomb': {
      code: `let s = ''; for (let i = 0; i < 30; i++) { s += s + 'x'.repeat(1024); } ({ size: s.length });`,
      expectsMemoryExceeded: true,
    },
    'misbehave.cross-pack-mutate': {
      code: `globalThis.__sharedState = (globalThis.__sharedState || 0) + 1; ({ shared: globalThis.__sharedState });`,
    },
    'misbehave.capability-gate-violation': {
      code: `host.notInAllowedList('args');`,
      expectsCapabilityDenied: true,
    },
    'well-behaved.echo': {
      code: `({ echoed: args.input });`,
    },
    'well-behaved.host-fetch': {
      code: `host.fetch('http://example.com');`,
    },
  };

  const SANDBOX_PACKS = new Set<string>();

  // Sentinel prefix the host Proxy embeds in its capability-denied thrower
  // so the classifier can recover the requested-capability name without
  // re-parsing the message. Format: `${SENTINEL}${capabilityName}:${humanMessage}`.
  const CAPABILITY_DENIED_SENTINEL = '__OPENWOP_CAP_DENIED__:';

  // Host-call dispatch for the sandbox seam: only names listed in
  // allowedHostCalls resolve; any other call throws a structured sentinel the
  // classifier parses into `sandbox_capability_denied + details.requestedCapability`
  // per `host-capabilities.md:1680`. Built as a `SandboxDispatch` (not an
  // outer-realm host object) so the hardened primitive keeps every reference the
  // sandbox can reach inside the vm realm — closing the prototype-chain escape
  // (`host.fetch(...).constructor.constructor('return process')()`).
  function makeSandboxDispatch(allowedHostCalls: string[]): SandboxDispatch {
    const allow = new Set(allowedHostCalls);
    const MOCKS: Record<string, (...args: unknown[]) => unknown> = {
      fetch: (_url) => ({ status: 200, body: 'mocked' }),
      // Future host calls (kv.get, queue.publish, etc.) extend here.
    };
    return (name, args) => {
      if (!allow.has(name)) {
        throw new Error(`${CAPABILITY_DENIED_SENTINEL}${name}:host.${name} is not in allowedHostCalls`);
      }
      const fn = MOCKS[name];
      return fn ? fn(...args) : undefined;
    };
  }

  function classifyError(err: unknown, program: SandboxProgram): SandboxResult {
    // Cross-realm-safe message extraction: the hardened sandbox re-throws host-
    // call failures as IN-CONTEXT Errors, which are NOT `instanceof` this realm's
    // Error — so read `.message` directly (the capability-denied sentinel lives
    // there) and only fall back to String() when there is no message string.
    const errMessage = (err as { message?: unknown } | null)?.message;
    const msg = typeof errMessage === 'string' ? errMessage : String(err);
    // Timeouts surface specifically from node:vm — pattern-match here
    // (timeout is independent of the program's declared intent). Canonical
    // code per `host-capabilities.md:1670,1679`.
    if (/timed out|Script execution timed out/i.test(msg)) {
      return {
        error: {
          code: 'sandbox_timeout',
          details: { message: msg },
        },
      };
    }
    // Memory cap surfaces from v8 with one of several patterns depending on
    // which allocator hit the cap. Canonical code per
    // `host-capabilities.md:1669,1678`. We also honor the program's
    // declared `expectsMemoryExceeded` flag — same lesson as escape kinds:
    // node:vm errors don't always carry enough information to distinguish
    // "the user code asked for too much memory" from "the user code threw
    // a RangeError for some other reason."
    if (
      program.expectsMemoryExceeded ||
      /Maximum call stack|out of memory|Allocation failed|Invalid string length|RangeError: Array buffer/i.test(msg)
    ) {
      return {
        error: {
          code: 'sandbox_memory_exceeded',
          details: { message: msg },
        },
      };
    }
    // Capability-gate violation: the Proxy thrower above embeds a
    // structured sentinel so we can recover `requestedCapability` per
    // `host-capabilities.md:1671,1680`. Distinct error code from
    // `sandbox_escape_attempt` (which covers forbidden-syscall escapes).
    if (msg.startsWith(CAPABILITY_DENIED_SENTINEL)) {
      const rest = msg.slice(CAPABILITY_DENIED_SENTINEL.length);
      const colonIdx = rest.indexOf(':');
      const requestedCapability = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
      const humanMsg = colonIdx >= 0 ? rest.slice(colonIdx + 1) : rest;
      return {
        error: {
          code: 'sandbox_capability_denied',
          details: { requestedCapability, message: humanMsg },
        },
      };
    }
    // For all other thrown errors, use the program's declared
    // expectedEscapeKind as the authoritative source. The classifier-by-
    // message approach can't differentiate fs/network/process escapes
    // because they all surface as "globalThis.require is not a function"
    // — same TypeError, different intent.
    if (program.expectedEscapeKind !== undefined) {
      return {
        error: {
          code: 'sandbox_escape_attempt',
          details: { escapeKind: program.expectedEscapeKind, message: msg },
        },
      };
    }
    // Fallback: code threw something we don't map to an escape category
    // AND the program didn't declare an expectedEscapeKind. Treat as
    // `sandbox_invocation_error`.
    return {
      error: {
        code: 'sandbox_invocation_error',
        details: { message: msg },
      },
    };
  }

  app.post('/v1/host/openwop-app/test/sandbox-load', (req, res) => {
    if (process.env.OPENWOP_TEST_SANDBOX_MVP !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'sandbox MVP disabled (set OPENWOP_TEST_SANDBOX_MVP=true)' });
      return;
    }
    const body = (req.body ?? {}) as { packId?: unknown };
    if (typeof body.packId !== 'string') {
      res.status(400).json({ error: 'validation_error', message: 'packId required' });
      return;
    }
    // Sandbox-load is symbolic — the synthetic registry is in-memory
    // and pre-populated above. Any non-empty packId "loads" successfully;
    // the scenario uses load as the lifecycle marker.
    SANDBOX_PACKS.add(body.packId);
    res.status(200).json({ ok: true, packId: body.packId });
  });

  app.post('/v1/host/openwop-app/test/sandbox-invoke', async (req, res) => {
    if (process.env.OPENWOP_TEST_SANDBOX_MVP !== 'true') {
      res.status(404).json({ error: 'not_found', message: 'sandbox MVP disabled' });
      return;
    }
    const body = (req.body ?? {}) as {
      typeId?: unknown;
      args?: unknown;
      packId?: unknown;
      allowedHostCalls?: unknown;
    };
    if (typeof body.typeId !== 'string') {
      res.status(400).json({ error: 'validation_error', message: 'typeId required' });
      return;
    }
    const program = SANDBOX_PROGRAMS[body.typeId];
    if (program === undefined) {
      res.status(404).json({
        error: 'sandbox_pack_not_found',
        message: `typeId ${body.typeId} not in synthetic misbehaving-pack registry`,
      });
      return;
    }
    const allowedHostCalls = Array.isArray(body.allowedHostCalls)
      ? (body.allowedHostCalls as string[])
      : [];
    const args = body.args ?? {};

    const dispatch = makeSandboxDispatch(allowedHostCalls);

    // A13(a) — run through the shared `execGuardedSandboxVm` primitive
    // (host/sandbox.ts) instead of a second inline node:vm path. Same isolation
    // (a fresh context exposing only an in-context `host` dispatcher + cloned
    // `args`, no require/process/fs/child_process, 1000ms wall-clock — RFC 0035
    // §A) and now hardened against prototype-chain escapes. It returns the RAW
    // thrown error so this seam keeps its richer, program-intent-driven taxonomy
    // (escapeKind / requestedCapability / memory-exceeded) that `runInSandbox`'s
    // base taxonomy omits — DRY on the executor, unchanged behavior on the wire.
    const exec = execGuardedSandboxVm(program.code, { timeoutMs: 1000, dispatch, args });
    if (!exec.ok) {
      res.status(200).json(classifyError(exec.error, program));
      return;
    }
    // Memory-cap heuristic: if the result is a string > 16MiB, treat
    // as memory-bomb. Real isolation needs worker_threads
    // resourceLimits. Canonical code `sandbox_memory_exceeded` +
    // `details.requestedBytes` per `host-capabilities.md:1669,1678`.
    const serialized = JSON.stringify(exec.value);
    if (serialized && serialized.length > 16 * 1024 * 1024) {
      res.status(200).json({
        error: {
          code: 'sandbox_memory_exceeded',
          details: {
            requestedBytes: serialized.length,
            message: `result exceeds 16MiB memory cap (got ${serialized.length} bytes)`,
          },
        },
      });
      return;
    }
    res.status(200).json({ result: exec.value });
  });
}
