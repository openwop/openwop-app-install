/**
 * Operations console client (ADR 0395). ONE batched summary request per panel
 * load (the D2 rate-limit rule) — never a per-row fetch. The superadmin
 * cross-tenant read is REFUSED for everyone else, so the panel tries it first
 * and falls back to the caller's org-scoped summary.
 *
 * > **CORRECTED 2026-08-17 (ADR 0556 P2).** This said the cross-tenant read
 * > "404s uniformly". It does not — `requireSuperadmin` answers **403**. The
 * > difference is a security property, not a wording nicety: a uniform 404
 * > hides whether the surface exists at all, and 403 does not. Every consumer
 * > here keys off `res.ok` or an explicit `status === 403`, so nothing behaved
 * > on the false claim; a reader reasoning about disclosure would have.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = () => `${config.baseUrl}/host/openwop-app/operations`;

export interface OpsDelivery {
  deliveryId: string;
  subscriptionId: string;
  eventType: string;
  url: string;
  status: 'pending' | 'delivered' | 'dead';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}
export interface OpsWebhookRow {
  subscriptionId: string;
  tenantId: string;
  url: string;
  events: string[];
  tags?: string[];
  counts: { pending: number; dead: number; delivered: number };
  recent: OpsDelivery[];
}
export interface OpsTriggerSubscription {
  subscriptionId: string;
  tenantId: string;
  source: string;
  label?: string;
  state: 'active' | 'paused' | 'failed' | 'dead-lettered';
  recentDeliveries: Array<{ deliveryId: string; outcome: string; at: string; runId?: string }>;
}
export interface WebhookSummary {
  webhooks: OpsWebhookRow[];
  triggerSubscriptions: OpsTriggerSubscription[];
  fetchedAt: string;
  /** true when the cross-tenant (superadmin) view answered. */
  crossTenant: boolean;
}

/** GRADE-UX 2026-07-17 — errors carry the HTTP status so callers can detect
 *  the operator-only 403 STRUCTURALLY (never by matching message text, which
 *  breaks under wording changes or localization). */
export class OperationsRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /**
     * The canonical flat-envelope `error` code, when the server sent one.
     *
     * Carried so a caller can branch on the CODE rather than on the message
     * text — `version_conflict` and `approval_required` are different outcomes
     * that share a 409, and matching prose would break the moment a message is
     * reworded or localized.
     */
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OperationsRequestError';
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string; error?: string; details?: Record<string, unknown>;
    };
    throw new OperationsRequestError(
      body.message ?? `${ctx} failed (${res.status})`,
      res.status,
      body.error,
      body.details,
    );
  }
  return (await res.json()) as T;
}

export async function getWebhookSummary(orgId: string | null): Promise<WebhookSummary> {
  // Superadmin first, then own-org. NOT a "uniform 404" despite what this
  // comment used to say — `requireSuperadmin` answers 403 (corrected 2026-08-17,
  // ADR 0556 P2). The fallback below keys off `res.ok`, so it is unaffected by
  // which refusal code arrives; the wording was the only thing wrong.
  const global = await fetch(`${BASE()}/webhooks/summary`, fetchOpts({ headers: authedHeaders() }));
  if (global.ok) return { ...(await (global.json() as Promise<Omit<WebhookSummary, 'crossTenant'>>)), crossTenant: true };
  if (!orgId) throw new Error('No organization available for the webhook summary.');
  const res = await fetch(`${BASE()}/orgs/${encodeURIComponent(orgId)}/webhooks/summary`, fetchOpts({ headers: authedHeaders() }));
  return { ...(await asJson<Omit<WebhookSummary, 'crossTenant'>>(res, 'webhook summary')), crossTenant: false };
}

export interface DlqSummary {
  subjects: Array<{ tenantId: string; subject: string; depth: number; reasons: string[]; messageIds: string[] }>;
  backend: 'memory' | 'durable';
  perInstance: boolean;
  pointInTime: boolean;
  fetchedAt: string;
}
export interface HealthSummary {
  status: 'ready' | 'degraded';
  version: string;
  // UX-OPS-2 — `managedProviders` was typed `unknown`, so the console could not
  // render it and silently dropped it. The backend surfaces this block
  // deliberately (routes/health.ts: an unconfigured managed provider "used to be
  // invisible until a user ran a workflow"), and it is frequently the ONLY
  // explanation for a `degraded` status when storage + config are both ok.
  checks: {
    managedProviders?: Array<{ providerId: string; ready: boolean; detail?: string }>;
    config: { ok: boolean; error?: string };
    storage: { ok: boolean; error?: string };
    // Optional — absent on revisions older than this field. Three-valued on
    // purpose: `probeError` present means the vault could NOT be read, which is
    // "unknown", not "no key". Typing it (rather than leaving it off, the UX-OPS-2
    // mistake above) is what lets the console render it at all.
    webSearch?: { configured: boolean; source: 'host-vault' | 'env' | null; probeError?: string };
  };
  sse: { totalStreams: number; keys: number; max: number; top: Array<{ key: string; streams: number }> };
  rateLimits: { ipReqsPerMin: number; /** ADR 0640 — absent on a backend older than it. */ ipReadReqsPerMin?: number; sessionRunsPerMin: number; sessionRunsPerDay: number; sessionConcurrent: number; ipRunsPerDay: number; mcpPrincipalReqsPerMin: number };
  daemon: Record<string, unknown>;
  perInstance: boolean;
  fetchedAt: string;
}

