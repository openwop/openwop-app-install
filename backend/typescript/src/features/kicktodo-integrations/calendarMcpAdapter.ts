/**
 * ADR 0466 / KT-PORT-6a-3 — calendar-write via Google's first-party remote Calendar
 * MCP server (`https://calendarmcp.googleapis.com/mcp/v1`), the architecturally-correct
 * successor to the bespoke direct-REST adapter (`calendarProviderAdapter.ts`).
 *
 * This is a SECOND implementation of the SAME `CalendarTransport` seam
 * (`calendarWriteService.ts`) — polymorphism, not a parallel system. The host outbound
 * MCP client (`host/mcpClient.ts`) already does everything the REST adapter did by hand:
 * resolves the server URL from the `google` provider's host-curated `mcpServer.url`,
 * gates on the ADR 0028 governance allowlist (fail-closed), resolves the OWNER's
 * per-user `google` Connection credential (ADR 0024, `actingUserId: ownerSubject`) →
 * Bearer, and egresses through the SSRF-guarding dispatcher. We call it RUNLESS (no
 * `runId` ⇒ no run-provenance stamp; the `ucpBuyerService` precedent).
 *
 * STATEFUL id map (unavoidable — ADR 0466 §2): the MCP `create_event` tool takes NO
 * client-supplied id (it returns Google's server-assigned `id`), so the REST adapter's
 * stateless upsert-by-our-id cannot be reproduced. This transport keeps a durable
 * `(tenantId, ownerSubject, externalId) → googleEventId` map: `upsert` updates on a
 * map-hit and creates+stores on a miss; `remove` deletes by the mapped id. The map IS
 * subject data (subject-keyed + it references the user's real Google events), so it is
 * on the ADR 0381 subject-erasure seam (unlike the REST `written` ledger, which is
 * deliberately off-seam as non-personal).
 *
 * Known residual (ADR 0466): `create_event` is not idempotent by a client id, so a
 * concurrent double-sync for the same `(subject, externalId)` can double-create + orphan
 * a Google event (the map is written immediately after create to minimize the window).
 * A CAS placeholder is the hardening follow-on if the lane goes live. Ships gated-off
 * behind `OPENWOP_CALENDAR_MCP_ENABLED` — a live write needs real Google OAuth creds.
 */
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { makeMcpClient, McpError } from '../../host/mcpClient.js';
import { getProvider } from '../connections/providerRegistry.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { randomUUID } from 'node:crypto';
import { registerCalendarTransport, type CalendarTransport, type CalendarWriteContext } from './calendarWriteService.js';

const log = createLogger('kicktodo.calendarMcp');
const DEFAULT_TIMEOUT_MS = 20_000;

/** The provider whose Connection credential AND `mcpServer.url` back the write. The MCP
 *  lane is Google-specific (the only provider with a modelled calendar MCP server); the
 *  generic/self-hosted case stays on the REST adapter. */
const CALENDAR_MCP_PROVIDER = 'google';

/** Marks a row as a CLAIM, not a real mapping — a writer is mid-`create_event`.
 *  A `remove()` or a read must never treat it as a Google event id. */
const PENDING_PREFIX = 'pending:';

/** Durable map row: our deterministic externalId ⇄ Google's server-assigned event id. */
interface CalendarEventMap {
  tenantId: string;
  ownerSubject: string;
  externalId: string;
  googleEventId: string;
}

const eventMap = new DurableCollection<CalendarEventMap>(
  'kicktodo-calendar-mcp-eventmap',
  (m) => `${m.tenantId}::${m.ownerSubject}::${m.externalId}`,
  undefined,
  (m) => m.tenantId, // purge-safe (tenant teardown)
);

function mapKey(ctx: CalendarWriteContext, externalId: string): string {
  return `${ctx.tenantId}::${ctx.ownerSubject}::${externalId}`;
}

