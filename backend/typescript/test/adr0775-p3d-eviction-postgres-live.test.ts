/**
 * ADR 0775 P3d — registry eviction over REAL Postgres LISTEN/NOTIFY, between two
 * storage instances (two pools, two dedicated LISTEN connections), which is what
 * two Cloud Run instances are to each other. The in-process test
 * (`adr0775-p3d-agent-registry-eviction.test.ts`) uses the memory adapter's
 * emitter; this is the half it cannot reach: a NOTIFY sent on one instance's
 * connection arriving on the other's LISTEN and evicting there.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set, else a `postgres:15-alpine`
 * testcontainer when Docker is reachable, else skips with a notice.
 *
 * NOT a PGlite socket server: MEASURED 2026-10-16, PGlite delivers a NOTIFY only
 * to the connection that sent it (a raw two-client probe received "self", never
 * "cross"), so this test is red there for a reason that is not the code. A real
 * Postgres without Docker: the `embedded-postgres` npm package in a scratch dir
 * (PG 17, darwin-arm64), where this passed and went red with the origin filter
 * or the eviction removed.
 *
 * NOT in the gate: `npm run ci` sets OPENWOP_SKIP_TESTCONTAINERS=1 and no DSN, so the
 * suite skips there and in the wave-60 probe runner (w60g2-p3dl-* came back vacuous
 * for that reason, tracker TST-BRC-5). Red, with Postgres present, when the origin
 * filter or the registry removal in `applyAgentEviction` is dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { AGENT_EVICTION_CHANNEL, applyAgentEviction } from '../src/host/agentRegistryEviction.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let a: Storage | null = null; // the instance holding a stale copy
let b: Storage | null = null; // the instance where the agent was edited
let stopContainer: (() => Promise<unknown>) | null = null;
const seen: string[] = [];

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0775-p3d-eviction-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  let dsn = externalDsn;
  if (!dsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  a = await openPostgresStorage(dsn);
  b = await openPostgresStorage(dsn);
  // What `startAgentRegistryEvictionListener` does on instance A, with A's id.
  await a.subscribe(AGENT_EVICTION_CHANNEL, (payload) => { seen.push(payload); applyAgentEviction(payload, 'instance-a'); });
}, 180_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await stopContainer?.();
});

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 25));
};

describe.skipIf(!available)('eviction across two Postgres-backed instances', () => {
  it('a NOTIFY from instance B evicts on instance A; A\'s own message does not', async () => {
    const reg = getAgentRegistry();
    reg.register({
      agentId: 'user.p3d-live', persona: 'stale', modelClass: 'chat', systemPrompt: 'OLD', packName: 'user:t-live', packVersion: '0',
      toolAllowlist: [], ownerTenant: 't-live',
    });

    // Echo of A's own broadcast: delivered over the wire, ignored by origin.
    await b!.publish(AGENT_EVICTION_CHANNEL, JSON.stringify({ tenantId: 't-live', agentId: 'user.p3d-live', origin: 'instance-a' }));
    await until(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    expect(reg.get('user.p3d-live', 't-live')).not.toBeNull();

    // B edited the agent.
    await b!.publish(AGENT_EVICTION_CHANNEL, JSON.stringify({ tenantId: 't-live', agentId: 'user.p3d-live', origin: 'instance-b' }));
    await until(() => reg.get('user.p3d-live', 't-live') === null);
    expect(seen).toHaveLength(2);
    expect(reg.get('user.p3d-live', 't-live')).toBeNull();
  });
});
