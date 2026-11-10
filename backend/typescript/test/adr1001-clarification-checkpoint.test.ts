/**
 * ADR 1001 D3.1 — the clarification continuation checkpoint store.
 *
 * Why it exists: a checkpoint holds the transcript tail of a paused agent turn,
 * tool output included, so it must (1) read back only for the run and node that
 * wrote it, newest round first; (2) refuse to grow past its cap rather than
 * write an unbounded row. Retiring with the run on both delete paths and both
 * adapters is `adr1001-checkpoint-run-cascade.test.ts`.
 *
 * The store takes a `Storage` and never reads the run row, so this drives it on
 * a memory storage with per-case ids (no app boot).
 *
 * Node scope is a DOUBLE GUARD in `clarificationCheckpoint.ts`: the `kvList`
 * prefix carries the encoded nodeId AND `parse` re-checks `cp.nodeId`. Removing
 * either alone stays green; removing both reds case 1's `agent:2` leg. Tenant
 * scope has one guard (`parse`). Rounds 1/2/10 pin the zero-padded key order.
 *
 * Sabotage: removing the tenant check in `parse` reds case 1's cross-tenant
 * leg; dropping the zero padding in the key reds case 1's newest-round leg;
 * removing the node check in `parse` together with the nodeId in the prefix
 * reds case 1's other-node leg; removing the size cap reds case 2.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  CLARIFICATION_CHECKPOINT_MAX_BYTES,
  latestClarificationCheckpoint,
  saveClarificationCheckpoint,
  type ClarificationCheckpoint,
} from '../src/host/clarificationCheckpoint.js';

const TENANT = 'org:adr1001-ckpt';
let s: Storage;
let n = 0;
const runIdFor = (): string => `run-ckpt-${n++}`;

beforeAll(async () => {
  s = await openStorage('memory://');
});

function cp(runId: string, tenantId: string, round: number, extra: Partial<ClarificationCheckpoint> = {}): ClarificationCheckpoint {
  return {
    v: 1, tenantId, runId, nodeId: 'agent:1', round,
    transcriptTail: [{ role: 'assistant', content: `ask ${round}` }],
    questions: [{ id: 'q', question: 'Q?', answer: { kind: 'boolean' } }],
    questionsDigest: 'abcdabcdabcdabcd', ordinalCursor: round * 2, createdAt: '2026-10-28T10:00:00Z',
    ...extra,
  };
}

describe('ADR 1001 D3.1 — clarification checkpoints', () => {
  it('reads back the newest round, only for the run, node and tenant that wrote it', async () => {
    const runId = runIdFor();
    for (const r of [1, 2, 10]) expect(await saveClarificationCheckpoint(s, cp(runId, TENANT, r))).toEqual({ ok: true });
    expect((await latestClarificationCheckpoint(s, { tenantId: TENANT, runId, nodeId: 'agent:1' }))?.round).toBe(10);
    expect(await latestClarificationCheckpoint(s, { tenantId: TENANT, runId, nodeId: 'agent:2' })).toBeNull();
    expect(await latestClarificationCheckpoint(s, { tenantId: 'other-tenant', runId, nodeId: 'agent:1' })).toBeNull();
  });

  it('refuses a checkpoint over the size cap instead of writing it', async () => {
    const runId = runIdFor();
    const big = cp(runId, TENANT, 1, { transcriptTail: [{ role: 'assistant', content: 'x'.repeat(CLARIFICATION_CHECKPOINT_MAX_BYTES) }] });
    expect(await saveClarificationCheckpoint(s, big)).toEqual({ ok: false, reason: 'too_large' });
    expect(await latestClarificationCheckpoint(s, { tenantId: TENANT, runId, nodeId: 'agent:1' })).toBeNull();
  });
});
