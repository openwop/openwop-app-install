/**
 * ADR 0318 — heartbeat admin settings service.
 *
 * One superadmin-owned durable row (`hostext:heartbeat-admin:default`) that
 * governs the ADR 0313 work loop at runtime. `resolveForCore` is the ADR 0318
 * provider the core `effectiveHeartbeatIntervalMs` resolver consults: it applies
 * the auto-disable window at read time (no timer/job needed) and returns the
 * shape core understands. Absent row ⇒ `null` ⇒ core inherits the env default
 * (byte-identical to pre-0318 behavior).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import type { ResolvedHeartbeatConfig } from '../../host/heartbeatService.js';
import type { HeartbeatAdminConfig, HeartbeatAdminView } from './types.js';
import { defaultRunBudgetLimit } from '../../host/runBudgetService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.heartbeat-admin');

/** ADR 0717 D1 — the last SUCCESSFULLY read admin config.
 *
 *  Only NON-null successes are cached: when the operator has never saved a config,
 *  `store.get` legitimately resolves to undefined and there is no brake to preserve.
 *  This must never invent a brake that was never set. */
let lastGoodConfig: HeartbeatAdminConfig | null = null;

/** Test seam — the cache is module state, so a suite that exercises the degraded path
 *  must be able to clear it. */
export function __resetHeartbeatConfigCacheForTests(): void { lastGoodConfig = null; }

/** ADR 0717 D1 — on a degraded read, fail the run budget to the TIGHTER of the
 *  last-known-good admin limit and the env default.
 *
 *  `runBudgetPerHour` is a SAFETY bound, not an availability knob: it caps autonomous
 *  runs per tenant per hour (env default 120). An operator who tightened it to 5 is
 *  applying a spend control, and simply dropping it on a fault would restore 120 — a
 *  24x loosening under fault, the same "a stated bound evaporates" defect this ADR
 *  exists to close. `<= 0` means UNLIMITED, so this is not a naive Math.min: unlimited
 *  must lose to any finite cap. `null` ⇒ inherit the env default. */
function tighterBudget(cached: number | null): number | null {
  if (cached == null) return null;              // nothing tightened — inherit env
  if (cached <= 0) return null;                 // cached is UNLIMITED — env is tighter
  const envLimit = defaultRunBudgetLimit();
  if (envLimit <= 0) return cached;             // env is unlimited — the cached cap is tighter
  return Math.min(cached, envLimit);
}

/** Durable store — one singleton row keyed `'default'` (rows `hostext:heartbeat-admin:default`). */
const store = new DurableCollection<HeartbeatAdminConfig>('heartbeat-admin', (c) => c.id);

const SINGLETON_ID = 'default' as const;

/** Bounds for the editable cadence: floor 1 min (a shorter loop hammers the fleet
 *  + budget), ceiling 24 h. */
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 600_000; // 10 min — mirrors the ADR 0313 env fallback.

/** The config shown when nothing is saved yet: OFF, inheriting the env default. */
export function defaultConfig(): HeartbeatAdminConfig {
  return { id: SINGLETON_ID, status: 'off', enabledUntil: null, hostDefaultIntervalMs: DEFAULT_INTERVAL_MS, runBudgetPerHour: null };
}

/** The raw saved config, or `null` when the operator has never saved one. */
export async function getStoredConfig(): Promise<HeartbeatAdminConfig | null> {
  return store.get(SINGLETON_ID);
}

/** ADR 0318 provider for the core seam. Resolves the durable config, applying the
 *  auto-disable window at `now`. Returns `null` when no admin row exists (core
 *  inherits `OPENWOP_HEARTBEAT_DEFAULT_MS`). */
