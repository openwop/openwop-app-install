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
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import type { WidgetConfig } from './widgetService.js';

// A5 (chat-first port) — both counters carry `tenantId` + `updatedAt` so the
// ADR 0077 retention seam can age them. They are technical abuse counters on an
// UNAUTH path (a visitor never signs in), so without a reaper the two namespaces
// grow one row per visitor-session and one row per widget-per-day forever.
// `updatedAt` is derived from the passed `day` but CLAMPED to the host clock (see
// `retentionStampFor`): a public visitor supplies `day`, so an unclamped future
// date would push the stamp past every age-out cutoff and evade the reaper. The
// cap DECISION never reads this stamp — it stays the deterministic, replay-neutral
// function of turns/sessions/caps/day it always was; the clamp touches retention
// metadata only, never decision input.
interface WidgetSession { sKey: string; turns: number; tenantId: string; updatedAt: string }
interface WidgetDayCount { dKey: string; sessions: number; tenantId: string; updatedAt: string }
// ADR 0469 A3 — the per-widget-per-day HELD-WRITE counter (anon write/egress cap).
interface WidgetAnonWriteDay { wKey: string; writes: number; tenantId: string; updatedAt: string }
// ADR 0469 Phase D — the per-widget-per-SESSION AUTO-WRITE counter (rate-limit-session-cap).
interface WidgetAnonAutoWriteSession { aKey: string; writes: number; tenantId: string; updatedAt: string }

const sessions = new DurableCollection<WidgetSession>('chatwidget:session', (s) => s.sKey);
const dayCounts = new DurableCollection<WidgetDayCount>('chatwidget:day', (d) => d.dKey);
const anonWriteDay = new DurableCollection<WidgetAnonWriteDay>('chatwidget:anonwrite:day', (w) => w.wKey);
const anonAutoWriteSession = new DurableCollection<WidgetAnonAutoWriteSession>('chatwidget:anonautowrite:session', (a) => a.aKey);

/** A day bucket (`YYYY-MM-DD`) normalized to an ISO instant for the retention
 *  `updatedAt < cutoffIso` comparison — day-granular is ample for a counter TTL. */
const dayToIso = (day: string): string => `${day}T00:00:00.000Z`;

/** The retention stamp for a turn: the day-derived instant, but never later than
 *  the host clock. `day` is visitor-supplied on this unauth path, so a future date
 *  would inflate the stamp past every future cutoff and evade age-out forever;
 *  clamping to `now` makes an inflated `day` age from now instead. Both operands
 *  are fixed-width UTC `Z` ISO-8601, so string `>` is chronological. Decision logic
 *  never reads this value, so the clamp does not affect determinism. */
const retentionStampFor = (day: string): string => {
  const iso = dayToIso(day);
  const now = new Date().toISOString();
  return iso > now ? now : iso;
};

// A5 — age both counter namespaces on the `internal` classification (they hold no
// PII — an opaque session id + integer counts). Like every ADR 0077 purger the
// window is operator opt-in (`retention.internalDays`; a short value e.g. 35 fits
// these throwaway counters); until then they persist, as they do today. Legacy
// rows written before this change carry no `tenantId`, so they match no tenant
// and are simply skipped — active sessions self-heal on their next turn write.
registerRetentionPurger({
  feature: 'chat-widget',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    const [s, d, w, a] = await Promise.all([
      purgeRowsByAge('chat-widget', await sessions.list(), tenantId, cutoffIso,
        (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.sKey }), (id) => sessions.delete(id)),
      purgeRowsByAge('chat-widget', await dayCounts.list(), tenantId, cutoffIso,
        (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.dKey }), (id) => dayCounts.delete(id)),
      // ADR 0469 A3 — age the anon-write counter on the same internal window.
      purgeRowsByAge('chat-widget', await anonWriteDay.list(), tenantId, cutoffIso,
        (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.wKey }), (id) => anonWriteDay.delete(id)),
      // ADR 0469 Phase D — age the anon auto-write session counter on the same window.
      purgeRowsByAge('chat-widget', await anonAutoWriteSession.list(), tenantId, cutoffIso,
        (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.aKey }), (id) => anonAutoWriteSession.delete(id)),
    ]);
    return { deleted: s.deleted + d.deleted + w.deleted + a.deleted, failed: (s.failed ?? 0) + (d.failed ?? 0) + (w.failed ?? 0) + (a.failed ?? 0) };
  },
});

