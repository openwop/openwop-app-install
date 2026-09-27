/**
 * Operations routes (ADR 0395 Phase A — webhook-delivery health).
 *
 * ONE batched summary per panel load (D2): the endpoint fans in server-side —
 * subscriptions + delivery rollups + trigger-bridge state in one response —
 * so the panel never N+1s the per-IP rate budget.
 *
 * SAFE PROJECTION (non-negotiable): a `WebhookDeliveryRecord` carries the
 * sealed HMAC `secret` and the full event `payload`, and a subscription URL
 * may embed tokens in its query string. Nothing secret ever leaves this
 * module — deliveries project to status/attempt/schedule/error fields only,
 * and URLs are stripped to origin+path.
 *
 * Gating (D3, fail-closed): the cross-tenant summary + the retry/state writes
 * are SUPERADMIN-only via `requireSuperadmin`; a tenant's own summary rides
 * `authorizeOrgScope` + the admin-tier `webhooks:manage` scope. The
 * `operations` toggle gates the tenant surface, never the auth boundary.
 *
 * > **CORRECTED 2026-08-17 (ADR 0556 P2).** This paragraph said "uniform 404
 * > via `requireSuperadmin`" and the route comment below said the same. Both
 * > were FALSE: `host/superadmin.ts` throws `OpenwopError('forbidden', …, 403)`,
 * > and always has. The claim mattered because it is a security statement — a
 * > uniform 404 is a non-disclosure property ("this surface does not exist for
 * > you"), and 403 deliberately does not have it. A reader hardening this
 * > surface would have believed a defence that was not there, and a test
 * > written to the comment would have pinned behaviour the code does not have.
 * > The gate is fail-closed either way, which is why nothing broke and why the
 * > comment survived so long. Corrected in place rather than deleted: the
 * > existing route tests accept `[403, 404]`, so the drift is older than this
 * > phase and worth leaving a trail for.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Storage } from '../../storage/storage.js';
import type { WebhookDeliveryRecord } from '../../types.js';
import type { SignedAttestation } from '../../host/deploymentAttestation.js'; // type-only — the module is imported lazily below
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { recordAttestationAge } from '../../observability/metricSeams.js';
import { collectLocalScrape, lastEmissionMap, localScrapeStartedAt, localScrapeCardinalityLimit } from '../../observability/metrics.js';
import { flattenSnapshot, projectSlos } from '../../observability/sloProjection.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { authorizeOrgScope, requireFeatureEnabled, requireTenantScope } from '../featureRoute.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { verifyChain } from '../../host/auditChainService.js';
import {
  compensationStatusForRunTree,
  obligationsForRunTree,
  type CompensationState,
} from '../../host/compensationLedger.js';
import {
  COMPENSATION_RECOVERY_ACTIONS,
  recoveryHistory,
  type CompensationRecoveryAction,
} from '../../host/compensationRecoveryAudit.js';
import { applyRecoveryAction, scopeForRecoveryAction } from '../../host/compensationRecovery.js';
import { decideCompensationOperatorAction } from '../../host/compensationOperator.js';
import {
  listAllSubscriptions,
  listSubscriptions,
  listDeliveries,
  setSubscriptionState,
  getSubscription,
  type SubscriptionState,
} from '../../host/triggerBridgeService.js';
import { snapshotDlqSubjects, replayDlqMessage } from '../../host/inMemorySurfaces.js';
import { snapshotDurableDlqSubjects, replayDurableDlqMessage } from '../../host/durable/durableQueue.js';
import { resolveBackendId } from '../../host/surfaceBackends.js';
import { getManagedProviderStatuses } from '../../providers/managedProvider.js';
import { sessionSecretConfigError, apiKeyConfigError } from '../../middleware/auth.js';
import { storageProbeError } from '../../routes/health.js';
import { snapshotSseStreams } from '../../host/sseChannel.js';
import { snapshotRateLimits } from '../../middleware/rateLimit.js';
import { buildDaemonStatus } from '../../routes/daemonStatus.js';
import { APP_VERSION } from '../../version.js';

const FEATURE = { toggleId: 'operations', label: 'Operations Console' };
const BASE = '/v1/host/openwop-app/operations';
const RECENT_LIMIT = 20;

const log = createLogger('features.operations');

/** Origin + path only — a webhook URL's query string may carry tokens. */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

