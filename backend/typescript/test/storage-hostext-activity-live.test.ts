/**
 * Grade-pass DATA-1 review M3 — the REAL postgres adapter's
 * `listHostExtTenantActivity` exercised against a live container (the
 * anon-lifecycle tests run sqlite; the pg-mem stub throws). Semantics are
 * shared via `storage/hostExtActivity.ts`, so this pins the pg-only surface:
 * the `k LIKE 'hostext:%'` keyspace prefilter, the value-LIKE parameterization
 * (incl. escaping), and the batched chat cross-check.
 *
 * Skips gracefully when Docker is unreachable (the pg-sql-live pattern);
 * `OPENWOP_SKIP_TESTCONTAINERS=1` skips explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    console.warn('[storage-hostext-activity-live] Docker not reachable — skipping.');
    return false;
  }
}

let container: StartedPostgreSqlContainer | null = null;
let storage: Storage | null = null;

beforeAll(async () => {
  if (!(await isDockerReachable())) return;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  storage = await openStorage(container.getConnectionUri());
}, 180_000);

afterAll(async () => {
  await storage?.close?.();
  await container?.stop();
});

describe('postgres listHostExtTenantActivity (live)', () => {
  it('anchors only purgeable, top-level-tenantId rows; chat cross-check batches', async (ctx) => {
    if (!storage) return ctx.skip();
    // Anchoring row (hostext keyspace, top-level tenantId).
    await storage.kvSet('hostext:roster:anon:pg-a:host:x', JSON.stringify({ rosterId: 'host:x', tenantId: 'anon:pg-a' }));
    // NON-anchoring: outside the purgeable keyspace — BOTH shapes (F-5):
    // nested tenantId in a surface payload, AND a top-level tenantId (the
    // row that only the k-prefix filter excludes — the H1 livelock shape).
    await storage.kvSet('hostsurf:table:rows:whatever', JSON.stringify({ payload: { tenantId: 'anon:pg-ghost' } }));
    await storage.kvSet('hostsurf:table:rows:toplevel', JSON.stringify({ tenantId: 'anon:pg-ghost2' }));
    // NON-anchoring: nested-only tenantId inside hostext.
    await storage.kvSet('hostext:thing:1', JSON.stringify({ inner: { tenantId: 'anon:pg-nested' } }));
    // Malformed value containing the probe substring — must be skipped.
    await storage.kvSet('hostext:junk:1', 'nope {"tenantId":"anon:pg-junk');
    // Foreign prefix.
    await storage.kvSet('hostext:roster:user:pg-b:host:x', JSON.stringify({ rosterId: 'host:x', tenantId: 'user:pg-b' }));
    // Chat cross-check row.
    await storage.createChatSession({
      sessionId: 'cs-pg', tenantId: 'anon:pg-a', title: 't',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 1,
    });

    const rows = await storage.listHostExtTenantActivity('anon:', 100);
    const ids = rows.map((r) => r.tenantId);
    expect(ids).toEqual(['anon:pg-a']);
    const a = rows[0]!;
    expect(typeof a.lastHostExtAt).toBe('string');
    expect(a.lastChatAt).not.toBeNull();
  });
});
