/**
 * ADR 0466 / KT-PORT-6a-3 — calendar-write via Google's remote Calendar MCP server.
 *
 * Integration test against a FAKE local MCP server (the real calendarmcp.googleapis.com
 * needs live OAuth — this lane ships gated-off). Drives the transport through the REAL
 * `makeMcpClient` pipeline (URL from the `google` provider's mcpServer.url, per-user
 * `google` Connection credential → Bearer, governance, egress) — so it also pins the
 * `structuredContent` surfacing added to invokeTool (create_event returns the event id
 * in `structuredContent`, not `content`).
 *
 * Proves the map lifecycle the MCP `create_event`'s lack of a client id forces:
 * create→store, update on a map-hit (never a second create), delete-by-mapped-id,
 * map-miss remove no-op, create-without-id fail-closed, and subject erasure.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import {
  calendarMcpTransport,
  eraseCalendarMcpForSubject,
  __clearCalendarEventMap,
  __getCalendarEventMap,
} from '../src/features/kicktodo-integrations/calendarMcpAdapter.js';

const T = 'default';
const SUBJECT = 'user:cal-owner';
const CTX = { tenantId: T, ownerSubject: SUBJECT };

let appServer: http.Server;
let mcpServer: http.Server;
/** Every tools/call the fake server saw, in order. */
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let eventSeq = 0;

/** A fake Google Calendar MCP server: JSON-RPC `tools/call` for create/update/delete_event. */
function startMcpServer(): Promise<number> {
  mcpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const rpc = JSON.parse(raw || '{}');
      const name: string = rpc.params?.name ?? '';
      const args: Record<string, unknown> = rpc.params?.arguments ?? {};
      calls.push({ name, args });
      const send = (result: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (name === 'create_event') {
        // A summary containing NOID simulates a server that returns no id (fail-closed path).
        if (String(args.summary ?? '').includes('NOID')) { send({ content: [{ type: 'text', text: 'created' }] }); return; }
        const id = `gcal-${++eventSeq}`;
        send({ content: [{ type: 'text', text: 'created' }], structuredContent: { id, summary: args.summary } });
        return;
      }
      if (name === 'update_event') {
        if (args.eventId === 'GONE') { send({ content: [{ type: 'text', text: 'not found' }], isError: true }); return; }
        send({ content: [{ type: 'text', text: 'updated' }], structuredContent: { id: args.eventId } });
        return;
      }
      if (name === 'delete_event') { send({ content: [{ type: 'text', text: 'deleted' }] }); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unknown tool ${name}` } }));
    });
  });
  return new Promise((r) => { mcpServer.listen(0, '127.0.0.1', () => r((mcpServer.address() as AddressInfo).port)); });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // allow http localhost egress to the fake MCP server
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { appServer = app.listen(0, '127.0.0.1', () => r()); });
  await __resetConnectionsStore();
  const port = await startMcpServer();
  // Point the `google` provider's MCP server at the fake (host-curated URL override).
  const google = getProvider('google');
  if (!google) throw new Error('google provider missing');
  registerProvider({ ...google, mcpServer: { url: `http://127.0.0.1:${port}/mcp`, transport: 'http' } });
  // The owner's per-user google Connection (the credential the transport resolves).
  await createSecretConnection({ tenantId: T, provider: 'google', kind: 'bearer', secret: 'owner-google-token', scope: 'user', userId: SUBJECT });
});

afterAll(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => mcpServer.close(() => r()));
});

afterEach(async () => { await __clearCalendarEventMap(); calls = []; eventSeq = 0; });

const EXT = 'enr-1|2026-08-01|act-1';

