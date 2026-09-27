/**
 * ADR 0591 P2 — does the logical identity REPRODUCE across the kill?
 *
 * This is the measurement the whole instrument rests on, and it can falsify the
 * design rather than merely regress it. RFC 0158 §C.7 (`duplicate-delivery`)
 * and RFC 0150 §D box #4 leg (ii) both assert on a count held at ONE
 * `logicalInvocationId`. That only works if the process which resumes the run
 * after a SIGKILL recomputes the SAME identity for the same logical effect. If
 * it does not, the pre-kill row and the post-kill row land at two different
 * identities, BOTH counts read 1, and a real double-fire passes — the witness
 * certifying the absence of the property it claims to prove.
 *
 * The ordinal comes from `effectIdentity.ts`'s module-level `ordinalCounters`
 * Map, which is process-local and rewinds per attempt. That is precisely why
 * this needs measuring rather than assuming: process-local state is what broke
 * the P1 key (see `effect-escape-ledger.test.ts`), and the same property is
 * load-bearing here in the opposite direction — there it had to be absent from
 * the key, here it has to be reproducible.
 *
 * `resetLogicalInvocationOrdinals()` IS the kill: dropping the module-level Map
 * is exactly what a fresh process starts with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import {
  recordDurableEffectEscape,
  setEffectEscapeBackend,
  __resetEffectEscapeBackendForTest,
} from '../src/host/effectEscapeLedger.js';
import { resetLogicalInvocationOrdinals } from '../src/host/effectIdentity.js';

const CTX = { runId: 'run-1', replaying: false, nodeId: 'notify', tenantId: 't1', attempt: 1 };

async function freshStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'adr0591-p2-'));
  return openStorage(`sqlite://${join(dir, 'ledger.db')}`);
}

beforeEach(() => {
  __resetEffectEscapeBackendForTest();
  resetLogicalInvocationOrdinals();
});

describe('ADR 0591 P2 — identity reproduction across a process kill', () => {
  it('the resumed process recomputes the SAME logicalInvocationId, so the double-fire is ONE identity with count 2', async () => {
    const storage = await freshStorage();
    setEffectEscapeBackend(storage);

    // ── process A: the run executes the node and the effect escapes.
    await runWithEffectContext(CTX, async () => {
      await recordDurableEffectEscape('notification:approval');
    });

    // ── SIGKILL. A fresh process has no ordinal state at all.
    resetLogicalInvocationOrdinals();

    // ── process B resumes the run and the SAME logical effect fires again.
    await runWithEffectContext(CTX, async () => {
      await recordDurableEffectEscape('notification:approval');
    });

    const rows = await storage.listEffectEscapes('run-1');
    // ONE identity — if the ordinal did not reproduce this would be 2 rows of
    // count 1 each, and the §C.7 assertion would read PASS on a real duplicate.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('two DISTINCT logical effects in one node stay distinct identities', async () => {
    // The counterweight to the test above: reproducibility must not come from
    // collapsing everything to one key. `effectIdentity.ts` requires that "two
    // distinct logical invocations MUST receive different ordinals even when
    // every other input matches".
    const storage = await freshStorage();
    setEffectEscapeBackend(storage);

    await runWithEffectContext(CTX, async () => {
      await recordDurableEffectEscape('notification:approval');
      await recordDurableEffectEscape('notification:approval');
    });

    const rows = await storage.listEffectEscapes('run-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.count)).toEqual([1, 1]);
  });

  it('records nothing outside a run — an effect from a route or sweep belongs to no identity', async () => {
    const storage = await freshStorage();
    setEffectEscapeBackend(storage);
    await recordDurableEffectEscape('notification:approval'); // no ambient context
    expect(await storage.listEffectEscapes('run-1')).toEqual([]);
  });

  it('does NOT silently record when the identity inputs are missing inside a run', async () => {
    // The wiring-drift case. If the executor stops populating nodeId/tenantId,
    // every later escape goes unrecorded while the ledger still reads healthy.
    // It must refuse and say so rather than write a row under a wrong identity.
    const storage = await freshStorage();
    setEffectEscapeBackend(storage);

    await runWithEffectContext({ runId: 'run-1', replaying: false }, async () => {
      await recordDurableEffectEscape('notification:approval');
    });

    expect(await storage.listEffectEscapes('run-1')).toEqual([]);
  });
});
