/**
 * ADR 0597 §Correction 6 — the KB purge's "fails closed" rationale was not
 * established by the code, and the claimed recovery is unreachable.
 *
 * §4 Decision 2 (and the comment beside the call) argued that removal-first
 * "fails CLOSED" while index-first would "fail OPEN", and that the worst case
 * was "the doc is absent and `reindex-kb` restores it". The shipped ORDER is
 * fine; the REASONING defending it was wrong on all three legs, and reasoning is
 * what a future editor trusts when reordering two adjacent lines.
 *
 * This file pins the legs that are checkable so the corrected comment cannot
 * quietly rot back:
 *
 *   1. neither function can throw, so neither ordering can abort the other;
 *   2. a FAILED eviction is reported (`removeStrategy` → false) rather than
 *      swallowed, because it is the one case with no self-heal;
 *   3. `backfillStrategyKb` on the OLD org genuinely cannot recover it — the
 *      relocated strategy carries the NEW orgId, so the sweep never visits it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { strategyFeature } from '../src/features/strategy/feature.js';
import * as kbService from '../src/features/kb/kbService.js';
import { createStrategy, updateStrategy, __clearStrategies } from '../src/features/strategy/strategyService.js';
import { removeStrategy, indexStrategy, backfillStrategyKb } from '../src/features/strategy/strategyKnowledgeService.js';

const T = 'org:kbreloc';
const A = 'org-alpha';
const B = 'org-bravo';
const col = (orgId: string): string => `mgd-strategy-${orgId}`;

describe('ADR 0597 §Correction 6 — the relocation eviction is OBSERVED, not assumed', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    // `deleteDocument` fires the ADR 0351 knowledge-changed seam through the host
    // surface bundle; without this the eviction throws for a reason that has
    // nothing to do with what is under test, and `removeStrategy` would return
    // `false` for the wrong reason.
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbreloc-')) });
    await __clearStrategies();
    // The feature's own declared default, registered + saved directly: this
    // suite is a unit test of the KB seam, not a booted app, so nothing has
    // registered it and `gatesOpen` would otherwise fail closed and make every
    // assertion below vacuous.
    registerToggleDefault(strategyFeature.toggleDefault!);
    await saveConfig({ ...strategyFeature.toggleDefault!, status: 'on' }, 'test');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('neither removeStrategy nor indexStrategy can throw — so neither ordering can "fail closed"', async () => {
    const s = await createStrategy(T, A, 'u1', { title: 'Ordered', scope: 'org' });
    vi.spyOn(kbService, 'deleteDocument').mockRejectedValue(new Error('kb store down'));
    vi.spyOn(kbService, 'upsertDocument').mockRejectedValue(new Error('kb store down'));

    // The whole premise of the old rationale was that one of these aborts the
    // other. Both resolve. The asymmetry it described does not exist.
    await expect(removeStrategy(T, A, s.id)).resolves.toBe(false);
    await expect(indexStrategy(T, s, 'u1')).resolves.toBeUndefined();
  });

  it('a FAILED eviction is reported to the caller instead of swallowed', async () => {
    const s = await createStrategy(T, A, 'u1', { title: 'Evictable', scope: 'org' });
    expect(await kbService.getDocument(T, A, col(A), s.id), 'never indexed ⇒ the rest is vacuous').toBeTruthy();

    // Success path first: the return value must not be a constant.
    expect(await removeStrategy(T, A, s.id), 'a successful eviction reported failure').toBe(true);

    await indexStrategy(T, s, 'u1');
    vi.spyOn(kbService, 'deleteDocument').mockRejectedValue(new Error('kb store down'));
    expect(await removeStrategy(T, A, s.id), 'a FAILED eviction reported success — the caller cannot alert on it').toBe(false);
    expect(await kbService.getDocument(T, A, col(A), s.id), 'the fixture must leave the stale doc in place').toBeTruthy();
  });

  it('the claimed recovery is UNREACHABLE: reindexing the old org never visits a relocated strategy', async () => {
    const s = await createStrategy(T, A, 'u1', { title: 'Moved on', scope: 'org' });
    expect(await kbService.getDocument(T, A, col(A), s.id)).toBeTruthy();

    // Relocate with the eviction failing — the exact "worst case" §4 claimed
    // `reindex-kb` would repair.
    const spy = vi.spyOn(kbService, 'deleteDocument').mockRejectedValue(new Error('kb store down'));
    await updateStrategy(T, s.id, { orgId: B }, 'u1');
    spy.mockRestore();

    expect(await kbService.getDocument(T, B, col(B), s.id), 'the destination copy must exist').toBeTruthy();
    expect(await kbService.getDocument(T, A, col(A), s.id), 'the stale trusted copy the ADR said was recoverable').toBeTruthy();

    // `reindex-kb` on the OLD org — the prescribed repair. It processes ZERO
    // strategies, because `listStrategies(tenantId, {orgId: A})` filters on the
    // strategy's CURRENT org, which is now B.
    expect(await backfillStrategyKb(T, A), 'the old-org sweep saw the relocated strategy after all').toBe(0);
    expect(await kbService.getDocument(T, A, col(A), s.id),
      'the ADR claimed reindex-kb restores the invariant here; it cannot even see the row').toBeTruthy();
  });
});
