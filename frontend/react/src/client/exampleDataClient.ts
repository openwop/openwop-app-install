/**
 * Demo-data dashboard client — wraps the extensible seeder-registry surface
 * `GET /host/openwop-app/example-data/status`, `POST .../demo/run`, `POST .../demo/clear`.
 *
 * The registry is the single source of truth: the dashboard renders one row per
 * step the backend reports, so adding a future demo data type needs no frontend
 * change. Raw fetch (host extension, not in the SDK), mirroring workforcesClient.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const base = `${config.baseUrl}/host/openwop-app/example-data`;
// Streaming seeds hit Cloud Run DIRECTLY (like SSE) — the Firebase `/api` rewrite
// caps ~60s and buffers, which is exactly what breaks the full reseed. ADR 0292.
const streamBase = `${config.sseBaseUrl}/host/openwop-app/example-data`;

export type SeedAction = 'created' | 'skipped' | 'error' | 'cleared';

/** One registered demo data type + its live count for the caller's tenant. */
export interface ExampleDataStep {
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

export interface ExampleDataStatus {
  /** Whether seeding is available on this deployment (the
   *  OPENWOP_DEMO_SEED_ENABLED kill-switch — opt-in under the enterprise
   *  posture, DUR-3/ADR 0195). Clearing existing example data is never gated. */
  enabled: boolean;
  /** Whether the caller is a superadmin — gates the "Provision demo tenant"
   *  affordance (SEED-RS-UX1). Server-authoritative; absent on older backends. */
  superadmin: boolean;
  steps: ExampleDataStep[];
}

/** Per-step live inventory ("N present") + whether seeding is enabled at all. */
export async function getExampleDataStatus(): Promise<ExampleDataStatus> {
  const res = await fetch(`${base}/status`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ enabled?: boolean; superadmin?: boolean; steps: ExampleDataStep[] }>(res, 'getExampleDataStatus');
  // Older backends omit `enabled` — treat absent as enabled (pre-DUR-3 behavior).
  return { enabled: body.enabled !== false, superadmin: body.superadmin === true, steps: body.steps ?? [] };
}

/** Seed the given steps (all when omitted). `dryRun` previews without writing. */
export async function runExampleDataSeed(opts: { steps?: string[]; dryRun?: boolean } = {}): Promise<RunResult> {
  const res = await fetch(`${base}/run`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }));
  return asJson<RunResult>(res, 'runExampleDataSeed');
}

/** Provision result attached to a demo-provision stream (DG-SEED-7). */
export interface DemoProvision {
  enabled: string[];
  alreadyOn: string[];
  unknown: string[];
}

/** A line from the NDJSON seed stream. */
export type SeedStreamEvent =
  | ({ type: 'step' } & StepResult)
  | ({ type: 'provision' } & DemoProvision)
  | { type: 'summary'; success: boolean; summary: RunResult['summary']; provision?: DemoProvision };

/**
 * Stream a seed as NDJSON from Cloud Run directly, invoking `onEvent` per line
 * so the UI shows live progress. Resolves with the final summary. The full
 * reseed outruns the 30s/60s HTTP timeouts; streaming (headers flushed first)
 * dodges both (ADR 0292). `path` is `run` (seed), `provision-demo`, or `clear`.
 */
async function streamSeed(
  path: 'run' | 'provision-demo' | 'clear',
  body: Record<string, unknown>,
  onEvent: (e: SeedStreamEvent) => void,
): Promise<{ success: boolean; summary: RunResult['summary']; provision?: DemoProvision }> {
  const res = await fetch(`${streamBase}/${path}`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  }));
  if (!res.ok || !res.body) {
    // Surface a useful error (the batch budget covers the non-stream fallback too).
    await asJson(res, `seed:${path}`);
    throw new Error(`seed:${path} returned ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let summary: { success: boolean; summary: RunResult['summary']; provision?: DemoProvision } | null = null;
  const dispatch = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: SeedStreamEvent;
    try { evt = JSON.parse(trimmed) as SeedStreamEvent; } catch { return; }
    onEvent(evt);
    if (evt.type === 'summary') summary = { success: evt.success, summary: evt.summary, ...(evt.provision ? { provision: evt.provision } : {}) };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      dispatch(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) dispatch(buffer);
  if (!summary) throw new Error(`seed:${path} stream ended without a summary`);
  return summary;
}

/** Seed the given steps (all when omitted), streaming per-step progress. */
export async function runExampleDataSeedStream(
  opts: { steps?: string[] },
  onEvent: (e: SeedStreamEvent) => void,
): Promise<{ success: boolean; summary: RunResult['summary'] }> {
  return streamSeed('run', { steps: opts.steps }, onEvent);
}

/** Superadmin: enable the demo features for this tenant, then seed everything —
 *  streamed. The gated surfaces (CRM/commerce/CDP/…) populate (DG-SEED-7). */
export async function provisionDemoTenant(
  onEvent: (e: SeedStreamEvent) => void,
): Promise<{ success: boolean; summary: RunResult['summary']; provision?: DemoProvision }> {
  return streamSeed('provision-demo', {}, onEvent);
}

/** Clear the given steps (all when omitted) — removes demo entities only.
 *  Non-streaming JSON fallback (curl/tests); the UI uses the streaming variant. */
export async function clearExampleData(opts: { steps?: string[] } = {}): Promise<RunResult> {
  const res = await fetch(`${base}/clear`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }));
  return asJson<RunResult>(res, 'clearExampleData');
}

/** Clear the given steps (all when omitted), streaming per-step progress from
 *  Cloud Run directly. The full clear (cascade deletes, thousands of rows)
 *  outruns the Firebase `/api` ~60s cap, exactly like the reseed — streaming
 *  dodges it and shows live progress (ADR 0292 / ADR 0321). */
export async function clearExampleDataStream(
  opts: { steps?: string[] },
  onEvent: (e: SeedStreamEvent) => void,
): Promise<{ success: boolean; summary: RunResult['summary'] }> {
  return streamSeed('clear', { steps: opts.steps }, onEvent);
}