export async function resolveForCore(now: number = Date.now()): Promise<ResolvedHeartbeatConfig | null> {
  let cfg: HeartbeatAdminConfig | null;
  let degraded = false;
  try {
    cfg = (await store.get(SINGLETON_ID)) ?? null;
    if (cfg) lastGoodConfig = cfg;
  } catch (err) {
    // ADR 0717 D1 — a store hiccup must not release the operator's emergency brake.
    // Re-throw when there is no last-known-good state: the core seam's catch then
    // returns null and the host inherits the env default, exactly as before.
    if (!lastGoodConfig) throw err;
    cfg = lastGoodConfig;
    degraded = true;
    log.warn('heartbeat admin config read failed — enforcing last-known-good brake', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!cfg) return null; // no override → inherit env default (pre-0318 behavior)
  // ADR 0717 D1 — the window is RE-DERIVED at `now`, never cached. `masterOff` is
  // time-derived (`status==='on' && !elapsed`), so caching the resolved boolean would
  // pin a stale time decision in BOTH unsafe directions: a window elapsing during a
  // fault would never apply the auto-disable brake, and a re-opened window could never
  // revive the fleet. Re-running the SAME `resolveWindow` both other callers use keeps
  // the degraded path from drifting away from the healthy one.
  const { effectiveOn } = resolveWindow(cfg, now);
  return {
    masterOff: !effectiveOn,
    // Degraded ⇒ drop the cadence override and inherit the env, which is ADR 0318's
    // availability posture: a hiccup must not wedge the loop at a stale cadence.
    hostDefaultIntervalMs: degraded || !effectiveOn ? null : cfg.hostDefaultIntervalMs,
    runBudgetPerHour: degraded ? tighterBudget(cfg.runBudgetPerHour) : cfg.runBudgetPerHour,
  };
}

/** The single window-resolution used by BOTH `resolveForCore` (core seam) and
 *  `getView` (admin GET), so the two can never drift on what "on" means: ON iff
 *  `status:'on'` AND the auto-disable window has not elapsed. */
function resolveWindow(cfg: HeartbeatAdminConfig, now: number): { effectiveOn: boolean; windowAtMs: number | null; elapsed: boolean } {
  const windowAtMs = cfg.enabledUntil != null ? Date.parse(cfg.enabledUntil) : null;
  const elapsed = windowAtMs != null && now >= windowAtMs;
  return { effectiveOn: cfg.status === 'on' && !elapsed, windowAtMs, elapsed };
}

/** Build the read-time view for the admin GET — saved config + window-resolved state. */
export async function getView(now: number = Date.now()): Promise<HeartbeatAdminView> {
  const stored = await store.get(SINGLETON_ID);
  const config = stored ?? defaultConfig();
  const { effectiveOn, windowAtMs, elapsed } = resolveWindow(config, now);
  return {
    config,
    overridden: stored != null,
    effective: {
      status: effectiveOn ? 'on' : 'off',
      autoDisabled: config.status === 'on' && elapsed,
      autoDisableAtMs: effectiveOn && windowAtMs != null ? windowAtMs : null,
      autoDisablesInMs: effectiveOn && windowAtMs != null ? Math.max(0, windowAtMs - now) : null,
      hostDefaultIntervalMs: config.hostDefaultIntervalMs,
      runBudgetPerHour: config.runBudgetPerHour,
    },
  };
}

/** Validate + normalize an admin PUT body into a `HeartbeatAdminConfig`. Throws
 *  `validation_error` (422) on bad input. `enabledUntil` is only kept for `status:'on'`. */
export function validateConfig(body: unknown): HeartbeatAdminConfig {
  const fail = (msg: string): never => { throw new OpenwopError('validation_error', msg, 422); };
  if (typeof body !== 'object' || body === null) return fail('Body must be an object.');
  const b = body as Record<string, unknown>;

  if (b.status !== 'on' && b.status !== 'off') fail('`status` must be "on" or "off".');
  const status = b.status as 'on' | 'off';

  const hostDefaultIntervalMs = Number(b.hostDefaultIntervalMs);
  if (!Number.isInteger(hostDefaultIntervalMs) || hostDefaultIntervalMs < MIN_INTERVAL_MS || hostDefaultIntervalMs > MAX_INTERVAL_MS) {
    fail(`\`hostDefaultIntervalMs\` must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms.`);
  }

  let runBudgetPerHour: number | null = null;
  if (b.runBudgetPerHour != null) {
    const n = Number(b.runBudgetPerHour);
    if (!Number.isInteger(n) || n < 0) fail('`runBudgetPerHour` must be a non-negative integer or null (0 = unlimited).');
    runBudgetPerHour = n;
  }

  // `enabledUntil` is meaningful only when ON. Off ⇒ always null (a stale window
  // must never linger and silently re-arm on the next turn-on).
  let enabledUntil: string | null = null;
  if (status === 'on' && b.enabledUntil != null) {
    const ts = String(b.enabledUntil);
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) fail('`enabledUntil` must be a valid ISO-8601 timestamp or null.');
    if (parsed <= Date.now()) fail('`enabledUntil` must be in the future (or null for indefinite).');
    enabledUntil = new Date(parsed).toISOString();
  }

  return { id: SINGLETON_ID, status, enabledUntil, hostDefaultIntervalMs, runBudgetPerHour };
}

/** Persist the admin config (upsert). Caller validates + gates (superadmin) first. */
export async function saveConfig(config: HeartbeatAdminConfig, savedBy: string): Promise<HeartbeatAdminConfig> {
  const next: HeartbeatAdminConfig = { ...config, updatedAt: new Date().toISOString(), updatedBy: savedBy };
  await store.put(next);
  return next;
}
