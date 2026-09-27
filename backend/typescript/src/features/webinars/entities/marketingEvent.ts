/**
 * Webinar marketing-event entity (ADR 0404 §a) — a lightweight aggregate over a
 * provider webinar (Zoom v1). KV-blob DurableCollection over host_ext_kv (no SQL
 * migration). Stores METADATA only; the registrant/attendee/no-show COUNTS are
 * derived on read from the CRM activity stream (single source of truth, race-safe
 * — never a stored counter two ingestion lanes could double-increment).
 *
 * A separate form→event binding store maps a registration FormDef to its event
 * (the forms feature owns FormDef and is left unmodified — this binding lives in
 * the webinars package).
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';

export interface MarketingEvent {
  /** `${tenantId}:${provider}:${providerEventId}` — TENANT-scoped so two tenants
   *  using the same provider webinar id never collide; stable across both lanes. */
  eventId: string;
  tenantId: string;
  orgId: string;
  provider: string; // 'zoom'
  providerEventId: string;
  title: string;
  startsAt?: string;
  /** The connection this event's registrant writes + backfill go through. */
  connectionId?: string;
  /** Bound registration form (webinar submission sink pushes registrants). */
  formId?: string;
  /** A journey chain enrolled on attendance (metadata for the dashboard). */
  journeyId?: string;
  createdAt: string;
  updatedAt: string;
}

function isMarketingEvent(v: unknown): MarketingEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.eventId !== 'string' || typeof e.tenantId !== 'string' || typeof e.orgId !== 'string' || typeof e.providerEventId !== 'string') return null;
  return v as MarketingEvent;
}

const events = new DurableCollection<MarketingEvent>('webinars:event', (e) => e.eventId, isMarketingEvent, (e) => e.tenantId);

export function marketingEventId(tenantId: string, provider: string, providerEventId: string): string {
  return `${tenantId}:${provider}:${providerEventId}`;
}

export async function getMarketingEvent(tenantId: string, orgId: string, eventId: string): Promise<MarketingEvent | null> {
  const e = await events.get(eventId);
  return e && e.tenantId === tenantId && e.orgId === orgId ? e : null;
}

/** By provider event id WITHOUT the org guard — the webhook observer resolves the
 *  event from the provider id + the connection's tenant (org is on the row). */
export async function getMarketingEventByProviderId(tenantId: string, provider: string, providerEventId: string): Promise<MarketingEvent | null> {
  const e = await events.get(marketingEventId(tenantId, provider, providerEventId));
  return e && e.tenantId === tenantId ? e : null;
}

export async function listMarketingEvents(tenantId: string, orgId: string): Promise<MarketingEvent[]> {
  return (await events.listForTenantIndexed(tenantId))
    .filter((e) => e.orgId === orgId)
    .sort((a, b) => (b.startsAt ?? b.createdAt).localeCompare(a.startsAt ?? a.createdAt));
}

/** Upsert a marketing event (idempotent on the provider event id). First writer
 *  sets orgId/connectionId; later writers patch metadata (title/startsAt) without
 *  clobbering the binding. */
export async function upsertMarketingEvent(input: {
  tenantId: string;
  orgId: string;
  provider: string;
  providerEventId: string;
  title?: string;
  startsAt?: string;
  connectionId?: string;
  formId?: string;
  journeyId?: string;
}): Promise<MarketingEvent> {
  if (!input.providerEventId) throw new OpenwopError('validation_error', 'providerEventId is required.', 400, {});
  const eventId = marketingEventId(input.tenantId, input.provider, input.providerEventId);
  const now = new Date().toISOString();
  const existing = await events.get(eventId);
  if (existing) {
    if (existing.tenantId !== input.tenantId) throw new OpenwopError('not_found', 'Event not found.', 404, {});
    const next: MarketingEvent = {
      ...existing,
      ...(input.title ? { title: input.title } : {}),
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.formId !== undefined ? { formId: input.formId } : {}),
      ...(input.journeyId !== undefined ? { journeyId: input.journeyId } : {}),
      updatedAt: now,
    };
    await events.put(next);
    return next;
  }
  const created: MarketingEvent = {
    eventId,
    tenantId: input.tenantId,
    orgId: input.orgId,
    provider: input.provider,
    providerEventId: input.providerEventId,
    title: input.title ?? `Webinar ${input.providerEventId}`,
    ...(input.startsAt ? { startsAt: input.startsAt } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.formId ? { formId: input.formId } : {}),
    ...(input.journeyId ? { journeyId: input.journeyId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await events.put(created);
  return created;
}

export async function deleteMarketingEvent(tenantId: string, orgId: string, eventId: string): Promise<boolean> {
  const e = await getMarketingEvent(tenantId, orgId, eventId);
  if (!e) return false;
  return events.delete(eventId);
}

// ── form → event binding (forms feature stays unmodified) ────────────────────

interface FormBinding { formId: string; tenantId: string; orgId: string; eventId: string; connectionId?: string }
const formBindings = new DurableCollection<FormBinding>('webinars:form-binding', (b) => b.formId, undefined, (b) => b.tenantId);

export async function bindFormToEvent(tenantId: string, orgId: string, formId: string, eventId: string, connectionId?: string): Promise<void> {
  // R2 WB-SP-3 — a rebind SUPERSEDES in both directions:
  // 1. This form previously bound to a DIFFERENT event → that event's `formId`
  //    pointer must not dangle (the chip kept rendering a dead link).
  const prior = await getFormBinding(tenantId, formId);
  if (prior && prior.eventId !== eventId) {
    const prevEvent = await getMarketingEvent(tenantId, prior.orgId, prior.eventId);
    if (prevEvent && prevEvent.formId === formId) {
      const { formId: _drop, ...rest } = prevEvent;
      await events.put({ ...rest, updatedAt: new Date().toISOString() });
    }
  }
  // 2. This EVENT previously bound to a different form → that form's binding
  //    row must die, or the "unlinked" form keeps registering people into the
  //    webinar forever. Tenant-INDEXED scan (review M1): listByPrefix('') pulled
  //    every tenant's rows into memory — the ADR 0513 lesson, with the bounded
  //    capability declared on this very collection.
  const all = await formBindings.listForTenantIndexed(tenantId);
  for (const b of all) {
    if (b.tenantId === tenantId && b.eventId === eventId && b.formId !== formId) {
      await formBindings.delete(b.formId);
    }
  }
  await formBindings.put({ formId, tenantId, orgId, eventId, ...(connectionId ? { connectionId } : {}) });
}

export async function getFormBinding(tenantId: string, formId: string): Promise<FormBinding | null> {
  const b = await formBindings.get(formId);
  return b && b.tenantId === tenantId ? b : null;
}

export async function unbindForm(tenantId: string, formId: string): Promise<boolean> {
  const b = await getFormBinding(tenantId, formId);
  if (!b) return false;
  await formBindings.delete(formId);
  // Also clear the pointer on the event, so a deleted/unbound form leaves NO
  // dangling `formId` behind (grade-data WEB-2). The binding carries the event.
  const e = await getMarketingEvent(tenantId, b.orgId, b.eventId);
  if (e && e.formId === formId) {
    const { formId: _drop, ...rest } = e;
    await events.put({ ...rest, updatedAt: new Date().toISOString() });
  }
  return true;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearWebinars(): Promise<void> {
  await events.__clear();
  await formBindings.__clear();
}