/** All-day event's exclusive end date (Google end is exclusive → +1 day). */
function nextDay(dateLocal: string): string {
  const d = new Date(`${dateLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Map the seam's generic `{dateLocal,title}` to the `create/update_event` arg shape.
 *  OQ2 (ADR 0466): the exact all-day start/end semantics are pinned to this documented
 *  contract until confirmed against a live authorized call — `allDay:true`, start = the
 *  day, end = the next day (a 24h all-day span; Google's end is exclusive). */
function eventArgs(event: { dateLocal: string; title: string }): Record<string, unknown> {
  return {
    summary: event.title,
    startTime: `${event.dateLocal}T00:00:00Z`,
    endTime: `${nextDay(event.dateLocal)}T00:00:00Z`,
    allDay: true,
  };
}

function mcpClientFor(ctx: CalendarWriteContext): ReturnType<typeof makeMcpClient> {
  // RUNLESS (no runId ⇒ no provenance stamp); credential is the OWNER's google Connection.
  return makeMcpClient({ storage: hostExtStorage(), tenantId: ctx.tenantId, actingUserId: ctx.ownerSubject });
}

/** Pull the created event id out of a tool result — `structuredContent.id` (MCP
 *  2025-06-18 typed output) first, then a defensive `result.id`. No `as any`. */
function extractCreatedEventId(out: { result: unknown; structuredContent?: unknown }): string | null {
  for (const c of [out.structuredContent, out.result]) {
    if (c && typeof c === 'object') {
      const id = (c as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return null;
}

/** Best-effort text of a TOOL error (isError:true carries the detail in the content,
 *  not a thrown McpError). Used only to recognise an already-absent event. */
function toolErrorText(out: { result: unknown }): string {
  const r = out.result;
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) {
    return r.map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? String((b as Record<string, unknown>).text) : '')).join(' ');
  }
  if (r && typeof r === 'object') {
    const m = (r as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

function looksNotFound(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('not found') || t.includes('notfound') || t.includes('404') || t.includes('410') || t.includes('deleted');
}

/** True iff a caught error / tool-error text indicates the event is already absent. */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof McpError) return looksNotFound(err.message);
  if (err instanceof Error) return looksNotFound(err.message);
  return false;
}

export const calendarMcpTransport: CalendarTransport = {
  async upsert(externalId, event, ctx) {
    const client = mcpClientFor(ctx);
    const key = mapKey(ctx, externalId);
    const existing = await eventMap.get(key);

    // A PENDING claim means another writer is mid-`create_event`. Its id is not a
    // Google event id, so sending it to `update_event` would be a bogus call.
    // Yield and let the caller's next sync converge on the winner's real id.
    if (existing?.googleEventId.startsWith(PENDING_PREFIX)) {
      throw new Error('calendar_mcp_create_in_progress');
    }

    if (existing) {
      try {
        const out = await client.invokeTool(CALENDAR_MCP_PROVIDER, 'update_event', { eventId: existing.googleEventId, ...eventArgs(event) }, { timeoutMs: DEFAULT_TIMEOUT_MS });
        if (out.isError) {
          if (looksNotFound(toolErrorText(out))) { await eventMap.delete(key); } // out-of-band delete → re-create below
          else throw new Error('calendar_mcp_update_failed');
        } else {
          return; // updated in place
        }
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        await eventMap.delete(key); // event gone → fall through to re-create
      }
    }

    // Map-miss (or a stale map we just cleared) → create.
    //
    // ENG-15(b) CAS HARDENING (ADR 0466's recorded residual, now that
    // OPENWOP_CALENDAR_MCP_ENABLED is live). MCP `create_event` takes no client
    // id, so it is NOT idempotent: two concurrent syncs both see the map-miss,
    // both create, and the second `put` OVERWRITES the first mapping — leaving an
    // orphaned event on the user's REAL calendar that nothing can ever clean up,
    // because the id that would have found it is gone. Minimising the window
    // (the previous approach) narrows the race; it does not close it.
    //
    // Close it by claiming the key BEFORE calling out. `compareAndSwap(null, …)`
    // is insert-only-if-absent, backed by the storage `kvCompareAndSwap` atomic —
    // a real cross-instance guard, not a local lock. The loser of the race does
    // NOT create a duplicate; it re-reads the winner's row and updates in place.
    const claim: CalendarEventMap = {
      tenantId: ctx.tenantId, ownerSubject: ctx.ownerSubject, externalId,
      googleEventId: `${PENDING_PREFIX}${randomUUID()}`,
    };
    if (!(await eventMap.compareAndSwap(null, claim))) {
      // Someone else claimed it between our read and now. Re-read and update
      // through their id rather than creating a second event.
      const winner = await eventMap.get(key);
      if (winner && !winner.googleEventId.startsWith(PENDING_PREFIX)) {
        const out2 = await client.invokeTool(CALENDAR_MCP_PROVIDER, 'update_event', { eventId: winner.googleEventId, ...eventArgs(event) }, { timeoutMs: DEFAULT_TIMEOUT_MS });
        if (out2.isError) throw new Error('calendar_mcp_update_failed');
        return;
      }
      // The winner is still mid-create (placeholder present). Yield rather than
      // race it — the caller's next sync converges. Creating here is the exact
      // double-create this guard exists to prevent.
      throw new Error('calendar_mcp_create_in_progress');
    }

    let googleEventId: string;
    try {
      const out = await client.invokeTool(CALENDAR_MCP_PROVIDER, 'create_event', eventArgs(event), { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (out.isError) throw new Error('calendar_mcp_create_failed');
      const id = extractCreatedEventId(out);
      if (!id) throw new Error('calendar_mcp_create_no_id'); // fail-closed: never store a bogus mapping
      googleEventId = id;
    } catch (err) {
      // Release the claim so a retry can proceed. Leaving a placeholder behind
      // would wedge this externalId forever on the `create_in_progress` branch.
      await eventMap.delete(key).catch(() => undefined);
      throw err;
    }
    await eventMap.put({ tenantId: ctx.tenantId, ownerSubject: ctx.ownerSubject, externalId, googleEventId });
  },

  async remove(externalId, ctx) {
    const key = mapKey(ctx, externalId);
    const existing = await eventMap.get(key);
    if (!existing) return; // no mapping ⇒ already removed (idempotent no-op)
    // A PENDING claim names no real event yet, so there is nothing to delete
    // remotely. Drop the claim so the externalId is not wedged; if a creator is
    // still in flight its final `put` re-adds a real row, and the next remove
    // deletes it properly. Calling `delete_event` with the placeholder would be
    // a bogus id.
    if (existing.googleEventId.startsWith(PENDING_PREFIX)) {
      await eventMap.delete(key);
      return;
    }
    const client = mcpClientFor(ctx);
    try {
      const out = await client.invokeTool(CALENDAR_MCP_PROVIDER, 'delete_event', { eventId: existing.googleEventId }, { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (out.isError && !looksNotFound(toolErrorText(out))) throw new Error('calendar_mcp_delete_failed');
    } catch (err) {
      // A real failure (auth/transport) keeps the map row so a retry re-attempts — never
      // orphan the mapping. An already-absent event converges (delete the row below).
      if (!isNotFoundError(err)) throw err;
    }
    await eventMap.delete(key);
  },
};

/** The honesty gate: the operator opted in AND the `google` provider actually carries a
 *  resolvable `mcpServer.url` (always true once ADR 0466's registry entry ships). */
export function calendarMcpConfigured(): boolean {
  return process.env.OPENWOP_CALENDAR_MCP_ENABLED === 'true' && !!getProvider(CALENDAR_MCP_PROVIDER)?.mcpServer?.url;
}

/** Boot hook — registers the MCP transport ONLY when opted in. The composition root
 *  (`feature.ts`) enforces MCP-wins precedence over the REST adapter. */
export function registerCalendarMcpAdapter(): void {
  if (!calendarMcpConfigured()) return;
  registerCalendarTransport(calendarMcpTransport);
  log.info('kicktodo_calendar_mcp_registered', { provider: CALENDAR_MCP_PROVIDER });
}

/** ADR 0381 subject erasure — drop a subject's externalId→googleEventId mappings (our
 *  local rows only; the events live in the user's own Google Calendar). Own registrant
 *  (multi-registrant seam, no import cycle). */
export async function eraseCalendarMcpForSubject(tenantId: string, subjectKey: string): Promise<void> {
  const rows = await eventMap.listByPrefix(`${tenantId}::${subjectKey}::`);
  for (const r of rows) await eventMap.delete(`${r.tenantId}::${r.ownerSubject}::${r.externalId}`);
}
registerSubjectEraser(eraseCalendarMcpForSubject);

/** Test-only helpers. */
export async function __clearCalendarEventMap(): Promise<void> { await eventMap.__clear(); }
export async function __getCalendarEventMap(tenantId: string, ownerSubject: string, externalId: string): Promise<CalendarEventMap | null> {
  return eventMap.get(`${tenantId}::${ownerSubject}::${externalId}`);
}