describe('ADR 0466 — calendar-write via Google Calendar MCP', () => {
  it('upsert on a MAP-MISS creates the event and stores the returned Google id', async () => {
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'KickTodo day 1' }, CTX);
    expect(calls.map((c) => c.name)).toEqual(['create_event']);
    const row = await __getCalendarEventMap(T, SUBJECT, EXT);
    expect(row?.googleEventId).toBe('gcal-1'); // read from structuredContent.id, not content
  });

  it('upsert on a MAP-HIT updates in place — never a second create (idempotent)', async () => {
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'v1' }, CTX);
    calls = [];
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'v2' }, CTX);
    expect(calls.map((c) => c.name)).toEqual(['update_event']);
    expect(calls[0].args.eventId).toBe('gcal-1'); // the mapped id, not a new event
    const row = await __getCalendarEventMap(T, SUBJECT, EXT);
    expect(row?.googleEventId).toBe('gcal-1'); // map unchanged
  });

  it('remove deletes by the mapped id and drops the map row; a second remove is a no-op', async () => {
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'x' }, CTX);
    calls = [];
    await calendarMcpTransport.remove(EXT, CTX);
    expect(calls.map((c) => c.name)).toEqual(['delete_event']);
    expect(calls[0].args.eventId).toBe('gcal-1');
    expect(await __getCalendarEventMap(T, SUBJECT, EXT)).toBeNull();
    // Idempotent: no mapping ⇒ no provider call at all.
    calls = [];
    await calendarMcpTransport.remove(EXT, CTX);
    expect(calls).toHaveLength(0);
  });

  it('fail-closed: a create that returns no id throws and stores NO mapping', async () => {
    await expect(
      calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'NOID please' }, CTX),
    ).rejects.toThrow('calendar_mcp_create_no_id');
    expect(await __getCalendarEventMap(T, SUBJECT, EXT)).toBeNull();
  });

  it('subject erasure drops the subject\'s externalId→googleEventId mappings', async () => {
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'y' }, CTX);
    await calendarMcpTransport.upsert('enr-1|2026-08-02|act-1', { dateLocal: '2026-08-02', title: 'z' }, CTX);
    expect(await __getCalendarEventMap(T, SUBJECT, EXT)).not.toBeNull();
    await eraseCalendarMcpForSubject(T, SUBJECT);
    expect(await __getCalendarEventMap(T, SUBJECT, EXT)).toBeNull();
    expect(await __getCalendarEventMap(T, SUBJECT, 'enr-1|2026-08-02|act-1')).toBeNull();
  });

  // ── ENG-15(b) — the CAS claim closes the double-create race ────────────────
  //
  // MCP `create_event` takes no client id, so it is NOT idempotent. Before the
  // claim, two concurrent syncs both saw the map-miss, both created, and the
  // second `put` overwrote the first mapping — leaving an orphaned event on the
  // user's REAL calendar that nothing could ever clean up, because the id that
  // would have found it was gone.
  it('two CONCURRENT upserts on a map-miss create exactly ONE event', async () => {
    const results = await Promise.allSettled([
      calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'racer A' }, CTX),
      calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'racer B' }, CTX),
    ]);
    // The load-bearing assertion: exactly one create reached the provider. Two
    // would be a duplicate event on a real calendar.
    expect(calls.filter((c) => c.name === 'create_event')).toHaveLength(1);
    // The loser fails loudly rather than silently duplicating; the caller's next
    // sync converges on the winner's real id.
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // And the surviving map row is a REAL id, never a leftover claim.
    const row = await __getCalendarEventMap(T, SUBJECT, EXT);
    expect(row?.googleEventId).toBe('gcal-1');
    expect(row?.googleEventId.startsWith('pending:')).toBe(false);
  });

  it('a FAILED create releases the claim so a retry can proceed', async () => {
    // Without the release, the placeholder would wedge this externalId forever
    // on the `create_in_progress` branch — a permanent, silent sync outage for
    // one day's event.
    // Reuse the harness's existing NOID mechanism (a server that returns no id)
    // rather than adding a second failure switch.
    await expect(calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'NOID boom' }, CTX)).rejects.toThrow();
    expect(await __getCalendarEventMap(T, SUBJECT, EXT)).toBeNull(); // claim released
    calls = [];
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'retry' }, CTX);
    expect(calls.map((c) => c.name)).toEqual(['create_event']);
    expect((await __getCalendarEventMap(T, SUBJECT, EXT))?.googleEventId).toBe('gcal-1');
  });
});