export interface CapDecision { allowed: boolean; reason?: 'turn_cap' | 'session_cap' | 'write_cap' | 'auto_write_cap' }

/**
 * ADR 0469 A3 — count a HELD anon write against the widget's per-day write cap,
 * BEFORE creating its approval (the anti-flood gate: an internet bot must not
 * flood the operator inbox). CAS-atomic increment (mirrors the day-count anchor
 * in `checkWidgetTurn`); fail-closed at the limit and on contention. Deterministic
 * (`day` passed in). Increment ONLY on an allowed write so a denied bot turn
 * doesn't consume the budget it's being denied.
 *
 * ADR 0470 P3 (architect finding) — the operator inbox is a PUBLIC-facing flood
 * target, so its bound must NOT be operator-optional. When `maxWritesPerDay` is
 * unset, a **secure default** (`OPENWOP_ANON_WRITE_DEFAULT_PER_DAY`, default 25)
 * applies — an UNCONFIGURED anon widget is bounded by default rather than uncapped.
 * The operator's explicit cap (up OR down) still wins; the default is only the
 * floor when they set nothing.
 */
const DEFAULT_ANON_WRITES_PER_DAY = (() => {
  const n = Number(process.env.OPENWOP_ANON_WRITE_DEFAULT_PER_DAY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
})();

export async function checkAnonWrite(widget: WidgetConfig, day: string): Promise<CapDecision> {
  const maxWrites = widget.caps.maxWritesPerDay ?? DEFAULT_ANON_WRITES_PER_DAY;
  if (maxWrites === Infinity) return { allowed: true }; // only if an operator EXPLICITLY set an uncapped value
  const wKey = `${widget.widgetId}:${day}`;
  const tenantId = widget.tenantId;
  const updatedAt = retentionStampFor(day);
  for (let attempt = 0; attempt < 12; attempt++) {
    const cur = await anonWriteDay.get(wKey);
    if ((cur?.writes ?? 0) >= maxWrites) return { allowed: false, reason: 'write_cap' };
    if (await anonWriteDay.compareAndSwap(cur ?? null, { wKey, writes: (cur?.writes ?? 0) + 1, tenantId, updatedAt })) return { allowed: true };
    // lost the race → re-read + retry
  }
  return { allowed: false, reason: 'write_cap' }; // contention exhausted → fail-closed
}

/**
 * ADR 0469 Phase D — count an AUTO-EXECUTED anon write (the `rate-limit-session-cap`
 * control) against the widget's per-SESSION auto-write cap. Unlike `checkAnonWrite`
 * (per-day, gates approval CREATION), this gates INLINE EXECUTION — so it is
 * FAIL-CLOSED when the cap is unset: an auto-run control with no bound is exactly the
 * fail-open shape the RFC forbids (config-time validation requires the cap, this is
 * the runtime backstop). CAS-atomic increment (mirrors `checkAnonWrite`); deterministic
 * (`day` passed in); increment ONLY on an allowed write.
 */
export async function checkAnonAutoWrite(widget: WidgetConfig, sessionId: string, day: string): Promise<CapDecision> {
  const maxAuto = widget.caps.maxAutoWritesPerSession;
  if (!(typeof maxAuto === 'number' && maxAuto > 0)) return { allowed: false, reason: 'auto_write_cap' }; // fail-closed: no bound ⇒ no auto-run
  const aKey = `${widget.widgetId}:${sessionId}:${day}`;
  const tenantId = widget.tenantId;
  const updatedAt = retentionStampFor(day);
  for (let attempt = 0; attempt < 12; attempt++) {
    const cur = await anonAutoWriteSession.get(aKey);
    if ((cur?.writes ?? 0) >= maxAuto) return { allowed: false, reason: 'auto_write_cap' };
    if (await anonAutoWriteSession.compareAndSwap(cur ?? null, { aKey, writes: (cur?.writes ?? 0) + 1, tenantId, updatedAt })) return { allowed: true };
    // lost the race → re-read + retry
  }
  return { allowed: false, reason: 'auto_write_cap' }; // contention exhausted → fail-closed
}

/** Count a visitor turn against the widget's caps. A NEW session is also counted
 *  against the per-day session cap. Fail-closed at the limits.
 *
 *  PUB-3: atomic via compare-and-swap, with the session-record CREATE as the anchor —
 *  only the writer that wins the create counts the new session against the per-day cap,
 *  so two concurrent first-turns of the SAME session can't double-count the day (a plain
 *  read-then-write both saw "no session" and both incremented). Fail-closed on contention. */
/** ADR 0707 — secure defaults for the LLM turn caps, mirroring
 *  `DEFAULT_ANON_WRITES_PER_DAY` above. These used to be `?? Infinity`: an unset cap
 *  meant an internet-reachable, OPERATOR-BILLED surface with no bound, sitting beside a
 *  write cap that the ADR 0470 P3 architect finding had already ruled must "NOT be
 *  operator-optional" for the weaker threat (inbox flood, not spend).
 *
 *  It also made a stated bound vacuous: `publicGateway.ts` explains that a visitor
 *  rotating their opaque session id "is bounded by `maxSessionsPerDay` + the global
 *  per-IP rateLimit" — true of a CONFIGURED widget, and empty for the default one.
 *
 *  Deliberately generous: the goal is BOUNDED, not tight. An operator's explicit value
 *  wins in either direction. */
const DEFAULT_TURNS_PER_SESSION = (() => {
  const n = Number(process.env.OPENWOP_WIDGET_TURNS_DEFAULT_PER_SESSION);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();
const DEFAULT_SESSIONS_PER_DAY = (() => {
  const n = Number(process.env.OPENWOP_WIDGET_SESSIONS_DEFAULT_PER_DAY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

export async function checkWidgetTurn(widget: WidgetConfig, sessionId: string, day: string): Promise<CapDecision> {
  // `?? DEFAULT`, then an EXPLICIT Infinity still opts out — copied from
  // `checkAnonWrite` above, because the distinction between UNSET and
  // EXPLICITLY-UNBOUNDED is the whole point: absence must never be a grant.
  const maxTurns = widget.caps.maxTurnsPerSession ?? DEFAULT_TURNS_PER_SESSION;
  const maxSessions = widget.caps.maxSessionsPerDay ?? DEFAULT_SESSIONS_PER_DAY;
  const sKey = `${widget.widgetId}:${sessionId}`;
  const dKey = `${widget.widgetId}:${day}`;
  const tenantId = widget.tenantId;
  const updatedAt = retentionStampFor(day);

  for (let attempt = 0; attempt < 12; attempt++) {
    const sess = await sessions.get(sKey);
    if (!sess) {
      // NEW session — gate on the per-day cap, then CAS-CREATE (the atomicity anchor).
      const dc = await dayCounts.get(dKey);
      if ((dc?.sessions ?? 0) >= maxSessions) return { allowed: false, reason: 'session_cap' };
      const created = await sessions.compareAndSwap(null, { sKey, turns: 1, tenantId, updatedAt });
      if (!created) continue; // lost the create race → re-read (now exists) on retry
      // We created it → this is the genuinely-new session; count it against the day.
      for (let d = 0; d < 12; d++) {
        const cur = await dayCounts.get(dKey);
        if (await dayCounts.compareAndSwap(cur ?? null, { dKey, sessions: (cur?.sessions ?? 0) + 1, tenantId, updatedAt })) break;
      }
      return { allowed: true };
    }
    // EXISTING session — gate on the per-session turn cap, then CAS-increment.
    // Refresh `updatedAt` so a session active across days ages from its last turn.
    if (sess.turns >= maxTurns) return { allowed: false, reason: 'turn_cap' };
    if (await sessions.compareAndSwap(sess, { ...sess, turns: sess.turns + 1, tenantId, updatedAt })) return { allowed: true };
    // lost the turn race → retry
  }
  return { allowed: false, reason: 'turn_cap' }; // contention exhausted → fail-closed
}
