/**
 * Heartbeat admin-settings client (ADR 0318, host-extension, superadmin only).
 *
 * Wraps GET/PUT /host/openwop-app/heartbeat/settings — the host-wide control
 * over the ADR 0313 autonomous work loop (master on/off, an auto-disabling
 * "run for N hours" window, host-default cadence, run-budget override). The
 * backend is the authority; the FE only reads the effective state + saves.
 *
 * @see ../../../backend/typescript/src/features/heartbeat-admin/routes.ts
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { readErrorMessage } from './errorEnvelope.js';

export interface HeartbeatAdminConfig {
  id: 'default';
  status: 'on' | 'off';
  enabledUntil: string | null;
  hostDefaultIntervalMs: number;
  runBudgetPerHour: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

export interface HeartbeatAdminView {
  config: HeartbeatAdminConfig;
  overridden: boolean;
  effective: {
    status: 'on' | 'off';
    autoDisabled: boolean;
    autoDisableAtMs: number | null;
    autoDisablesInMs: number | null;
    hostDefaultIntervalMs: number;
    runBudgetPerHour: number | null;
  };
}

/** The editable subset the PUT body carries (server stamps id/updatedAt/updatedBy). */
export type HeartbeatAdminInput = Pick<
  HeartbeatAdminConfig,
  'status' | 'enabledUntil' | 'hostDefaultIntervalMs' | 'runBudgetPerHour'
>;

const base = `${config.baseUrl}/host/openwop-app/heartbeat/settings`;

async function readOrThrow(res: Response): Promise<HeartbeatAdminView> {
  if (!res.ok) {
    // H27 — this read `body.error?.message`, which is `undefined` against the
    // canonical FLAT envelope (`error` is the code STRING). Every backend message
    // was dropped and the operator saw only `Request failed (403)`.
    const body: unknown = await res.json().catch(() => ({}));
    throw new Error(readErrorMessage(body) ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as HeartbeatAdminView;
}

export async function getHeartbeatSettings(): Promise<HeartbeatAdminView> {
  return readOrThrow(await fetch(base, fetchOpts({ headers: authedHeaders() })));
}

export async function saveHeartbeatSettings(input: HeartbeatAdminInput): Promise<HeartbeatAdminView> {
  return readOrThrow(
    await fetch(base, fetchOpts({
      method: 'PUT',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    })),
  );
}
