/**
 * ADR 0127 Phase 2c — public-widget abuse caps. The gate a visitor turn passes
 * BEFORE it drives the agent: a per-SESSION turn cap + a per-DAY new-session cap
 * (the `WidgetCaps` an operator set). Unset caps = uncapped. Deterministic — the
 * `day` bucket is passed in (no host clock in the logic), so it is unit-testable
 * and replay-neutral. Persisted via DurableCollection (per-IP rate-limit still
 * applies on top at the middleware).
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { WidgetConfig } from './widgetService.js';

interface WidgetSession { sKey: string; turns: number }
interface WidgetDayCount { dKey: string; sessions: number }

const sessions = new DurableCollection<WidgetSession>('chatwidget:session', (s) => s.sKey);
const dayCounts = new DurableCollection<WidgetDayCount>('chatwidget:day', (d) => d.dKey);

export interface CapDecision { allowed: boolean; reason?: 'turn_cap' | 'session_cap' }

/** Count a visitor turn against the widget's caps. A NEW session is also counted
 *  against the per-day session cap. Fail-closed at the limits.
 *
 *  PUB-3: atomic via compare-and-swap, with the session-record CREATE as the anchor —
 *  only the writer that wins the create counts the new session against the per-day cap,
 *  so two concurrent first-turns of the SAME session can't double-count the day (a plain
 *  read-then-write both saw "no session" and both incremented). Fail-closed on contention. */
export async function checkWidgetTurn(widget: WidgetConfig, sessionId: string, day: string): Promise<CapDecision> {
  const maxTurns = widget.caps.maxTurnsPerSession ?? Infinity;
  const maxSessions = widget.caps.maxSessionsPerDay ?? Infinity;
  const sKey = `${widget.widgetId}:${sessionId}`;
  const dKey = `${widget.widgetId}:${day}`;

  for (let attempt = 0; attempt < 12; attempt++) {
    const sess = await sessions.get(sKey);
    if (!sess) {
      // NEW session — gate on the per-day cap, then CAS-CREATE (the atomicity anchor).
      const dc = await dayCounts.get(dKey);
      if ((dc?.sessions ?? 0) >= maxSessions) return { allowed: false, reason: 'session_cap' };
      const created = await sessions.compareAndSwap(null, { sKey, turns: 1 });
      if (!created) continue; // lost the create race → re-read (now exists) on retry
      // We created it → this is the genuinely-new session; count it against the day.
      for (let d = 0; d < 12; d++) {
        const cur = await dayCounts.get(dKey);
        if (await dayCounts.compareAndSwap(cur ?? null, { dKey, sessions: (cur?.sessions ?? 0) + 1 })) break;
      }
      return { allowed: true };
    }
    // EXISTING session — gate on the per-session turn cap, then CAS-increment.
    if (sess.turns >= maxTurns) return { allowed: false, reason: 'turn_cap' };
    if (await sessions.compareAndSwap(sess, { sKey, turns: sess.turns + 1 })) return { allowed: true };
    // lost the turn race → retry
  }
  return { allowed: false, reason: 'turn_cap' }; // contention exhausted → fail-closed
}
