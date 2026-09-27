/**
 * Host-event dispatcher (ADR 0208 §1) — the ONE seam for record-change events
 * that have no run. Two fanouts per emit:
 *
 *   1. Outbound webhooks — the SAME subscription matching + signed durable
 *      delivery as run events (`routes/webhooks.ts`), with the tenant supplied
 *      by the EMITTER (a service mutation knows its tenant; there is no run to
 *      derive it from). Event types are host-extension-namespaced per RFC 0086
 *      §E (`host.crm.contact.created`, …) — never canonical RunEventTypes.
 *
 *   2. Workflow triggers — implements the `core.trigger.event` contract the
 *      trigger pack has always declared ("the host's event bus dispatches to
 *      the workflow when a matching event name fires") but no host layer ever
 *      built: exact-match (tenantId, eventType) against the durable host-event
 *      binding registry, then start each bound workflow through the shared
 *      `startWorkflowRun` recipe with `metadata.triggerData` set — the field
 *      `core.trigger.event` forwards as `ctx.triggerData`. Autonomous-run
 *      budgets apply exactly as schedule fires do.
 *
 * Deliberately NOT the run event log: `EventRecord.runId` is required and
 * webhook tenant scoping is run-derived (`routes/webhooks.ts:246`) — a
 * sentinel runId would corrupt per-run sequences and collapse scoping to
 * 'default'. And deliberately NOT an extension of the RFC 0099
 * `/v1/trigger-subscriptions` source enum — that is wire-governed and would
 * need an RFC; the binding registry below is host-ext only.
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { checkAutonomousRunBudget } from './runBudgetService.js';
import type { StartRunDeps } from './runStarter.js';

const log = createLogger('host.events');

/**
 * ADR 0617 D1a — where an emit ORIGINATED when it came from inside a workflow
 * run (a feature surface called by a node). The binding loop below skips any
 * binding whose `workflowId` equals `origin.workflowId`: without it, a run of
 * chain X whose node emits an event X is bound to would start a SECOND run of
 * X, and that run's ungated entry nodes would fire again (the review's
 * BLOCKER-2). Stamped only by the emitting surface; never a webhook field.
 */
export interface HostEventOrigin {
  runId?: string;
  workflowId?: string;
  /** ADR 0617 D1a (review BLOCKER-1 correction) — the CHAIN the emitting run's
   *  definition was expanded from (`definition.metadata.expandedFrom.chainId`).
   *  A from-chain instance is minted PER PARAMETER SET (`workflowId =
   *  chainId:expansionId`, RFC 0013 Path A), so a tenant with two instances of
   *  the same chain (one per departing employee) and a binding on either would
   *  still be re-triggered by the instance-id compare alone: a run of B emits,
   *  B ≠ A, A starts, A's ungated entry nodes fire for the WRONG employee. The
   *  loop therefore also skips a binding whose workflow shares this lineage. */
  chainId?: string;
}

export interface HostEvent {
  /** Host-extension event type, e.g. `host.crm.deal.stage-changed` (RFC 0086 §E). */
  type: string;
  tenantId: string;
  /** Ids-only by convention — never PII bodies (receivers re-fetch under authz). */
  payload: Record<string, unknown>;
  /** ADR 0617 D1a — the emitting run, when the emit came from a workflow surface. */
  origin?: HostEventOrigin;
}

/** A delivered host event (the webhook POST body). `origin` is NOT delivered —
 *  it is dispatcher routing state (ADR 0617 D1a), not part of the wire body. */
export interface HostEventEnvelope extends Omit<HostEvent, 'origin'> {
  eventId: string;
  timestamp: string;
}

