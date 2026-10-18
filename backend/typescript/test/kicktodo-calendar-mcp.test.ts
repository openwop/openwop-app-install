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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  __putCalendarEventMap,
} from '../src/features/kicktodo-integrations/calendarMcpAdapter.js';

const T = 'default';
const SUBJECT = 'user:cal-owner';
const CTX = { tenantId: T, ownerSubject: SUBJECT };

let appServer: http.Server;
let mcpServer: http.Server;
/** Every tools/call the fake server saw, in order. */
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let eventSeq = 0;
/** When set, every `create_event` RESPONSE waits on this gate — the race case uses it
 *  to hold the winner inside its create window while the loser runs. */
let createGate: Promise<void> | null = null;

/** The JSON-RPC request the fake server reads. */
interface RpcRequest { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
let originalGoogle: ReturnType<typeof getProvider>;

/** A fake Google Calendar MCP server: JSON-RPC `tools/call` for create/update/delete_event. */
function startMcpServer(): Promise<number> {
  mcpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const rpc: RpcRequest = JSON.parse(raw || '{}');
      const name = rpc.params?.name ?? '';
      const args = rpc.params?.arguments ?? {};
      calls.push({ name, args });
      const send = (result: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (name === 'create_event') {
        // A summary containing NOID simulates a server that returns no id (fail-closed path).
        if (String(args.summary ?? '').includes('NOID')) { send({ content: [{ type: 'text', text: 'created' }] }); return; }
        const id = `gcal-${++eventSeq}`;
        const respond = (): void => send({ content: [{ type: 'text', text: 'created' }], structuredContent: { id, summary: args.summary } });
        if (createGate) void createGate.then(respond); else respond();
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
  originalGoogle = google;
  registerProvider({ ...google, mcpServer: { url: `http://127.0.0.1:${port}/mcp`, transport: 'http' } });
  // The owner's per-user google Connection (the credential the transport resolves).
  await createSecretConnection({ tenantId: T, provider: 'google', kind: 'bearer', secret: 'owner-google-token', scope: 'user', userId: SUBJECT });
});

afterAll(async () => {
  if (originalGoogle) registerProvider(originalGoogle); // undo the URL override (process-global registry)
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => mcpServer.close(() => r()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

afterEach(async () => { await __clearCalendarEventMap(); calls = []; eventSeq = 0; createGate = null; });

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
    expect(calls[0]?.args.eventId).toBe('gcal-1'); // the mapped id, not a new event
    const row = await __getCalendarEventMap(T, SUBJECT, EXT);
    expect(row?.googleEventId).toBe('gcal-1'); // map unchanged
  });

  it('remove deletes by the mapped id and drops the map row; a second remove is a no-op', async () => {
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'x' }, CTX);
    calls = [];
    await calendarMcpTransport.remove(EXT, CTX);
    expect(calls.map((c) => c.name)).toEqual(['delete_event']);
    expect(calls[0]?.args.eventId).toBe('gcal-1');
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
    // FORCED race (wave-39 pattern): the winner's create_event RESPONSE is held, so it
    // sits inside its create window (claim written, no real id yet) while the second
    // upsert runs its map read + CAS. Whichever settles FIRST while the gate is shut
    // must be the loser — the winner cannot settle until its create returns. A 2 s
    // fallback releases the gate if nothing settles (e.g. both reached create_event).
    let release = (): void => {};
    createGate = new Promise<void>((r) => { release = r; });
    const racers = [
      calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'racer A' }, CTX),
      calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'racer B' }, CTX),
    ];
    let timer: NodeJS.Timeout | undefined;
    const first = await Promise.race([
      ...racers.map((p) => p.then(() => 'resolved' as const, (e: unknown) => (e instanceof Error ? e.message : String(e)))),
      new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 2000); }),
    ]);
    clearTimeout(timer);
    // The loser can settle before the winner's request even lands, so wait for the
    // winner's (held) create to arrive, then check it is the ONLY one in flight.
    await vi.waitFor(() => expect(calls.some((c) => c.name === 'create_event')).toBe(true), { timeout: 2000 });
    const createsWhileHeld = calls.filter((c) => c.name === 'create_event').length;
    release();
    const results = await Promise.allSettled(racers);
    expect(createsWhileHeld).toBe(1);
    // …and the loser yielded loudly with the exact in-progress refusal (not a timeout).
    expect(first).toBe('calendar_mcp_create_in_progress');
    // The load-bearing assertion: exactly one create reached the provider overall.
    // Two would be a duplicate event on a real calendar.
    expect(calls.filter((c) => c.name === 'create_event')).toHaveLength(1);
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

  // ── KTINT-3 — an expiring claim: a crashed writer never wedges sync ─────────
  //
  // Sabotage-witnessed: drop the `isStaleClaim` retake (the two "retaken" cases
  // red with calendar_mcp_create_in_progress); restore the blind final `put` (the
  // claim-lost case reds: the removed event is resurrected and never deleted).
  const claimRow = (googleEventId: string) => ({ tenantId: T, ownerSubject: SUBJECT, externalId: EXT, googleEventId });

  it('KTINT-3 — an EXPIRED claim (crashed writer) is retaken: the sync creates instead of wedging', async () => {
    await __putCalendarEventMap(claimRow(`pending:${Date.now() - 10 * 60_000}:crashed`));
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'after crash' }, CTX);
    expect(calls.map((c) => c.name)).toEqual(['create_event']);
    expect((await __getCalendarEventMap(T, SUBJECT, EXT))?.googleEventId).toBe('gcal-1');
  });

  it('KTINT-3 — a pre-expiry claim of the legacy `pending:<uuid>` shape is retaken too', async () => {
    // The old shape carried no time; it could only survive a crash, so it is stale.
    await __putCalendarEventMap(claimRow('pending:3f1c0e9e-legacy'));
    await calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'legacy' }, CTX);
    expect((await __getCalendarEventMap(T, SUBJECT, EXT))?.googleEventId).toBe('gcal-1');
  });

  it('KTINT-3 — a FRESH claim still yields (no retake while its writer may be live)', async () => {
    const fresh = `pending:${Date.now()}:live`;
    await __putCalendarEventMap(claimRow(fresh));
    await expect(calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'x' }, CTX))
      .rejects.toThrow('calendar_mcp_create_in_progress');
    expect(calls).toEqual([]);
    expect((await __getCalendarEventMap(T, SUBJECT, EXT))?.googleEventId).toBe(fresh);
  });

  it('KTINT-3 — a creator whose claim is gone when its create returns deletes its own event', async () => {
    // remove() drops an in-flight claim (the user removed the day). The old blind
    // `put` then re-added the mapping, resurrecting the removed event; a retaker's
    // claim would have been overwritten the same way, orphaning ITS event.
    let release = (): void => {};
    createGate = new Promise<void>((r) => { release = r; });
    const creating = calendarMcpTransport.upsert(EXT, { dateLocal: '2026-08-01', title: 'held' }, CTX);
    await vi.waitFor(() => expect(calls.some((c) => c.name === 'create_event')).toBe(true), { timeout: 2000 });
    await calendarMcpTransport.remove(EXT, CTX); // drops the pending claim
    release();
    await expect(creating).rejects.toThrow('calendar_mcp_claim_lost');
    expect(await __getCalendarEventMap(T, SUBJECT, EXT), 'the removed event was resurrected').toBeNull();
    expect(calls.filter((c) => c.name === 'delete_event').map((c) => c.args.eventId), 'the created event was left orphaned')
      .toEqual(['gcal-1']);
  });
});

