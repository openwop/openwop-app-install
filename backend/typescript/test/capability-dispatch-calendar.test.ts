/**
 * ADR 0186 Phase 2b slice 1 — provider-agnostic calendar capability node.
 *
 * Verifies core.openwop.connectors.calendar-list-events: resolves the tenant's
 * connected email-calendar provider via ctx.connectors.resolveForCapability, dispatches
 * to the RIGHT vendor endpoint (Google Calendar vs MS Graph), normalizes the response,
 * and fails SAFE (no connection / a non-calendar provider / a connector error).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

/** Narrow a NodeOutcome to its success outputs (throws if the node failed). */
function outputsOf(res: { status: string; outputs?: unknown }): Record<string, unknown> {
  if (res.status !== 'success') throw new Error(`expected success, got ${res.status}`);
  return (res.outputs ?? {}) as Record<string, unknown>;
}

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}

/** A ctx.connectors double. `providers` = the category's authorized candidates
 *  (precedence-ordered); invoke returns `data`. resolveForCapability yields the first
 *  (the older single-resolver path), resolveAllForCapability the full list. */
function connectors(providers: string[] | string | null, data: unknown, ok = true) {
  const list = providers == null ? [] : Array.isArray(providers) ? providers : [providers];
  const calls: Array<{ connectorId: string; url: string; method?: string }> = [];
  return {
    calls,
    surface: {
      resolveForCapability: async () => list[0] ?? null,
      resolveAllForCapability: async () => list,
      invoke: async (connectorId: string, request: { url: string; method?: string }) => {
        calls.push({ connectorId, url: request.url, ...(request.method ? { method: request.method } : {}) });
        return ok ? { ok: true, status: 200, data } : { ok: false, status: 502, error: 'bad_gateway' };
      },
    },
  };
}

describe('ADR 0186 — calendar-list-events capability node', () => {
  beforeAll(() => ensureNodesRegistered());
  const getNode = () => {
    const node = getNodeRegistry().get('core.openwop.connectors.calendar-list-events');
    expect(node).toBeTruthy();
    return node!;
  };

  it('dispatches to Google Calendar and normalizes items', async () => {
    const c = connectors('google', { items: [{ summary: 'Standup', start: { dateTime: '2026-07-03T09:00:00Z' }, end: { dateTime: '2026-07-03T09:15:00Z' }, location: 'Zoom', attendees: [{ email: 'a@x.com' }] }] });
    const res = await getNode().execute(makeCtx({ config: { maxResults: 5 }, connectors: c.surface }));
    expect(res.status).toBe('success');
    expect(c.calls[0].connectorId).toBe('google');
    expect(c.calls[0].url).toContain('www.googleapis.com/calendar/v3');
    expect(outputsOf(res)).toMatchObject({ connected: true, provider: 'google', eventCount: 1 });
    expect((outputsOf(res).events as Array<Record<string, unknown>>)[0]).toEqual({ title: 'Standup', start: '2026-07-03T09:00:00Z', end: '2026-07-03T09:15:00Z', location: 'Zoom', attendees: ['a@x.com'] });
  });

  it('dispatches to Microsoft Graph and normalizes value', async () => {
    const c = connectors('microsoft-graph', { value: [{ subject: 'Review', start: { dateTime: '2026-07-03T10:00:00' }, end: { dateTime: '2026-07-03T11:00:00' }, location: { displayName: 'Room 4' }, attendees: [{ emailAddress: { address: 'b@y.com' } }] }] });
    const res = await getNode().execute(makeCtx({ connectors: c.surface }));
    expect(res.status).toBe('success');
    expect(c.calls[0].url).toContain('graph.microsoft.com/v1.0/me/events');
    expect((outputsOf(res).events as Array<Record<string, unknown>>)[0]).toEqual({ title: 'Review', start: '2026-07-03T10:00:00', end: '2026-07-03T11:00:00', location: 'Room 4', attendees: ['b@y.com'] });
  });

  it('anchors Google to timeMin when a window is supplied (replay-safe "upcoming")', async () => {
    const c = connectors('google', { items: [] });
    await getNode().execute(makeCtx({ config: { timeMin: '2026-07-02T00:00:00Z' }, connectors: c.surface }));
    expect(c.calls[0].url).toContain('timeMin=2026-07-02T00%3A00%3A00Z');
  });

  it('anchors Microsoft Graph to a $filter when a window is supplied', async () => {
    const c = connectors('microsoft-graph', { value: [] });
    await getNode().execute(makeCtx({ inputs: { timeMin: '2026-07-02T00:00:00Z' }, connectors: c.surface }));
    expect(c.calls[0].url).toContain('$filter=');
    expect(decodeURIComponent(c.calls[0].url)).toContain("start/dateTime ge '2026-07-02T00:00:00Z'");
  });

  it('picks a calendar-capable provider when an email-only one sorts first', async () => {
    const c = connectors(['gmail', 'google'], { items: [{ summary: 'X', start: { dateTime: 't' }, end: { dateTime: 't' } }] });
    const res = await getNode().execute(makeCtx({ connectors: c.surface }));
    expect(res.status).toBe('success');
    expect(c.calls[0].connectorId).toBe('google'); // not gmail
    expect(outputsOf(res)).toMatchObject({ connected: true, provider: 'google' });
  });

  it('degrades to connected:false when no calendar is connected (never throws)', async () => {
    const c = connectors(null, null);
    const res = await getNode().execute(makeCtx({ connectors: c.surface }));
    expect(res.status).toBe('success');
    expect(outputsOf(res)).toMatchObject({ connected: false, eventCount: 0 });
    expect(c.calls.length).toBe(0); // no egress attempted
  });

  it('degrades when a connected provider has no calendar API (email-only category member)', async () => {
    const c = connectors('sendgrid', null);
    const res = await getNode().execute(makeCtx({ connectors: c.surface }));
    expect(res.status).toBe('success');
    expect(outputsOf(res)).toMatchObject({ connected: false, reason: 'provider_no_calendar', provider: 'sendgrid' });
    expect(c.calls.length).toBe(0);
  });

  it('fails when the connector egress errors', async () => {
    const c = connectors('google', null, false);
    const res = await getNode().execute(makeCtx({ connectors: c.surface }));
    expect(res.status).toBe('failure');
  });

  it('fails closed when the host connectors surface is absent', async () => {
    const res = await getNode().execute(makeCtx({}));
    expect(res.status).toBe('failure');
    if (res.status === 'failure') expect(res.error?.code).toBe('host_capability_missing');
  });
});
