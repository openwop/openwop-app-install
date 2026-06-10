/**
 * Demo-seeder registry — the extensible backbone of the `/demo-data` dashboard.
 *
 * Each seedable kind of demo data is ONE {@link DemoSeeder} entry: an id, a
 * label/description, a live `count` (so the dashboard shows "N present"), a
 * `seed`, and a `clear`. Adding a future demo data type (prompts, memory, …) is
 * a single entry here — no dashboard or endpoint edits. The dashboard, the
 * status endpoint, and the seed/clear endpoints all derive from this array, so
 * they can never drift (modelled on myndhyve's seed-step registry, adapted to
 * openwop's single-tenant host-extension runtime).
 *
 * Everything stays IDEMPOTENT + non-destructive to user-authored data: seeders
 * create only what's missing; clearers remove only the canonical demo entities.
 */

import type { Storage } from '../storage/storage.js';
import { clearDemoAgents, countDemoAgents, seedDemoAgents } from './demoSeed.js';
import {
  clearWorkforceHistory,
  countWorkforceRuns,
  seedWorkforceEntities,
  seedWorkforceHistory,
} from './workforceService.js';

export type SeedAction = 'created' | 'skipped' | 'error' | 'cleared';

/** One step's outcome — mirrors the dashboard's per-row result. */
export interface StepResult {
  step: string;
  label: string;
  action: SeedAction;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunSummary {
  created: number;
  skipped: number;
  cleared: number;
  errors: number;
  total: number;
}

export interface RunResult {
  success: boolean;
  dryRun: boolean;
  results: StepResult[];
  summary: RunSummary;
}

/** A seedable kind of demo data. */
export interface DemoSeeder {
  id: string;
  label: string;
  description: string;
  /** Steps that should seed before this one (the registry order already
   *  satisfies these; declared for documentation + future reordering). */
  dependsOn?: string[];
  /** Live count of this kind present for the tenant (drives "N present"). */
  count(tenantId: string, storage: Storage): Promise<number>;
  /** Create what's missing. Returns how many net-new items were created. */
  seed(tenantId: string, storage: Storage): Promise<{ created: number; details?: Record<string, unknown> }>;
  /** Remove the canonical demo entities (never user-authored data). */
  clear(tenantId: string, storage: Storage): Promise<{ cleared: number; details?: Record<string, unknown> }>;
}

const agentsSeeder: DemoSeeder = {
  id: 'agents',
  label: 'Agents',
  description: 'Five named demo coworkers — each with a task board, sample cards, schedules, and an org-chart seat.',
  async count(tenantId) {
    return countDemoAgents(tenantId);
  },
  async seed(tenantId, storage) {
    // skipWorkforces: the `workforces` step owns workforce seeding, so loading
    // the agents step never silently seeds workforces too.
    const r = await seedDemoAgents(tenantId, storage, { heal: true, skipWorkforces: true });
    const restored =
      (r.healed?.boards ?? 0) + (r.healed?.schedules ?? 0) + (r.healed?.orgChart ? 1 : 0);
    return {
      created: r.seeded ? r.agents : restored,
      details: { agents: r.agents, ...(r.healed ?? {}) },
    };
  },
  async clear(tenantId, storage) {
    return clearDemoAgents(tenantId, storage);
  },
};

const workforcesSeeder: DemoSeeder = {
  id: 'workforces',
  label: 'Workforces',
  description: 'Governed agent clusters plus weeks of synthetic run history for the instrumented ones (telemetry, governance, graduation).',
  dependsOn: ['agents'],
  async count(_tenantId, storage) {
    return (await countWorkforceRuns(storage, _tenantId)).workforces;
  },
  async seed(tenantId, storage) {
    const entities = await seedWorkforceEntities();
    const hist = await seedWorkforceHistory(storage, tenantId, { nowMs: Date.now() });
    return { created: hist.runs, details: { workforceEntities: entities, runs: hist.runs } };
  },
  async clear(tenantId, storage) {
    const { runs } = await clearWorkforceHistory(storage, tenantId);
    return { cleared: runs, details: { runs } };
  },
};

/** The registry. Order = seed order (dependencies first). */
export const DEMO_SEEDERS: readonly DemoSeeder[] = [agentsSeeder, workforcesSeeder];

export interface DemoStepStatus {
  id: string;
  label: string;
  description: string;
  count: number;
}

/** Per-step live counts for the dashboard. */
export async function demoStatus(tenantId: string, storage: Storage): Promise<DemoStepStatus[]> {
  return Promise.all(
    DEMO_SEEDERS.map(async (s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      count: await s.count(tenantId, storage).catch(() => 0),
    })),
  );
}

/** Resolve a requested step-id list to seeders, preserving registry order.
 *  Unknown ids are ignored; an empty/absent list means ALL steps. */
function selected(steps?: readonly string[]): DemoSeeder[] {
  if (!steps || steps.length === 0) return [...DEMO_SEEDERS];
  const want = new Set(steps);
  return DEMO_SEEDERS.filter((s) => want.has(s.id));
}

function emptySummary(): RunSummary {
  return { created: 0, skipped: 0, cleared: 0, errors: 0, total: 0 };
}

/** Seed the selected steps (all when none given). `dryRun` writes nothing and
 *  reports the action each step WOULD take from its current count. */
export async function runDemoSeed(
  tenantId: string,
  storage: Storage,
  opts: { steps?: readonly string[]; dryRun?: boolean } = {},
): Promise<RunResult> {
  const dryRun = opts.dryRun === true;
  const results: StepResult[] = [];
  const summary = emptySummary();

  for (const s of selected(opts.steps)) {
    summary.total += 1;
    try {
      if (dryRun) {
        const have = await s.count(tenantId, storage);
        const action: SeedAction = have > 0 ? 'skipped' : 'created';
        if (action === 'created') summary.created += 1; else summary.skipped += 1;
        results.push({
          step: s.id, label: s.label, action,
          message: have > 0 ? `${have} already present — would skip` : 'would create',
          details: { present: have },
        });
        continue;
      }
      const { created, details } = await s.seed(tenantId, storage);
      const action: SeedAction = created > 0 ? 'created' : 'skipped';
      if (created > 0) summary.created += 1; else summary.skipped += 1;
      results.push({
        step: s.id, label: s.label, action,
        message: created > 0 ? `${created} created` : 'already present — skipped',
        ...(details ? { details } : {}),
      });
    } catch (err) {
      summary.errors += 1;
      results.push({
        step: s.id, label: s.label, action: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { success: summary.errors === 0, dryRun, results, summary };
}

/** Clear the selected steps (all when none given). Never dry-run (destructive
 *  actions are confirmed in the UI instead). */
export async function runDemoClear(
  tenantId: string,
  storage: Storage,
  opts: { steps?: readonly string[] } = {},
): Promise<RunResult> {
  const results: StepResult[] = [];
  const summary = emptySummary();
  // Clear in reverse registry order so dependents go before their dependencies.
  for (const s of selected(opts.steps).reverse()) {
    summary.total += 1;
    try {
      const { cleared, details } = await s.clear(tenantId, storage);
      summary.cleared += cleared > 0 ? 1 : 0;
      if (cleared === 0) summary.skipped += 1;
      results.push({
        step: s.id, label: s.label,
        action: cleared > 0 ? 'cleared' : 'skipped',
        message: cleared > 0 ? `${cleared} cleared` : 'nothing to clear',
        ...(details ? { details } : {}),
      });
    } catch (err) {
      summary.errors += 1;
      results.push({
        step: s.id, label: s.label, action: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { success: summary.errors === 0, dryRun: false, results, summary };
}