/** Durable event→workflow binding (ADR 0208 §1). */
export interface HostEventBinding {
  bindingId: string;
  tenantId: string;
  eventType: string;
  workflowId: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Tenant secondary index armed (audit CRMGAP-3): emitHostEvent runs on EVERY
// CRM/CSM/email mutation — the binding lookup must be a bounded per-tenant
// slice, never a full cross-tenant scan.
const bindings = new DurableCollection<HostEventBinding>('hostevent:binding', (b) => b.bindingId, undefined, (b) => b.tenantId);

export const MAX_BINDINGS_PER_TENANT = 200;

export async function listHostEventBindings(tenantId: string): Promise<HostEventBinding[]> {
  return bindings.listForTenantIndexed(tenantId);
}

export async function createHostEventBinding(input: {
  tenantId: string;
  eventType: string;
  workflowId: string;
  createdBy: string;
}): Promise<HostEventBinding> {
  const ts = new Date().toISOString();
  const b: HostEventBinding = {
    bindingId: `hevb:${randomUUID()}`,
    tenantId: input.tenantId,
    eventType: input.eventType,
    workflowId: input.workflowId,
    enabled: true,
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await bindings.put(b);
  return b;
}

export async function deleteHostEventBinding(tenantId: string, bindingId: string): Promise<boolean> {
  const b = await bindings.get(bindingId);
  if (!b || b.tenantId !== tenantId) return false;
  await bindings.delete(bindingId);
  return true;
}

/** Flip a binding's `enabled` flag (the admin-UI toggle). Tenant-guarded like
 *  delete: a cross-tenant bindingId resolves `null` (never leaks existence). */
export async function updateHostEventBindingEnabled(
  tenantId: string,
  bindingId: string,
  enabled: boolean,
): Promise<HostEventBinding | null> {
  const b = await bindings.get(bindingId);
  if (!b || b.tenantId !== tenantId) return null;
  const updated: HostEventBinding = { ...b, enabled, updatedAt: new Date().toISOString() };
  await bindings.put(updated);
  return updated;
}

interface DispatcherDeps extends StartRunDeps {
  /** The webhook fanout seam exported by routes/webhooks.ts (injected at boot
   *  so host/ does not import routes/ — layering stays routes → host). */
  deliverWebhooks: (event: HostEventEnvelope) => Promise<void>;
  /** Shared run starter (`host/runStarter.startWorkflowRun`), injected for the
   *  same reason + test seams. */
  startRun: (
    deps: StartRunDeps,
    input: { tenantId: string; workflowId: string; metadata?: Record<string, unknown> },
  ) => Promise<string | null>;
}

let deps: DispatcherDeps | null = null;

export function initHostEventDispatcher(d: DispatcherDeps): void {
  deps = d;
}

/** Test-only seam. */
export function __resetHostEventDispatcher(): void {
  deps = null;
}

/**
 * Person-PII markers stripped from EVERY host-event payload before any fanout
 * (CRMGAP-16 — ADR 0208 §1 correction, 2026-07-03): the "ids-only" payload
 * discipline was convention-only, and the seam's first external consumer
 * (`campaign-brief/briefService.ts`) already shipped a content field
 * (`name`). Rather than "ids only" (unenforceable — an id-shaped string
 * carries no signal distinguishing an artifact id from a person id), the
 * ENFORCEABLE rule this strips to is "no person-PII fields": exact `email`/
 * `phone` keys, plus any key ENDING `Email`/`Phone` (e.g. `contactEmail`) —
 * unambiguous person-PII markers. A non-person artifact's `name` (a campaign
 * brief title, a template name, an entity label, …) is explicitly ALLOWED —
 * brief/template names are not PII-declared (see `declarePiiFields` call
 * sites) and are the established precedent this rule codifies, not breaks.
 */
const PII_PAYLOAD_KEY = /^email$|^phone$|Email$|Phone$/;

/** Strip PII-marker keys from a payload; log once (with the stripped key
 *  names, never their values) when anything was removed. */
function stripPiiPayload(payload: Record<string, unknown>, type: string): Record<string, unknown> {
  const stripped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PII_PAYLOAD_KEY.test(key)) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }
  if (stripped.length > 0) {
    log.warn('host_event_payload_pii_stripped', { type, keys: stripped });
  }
  return out;
}

/** The chain a definition was expanded from (`expandedFrom.chainId`, with the
 *  loader's sibling `metadata.chainId` as the fallback stamp), or undefined for
 *  an authored workflow. */
export function chainIdOfDefinition(definition: { metadata?: unknown } | null | undefined): string | undefined {
  const meta = definition?.metadata as { expandedFrom?: { chainId?: unknown }; chainId?: unknown } | undefined;
  const fromExpansion = meta?.expandedFrom?.chainId;
  if (typeof fromExpansion === 'string' && fromExpansion.length > 0) return fromExpansion;
  return typeof meta?.chainId === 'string' && meta.chainId.length > 0 ? meta.chainId : undefined;
}

/** Does the BOUND workflow descend from `chainId`? A catalog miss or an
 *  unreadable definition answers `false` — the binding then proceeds to
 *  `startRun`, which resolves (and refuses) the same id on its own path; this
 *  guard never widens what a binding can start, it only narrows it. */
