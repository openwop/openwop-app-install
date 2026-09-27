/**
 * ADR 0318 — host-wide heartbeat admin settings.
 *
 * A single superadmin-owned durable config that governs the ADR 0313 autonomous
 * work loop at runtime — turning today's redeploy-only `OPENWOP_HEARTBEAT_DEFAULT_MS`
 * env into an operator-editable setting, plus an auto-disabling "run for N hours"
 * window. Read by the core `effectiveHeartbeatIntervalMs` resolver via the ADR 0318
 * fill-a-seam provider (core never imports this feature).
 */

/** The persisted admin config (singleton row, id = `default`). */
export interface HeartbeatAdminConfig {
  /** Singleton id — always `'default'`. */
  id: 'default';
  /** Master switch. `on` ⇒ the host-default cadence applies fleet-wide (subject to
   *  the window); `off` ⇒ a HARD kill — no member heartbeats at all, overriding any
   *  per-agent cadence (the operator emergency brake). */
  status: 'on' | 'off';
  /** Auto-disable window (ADR 0318). ISO-8601 timestamp; when `status:'on'` and
   *  `now >= enabledUntil` the loop is treated as OFF (auto-disabled). `null` ⇒
   *  run indefinitely (until explicitly turned off). Ignored when `status:'off'`. */
  enabledUntil: string | null;
  /** Host-default cadence (ms) for members without an explicit per-agent cadence,
   *  applied while ON. Overrides the `OPENWOP_HEARTBEAT_DEFAULT_MS` env default. */
  hostDefaultIntervalMs: number;
  /** Optional runtime override of the per-tenant autonomous-run budget (runs/hour).
   *  `null` ⇒ inherit the env/default cap (120/h). `0` ⇒ unlimited. */
  runBudgetPerHour: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

/** The read-time effective view returned by GET — the saved config PLUS the
 *  window-resolved live state, so the admin UI shows the truth without recomputing. */
export interface HeartbeatAdminView {
  config: HeartbeatAdminConfig;
  /** `true` when there IS a saved admin row; `false` ⇒ inheriting the env default
   *  (the loop is governed by `OPENWOP_HEARTBEAT_DEFAULT_MS`, not this setting). */
  overridden: boolean;
  effective: {
    /** The effective status after applying the auto-disable window. */
    status: 'on' | 'off';
    /** Set when an ON window has already elapsed (status flipped itself off). */
    autoDisabled: boolean;
    /** Epoch ms the window auto-disables at, or `null` when indefinite/off. */
    autoDisableAtMs: number | null;
    /** Ms remaining before auto-disable, or `null` when indefinite/off. */
    autoDisablesInMs: number | null;
    /** The cadence unconfigured members would run at while ON (ms). */
    hostDefaultIntervalMs: number;
    /** The effective per-tenant run budget (runs/hour); `null` ⇒ env/default cap. */
    runBudgetPerHour: number | null;
  };
}
