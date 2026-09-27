/**
 * ADR 0376 Phase 2 — the tour→walkthrough persisted-id migration + the
 * replay-safety aliases. Verifies:
 *  - the app-migration COPIES (not moves) the toggle canary row + progress rows
 *    to the new ids, renaming the tourId field and rewriting the builtin id;
 *  - it is idempotent + preserves the tenant override (the canary);
 *  - the legacy node type ids + builtin workflow id stay REGISTERED as aliases so
 *    pre-rename defs/runs still resolve on replay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWalkthroughNodes, WALKTHROUGH_STEP_TYPE_ID, WALKTHROUGH_CHECKPOINT_TYPE_ID, LEGACY_STEP_TYPE_ID, LEGACY_CHECKPOINT_TYPE_ID } from '../src/features/walkthroughs/walkthroughNodes.js';

let store: Storage | null = null;
afterEach(async () => { await store?.close(); store = null; __resetHostExtPersistence(); });

const migration = APP_MIGRATIONS.find((m) => m.version === 2)!;

describe('ADR 0376 Phase 2 — persisted-id migration', () => {
  it('copies the toggle canary + progress rows to the new ids (COPY, not move), idempotently', async () => {
    store = openSqliteStorage(':memory:');
    initHostExtPersistence(store);
    // Seed the deployed state under the OLD ids: a canary toggle (David override on)
    // and one completed progress row for the builtin walkthrough.
    const toggle = { id: 'guided-tours', status: 'off', tenantOverrides: { 'user:abc': true } };
    await store.kvSet('hostext:feature-toggle:guided-tours', JSON.stringify(toggle));
    const prog = { key: 't1:tour.campaign-studio.first-brief', tenantId: 't1', tourId: 'tour.campaign-studio.first-brief', status: 'completed', runId: 'r1', updatedAt: '2026-07-16T00:00:00.000Z' };
    await store.kvSet('hostext:guided-tour-progress:t1:tour.campaign-studio.first-brief', JSON.stringify(prog));

    await migration.run(store);

    // Toggle COPIED with the override preserved + id rewritten; old row still present.
    const newToggle = JSON.parse((await store.kvGet('hostext:feature-toggle:walkthroughs'))!) as Record<string, unknown>;
    expect(newToggle.id).toBe('walkthroughs');
    expect(newToggle.tenantOverrides).toEqual({ 'user:abc': true }); // the canary survives
    expect(await store.kvGet('hostext:feature-toggle:guided-tours')).not.toBeNull(); // copy, not move

    // Progress COPIED with tourId->walkthroughId field + the builtin id rewritten.
    const newProg = JSON.parse((await store.kvGet('hostext:walkthrough-progress:t1:walkthrough.campaign-studio.first-brief'))!) as Record<string, unknown>;
    expect(newProg.walkthroughId).toBe('walkthrough.campaign-studio.first-brief');
    expect(newProg.tourId).toBeUndefined();
    expect(newProg.status).toBe('completed');
    expect(await store.kvGet('hostext:guided-tour-progress:t1:tour.campaign-studio.first-brief')).not.toBeNull();

    // Idempotent: a second run neither duplicates nor clobbers.
    await migration.run(store);
    const again = JSON.parse((await store.kvGet('hostext:feature-toggle:walkthroughs'))!) as Record<string, unknown>;
    expect(again.tenantOverrides).toEqual({ 'user:abc': true });
  });

  it('does NOT clobber a diverged new-toggle on re-run (first-write-wins)', async () => {
    store = openSqliteStorage(':memory:');
    initHostExtPersistence(store);
    await store.kvSet('hostext:feature-toggle:guided-tours', JSON.stringify({ id: 'guided-tours', status: 'off', tenantOverrides: { 'user:x': true } }));
    // An admin already turned the new toggle fully on — the migration must not revert it.
    await store.kvSet('hostext:feature-toggle:walkthroughs', JSON.stringify({ id: 'walkthroughs', status: 'on', tenantOverrides: {} }));
    await migration.run(store);
    const t = JSON.parse((await store.kvGet('hostext:feature-toggle:walkthroughs'))!) as Record<string, unknown>;
    expect(t.status).toBe('on'); // preserved, not overwritten by the guided-tours copy
  });

  it('registers the legacy node type ids as aliases (pre-rename runs replay)', () => {
    registerWalkthroughNodes();
    const reg = getNodeRegistry();
    // Both the new AND legacy type ids resolve to a node impl.
    for (const id of [WALKTHROUGH_STEP_TYPE_ID, LEGACY_STEP_TYPE_ID, WALKTHROUGH_CHECKPOINT_TYPE_ID, LEGACY_CHECKPOINT_TYPE_ID]) {
      expect(reg.get(id), `type id ${id} must resolve`).toBeTruthy();
    }
    expect(LEGACY_STEP_TYPE_ID).toBe('ui.tour.step');
    expect(WALKTHROUGH_STEP_TYPE_ID).toBe('ui.walkthrough.step');
  });
});
