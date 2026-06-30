/**
 * ADR 0127 Phase 2c — public-widget abuse caps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkWidgetTurn } from '../src/features/chat-widget/capsTracker.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';

function widget(id: string, caps: WidgetConfig['caps']): WidgetConfig {
  return { widgetId: id, tenantId: 't', orgId: 'o', agentId: 'a', allowedDomains: ['x.com'], caps, token: 'wgt_x', enabled: true, createdBy: 'u', createdAt: 'x', updatedAt: 'x' };
}

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('checkWidgetTurn', () => {
  it('enforces the per-session turn cap', async () => {
    const w = widget('w1', { maxTurnsPerSession: 2 });
    expect((await checkWidgetTurn(w, 's1', '2026-06-24')).allowed).toBe(true);  // turn 1
    expect((await checkWidgetTurn(w, 's1', '2026-06-24')).allowed).toBe(true);  // turn 2
    const third = await checkWidgetTurn(w, 's1', '2026-06-24');
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('turn_cap');
  });

  it('enforces the per-day new-session cap', async () => {
    const w = widget('w2', { maxSessionsPerDay: 1, maxTurnsPerSession: 5 });
    expect((await checkWidgetTurn(w, 'sA', '2026-06-24')).allowed).toBe(true);  // session A (new)
    const sB = await checkWidgetTurn(w, 'sB', '2026-06-24');                    // session B (new) → over cap
    expect(sB.allowed).toBe(false);
    expect(sB.reason).toBe('session_cap');
    // a NEW day resets the session cap
    expect((await checkWidgetTurn(w, 'sC', '2026-06-25')).allowed).toBe(true);
  });

  it('uncapped widget always allows', async () => {
    const w = widget('w3', {});
    for (let i = 0; i < 20; i++) expect((await checkWidgetTurn(w, 's', '2026-06-24')).allowed).toBe(true);
  });

  it('PUB-3: concurrent first-turns of the SAME session count ONE session (no double-count)', async () => {
    const w = widget('w4', { maxSessionsPerDay: 1, maxTurnsPerSession: 100 });
    // 5 concurrent first-turns of the same sessionId must NOT each increment the day count.
    const results = await Promise.all(Array.from({ length: 5 }, () => checkWidgetTurn(w, 'sameSession', '2026-06-24')));
    expect(results.every((r) => r.allowed)).toBe(true); // all same-session turns allowed (cap 100)
    // A DIFFERENT session is now over the per-day cap of 1 (the same session counted once).
    expect((await checkWidgetTurn(w, 'otherSession', '2026-06-24')).reason).toBe('session_cap');
  });

  it('PUB-3: concurrent turns of one session do not overshoot the turn cap', async () => {
    const w = widget('w5', { maxTurnsPerSession: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => checkWidgetTurn(w, 's', '2026-06-24')));
    expect(results.filter((r) => r.allowed).length).toBe(3); // exactly the cap, not more
  });
});
