/**
 * ADR 0693 phase 5 — a participant can see the allowance phases 0-4 gave them.
 *
 * Phases 0-4 gave every participant in a shared workspace a private daily
 * allowance and NO WAY TO SEE IT. That is a real gap, not a nicety: under the
 * old pooled behaviour "the free tier is exhausted" was a property of the
 * workspace, and after the fix it is a property of YOU — and a user cannot tell
 * which regime they are under, or how much of their own allowance is left,
 * without being told.
 *
 * THE LOAD-BEARING ASSERTION IS THAT THE READ AGREES WITH THE CHARGE. A read
 * that resolved its own bucket would be a SECOND composer — the one thing
 * ADR 0693 §2 says to refuse in review — and a usage display that disagreed
 * with the cap that blocks you is worse than no display at all: it would make a
 * correct "daily limit reached" look like a bug. So every case here CHARGES the
 * way `prepareManagedDispatch` charges (compose, then increment) and then asks
 * the read.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { configureManagedProvider, describeOwnManagedUsage } from '../src/providers/managedProvider.js';
import { managedUsageBucket } from '../src/providers/managedUsageScope.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let storage: Storage;
const WS = 'host-ownusage';                    // shared workspace (multi-principal)
const A = 'user:aaaa1111';
const B = 'user:bbbb2222';
const today = new Date().toISOString().slice(0, 10);

/** Charge exactly as `prepareManagedDispatch` does: compose, then increment. */
async function charge(tenantId: string, subject: string | undefined, tokens: number): Promise<void> {
  await storage.incrementManagedUsage(managedUsageBucket(tenantId, subject), 'openwop-free', today, tokens, 0);
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  configureManagedProvider({ storage, dataDir: mkdtempSync(join(tmpdir(), 'owp-ownusage-')) });
});

describe('ADR 0693 phase 5 — the read agrees with the charge', () => {
  it("a participant sees THEIR OWN spend, not the workspace's", async () => {
    await charge(WS, A, 900);

    const forA = await describeOwnManagedUsage(WS, A);
    const forB = await describeOwnManagedUsage(WS, B);

    expect(forA?.tokens, 'A must see their own spend').toBe(900);
    // Before phases 0-2 both read the same row. A display that still pooled
    // would tell B they had spent 900 tokens they never spent.
    expect(forB?.tokens, "B must not see A's spend").toBe(0);
  });

  it('`remaining` counts down against the cap the dispatcher enforces', async () => {
    const C = 'user:cccc3333';
    await charge(WS, C, 400);
    const u = await describeOwnManagedUsage(WS, C);
    expect(u).not.toBeNull();
    expect(u!.remaining).toBe(Math.max(0, u!.dailyTokenCap - 400));
    expect(u!.day).toBe(today);
  });

  it('SCOPE tells the truth about whose allowance it is', async () => {
    // The one thing a user cannot infer from a number. In a shared workspace
    // with a subject it is theirs; on a personal tenant the bucket IS the
    // tenant, so "subject" would be a lie even though the figure is right.
    expect((await describeOwnManagedUsage(WS, A))?.scope).toBe('subject');
    expect((await describeOwnManagedUsage('user:solo9', 'user:solo9'))?.scope).toBe('tenant');
    // No subject — the anonymous widget path. Shared, and says so.
    expect((await describeOwnManagedUsage(WS))?.scope).toBe('tenant');
  });

  it('the anonymous path reads the TENANT row it actually charges', async () => {
    const W2 = 'host-anonread';
    await charge(W2, undefined, 250);
    expect((await describeOwnManagedUsage(W2))?.tokens).toBe(250);
  });

  it('NEVER exposes the bucket key — it is a pseudonymous identifier (§4)', async () => {
    // The bucket is a hash precisely so these rows are not a log of who asked
    // what, when. Handing it to a client would make it trivially correlatable
    // across responses and would undo that.
    const u = await describeOwnManagedUsage(WS, A);
    const serialised = JSON.stringify(u);
    expect(serialised).not.toContain(managedUsageBucket(WS, A));
    expect(serialised).not.toContain(A);
  });

  it('reports NULL, not zero, when no managed target is configured', async () => {
    // A white-label deployment with no free tier has nothing to report, which
    // is a different claim from "you have used none of it".
    expect(await describeOwnManagedUsage(WS, A, 'no-such-provider')).toBeNull();
  });
});
