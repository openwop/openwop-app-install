/**
 * R0399-2 — the render cap is TOCTOU: the pre-flight count check can let
 * parallel renders overshoot. The convergent post-write recheck (every writer
 * sorts the same way and prunes the same newest-beyond-cap overflow, keeping
 * the oldest MAX) closes it: the persisted count NEVER exceeds the cap, and the
 * overflowing renders fail typed. Direct-service test (no HTTP) so the parallel
 * race is exercised cheaply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBrief, __clearCreativeBriefs } from '../src/features/creative-briefs/creativeBriefsService.js';
import { renderForBrief, listRenders, __clearCreativeRenders, renderCapForTest, __setRenderCapForTest } from '../src/features/creative-briefs/render/renderService.js';

const TENANT = 'org:rcap';
const ORG = 'org-1';

// Every render here is a full rasterization, so filling to the PRODUCTION cap
// (60) cost ~12s per test — right up against the 30s budget, and red whenever
// the suite ran under parallel load. The invariant under test (convergent
// post-write recheck) is about the RACE, not the cap's magnitude, so these run
// at a small cap: same shape, ~15x cheaper, no timing cliff.
const TEST_CAP = 4;
let restoreCap: () => void;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  restoreCap = __setRenderCapForTest(TEST_CAP);
});
afterAll(() => { restoreCap(); });
beforeEach(async () => { await __clearCreativeRenders(); await __clearCreativeBriefs(); });

async function seedBrief(): Promise<string> {
  const b = await createBrief(TENANT, ORG, 'tester', { title: 'Cap brief', assetType: 'image', sceneDescription: 'Scene.' });
  return b.briefId;
}
// Distinct CTA copy ⇒ distinct pixels ⇒ distinct asset rows (no dedup collapse).
const render = (briefId: string, i: number) =>
  renderForBrief(TENANT, ORG, 'tester', { briefId, templateId: 'meta.feed.1x1', copy: { cta: `Buy ${i}` } });

describe('render cap — convergent post-write recheck (R0399-2)', () => {
  it('a parallel burst past the cap never persists more than the cap; overflow fails typed', async () => {
    const briefId = await seedBrief();
    const cap = renderCapForTest();
    expect(cap).toBe(TEST_CAP); // the override is live — not silently running at 60

    // Fill to cap MINUS ONE — this is what puts the burst inside the TOCTOU
    // window. Filling to exactly the cap (as this test used to) means all three
    // renders are turned away by the PRE-FLIGHT count check and never reach the
    // post-write recheck at all: verified vacuous — deleting the entire
    // convergent recheck left the old assertions green. With one slot free, all
    // three read `cap-1 < cap`, all three pass pre-flight and write, and only
    // the post-write recheck can bring the total back down to the cap.
    for (let i = 0; i < cap - 1; i++) await render(briefId, i);
    expect((await listRenders(TENANT, ORG, briefId)).length).toBe(cap - 1);

    const results = await Promise.allSettled([render(briefId, 1001), render(briefId, 1002), render(briefId, 1003)]);

    // 3 writers raced for 1 slot ⇒ exactly one survives, the other two are
    // pruned and fail typed. (Without the recheck the store would hold cap+2.)
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBe(2);
    for (const r of rejected) {
      expect(String((r as PromiseRejectedResult).reason?.message ?? '')).toMatch(/Render cap reached/);
    }
    expect((await listRenders(TENANT, ORG, briefId)).length).toBe(cap);
  }, 30_000);

  it('keeps the OLDEST renders (delete-old-first intent), evicting the newest overflow', async () => {
    const briefId = await seedBrief();
    const cap = renderCapForTest();
    expect(cap).toBe(TEST_CAP); // the override is live — not silently running at 60

    // Again cap-1, for the same reason as above: a sequential overshoot from a
    // FULL brief is refused by the pre-flight check, so it proves nothing about
    // WHICH rows the eviction picks. Racing two writers for the last slot forces
    // the overflow through the recheck, where delete-old-first is decided.
    const kept: string[] = [];
    for (let i = 0; i < cap - 1; i++) kept.push((await render(briefId, i)).renderId);

    const results = await Promise.allSettled([render(briefId, 9998), render(briefId, 9999)]);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1);

    const surviving = new Set((await listRenders(TENANT, ORG, briefId)).map((r) => r.renderId));
    expect(surviving.size).toBe(cap);
    // Every ORIGINAL survives — the eviction took the newest overflow, never an
    // older row.
    for (const id of kept) expect(surviving.has(id), id).toBe(true);
    // …and the one winner of the race is the remaining member.
    const winner = results.find((r) => r.status === 'fulfilled');
    expect(winner).toBeDefined();
    expect(surviving.has((winner as PromiseFulfilledResult<{ renderId: string }>).value.renderId)).toBe(true);
  }, 30_000);
});