/** The delivery projection the panel sees — no secret, no payload. */
function projectDelivery(d: WebhookDeliveryRecord): Record<string, unknown> {
  return {
    deliveryId: d.deliveryId,
    subscriptionId: d.subscriptionId,
    eventType: d.eventType,
    url: sanitizeUrl(d.url),
    status: d.status,
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    nextAttemptAt: d.nextAttemptAt,
    lastError: d.lastError ?? null,
  };
}

/** The batched webhook-health summary for one set of tenants (or all). */
async function buildWebhookSummary(storage: Storage, tenantId?: string): Promise<Record<string, unknown>> {
  const subscriptions = await storage.listWebhooks(tenantId !== undefined ? { tenantId } : {});
  const subIds = subscriptions.map((s) => s.subscriptionId);
  const DELIVERY_SAMPLE = 500;
  const deliveries = await storage.listWebhookDeliveries({ subscriptionIds: subIds, limit: DELIVERY_SAMPLE });
  // GRADE-CODE 2026-07-17 — counts computed over a capped sample must SAY so
  // (no silent under-report of a busy tenant's dead-letter count).
  const truncated = deliveries.length >= DELIVERY_SAMPLE;
  const bySub = new Map<string, WebhookDeliveryRecord[]>();
  for (const d of deliveries) {
    const list = bySub.get(d.subscriptionId) ?? [];
    list.push(d);
    bySub.set(d.subscriptionId, list);
  }
  const webhooks = subscriptions.map((s) => {
    const rows = bySub.get(s.subscriptionId) ?? [];
    return {
      subscriptionId: s.subscriptionId,
      tenantId: s.tenantId,
      url: sanitizeUrl(s.url),
      events: s.events,
      ...(s.tags ? { tags: s.tags } : {}),
      counts: {
        pending: rows.filter((d) => d.status === 'pending').length,
        dead: rows.filter((d) => d.status === 'dead').length,
        delivered: rows.filter((d) => d.status === 'delivered').length,
      },
      recent: rows.slice(0, RECENT_LIMIT).map(projectDelivery),
    };
  });
  const triggerSubs = tenantId !== undefined ? await listSubscriptions(tenantId) : await listAllSubscriptions();
  const triggerSubscriptions = await Promise.all(triggerSubs.map(async (s) => ({
    subscriptionId: s.subscriptionId,
    tenantId: s.tenantId,
    source: s.source,
    ...(s.label ? { label: s.label } : {}),
    state: s.state,
    recentDeliveries: (await listDeliveries(s.subscriptionId)).slice(-RECENT_LIMIT).map((d) => ({
      deliveryId: d.deliveryId,
      outcome: d.outcome,
      at: d.at,
      ...(d.runId ? { runId: d.runId } : {}),
    })),
  })));
  return { webhooks, triggerSubscriptions, deliverySample: { limit: DELIVERY_SAMPLE, truncated }, fetchedAt: new Date().toISOString() };
}

