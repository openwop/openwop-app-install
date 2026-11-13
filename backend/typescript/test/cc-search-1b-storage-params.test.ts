/**
 * CC-SEARCH-1b — CI coverage for the storage adapter's runs-path jsonb writes
 * (the live Postgres sibling is skipped in `npm run ci`).
 *
 * A fake `pg` Pool captures every parameter the adapter sends. `updateRun`
 * (inputs / metadata / configurable), `mergeRunMetadata`, `insertAnnotation`
 * and `putEnvelopeCorrelation` must send a jsonb TEXT with no unpaired surrogate
 * escape — node-pg would otherwise stringify a raw object with no replacer, and
 * Postgres `jsonb` rejects the lone escape (`invalid input syntax for type json`).
 *
 * Red when: any of the four writes passes a raw object or a bare
 * `JSON.stringify` (the pre-fix code).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Storage } from '../src/storage/storage.js';

const calls: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('pg', () => {
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM runs WHERE run_id = \$1/.test(sql)) {
      return { rows: [{ run_id: 'r1', workflow_id: 'wf', tenant_id: 't', status: 'running', inputs: {}, metadata: {}, configurable: {}, created_at: new Date('2026-11-12T00:00:00Z'), updated_at: new Date('2026-11-12T00:00:00Z') }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release: () => undefined, on: () => undefined, removeAllListeners: () => undefined };
  class Pool {
    query = query;
    connect = async () => client;
    on() { return this; }
    end = async () => undefined;
    totalCount = 0; idleCount = 0; waitingCount = 0;
  }
  return { Pool, default: { Pool } };
});

const LONE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
const HALF = 'Goal apps 😀'.slice(0, 11);
let storage: Storage;

/** Every param of the matching statements, as the text pg would send. */
function sent(match: RegExp): string[] {
  return calls.filter((c) => match.test(c.sql)).flatMap((c) => c.params).map((p) => (typeof p === 'string' ? p : JSON.stringify(p) ?? ''));
}

beforeAll(async () => {
  const { openPostgresStorage } = await import('../src/storage/postgres/index.js');
  storage = await openPostgresStorage('postgres://fake/fake');
});

describe('CC-SEARCH-1b — storage jsonb params are sanitised (CI)', () => {
  it('updateRun sends inputs / metadata / configurable as sanitised jsonb text', async () => {
    calls.length = 0;
    await storage.updateRun('r1', { inputs: { s: HALF }, metadata: { s: HALF }, configurable: { s: [HALF] } });
    const params = calls.filter((c) => /^UPDATE runs SET/.test(c.sql)).flatMap((c) => c.params);
    const jsonb = params.filter((p) => typeof p === 'string' && p.startsWith('{'));
    expect(jsonb, 'inputs/metadata/configurable must be sent as jsonb TEXT, not raw objects').toHaveLength(3);
    for (const p of params) expect(typeof p === 'object' && p !== null, 'a raw object reaches node-pg').toBe(false);
    for (const p of jsonb) expect(LONE.test(p as string), p as string).toBe(false);
  });

  it('mergeRunMetadata, insertAnnotation and putEnvelopeCorrelation send no lone surrogate escape', async () => {
    calls.length = 0;
    await storage.mergeRunMetadata('r1', { s: HALF });
    await storage.insertAnnotation({ annotationId: 'a1', runId: 'r1', tenantId: 't', payload: { s: HALF }, createdAt: '2026-11-12T00:00:00Z' } as Parameters<Storage['insertAnnotation']>[0]);
    await storage.putEnvelopeCorrelation('r1', 'c1', { s: HALF } as Parameters<Storage['putEnvelopeCorrelation']>[2], 'cc-test', '2026-11-12T00:00:00Z');
    const texts = [...sent(/SET metadata = \(COALESCE/), ...sent(/INSERT INTO annotations/), ...sent(/INSERT INTO envelope_correlations/)];
    expect(texts.some((t) => t.includes('�')), 'the sanitised value must be present').toBe(true);
    for (const t of texts) expect(LONE.test(t), t).toBe(false);
  });
});
