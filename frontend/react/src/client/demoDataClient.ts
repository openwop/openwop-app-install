/**
 * Demo-data dashboard client — wraps the extensible seeder-registry surface
 * `GET /v1/host/sample/demo/status`, `POST .../demo/run`, `POST .../demo/clear`.
 *
 * The registry is the single source of truth: the dashboard renders one row per
 * step the backend reports, so adding a future demo data type needs no frontend
 * change. Raw fetch (host extension, not in the SDK), mirroring workforcesClient.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const base = `${config.baseUrl}/v1/host/sample/demo`;

export type SeedAction = 'created' | 'skipped' | 'error' | 'cleared';

/** One registered demo data type + its live count for the caller's tenant. */
export interface DemoStep {
  id: string;
  label: string;
  description: string;
  count: number;
}

export interface StepResult {
  step: string;
  label: string;
  action: SeedAction;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunResult {
  success: boolean;
  dryRun: boolean;
  results: StepResult[];
  summary: { created: number; skipped: number; cleared: number; errors: number; total: number };
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Per-step live inventory ("N present"). */
export async function getDemoStatus(): Promise<DemoStep[]> {
  const res = await fetch(`${base}/status`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ steps: DemoStep[] }>(res, 'getDemoStatus')).steps ?? [];
}

/** Seed the given steps (all when omitted). `dryRun` previews without writing. */
export async function runDemoSeed(opts: { steps?: string[]; dryRun?: boolean } = {}): Promise<RunResult> {
  const res = await fetch(`${base}/run`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }));
  return asJson<RunResult>(res, 'runDemoSeed');
}

/** Clear the given steps (all when omitted) — removes demo entities only. */
export async function clearDemoData(opts: { steps?: string[] } = {}): Promise<RunResult> {
  const res = await fetch(`${base}/clear`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }));
  return asJson<RunResult>(res, 'clearDemoData');
}