export function registerOperationsRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  // ── Cross-tenant webhook health (superadmin; 403 otherwise — see the
  //    correction in the module header, NOT a uniform 404) ─────────────────
  app.get(`${BASE}/webhooks/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : undefined;
      res.json(await buildWebhookSummary(storage, tenantId));
    } catch (err) { next(err); }
  });

  // ── A tenant admin's OWN webhook health (toggle + webhooks:manage) ───────
  app.get(`${BASE}/orgs/:orgId/webhooks/summary`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'webhooks:manage');
      res.json(await buildWebhookSummary(storage, tenantId));
    } catch (err) { next(err); }
  });

  // ── Manual retry (D4): re-arm a dead/stuck delivery for the EXISTING
  //    worker — no new sender, audited, superadmin-only. ────────────────────
  app.post(`${BASE}/webhooks/deliveries/:deliveryId/retry`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const deliveryId = req.params.deliveryId!;
      const retried = await storage.retryWebhookDelivery(deliveryId, Date.now());
      if (!retried) throw new OpenwopError('not_found', 'Delivery not found (or already delivered).', 404);
      await storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.userId ?? req.principal?.principalId ?? 'superadmin',
        action: 'operations.webhook.retry',
        resource: deliveryId,
        outcome: 'success',
        payload: {},
      });
      log.info('operations_webhook_retry', { deliveryId, actor: req.userId ?? null });
      res.status(202).json({ retried: true });
    } catch (err) { next(err); }
  });

  // ── Phase B — DLQ dashboard: point-in-time depths from THIS instance's
  //    RFC 0017 bus surface (in-memory — the response says so honestly, OQ-3);
  //    payloads never leave the surface (ids + reasons only). ────────────────
  app.get(`${BASE}/dlq/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : undefined;
      // Backend-aware (OQ-3 resolved): the DURABLE bus is fleet-shared (rows in
      // storage — replay survives restarts); the in-memory default is
      // per-instance, and the response says which one answered.
      const durable = resolveBackendId('queueBus') !== 'memory';
      res.json({
        subjects: durable ? await snapshotDurableDlqSubjects(tenantId) : snapshotDlqSubjects(tenantId),
        backend: durable ? 'durable' : 'memory',
        perInstance: !durable,
        pointInTime: true,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) { next(err); }
  });

  // Gated replay (D4): re-publish ONE dead-lettered message through the
  // surface's own state — idempotent per message (a second replay 404s).
  app.post(`${BASE}/dlq/replay`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = typeof body.tenantId === 'string' && body.tenantId ? body.tenantId : undefined;
      const subject = typeof body.subject === 'string' ? body.subject : '';
      const messageId = typeof body.messageId === 'string' ? body.messageId : '';
      if (!tenantId || !subject || !messageId) {
        throw new OpenwopError('validation_error', '`tenantId`, `subject` (the .dlq subject), and `messageId` are required.', 400);
      }
      const result = resolveBackendId('queueBus') !== 'memory'
        ? await replayDurableDlqMessage(tenantId, subject, messageId)
        : replayDlqMessage(tenantId, subject, messageId);
      if (!result.replayed) {
        throw new OpenwopError(result.reason === 'bad_subject' ? 'validation_error' : 'not_found',
          result.reason === 'bad_subject' ? '`subject` must be a `.dlq` subject.' : 'Message not found on that DLQ subject (already replayed, consumed, or on another instance).',
          result.reason === 'bad_subject' ? 400 : 404);
      }
      await storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.userId ?? req.principal?.principalId ?? 'superadmin',
        action: 'operations.dlq.replay',
        resource: `${tenantId}:${subject}:${messageId}`,
        outcome: 'success',
        payload: {},
      });
      log.info('operations_dlq_replay', { tenantId, subject, messageId, actor: req.userId ?? null });
      res.status(202).json({ replayed: true });
    } catch (err) { next(err); }
  });

  // ── Phase C — system-health summary: readiness checks + SSE + rate-limit
  //    config + daemon status, ONE response, per-instance-honest. ────────────
  app.get(`${BASE}/health/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const managedProviders = await getManagedProviderStatuses().catch(() => null);
      const configError = sessionSecretConfigError() ?? apiKeyConfigError();
      const storageError = await storageProbeError(storage);
      const ready = (managedProviders?.every((p) => p.ready) ?? false) && !configError && !storageError;
      res.json({
        status: ready ? 'ready' : 'degraded',
        version: APP_VERSION,
        checks: {
          managedProviders: managedProviders ?? { ok: false, error: 'managed-provider check failed' },
          config: configError ? { ok: false, error: configError } : { ok: true },
          storage: storageError ? { ok: false, error: storageError } : { ok: true },
        },
        sse: snapshotSseStreams(),
        rateLimits: snapshotRateLimits(),
        daemon: buildDaemonStatus({ config: deps.config, startTimeMs: deps.startTimeMs }),
        // Cloud Run multi-instance honesty: SSE counts + daemon uptime are THIS
        // revision-instance's view, not a fleet aggregate (no shared metrics store).
        perInstance: true,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) { next(err); }
  });

  // ── Trigger-subscription pause/resume via the EXISTING state machine ─────
  app.post(`${BASE}/trigger-subscriptions/:subscriptionId/state`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const state = (req.body ?? {}).state as SubscriptionState;
      if (state !== 'active' && state !== 'paused') {
        throw new OpenwopError('validation_error', "`state` must be 'active' or 'paused'.", 400, { field: 'state' });
      }
      const subscriptionId = req.params.subscriptionId!;
      if (!(await getSubscription(subscriptionId))) throw new OpenwopError('not_found', 'Subscription not found.', 404);
      await setSubscriptionState(subscriptionId, state);
      await storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.userId ?? req.principal?.principalId ?? 'superadmin',
        action: `operations.trigger-subscription.${state === 'paused' ? 'pause' : 'resume'}`,
        resource: subscriptionId,
        outcome: 'success',
        payload: {},
      });
      res.json({ subscriptionId, state });
    } catch (err) { next(err); }
  });

  /**
   * ADR 0551 P2 — dispatch-outbox health.
   *
   * The queue is FLEET-SHARED (rows in storage), which is what makes this the
   * one Operations panel whose numbers are NOT per-instance — unlike the DLQ
   * and SSE reads above, which say so honestly. Stated in the response so the
   * console does not have to guess.
   *
   * Depths are whole-table aggregates from the adapter, not counts over the
   * `dead` page: a capped count under-reports exactly when the backlog is deep
   * enough for someone to be looking at it.
   *
   * Nothing here is secret. An outbox row carries ids, a state, an attempt
   * count and the host's own last-error string — no payload, no credential, no
   * caller input. `lastError` is written by this host (a workflow id, or the
   * redrive reason an operator typed), so it is projected as-is.
   */
  app.get(`${BASE}/dispatch-outbox/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const stats = await storage.dispatchOutboxStats();
      const dead = await storage.listDispatchOutbox({ status: 'dead', limit: RECENT_LIMIT });
      const now = Date.now();
      res.json({
        counts: { pending: stats.pending, dead: stats.dead },
        oldestPendingCreatedAt: stats.oldestPendingCreatedAt,
        oldestPendingAgeS: stats.oldestPendingCreatedAt
          ? Math.max(0, Math.round((now - Date.parse(stats.oldestPendingCreatedAt)) / 1000))
          : null,
        dead: dead.map((row) => ({
          runId: row.runId,
          tenantId: row.tenantId,
          workflowId: row.workflowId,
          attempts: row.attempts,
          lastError: row.lastError ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        deadSample: { limit: RECENT_LIMIT, truncated: stats.dead > RECENT_LIMIT },
        // The one Operations read that IS a fleet aggregate — the outbox is a
        // durable table, not this instance's memory.
        perInstance: false,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) { next(err); }
  });

  /**
   * ADR 0551 P2 — REDRIVE one `dead` dispatch intent.
   *
   * A CAS, not a read-then-write: `redriveDispatchOutbox` puts `status='dead'`
   * in the WHERE of the statement that writes, so two operators clicking at
   * once produce exactly ONE re-queued row. A legal-transition check performed
   * before the write would let both observe `dead` and both write `pending` —
   * the failure that has already produced a duplicated refund in this codebase.
   *
   * No new dispatcher: the row goes back on the queue the EXISTING sweeper
   * drains, with a fresh attempts budget, and the run-dispatch lease remains
   * the execution fence. `reason` is required and lands on the row itself, so
   * the queue carries WHY it was re-queued; the audit chain carries WHO.
   *
   * Superadmin-only, matching every other write on this surface. SoD is not
   * required (ADR 0551 does not put a second approver on this), but the action
   * is idempotent by construction, so a replayed request cannot double-queue.
   */
  app.post(`${BASE}/dispatch-outbox/:runId/redrive`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const runId = req.params.runId!;
      const reason = typeof (req.body ?? {}).reason === 'string' ? (req.body as { reason: string }).reason.trim() : '';
      if (!reason) {
        throw new OpenwopError('validation_error', '`reason` is required — a redrive is an operator overriding an exhausted attempt budget, and the row records why.', 400, { field: 'reason' });
      }
      const redriven = await storage.redriveDispatchOutbox(runId, Date.now(), `redriven by operator: ${reason}`);
      if (!redriven) {
        // Deliberately indistinguishable from "no such row": a second click and
        // a bad id are the same 404, and neither leaks whether a run exists.
        throw new OpenwopError('not_found', 'No dead dispatch intent for that run (already redriven, or never dead).', 404);
      }
      await storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.userId ?? req.principal?.principalId ?? 'superadmin',
        action: 'operations.dispatch-outbox.redrive',
        resource: runId,
        outcome: 'success',
        payload: { reason },
      });
      log.info('operations_dispatch_outbox_redrive', { runId, actor: req.userId ?? null });
      res.status(202).json({ redriven: true });
    } catch (err) { next(err); }
  });

  /**
   * ADR 0556 P2 — the SLO + ALERTS projection.
   *
   * ONE batched read carrying both the objective rows and the derived alerts,
   * not two routes: they are computed from the same snapshot in the same pass,
   * and splitting them would let a panel render an alert list that disagreed
   * with the rows beside it (two collections, two instants). The D2 rule — one
   * summary request per panel load — points the same way.
   *
   * SUPERADMIN-only through the SAME `requireSuperadmin` every other write and
   * cross-tenant read on this surface uses. No new predicate, and deliberately
   * no agent tool: a tool would need the identical predicate (the CLAUDE.md
   * "AI↔app" rule) and there is no ask for one, so the surface stays a route.
   *
   * NOTHING TENANT-SCOPED CAN LEAK HERE, structurally rather than by review.
   * Every value on this response comes from a metric attribute, and the ADR
   * 0556 P0 cardinality guard drops any attribute not in the metric's declared
   * closed label set — tenant, run, user, key and URL are all in
   * `FORBIDDEN_LABELS`, so there is no path by which one reaches the
   * aggregation this route reads. The projection re-exposes label VALUES only
   * through the objectives' own filters, which name literals from closed
   * domains owned by `metricSeams.ts`.
   */
  app.get(`${BASE}/slo/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      let snapshot = null;
      try {
        const rm = await collectLocalScrape();
        snapshot = rm ? flattenSnapshot(rm) : null;
      } catch (err) {
        // A collection failure is NOT "no data". Returning an empty snapshot
        // would render every objective as `unknown`, which is the answer for a
        // deliberately disabled profile — and an operator would read a broken
        // reader as a configuration choice they made. Typed failure instead.
        log.warn('operations_slo_collect_failed', { detail: err instanceof Error ? err.message : String(err) });
        sendError(res, 503, 'metrics_collection_failed',
          'The local metric scrape could not be collected, so no objective can be evaluated.');
        return;
      }
      // The AUTHORITATIVE queue numbers, from the same call the dispatch-outbox
      // panel above renders. Q1/Q2/Q4 read these rather than the gauges: the
      // gauge is point-in-time, observed only on instances that run the
      // sweeper, and frozen at its last value on instances that do not — so
      // reading it here would put two different numbers for one quantity on one
      // page. A failed read is `null`, which the projection reports as
      // `unknown`; it is emphatically not zero.
      const now = Date.now();
      let outbox = null;
      try {
        const stats = await storage.dispatchOutboxStats();
        outbox = {
          pending: stats.pending,
          dead: stats.dead,
          oldestAgeS: stats.oldestPendingCreatedAt
            ? Math.max(0, Math.round((now - Date.parse(stats.oldestPendingCreatedAt)) / 1000))
            : null,
        };
      } catch (err) {
        log.warn('operations_slo_outbox_read_failed', { detail: err instanceof Error ? err.message : String(err) });
      }
      res.json(projectSlos({
        snapshot,
        lastEmission: lastEmissionMap(),
        startedAtMs: localScrapeStartedAt(),
        outbox,
        seriesLimit: localScrapeCardinalityLimit(),
        nowMs: now,
      }));
    } catch (err) { next(err); }
  });

  /**
   * ADR 0550 P3 — deployment-attestation projection.
   *
   * READ-TIME drift detection, deliberately. The attestation binds a digest of
   * the discovery document at the moment it was signed; this endpoint re-digests
   * the LIVE document and compares. A background job would add a second owner
   * for "is the attestation still true" and would answer a question nobody
   * asked — expiry already covers the case where nobody looks.
   *
   * SUPERADMIN-only: ADR 0550's feature matrix puts detailed evidence in the
   * operator's hands and keeps the public claim (P4) out of this host entirely
   * while RFCs 0148/0155/0156 are Draft. Serving it publicly would be rendering
   * a claim in a vocabulary the corpus has not settled.
   *
   * Nothing secret is exposed because nothing secret is in the record: the
   * payload carries adapter KINDS, never a DSN or credential.
   */
  app.get(`${BASE}/attestation/summary`, async (req, res, next) => {
    try {
      requireSuperadmin(req);

      const path = process.env.OPENWOP_ATTESTATION_PATH;
      if (!path) {
        // ABSENT is a real, honest state — not an error and not a pass. An
        // operator must be able to tell "no attestation was produced" apart
        // from "one was produced and is valid".
        res.json({ state: 'absent', reason: 'OPENWOP_ATTESTATION_PATH is not configured' });
        return;
      }

      const { readFileSync } = await import('node:fs');
      const { verifyAttestation } = await import('../../host/deploymentAttestation.js');
      const { loadPinnedKeyring } = await import('../../host/packSignature.js');

      let signed: SignedAttestation;
      try {
        signed = JSON.parse(readFileSync(path, 'utf8')) as SignedAttestation;
      } catch (err) {
        res.json({ state: 'unreadable', reason: err instanceof Error ? err.message : String(err) });
        return;
      }

      // Verified against THIS host, which is the only host the claim is about.
      //
      // The advertisement is built IN-PROCESS, not fetched from our own
      // /.well-known/openwop. A route that requests itself must guess its own
      // port — wrong under a random-port test boot, fragile behind a proxy — and
      // spends a connection plus rate budget to learn something it already
      // knows. The first version did exactly that and the route test caught it
      // as a 500.
      //
      // It must be the SAME serialization the discovery route serves, or the
      // digest would differ for reasons unrelated to drift. Both call
      // `buildAdvertisement`; `JSON.stringify` of the same object is stable
      // because key order follows construction order.
      const selfCommit = (await import('../../host/buildInfo.js')).buildCommit();
      const { buildAdvertisement, readBundleSigningKeys } = await import('../../routes/discovery.js');
      // WHD-18 — the discovery route makes the certification-evidence cache
      // current before it builds (the pointer depends on it), so this must too:
      // otherwise the two could build from different cache states and the digest
      // would differ for a reason that is not drift. Bounded; a no-op unless
      // `OPENWOP_CERT_BUNDLE_ORIGIN` is set.
      const { ensureCertificationEvidence } = await import('../../host/conformanceClaims.js');
      await ensureCertificationEvidence(1, readBundleSigningKeys());
      const advertisement = buildAdvertisement(deps.config, req);
      const verdict = verifyAttestation(
        signed,
        { commit: selfCommit, discoveryDocument: JSON.stringify(advertisement) },
        { keyring: loadPinnedKeyring().keys },
      );

      // ADR 0556 P1 — assurance freshness. The age is recorded HERE, on the read,
      // rather than on a timer: this route is what an operator (and the P2
      // Operations panel) actually calls, and a manifest nobody reads has no
      // freshness problem worth alerting on. `absent`/`unreadable` return above
      // WITHOUT an observation — a manifest with no issuedAt has no age, and a
      // zero would read as "issued just now", the most reassuring possible value
      // for the most alarming possible state.
      recordAttestationAge({
        state: verdict.ok ? 'valid' : 'invalid',
        environmentClass: signed.payload?.environmentClass ?? 'unknown',
        ...(signed.payload?.issuedAt ? { issuedAt: signed.payload.issuedAt } : {}),
      });

      res.json({
        state: verdict.ok ? 'valid' : 'invalid',
        verdict,
        // Projection, not the raw record: enough for an operator to act, and
        // explicitly NOT the evidence counts, which belong to the signed file.
        attested: {
          commit: signed.payload?.build?.commit ?? null,
          commitSource: signed.payload?.build?.commitSource ?? null,
          environmentClass: signed.payload?.environmentClass ?? null,
          deployRevision: signed.payload?.build?.deployRevision ?? null,
          issuedAt: signed.payload?.issuedAt ?? null,
          expiresAt: signed.payload?.expiresAt ?? null,
          profileCount: Array.isArray(signed.payload?.profiles) ? signed.payload.profiles.length : null,
        },
      });
    } catch (err) { next(err); }
  });

  registerCompensationRecoveryRoutes(deps);
}

/* ── ADR 0554 P3 — compensation recovery (RFC 0151 §E) ─────────────────────
 *
 * ADR 0554's boundaries table puts "operator actions" on the EXISTING Operations
 * routes, which is why these live here rather than in a new feature package.
 *
 * THEY ARE GATED DIFFERENTLY FROM EVERY ROUTE ABOVE, and that is deliberate
 * rather than an inconsistency. The panels above are CROSS-TENANT health reads,
 * so they are `requireSuperadmin` with a uniform 404. A compensation plan
 * belongs to ONE tenant and its recovery actions are that tenant's operators'
 * to take, so they ride `requireTenantScope` with the three ADR 0554 P3 scopes.
 *
 * `requireTenantScope` is called UNMODIFIED, inheriting both of its escapes (the
 * wildcard-operator principal and the personal-workspace owner). Forking it to
 * strip one would create a second authorization predicate for one question — the
 * drift generator `accessControlService.ts` already records. The personal-owner
 * escape does mean these three scopes are VACUOUS in a solo personal workspace;
 * that is pre-existing and correct (one human, who is the owner), and the
 * separation-of-duties gate is what still bites there — a personal owner passes
 * this route and is then refused at the approval decision for a high-risk waive.
 */
function registerCompensationRecoveryRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  /** The obligation timeline for one run: rows + each row's audit history. */
  app.get(`${BASE}/runs/:runId/compensation`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      // A READ needs the weakest of the three. Reading which effects were left
      // un-undone is what an operator does BEFORE deciding, so gating it behind
      // the override scope would make the decision less informed, not safer.
      await requireTenantScope(req, 'host:compensation:start');

      const runId = req.params.runId ?? '';
      const run = await storage.getRun(runId);
      // Cross-tenant and non-existent answer IDENTICALLY (RFC 0132 §A.2).
      // Distinguishing them rebuilds the existence oracle the rule closes.
      if (!run || run.tenantId !== tenantOf(req)) {
        sendError(res, 404, 'not_found', 'run not found', { retriable: false });
        return;
      }

      const rows = await obligationsForRunTree(run.tenantId, run.runId);
      const timeline = await Promise.all(rows.map(async (o) => ({
        obligationId: o.inverseActionId,
        runId: o.runId,
        nodeId: o.nodeId ?? null,
        state: o.state,
        shape: o.shape,
        effectKind: o.effectKind,
        attempts: o.attempts,
        reason: o.reason ?? null,
        requiresApproval: o.requiresApproval === true,
        committedAt: o.committedAt,
        updatedAt: o.updatedAt,
        startedBy: o.startedBy ?? null,
        waiveApprovalId: o.waiveApprovalId ?? null,
        compensationOrdinal: o.compensationOrdinal,
        history: await recoveryHistory(o.tenantId, o.inverseActionId, o.recoveryAuditSeqs ?? []),
      })));

      res.json({
        runId: run.runId,
        compensationStatus: await compensationStatusForRunTree(run.tenantId, run.runId),
        // The tenant chain's own verdict, surfaced so the panel can say the
        // audit trail is intact rather than implying it by rendering rows.
        auditChain: await verifyChain(run.tenantId),
        obligations: timeline,
      });
    } catch (err) { next(err); }
  });

  /** Take one recovery action against one obligation. */
  app.post(`${BASE}/runs/:runId/compensation/actions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const action = body['action'];
      if (typeof action !== 'string' || !COMPENSATION_RECOVERY_ACTIONS.includes(action as CompensationRecoveryAction)) {
        sendError(res, 400, 'validation_error',
          `action must be one of ${COMPENSATION_RECOVERY_ACTIONS.join(' | ')}`, { retriable: false });
        return;
      }
      const recoveryAction = action as CompensationRecoveryAction;

      // THE PERMISSION IS ASKED FOR, NOT RESTATED. `scopeForRecoveryAction` is
      // the single owner of the action->scope map; a literal here would be the
      // second copy that drifts.
      await requireTenantScope(req, scopeForRecoveryAction(recoveryAction));

      const runId = req.params.runId ?? '';
      const run = await storage.getRun(runId);
      if (!run) {
        sendError(res, 404, 'not_found', 'run not found', { retriable: false });
        return;
      }

      // The SAME §E decision the §21 conformance seam runs — one predicate, so a
      // seam can never be more permissive than production. It also writes the
      // RFC 0049 `authorization.decided` record for the arms that get one.
      const actor = {
        tenantId: tenantOf(req),
        principalId: callerSubject(req) ?? req.principal?.principalId ?? '(unidentified)',
        operator: true, // authority was just proven by `requireTenantScope`
      };
      const decision = await decideCompensationOperatorAction({
        run,
        actor,
        // The §21 action set has no `start`; it is this host's own extension for
        // the P2 sweeper residue. `retry` is the closest §21 verb and is what
        // the audit record names, so the shared decision function keeps its
        // closed vocabulary.
        action: recoveryAction === 'start' ? 'retry' : recoveryAction,
      });
      if (!decision.allowed) {
        sendError(res, decision.status, decision.code,
          decision.code === 'not_found' ? 'run not found' : 'operator authority required',
          { retriable: false });
        return;
      }

      const obligationId = typeof body['obligationId'] === 'string' ? body['obligationId'] : '';
      const expectedState = body['expectedState'];
      if (!obligationId || typeof expectedState !== 'string') {
        sendError(res, 400, 'validation_error',
          'obligationId and expectedState are required (expectedState is the state you saw — it is how a lost race is detected)',
          { retriable: false });
        return;
      }

      const result = await applyRecoveryAction({
        tenantId: run.tenantId,
        runId: run.runId,
        obligationId,
        action: recoveryAction,
        actor: actor.principalId,
        expectedState: expectedState as CompensationState,
        ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
        resume: async () => {
          const { resumeUnwindForOperator, resolveDefinitionForRun } =
            await import('../../host/compensationRuntime.js');
          const definition = await resolveDefinitionForRun(run);
          // "Cannot resume" is NOT "nothing to resume". The obligations stay
          // owed and durable; the row is already witnessed at `started` with the
          // audit entry that authorized it, so an operator sees an action that
          // began and did not finish rather than one that silently no-opped.
          if (!definition) {
            log.warn('compensation_recovery_definition_unresolved', {
              runId: run.runId, workflowId: run.workflowId,
            });
            return;
          }
          await resumeUnwindForOperator({
            storage,
            run,
            definition,
            ...(recoveryAction === 'substitute' && typeof body['nodeTypeId'] === 'string'
              ? { substituteNodeTypeId: body['nodeTypeId'] }
              : {}),
          });
        },
      });

      if (result.outcome === 'approval-pending') {
        // 409 `approval_required` is the EXISTING typed code for "a human gate
        // opened; retry the same call after the decision" (ADR 0217). A 200 here
        // would report a waive that nobody has authorized.
        sendError(res, 409, 'approval_required',
          'This obligation was declared approval-gated; the waive is parked for a second human.',
          { retriable: true, approvalId: result.approvalId, approvalStatus: 'pending' });
        return;
      }

      res.status(200).json({
        runId: run.runId,
        obligationId,
        action: recoveryAction,
        state: result.state,
        auditSeq: result.auditSeq,
        compensationStatus: await compensationStatusForRunTree(run.tenantId, run.runId),
      });
    } catch (err) { next(err); }
  });
}
