/**
 * #6133 on a REAL Postgres: the pub/sub LISTEN connection is killed server-side
 * (`pg_terminate_backend`, what a database restart, failover or connector cut
 * does to it), and the next publish must still reach the subscriber after the
 * listener recovers. Before the fix, only an 'error' re-listened, with ONE retry.
 * This is the Postgres-only path the sqlite suite never exercises.
 *
 * Runs against `OPENWOP_PG_TEST_DSN`, else a `postgres:15-alpine` container, else
 * skips (as every `*-postgres-live` test does in `npm run ci`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { Client } from 'pg';
import net from 'node:net';
import type { Storage } from '../src/storage/storage.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();
let dsn: string | undefined = externalDsn;
let stopContainer: (() => Promise<unknown>) | null = null;
let storage: Storage | null = null;
let peer: Storage | null = null;
let viaProxy: Storage | null = null;
let proxy: { port: number; endAll(): void; blackhole(): void; close(): Promise<void> } | null = null;

/** A TCP proxy to Postgres whose sockets can be closed CLEANLY (FIN, no RST), the way an idle-cutting connector or NAT ends a connection. */
async function startProxy(target: URL): Promise<{ port: number; endAll(): void; blackhole(): void; close(): Promise<void> }> {
  const pairs = new Set<[net.Socket, net.Socket]>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    const pair: [net.Socket, net.Socket] = [client, upstream];
    pairs.add(pair);
    client.pipe(upstream); upstream.pipe(client);
    const drop = (): void => { pairs.delete(pair); client.destroy(); upstream.destroy(); };
    client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    endAll() { for (const [c, u] of pairs) { c.end(); u.end(); } },
    /** Half-open: stop forwarding in both directions WITHOUT closing anything, the way a silently dropped connection looks to both ends. */
    blackhole() { for (const [c, u] of pairs) { c.unpipe(u); u.unpipe(c); c.pause(); u.pause(); } },
    close: () => new Promise<void>((ok) => { for (const [c, u] of pairs) { c.destroy(); u.destroy(); } server.close(() => ok()); }),
  };
}

beforeAll(async () => {
  if (!available) return;
  // A short self-ping, so the half-open case below runs in seconds, not minutes.
  process.env.OPENWOP_PUBSUB_PING_INTERVAL_MS = '2000';
  process.env.OPENWOP_PUBSUB_PING_TIMEOUT_MS = '1500';
  if (!dsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  const { openPostgresStorage } = await import('../src/storage/postgres/index.js');
  storage = await openPostgresStorage(dsn);
  peer = await openPostgresStorage(dsn);
  const u = new URL(dsn);
  proxy = await startProxy(u);
  const viaUrl = new URL(dsn); viaUrl.hostname = '127.0.0.1'; viaUrl.port = String(proxy.port);
  viaProxy = await openPostgresStorage(viaUrl.toString());
}, 200_000);
afterAll(async () => {
  await storage?.close();
  await peer?.close();
  await viaProxy?.close().catch(() => undefined);
  await proxy?.close();
  await stopContainer?.();
});

/** Kill every backend that is LISTENing on the pub/sub channel. Returns how many died. */
async function killListeners(): Promise<number> {
  const admin = new Client({ connectionString: dsn });
  await admin.connect();
  try {
    const r = await admin.query<{ killed: boolean }>(
      `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query ILIKE 'LISTEN openwop_host_ext%'`,
    );
    return r.rows.filter((x) => x.killed).length;
  } finally {
    await admin.end();
  }
}

/** Publish until the subscriber hears `payload` or `ms` pass; the listener may still be re-listening. */
async function heardWithin(from: Storage, channel: string, got: string[], payload: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await from.publish(channel, payload);
    await new Promise((r) => setTimeout(r, 250));
    if (got.includes(payload)) return true;
  }
  return false;
}

describe.skipIf(!available)('#6133 — the LISTEN connection on a real Postgres', () => {
  it('delivers a NOTIFY to the subscriber, then still delivers after its LISTEN backend is killed', async () => {
    const got: string[] = [];
    await storage!.subscribe('issue6133', (p) => got.push(p));
    expect(await heardWithin(storage!, 'issue6133', got, 'before', 5_000), 'no delivery even before the kill').toBe(true);
    const killed = await killListeners();
    expect(killed, 'no LISTEN backend was found to kill, so this case would test nothing').toBeGreaterThan(0);
    // The listener recycles on the dropped connection and re-LISTENs (1 s first backoff).
    expect(await heardWithin(storage!, 'issue6133', got, 'after-kill', 15_000), 'the subscriber never heard a publish after its LISTEN connection was killed').toBe(true);
  }, 60_000);

  it('a second instance publishing reaches the first after the first one recovers', async () => {
    const got: string[] = [];
    await storage!.subscribe('issue6133-peer', (p) => got.push(p));
    await peer!.subscribe('issue6133-noop', () => undefined); // the peer listens too, and gets killed with it
    await killListeners();
    expect(await heardWithin(peer!, 'issue6133-peer', got, 'from-peer', 15_000)).toBe(true);
  }, 60_000);

  it('a connection the network ends CLEANLY (FIN, no error from the server) is recycled, and delivery resumes', async () => {
    // This is the production shape. A terminated backend surfaces as an 'error',
    // which the old code already handled; a socket closed by an idle cut may not.
    const got: string[] = [];
    await viaProxy!.subscribe('issue6133-fin', (p) => got.push(p));
    expect(await heardWithin(peer!, 'issue6133-fin', got, 'before-fin', 5_000), 'no delivery through the proxy even before the cut').toBe(true);
    proxy!.endAll();
    expect(await heardWithin(peer!, 'issue6133-fin', got, 'after-fin', 20_000), 'the subscriber never heard a publish after its connection was ended cleanly').toBe(true);
  }, 60_000);

  it('a connection that goes silently half-open (no FIN, no error) is detected by the self-ping and recycled', async () => {
    // The case the old listener could not survive: no event ever fires on a dead
    // socket, so a listener that waits for 'error' or 'end' waits forever.
    proxy!.endAll(); // start from fresh connections through the proxy
    const got: string[] = [];
    await viaProxy!.subscribe('issue6133-halfopen', (p) => got.push(p));
    expect(await heardWithin(peer!, 'issue6133-halfopen', got, 'before-blackhole', 15_000), 'no delivery through the proxy even before the black hole').toBe(true);
    proxy!.blackhole();
    expect(await heardWithin(peer!, 'issue6133-halfopen', got, 'after-blackhole', 25_000), 'the subscriber never heard a publish after its connection went half-open').toBe(true);
  }, 60_000);
});
