/**
 * STRAT-5 / STRAT-6 — Strategy Nice-to-haves.
 *
 * STRAT-6: a strategy's free-text `summary`/`rationale` are declared PII (ADR 0077) so they
 *   mask in logs; `ownerUserId`/`createdBy` are opaque principals, not PII; there is
 *   deliberately no retention purger (strategy is intentional org data, soft-archived).
 * STRAT-5: resolving a set of strategy ids (the advisory-board context path) that includes
 *   an archived/missing ref now emits `strategy_context_refs_dropped` so the silent
 *   context-vanishing is observable — without mutating the board (un-archive stays lossless).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { isPiiField, isKnownPiiFieldName, maskPiiDeep } from '../src/host/dataClassification.js';
import {
  createStrategy, archiveStrategy, resolveStrategyEntriesByIds, __clearStrategies,
} from '../src/features/strategy/strategyService.js';

function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    lines.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
  return fn().finally(() => spy.mockRestore()).then(() => lines.join(''));
}

beforeEach(async () => {
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await __clearStrategies();
});

describe('STRAT-6 — strategy free-text declared PII', () => {
  it('summary + rationale are registered PII fields and mask under their keys', () => {
    // Importing strategyService ran `declarePiiFields('strategy.record', [...])` at load.
    expect(isPiiField('strategy.record', 'summary')).toBe(true);
    expect(isPiiField('strategy.record', 'rationale')).toBe(true);
    expect(isKnownPiiFieldName('summary')).toBe(true);
    const masked = maskPiiDeep({ summary: 'Jane will own Q3', rationale: 'see Bob', title: 'Growth' }) as Record<string, unknown>;
    expect(masked.summary).toMatch(/^pii_/);
    expect(masked.rationale).toMatch(/^pii_/);
    expect(masked.title).toBe('Growth'); // title is operational, not over-masked
  });
});

describe('STRAT-5 — archived/missing context refs are observable on resolve', () => {
  it('logs strategy_context_refs_dropped with reasons; keeps the live ones', async () => {
    // `user` scope = creator-readable, so subject 'u' can read its own live strategy — this
    // isolates the archived/missing drop reasons from RBAC (org scope would need workspace:read).
    const live = await createStrategy('t', 'org-1', 'u', { title: 'Live', scope: 'user' });
    const archived = await createStrategy('t', 'org-1', 'u', { title: 'Old', scope: 'user' });
    await archiveStrategy('t', archived.id);

    let entries: Awaited<ReturnType<typeof resolveStrategyEntriesByIds>> = [];
    const out = await capture(async () => {
      // A board's contextRefs pointing at: one live, one archived, one deleted/missing.
      entries = await resolveStrategyEntriesByIds('t', [live.id, archived.id, 'strat-missing'], 'u');
    });

    expect(entries.map((e) => e.id)).toEqual([live.id]); // only the live strategy survives
    expect(out).toContain('strategy_context_refs_dropped');
    expect(out).toMatch(/"droppedArchived":1/);
    expect(out).toMatch(/"droppedMissing":1/);
    expect(out).toMatch(/"kept":1/);
  });

  it('does not log when every ref resolves cleanly', async () => {
    const live = await createStrategy('t', 'org-1', 'u', { title: 'Live', scope: 'user' });
    const out = await capture(async () => { await resolveStrategyEntriesByIds('t', [live.id], 'u'); });
    expect(out).not.toContain('strategy_context_refs_dropped');
  });
});
