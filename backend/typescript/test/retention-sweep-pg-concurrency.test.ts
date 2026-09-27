/**
 * GOV-5 — multi-instance safety of the retention sweep lease, on a REAL Postgres.
 *
 * The sweep is fleet-deployed (multi-instance Cloud Run). Its only guard against two
 * instances double-purging the SAME (tenant, classification, day) is the atomic
 * `claimOnce` lease (`retentionSweepDaemon.ts` — `claim.claimed` gates the purge),
 * which on Postgres is an `INSERT … ON CONFLICT (key) DO NOTHING RETURNING`
 * (`storage/postgres/index.ts`). The other retention tests exercise this on `memory://`
 * only; this one runs two concurrent sweeps against a REAL Postgres so the fleet
 * "claim-once" guarantee is verified on the constraint enforcement that ships.
 *
 * pg-mem can't stand in here: it does not enforce the migration's PRIMARY KEY on
 * `idempotency`, so `ON CONFLICT` has nothing to conflict on and every racer "wins" — the
 * exact property under test only exists on a real engine. Hence: testcontainers.
 *
 * Gated on Docker; OPENWOP_PG_RETENTION_LIVE=1 (set by the dedicated CI job) hard-requires
 * the run so a green job means validated, never a silent skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';
import { registerRetentionPurger, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { processRetentionSweep } from '../src/host/retentionSweepDaemon.js';
import type { Storage } from '../src/storage/storage.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const forceLive = process.env.OPENWOP_PG_RETENTION_LIVE === '1';
const dockerAvailable = forceLive || (await isDockerReachable());
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[retention-sweep-pg-concurrency] Docker not reachable — skipping. Set OPENWOP_PG_RETENTION_LIVE=1 to require it.');
}

const now = 1_900_000_000_000; // fixed clock ⇒ both instances compute the SAME day slot
let container: StartedPostgreSqlContainer | null = null;
let storage: Storage;

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  storage = await openPostgresStorage(container.getConnectionUri());
  initHostExtPersistence(storage);
}, 180_000);

afterAll(async () => {
  try { await storage?.close?.(); } catch { /* ignore */ }
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

describe('GOV-5 — retention sweep lease is multi-instance safe (real Postgres ON CONFLICT)', () => {
  it.skipIf(!dockerAvailable)('two concurrent sweeps over the same governed tenant purge it EXACTLY once', async () => {
    await __resetGovernanceStore();
    __resetRetentionPurgers();
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    let invocations = 0;
    registerRetentionPurger({ feature: 'gov5', async purge() { invocations += 1; return 1; } });

    // Two fleet instances fire the same-day sweep at the same instant.
    const [a, b] = await Promise.all([
      processRetentionSweep({ storage }, now),
      processRetentionSweep({ storage }, now),
    ]);

    // The lease admits exactly one: the purger runs once, total purged is counted once,
    // and the losing instance reports 0 (its claim lost the ON CONFLICT race).
    expect(invocations).toBe(1);
    expect(a + b).toBe(1);
    expect([a, b].sort()).toEqual([0, 1]);
  });

  it.skipIf(!dockerAvailable)('a second same-day sweep is a no-op; the next day re-claims', async () => {
    await __resetGovernanceStore();
    __resetRetentionPurgers();
    await setGovernancePolicy('tenantB', { retention: { confidentialPiiDays: 365 } });
    let invocations = 0;
    registerRetentionPurger({ feature: 'gov5b', async purge() { invocations += 1; return 0; } });

    await processRetentionSweep({ storage }, now);
    await processRetentionSweep({ storage }, now); // same day slot → claim already held
    expect(invocations).toBe(1);

    await processRetentionSweep({ storage }, now + 86_400_000); // next day → fresh slot
    expect(invocations).toBe(2);
  });
});

describe('ADR 0287 — pruneTerminalRuns on REAL Postgres (pg-mem cannot express DELETE…ANY)', () => {
  it.skipIf(!dockerAvailable)('retires the whole run: row, children, kv write-throughs, AND artifact rows', async () => {
    const old = {
      runId: 'prune-live-old', workflowId: 'wf', tenantId: 't-prune', status: 'completed' as const,
      inputs: {}, metadata: {}, configurable: {},
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    };
    await storage.insertRun(old);
    await storage.appendEvent({ runId: old.runId, eventId: 'prune-live-ev', type: 'run.started', payload: {}, timestamp: old.updatedAt });
    await storage.kvSet(`hostext:runartifact:${old.runId}:node-a`, '{"a":1}');
    await storage.kvSet(`hostext:runartifact:${old.runId}:node-b`, '{"b":2}');
    await storage.kvSet('hostext:runartifact:prune-live-other:node-a', '{"keep":true}');

    const res = await storage.pruneTerminalRuns('2021-01-01T00:00:00.000Z', 10);
    expect(res.runs).toBe(1);
    expect(res.childRows).toBeGreaterThanOrEqual(3); // event + 2 artifact rows
    expect(await storage.getRun(old.runId)).toBeNull();
    expect(await storage.kvGet(`hostext:runartifact:${old.runId}:node-a`)).toBeNull();
    expect(await storage.kvGet(`hostext:runartifact:${old.runId}:node-b`)).toBeNull();
    expect(await storage.kvGet('hostext:runartifact:prune-live-other:node-a')).not.toBeNull();
  });
});
