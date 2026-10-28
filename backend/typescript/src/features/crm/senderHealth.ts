/**
 * ADR 0955 D7 (J10) — per-sender deliverability: the circuit breaker that pauses ONE client's
 * marketing email when its list goes bad, before it burns the client's sending domain.
 *
 * It lives in `crm` beside the suppression overlay (architect P4 finding 1): it is the same kind
 * of operational overlay, `checkChannelEligibility` (crm) reads it, and `email` writes it through
 * the existing email→crm direction, so nothing cycles.
 *
 * - Counters per (tenant, sender org, UTC day): `sent`, `hardBounces`, `complaints`. The broadcast
 *   adds its `sent` once per pass (a crash mid-pass under-counts sends, which raises the rates —
 *   it fails toward pausing). Each hard bounce or complaint is counted once per (org, day,
 *   reason, address), so a provider's redelivery is idempotent.
 * - The breaker: over the trailing 7 days, with at least `minSends` sends, complaints above
 *   0.1 % or hard bounces above 2 % pause the sender (ADR 0955 D7 / Q5 — first guesses,
 *   env-tunable). The pause is a CAS, so it happens once and notifies once.
 * - Resume is a PERSON's act only (the email route checks a browser session and
 *   `host:members:manage`); there is no workflow verb and no agent tool. Never `auto`.
 * - Transactional mail is never paused: the breaker protects marketing reputation, and receipts
 *   and invitations must keep flowing.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { listMembers } from '../../host/accessControlService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.crm.sender-health');

interface DayCounts { key: string; tenantId: string; orgId: string; day: string; sent: number; hardBounces: number; complaints: number }
interface Seen { key: string; tenantId: string; at: string }
export interface SenderState {
  key: string; tenantId: string; orgId: string;
  paused: boolean;
  pausedAt?: string;
  reason?: 'complaints' | 'hard_bounces';
  /** The 7-day figures that tripped it. */
  rates?: { sent: number; hardBounceRate: number; complaintRate: number };
  resumedAt?: string;
  resumedBy?: string;
}

const days = new DurableCollection<DayCounts>('crm:sender-health-day', (d) => d.key, undefined, (d) => d.tenantId);
const seen = new DurableCollection<Seen>('crm:sender-health-seen', (s) => s.key, undefined, (s) => s.tenantId);
const states = new DurableCollection<SenderState>('crm:sender-state', (s) => s.key, undefined, (s) => s.tenantId);

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const dayKey = (tenantId: string, orgId: string, day: string): string => `${tenantId}::${orgId}::${day}`;
const stateKey = (tenantId: string, orgId: string): string => `${tenantId}::${orgId}`;
const WINDOW_DAYS = 7;

export function breakerThresholds(): { minSends: number; complaintRate: number; hardBounceRate: number } {
  const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    minSends: num(process.env.OPENWOP_EMAIL_BREAKER_MIN_SENDS, 500),
    complaintRate: num(process.env.OPENWOP_EMAIL_BREAKER_COMPLAINT_RATE, 0.001),
    hardBounceRate: num(process.env.OPENWOP_EMAIL_BREAKER_BOUNCE_RATE, 0.02),
  };
}

async function bump(tenantId: string, orgId: string, at: Date, field: 'sent' | 'hardBounces' | 'complaints', by: number): Promise<void> {
  const day = dayOf(at);
  const key = dayKey(tenantId, orgId, day);
  for (let attempt = 0; attempt < 12; attempt++) {
    const cur = await days.get(key);
    const base: DayCounts = cur ?? { key, tenantId, orgId, day, sent: 0, hardBounces: 0, complaints: 0 };
    if (await days.compareAndSwap(cur ?? null, { ...base, [field]: base[field] + by })) return;
  }
  throw new Error('sender health counter contention');
}

/** The broadcast's sends for one pass. `orgId` is the sending client. */
export async function recordSends(tenantId: string, orgId: string, count: number, at: Date = new Date()): Promise<void> {
  if (!orgId || count <= 0) return;
  await bump(tenantId, orgId, at, 'sent', count);
}

/** The trailing-window sums for a sender. Point reads, one per day. */
export async function windowCounts(tenantId: string, orgId: string, now: Date = new Date()): Promise<{ sent: number; hardBounces: number; complaints: number }> {
  const out = { sent: 0, hardBounces: 0, complaints: 0 };
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = await days.get(dayKey(tenantId, orgId, dayOf(new Date(now.getTime() - i * 86_400_000))));
    if (d && d.tenantId === tenantId && d.orgId === orgId) { out.sent += d.sent; out.hardBounces += d.hardBounces; out.complaints += d.complaints; }
  }
  return out;
}

/**
 * One hard bounce or complaint against a sender. Counted once per (org, day, reason, address);
 * then the breaker is evaluated. Returns whether this call paused the sender.
 */
export async function recordBounceSignal(tenantId: string, orgId: string, reason: 'bounced' | 'complaint', address: string, at: Date = new Date()): Promise<boolean> {
  if (!orgId || !address) return false;
  const day = dayOf(at);
  if (!(await seen.putIfAbsent({ key: `${tenantId}::${orgId}::${day}::${reason}::${address.toLowerCase()}`, tenantId, at: at.toISOString() }))) return false;
  await bump(tenantId, orgId, at, reason === 'complaint' ? 'complaints' : 'hardBounces', 1);
  return evaluateBreaker(tenantId, orgId, at);
}

