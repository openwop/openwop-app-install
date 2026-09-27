/**
 * Environments feature client (ADR 0387, host-extension). Wraps
 * /host/openwop-app/environments/*. 404s when the toggle is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type EnvironmentProtection = 'open' | 'protected' | 'locked';

export interface Environment {
  environmentId: string;
  name: string;
  order: number;
  protection: EnvironmentProtection;
  currentSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
  drift?: { drifted: boolean; liveHash: string };
}

export interface ConfigSnapshot {
  snapshotId: string;
  hash: string;
  domains: Record<string, unknown>;
  sourceEnv: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DomainDiff {
  added: number;
  changed: number;
  removed: number;
}

export interface Promotion {
  promotionId: string;
  fromEnv: string | null;
  toEnv: string;
  snapshotHash: string;
  actor: string;
  diffSummary: Record<string, DomainDiff>;
  createdAt: string;
}

const base = `${config.baseUrl}/host/openwop-app/environments`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * The promote/rollback outcome, as a DISCRIMINATED UNION mirroring the route's
 * two-status contract (`features/environments/routes.ts` `sendPromotionOutcome`):
 *
 *   201 `{ environment, noop }`                  — the pointer moved (or was
 *                                                  already at this hash: `noop`).
 *   202 `{ status:'pending_approval', approval }` — the H2 approval gate
 *                                                  intercepted; **nothing moved**.
 *
 * This used to be typed as the 201 shape alone. Because `202` passes `res.ok`,
 * a gated promotion deserialized into `{ environment: undefined, noop: undefined }`
 * and the page reported it as a completed promotion — the exact thing the
 * service's own comment warns against ("Route returns a typed 202, NOT a success
 * mutation", `environmentsService.ts` § PendingPromotionApproval). Callers must
 * now narrow on `status` before claiming anything moved.
 */
export type PromotionOutcome =
  | { status: 'applied'; environment: Environment; noop: boolean }
  | { status: 'pending_approval'; approvalId: string | null };

async function asPromotionOutcome(res: Response, ctx: string): Promise<PromotionOutcome> {
  const body = await asJson<
    { environment: Environment; noop: boolean } & { status?: string; approval?: { approvalId?: string } }
  >(res, ctx);
  if (res.status === 202 || body.status === 'pending_approval') {
    return { status: 'pending_approval', approvalId: body.approval?.approvalId ?? null };
  }
  return { status: 'applied', environment: body.environment, noop: body.noop };
}

export interface DomainInfo { id: string; label: string; restore: 'exact-match' | 'apply-only' }

export async function listEnvironments(withDrift = false): Promise<{ environments: Environment[]; domains?: DomainInfo[]; appVersion: string }> {
  const res = await fetch(`${base}${withDrift ? '?drift=1' : ''}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ environments: Environment[]; domains?: DomainInfo[]; appVersion: string }>(res, 'listEnvironments');
}

export async function ensureChain(): Promise<Environment[]> {
  const res = await fetch(`${base}/ensure-chain`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  return (await asJson<{ environments: Environment[] }>(res, 'ensureChain')).environments;
}

export async function createEnvironment(name: string, protection?: EnvironmentProtection): Promise<Environment> {
  const res = await fetch(`${base}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...(protection ? { protection } : {}) }) }));
  return asJson<Environment>(res, 'createEnvironment');
}

export async function setProtection(name: string, protection: EnvironmentProtection): Promise<Environment> {
  const res = await fetch(`${base}/${encodeURIComponent(name)}/protection`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ protection }) }));
  return asJson<Environment>(res, 'setProtection');
}

export async function listSnapshots(): Promise<ConfigSnapshot[]> {
  const res = await fetch(`${base}/snapshots`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ snapshots: ConfigSnapshot[] }>(res, 'listSnapshots')).snapshots;
}

export async function snapshotLive(sourceEnv?: string): Promise<ConfigSnapshot> {
  const res = await fetch(`${base}/snapshots`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ...(sourceEnv ? { sourceEnv } : {}) }) }));
  return asJson<ConfigSnapshot>(res, 'snapshotLive');
}

/** One entry-level change behind the counts — the value-level view. `path` is the
 *  flattened key (`orgId/funnelId` for a nested domain, a bare id for a flat one). */
export interface ConfigEntryChange {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  from?: unknown;
  to?: unknown;
}

export interface ConfigEntryDiff {
  changes: ConfigEntryChange[];
  /** Entries beyond the server cap. Rendered explicitly — a truncated list that
   *  looked complete would recreate the "counts you can't verify" problem. */
  truncated: number;
}

export async function previewPromotion(
  toEnv: string,
  snapshotHash: string,
): Promise<{ diffSummary: Record<string, DomainDiff>; entryDiff?: Record<string, ConfigEntryDiff> }> {
  const res = await fetch(`${base}/preview`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ toEnv, snapshotHash }) }));
  // `entryDiff` is optional so an older backend (or a host that has not deployed
  // this yet) degrades to counts-only rather than rendering an empty value list —
  // which would read as "nothing changed" over a non-zero count.
  return asJson<{ diffSummary: Record<string, DomainDiff>; entryDiff?: Record<string, ConfigEntryDiff> }>(res, 'previewPromotion');
}

export async function promote(fromEnv: string, toEnv?: string): Promise<PromotionOutcome> {
  const res = await fetch(`${base}/promote`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ fromEnv, ...(toEnv ? { toEnv } : {}) }) }));
  return asPromotionOutcome(res, 'promote');
}

export async function rollback(env: string, snapshotHash: string): Promise<PromotionOutcome> {
  const res = await fetch(`${base}/rollback`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ env, snapshotHash }) }));
  return asPromotionOutcome(res, 'rollback');
}

export async function applyToLive(snapshotHash: string): Promise<{ hash: string; domains: Array<{ id: string; ok: boolean; error?: string }> }> {
  const res = await fetch(`${base}/apply`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ snapshotHash }) }));
  return asJson<{ hash: string; domains: Array<{ id: string; ok: boolean; error?: string }> }>(res, 'applyToLive');
}

export async function listPromotions(): Promise<Promotion[]> {
  const res = await fetch(`${base}/promotions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ promotions: Promotion[] }>(res, 'listPromotions')).promotions;
}