async function boundWorkflowSharesChain(workflowId: string, chainId: string): Promise<boolean> {
  if (!deps) return false;
  try {
    const wf = await deps.hostSuite.workflowCatalog.getWorkflow(workflowId);
    return chainIdOfDefinition(wf?.definition) === chainId;
  } catch (err) {
    log.warn('host_event_lineage_resolve_failed', { workflowId, chainId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Emit one host event. Fire-and-forget by contract: NEVER throws — a webhook
 * or trigger failure must not fail the mutation that emitted it. Callers may
 * `void emitHostEvent(...)` safely.
 */
export async function emitHostEvent(event: HostEvent): Promise<void> {
  try {
    if (!deps) return; // pre-boot / minimal test app — nothing to fan out to.
    // CRMGAP-16: strip ONCE, before either fanout, so webhooks AND
    // `metadata.triggerData` (below) both only ever see the safe payload.
    const safePayload = stripPiiPayload(event.payload, event.type);
    const { origin, ...wireEvent } = event;
    const envelope: HostEventEnvelope = {
      ...wireEvent,
      payload: safePayload,
      eventId: `hev:${randomUUID()}`,
      timestamp: new Date().toISOString(),
    };
    await deps.deliverWebhooks(envelope).catch((err) => {
      log.warn('host_event_webhook_fanout_failed', { type: event.type, error: err instanceof Error ? err.message : String(err) });
    });
    const matched = (await bindings.listForTenantIndexed(event.tenantId)).filter(
      (b) => b.enabled && b.eventType === event.type,
    );
    for (const binding of matched) {
      // ADR 0617 D1a — self-trigger guard. An event emitted from INSIDE a run of
      // the bound workflow must not start another run of that same workflow.
      if (origin?.workflowId !== undefined && origin.workflowId === binding.workflowId) {
        log.info('host_event_self_trigger_skipped', {
          type: event.type,
          tenantId: event.tenantId,
          workflowId: binding.workflowId,
          bindingId: binding.bindingId,
          ...(origin.runId ? { runId: origin.runId } : {}),
        });
        continue;
      }
      // ADR 0617 D1a, review BLOCKER-1 — chain LINEAGE guard. The instance-id
      // compare above cannot see two from-chain instances of the SAME chain
      // (each parameter set mints its own `chainId:expansionId`), so a run of
      // instance B would start instance A and fire A's ungated entry nodes with
      // A's frozen params. Resolved ONLY when the emit carries a chain origin
      // (the admin/SCIM lanes pay no read); the bound definition's stamp is the
      // honest source (`expandedFrom.chainId`), not the id's spelling — a
      // builder copy keeps the stamp and drops the `chainId:` prefix.
      if (origin?.chainId !== undefined && await boundWorkflowSharesChain(binding.workflowId, origin.chainId)) {
        log.info('host_event_chain_lineage_skipped', {
          type: event.type,
          tenantId: event.tenantId,
          workflowId: binding.workflowId,
          bindingId: binding.bindingId,
          chainId: origin.chainId,
          ...(origin.runId ? { runId: origin.runId } : {}),
        });
        continue;
      }
      const budget = await checkAutonomousRunBudget(deps.storage, event.tenantId, Date.now());
      if (!budget.allowed) {
        log.warn('host_event_trigger_dropped_over_budget', { type: event.type, tenantId: event.tenantId, workflowId: binding.workflowId });
        continue;
      }
      // ADR 0482 grade-fix H1 — a PER-BINDING catch: ADR 0482 §5 changed
      // startWorkflowRun's budget-exhausted signal from a null return to a
      // typed 429 THROW. In this shared fan-out loop that throw would abort
      // the whole batch, so ONE hard-capped workflow silently suppressed
      // every OTHER workflow bound to the same event. Isolate each binding —
      // a budget refusal (or any dispatch error) drops just that one.
      try {
        const runId = await deps.startRun(deps, {
          tenantId: event.tenantId,
          workflowId: binding.workflowId,
          metadata: {
            triggerData: { eventName: event.type, payload: safePayload },
            hostEvent: { eventId: envelope.eventId, bindingId: binding.bindingId },
          },
        });
        if (runId) log.info('host_event_triggered_run', { type: event.type, workflowId: binding.workflowId, runId });
      } catch (err) {
        const reason = err instanceof OpenwopError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : (err instanceof Error ? err.message : String(err));
        log.warn('host_event_binding_dispatch_failed', { type: event.type, workflowId: binding.workflowId, bindingId: binding.bindingId, reason });
      }
    }
  } catch (err) {
    log.warn('host_event_emit_failed', { type: event.type, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Test-only: clear bindings. */
export async function __clearHostEventBindings(): Promise<void> {
  await bindings.__clear();
}