async function evaluateBreaker(tenantId: string, orgId: string, now: Date): Promise<boolean> {
  const t = breakerThresholds();
  const w = await windowCounts(tenantId, orgId, now);
  if (w.sent < t.minSends) return false;
  const complaintRate = w.complaints / w.sent;
  const hardBounceRate = w.hardBounces / w.sent;
  const reason = complaintRate > t.complaintRate ? 'complaints' : hardBounceRate > t.hardBounceRate ? 'hard_bounces' : null;
  if (!reason) return false;
  const key = stateKey(tenantId, orgId);
  const cur = await states.get(key);
  if (cur?.paused) return false;
  const next: SenderState = { key, tenantId, orgId, paused: true, pausedAt: now.toISOString(), reason, rates: { sent: w.sent, hardBounceRate, complaintRate } };
  if (!(await states.compareAndSwap(cur ?? null, next))) return false; // another instance paused it
  log.warn('email_sender_paused', { tenantId, orgId, reason, sent: w.sent });
  await notifyPaused(next);
  return true;
}

async function notifyPaused(state: SenderState): Promise<void> {
  try {
    const members = await listMembers(state.tenantId, state.orgId);
    for (const m of members.filter((x) => x.subject && x.roles.some((r) => r === 'owner' || r === 'admin'))) {
      await getNotificationEmitter().emit({
        tenantId: state.tenantId,
        recipientUserId: m.subject!,
        type: 'email.deliverability-paused',
        priority: 'high',
        title: 'Marketing email paused for this client',
        message: state.reason === 'complaints'
          ? 'Spam complaints went over 0.1% of sends in the last 7 days, so marketing email from this client is paused. A manager must review and resume it.'
          : 'Hard bounces went over 2% of sends in the last 7 days, so marketing email from this client is paused. A manager must review and resume it.',
        actionUrl: '/email',
        metadata: { orgId: state.orgId, reason: state.reason ?? '' },
      });
    }
  } catch (err) {
    log.warn('email_sender_paused_notify_failed', { tenantId: state.tenantId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Is marketing email from this sender paused? A point read; a read error is `'unreadable'`. */
export async function senderPaused(tenantId: string, orgId: string): Promise<boolean | 'unreadable'> {
  if (!orgId) return false;
  try {
    const s = await states.get(stateKey(tenantId, orgId));
    return !!s && s.tenantId === tenantId && s.paused;
  } catch (err) {
    log.error('sender_state_read_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return 'unreadable';
  }
}

/** The sender's state and its trailing figures, for the Email page. */
export async function getSenderHealth(tenantId: string, orgId: string, now: Date = new Date()): Promise<{ state: SenderState | null; window: { sent: number; hardBounces: number; complaints: number }; thresholds: ReturnType<typeof breakerThresholds> }> {
  const s = await states.get(stateKey(tenantId, orgId));
  return { state: s && s.tenantId === tenantId ? s : null, window: await windowCounts(tenantId, orgId, now), thresholds: breakerThresholds() };
}

/** A PERSON resumes a paused sender (the route enforces who). CAS; resuming a running sender is a no-op. */
export async function resumeSender(tenantId: string, orgId: string, resumedBy: string): Promise<SenderState | null> {
  const key = stateKey(tenantId, orgId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await states.get(key);
    if (!cur || cur.tenantId !== tenantId || !cur.paused) return cur && cur.tenantId === tenantId ? cur : null;
    const next: SenderState = { ...cur, paused: false, resumedAt: new Date().toISOString(), resumedBy };
    if (await states.compareAndSwap(cur, next)) { log.info('email_sender_resumed', { tenantId, orgId }); return next; }
  }
  return null;
}

// ── ADR 0955 D7 — warm-up caps (P4b) ──────────────────────────────────────────
// A NEW sender earns volume gradually: day N of its sending life allows `ramp[N]` marketing
// emails, then no ceiling. Over the ceiling a send is DEFERRED to the next UTC day, never
// dropped (the broadcast stops the pass and stays `sending`). Opt-in per workspace (the
// `email.warmup` restriction, OFF): turning it on for an established sender would otherwise
// throttle it as if it were new, because nothing before P4a counted sends.

interface Warmup { key: string; tenantId: string; orgId: string; firstSendDay: string }
const warmups = new DurableCollection<Warmup>('crm:sender-warmup', (w) => w.key, undefined, (w) => w.tenantId);

export function warmupRamp(): number[] {
  const raw = process.env.OPENWOP_EMAIL_WARMUP_RAMP;
  const parsed = raw ? raw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0) : [];
  return parsed.length ? parsed : [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000];
}

/** Mark the sender's first sending day (idempotent; the first writer wins). */
export async function noteFirstSend(tenantId: string, orgId: string, at: Date = new Date()): Promise<void> {
  if (!orgId) return;
  await warmups.putIfAbsent({ key: stateKey(tenantId, orgId), tenantId, orgId, firstSendDay: dayOf(at) });
}

/**
 * How many more marketing emails this sender may send today under its warm-up ramp, or
 * `Infinity` once past the ramp. A sender that has never sent is on day 0.
 */
export async function warmupRemaining(tenantId: string, orgId: string, now: Date = new Date()): Promise<{ remaining: number; day: number; cap: number; resumeAt: string }> {
  const ramp = warmupRamp();
  const w = await warmups.get(stateKey(tenantId, orgId));
  const today = dayOf(now);
  const first = w && w.tenantId === tenantId ? w.firstSendDay : today;
  const day = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000));
  const cap = ramp[day] ?? Number.POSITIVE_INFINITY;
  const sentToday = (await days.get(dayKey(tenantId, orgId, today)))?.sent ?? 0;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString();
  return { remaining: Math.max(0, cap - sentToday), day, cap, resumeAt: tomorrow };
}