export async function getDlqSummary(): Promise<DlqSummary> {
  const res = await fetch(`${BASE()}/dlq/summary`, fetchOpts({ headers: authedHeaders() }));
  return asJson<DlqSummary>(res, 'DLQ summary');
}

export async function getHealthSummary(): Promise<HealthSummary> {
  const res = await fetch(`${BASE()}/health/summary`, fetchOpts({ headers: authedHeaders() }));
  return asJson<HealthSummary>(res, 'health summary');
}

export async function replayDlqMessage(tenantId: string, subject: string, messageId: string): Promise<void> {
  const res = await fetch(`${BASE()}/dlq/replay`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ tenantId, subject, messageId }) }));
  await asJson(res, 'replay DLQ message');
}

/** ADR 0551 P2 — the durable dispatch outbox. Unlike the DLQ and SSE reads,
 *  these numbers are a FLEET aggregate: the outbox is a table, not this
 *  instance's memory. `perInstance` is on the wire so the console never has to
 *  assume it. */
export interface OutboxDeadRow {
  runId: string;
  tenantId: string;
  workflowId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OutboxSummary {
  counts: { pending: number; dead: number };
  oldestPendingCreatedAt: string | null;
  oldestPendingAgeS: number | null;
  dead: OutboxDeadRow[];
  deadSample: { limit: number; truncated: boolean };
  perInstance: boolean;
  fetchedAt: string;
}

export async function getOutboxSummary(): Promise<OutboxSummary> {
  const res = await fetch(`${BASE()}/dispatch-outbox/summary`, fetchOpts({ headers: authedHeaders() }));
  return asJson<OutboxSummary>(res, 'dispatch-outbox summary');
}

/** Re-queue ONE dead dispatch intent. The reason is required by the route and
 *  lands on the row itself, so the queue records why it was redriven. */
export async function redriveOutboxIntent(runId: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE()}/dispatch-outbox/${encodeURIComponent(runId)}/redrive`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ reason }),
  }));
  await asJson(res, 'redrive dispatch intent');
}

/**
 * ADR 0556 P2 — the SLO + alerts projection.
 *
 * ONE read carrying both the objective rows and the alerts derived from them:
 * they come off the same metric snapshot in the same pass, so fetching them
 * separately would let the panel render an alert list that disagreed with the
 * rows beside it.
 *
 * `perInstance` is ALWAYS true here and the field exists so the console cannot
 * forget it. `docs/SLO.md` declares a 28-day rolling, fleet-wide window; the
 * host reads its own in-process instruments, cumulative since boot, on one
 * instance. Rendering that as SLO attainment would be wrong in the most
 * flattering direction — a freshly restarted instance shows 100% availability
 * off four requests — so the panel shows the window and the sample count.
 */
export type SloState = 'healthy' | 'breaching' | 'empty' | 'stale' | 'unknown' | 'degraded' | 'not_projectable';

export interface SloRow {
  id: string;
  group: string;
  metric: string;
  sli: string;
  state: SloState;
  /** Which number answered — the in-process instruments, or the queue table.
   *  Surfaced because "which of the two numbers is this" is exactly what a
   *  duplicated quantity makes an operator ask. */
  source: 'local-scrape' | 'dispatch-outbox-stats' | 'none';
  observed: number | null;
  target: number;
  comparison: 'at_most' | 'at_least';
  unit: 'ratio' | 'seconds' | 'count';
  /** For a percentile row: the seconds bound the share is taken at. */
  thresholdS?: number;
  sampleCount: number;
  lastSampleAt: number | null;
  freshnessS: number | null;
  severity: 'page' | 'ticket';
  runbook: string;
  caveat?: string;
  reason?: string;
}

export interface SloAlert {
  id: string;
  severity: 'page' | 'ticket';
  kind: 'breach' | 'stale' | 'degraded';
  summary: string;
  runbook: string;
}

export interface SloSummary {
  /** `unavailable` means the local-scrape operator profile is off, so every
   *  row is `unknown` — which is NOT a health claim. */
  source: 'local-scrape' | 'unavailable';
  window: { kind: 'process_uptime'; startedAt: string | null; seconds: number | null };
  perInstance: boolean;
  /** Distinct series held by the reader, its ceiling, and whether the SDK
   *  folded any away into an overflow bucket. */
  series: { count: number; limit: number; overflowed: boolean };
  rows: SloRow[];
  alerts: SloAlert[];
  runbookDoc: string;
  fetchedAt: string;
}

export async function getSloSummary(): Promise<SloSummary> {
  const res = await fetch(`${BASE()}/slo/summary`, fetchOpts({ headers: authedHeaders() }));
  return asJson<SloSummary>(res, 'SLO summary');
}

export async function retryDelivery(deliveryId: string): Promise<void> {
  const res = await fetch(`${BASE()}/webhooks/deliveries/${encodeURIComponent(deliveryId)}/retry`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }) }));
  await asJson(res, 'retry delivery');
}

export async function setTriggerSubscriptionState(subscriptionId: string, state: 'active' | 'paused'): Promise<void> {
  const res = await fetch(`${BASE()}/trigger-subscriptions/${encodeURIComponent(subscriptionId)}/state`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ state }) }));
  await asJson(res, 'set subscription state');
}

/* ── ADR 0554 P3 — compensation recovery (RFC 0151 §E) ─────────────────────
 *
 * Tenant-scoped, unlike every read above (which are cross-tenant superadmin
 * summaries). They live in this client because the ROUTES are Operations
 * routes — ADR 0554's boundaries table puts operator actions there — even
 * though the UI that calls them is the run-detail panel.
 */

/** One entry of an obligation's recovery-audit history. */
export interface CompensationAuditRecord {
  seq: number;
  at: string;
  entryHash: string;
  /**
   * FALSE means the action was RECORDED BUT NEVER APPLIED — the window between
   * the audit append and the ledger write. It is a real state, not a rendering
   * detail, and the panel says so rather than showing it as a completed act.
   */
  applied: boolean;
  payload: {
    obligationId: string;
    runId: string;
    action: string;
    actor: string;
    requiredScope: string;
    reason?: string;
    priorState: string;
    /** What was ASKED FOR. Never a claim that the state was reached. */
    requestedState: string;
    prevSeq: number | null;
    prevEntryHash: string | null;
  };
}

export type CompensationObligationState =
  | 'requested' | 'started' | 'completed' | 'failed' | 'paused' | 'manual_intervention_required';

export interface CompensationObligationRow {
  obligationId: string;
  runId: string;
  nodeId: string | null;
  state: CompensationObligationState;
  shape: string;
  effectKind: string;
  attempts: number;
  reason: string | null;
  requiresApproval: boolean;
  committedAt: string;
  updatedAt: string;
  startedBy: string | null;
  waiveApprovalId: string | null;
  compensationOrdinal: number;
  history: CompensationAuditRecord[];
}

export interface RunCompensation {
  runId: string;
  compensationStatus: string;
  /** The tenant hash-chain's own verdict, so the panel can state the audit
   *  trail is intact instead of implying it by rendering rows. */
  auditChain: { ok: boolean; brokenAt?: number };
  obligations: CompensationObligationRow[];
}

export type CompensationRecoveryAction = 'start' | 'retry' | 'skip' | 'substitute' | 'terminate';

export async function getRunCompensation(runId: string): Promise<RunCompensation> {
  const res = await fetch(
    `${BASE()}/runs/${encodeURIComponent(runId)}/compensation`,
    fetchOpts({ headers: authedHeaders() }),
  );
  return asJson<RunCompensation>(res, 'run compensation');
}

/**
 * Take one recovery action.
 *
 * `expectedState` is REQUIRED and is the state the panel last showed. It is how
 * a lost race is detected: the server refuses with `version_conflict` (409) if
 * the row moved, rather than letting two operators both act on one obligation.
 */
export async function postRunCompensationAction(input: {
  runId: string;
  obligationId: string;
  action: CompensationRecoveryAction;
  expectedState: CompensationObligationState;
  reason?: string;
  nodeTypeId?: string;
}): Promise<{ state: string; auditSeq: number; compensationStatus: string }> {
  const { runId, ...body } = input;
  const res = await fetch(
    `${BASE()}/runs/${encodeURIComponent(runId)}/compensation/actions`,
    fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
  );
  return asJson(res, 'compensation recovery action');
}
