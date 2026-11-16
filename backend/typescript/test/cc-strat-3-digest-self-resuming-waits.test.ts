/**
 * CC-STRAT-3 — the run digest a chat agent reads must say what a waiting run is
 * waiting FOR.
 *
 * Found on the prod retest of 2026-11-16 (run a3971138): the campaign
 * orchestration run was `waiting-external` on its own channel runs, and the
 * Campaign Strategist told the person it was "waiting for a person to decide",
 * because the digest rendered every `waiting-*` status as "paused, waiting for
 * input". CC-ORCH-3 fixed the same confusion in the UI.
 *
 * Red when (witnessed with main's runDigests.ts): a `waiting-external` digest says
 * "waiting for input" or omits that it continues on its own; or an approval or
 * input wait stops saying a person is needed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { __resetRunDigestCacheForTest, resolveRunDigests } from '../src/host/exchange/runDigests.js';

const now = '2026-11-16T06:00:00.000Z';
let storage: Storage;
beforeEach(async () => { storage = await openStorage('memory://'); __resetRunDigestCacheForTest(); });

async function digestFor(status: RunRecord['status']): Promise<string> {
  const runId = `r-${status}`;
  await storage.insertRun({ runId, workflowId: 'campaign-studio.campaign-orchestration', tenantId: 't1', status, inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as RunRecord);
  const out = await resolveRunDigests(storage, { tenantId: 't1', refs: [{ runId, ts: 1, source: 'turn', workflowName: 'Campaign orchestration' }] });
  const d = out.get(runId);
  return `${d?.headline ?? ''}\n${d?.detail ?? ''}`;
}

describe('CC-STRAT-3 — waiting digests say what the run waits for', () => {
  it('a waiting-external run continues on its own; nobody needs to act', async () => {
    const text = await digestFor('waiting-external');
    expect(text).toMatch(/continues on its own/);
    expect(text).toMatch(/nobody needs to act/);
    expect(text).not.toMatch(/waiting for input/);
  });

  it('human waits still say a person is needed', async () => {
    expect(await digestFor('waiting-approval')).toMatch(/waiting for a person to approve/);
    expect(await digestFor('waiting-input')).toMatch(/waiting for input/);
  });
});
