/**
 * Agent operations — host-extension routes (non-normative).
 *
 * Two demo-experience surfaces (PRD §14, §17):
 *   POST /v1/host/openwop-app/example-data/seed            — idempotently seed all built-in
 *                                                demo domains for the caller's
 *                                                tenant ("Load demo data")
 *   POST /v1/host/openwop-app/roster/{rosterId}/check
 *                                              — the agent "heartbeat": pick the
 *                                                first eligible To Do card on the
 *                                                agent's board and start its
 *                                                workflow ("Check now")
 *
 * The heartbeat is an MVP pull model (PRD §14): a manual/poll "check now" that
 * claims the first To Do card carrying a resolvable workflow, starts a run
 * attributed to the named agent, and moves the card to Working. A real
 * background daemon (claim cadence, concurrency, dead-letter) is deferred.
 *
 * @see src/host/seedEverything.ts — the idempotent seed orchestrator
 * @see src/host/runStarter.ts — the shared run dispatch
 */

import type { Express, Request, Response } from 'express';
import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import { seedEverything } from '../host/seedEverything.js';
import { exampleDataStatus, runDemoClear, runExampleDataSeed } from '../host/exampleDataSeeders.js';
import type { StepResult } from '../host/exampleDataSeeders.js';
import { exampleDataSeedEnabled } from '../host/exampleDataSeed.js';
import { provisionDemoFeatures } from '../host/demoProvision.js';
import { withSeedLock } from '../host/seedLock.js';
import { isSuperadmin, requireSuperadmin } from '../host/superadmin.js';
import { getRosterEntry } from '../host/rosterService.js';
import { runHeartbeatOnce } from '../host/heartbeatService.js';
import { projectAgentActivity } from '../host/agentActivity.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

function actorOf(req: Request): string {
  return (req as { userId?: string; principal?: { principalId?: string } }).userId
    ?? (req as { principal?: { principalId?: string } }).principal?.principalId
    ?? 'superadmin';
}

/** True when the client asked for the streaming NDJSON seed (ADR 0292). The full
 *  reseed outruns the 30s request-timeout + the ~60s `/api` proxy budget; a
 *  streamed response flushes headers immediately (making the timer a no-op) and
 *  emits one JSON line per step, so the UI shows progress and never times out.
 *  The UI hits this via the direct `*.run.app` URL — the SSE-bypass pattern —
 *  because the Firebase `/api` rewrite would buffer it. */
function wantsStream(req: Request): boolean {
  return (req.headers.accept ?? '').includes('application/x-ndjson');
}

/** Run a seed as an NDJSON stream: `{type:'step',...}` per seeder, then a final
 *  `{type:'summary',...}`. Header flush first = timeout no-op. Writes that fail
 *  (client hung up) are swallowed — `runExampleDataSeed` keeps going and the
 *  idempotent seed still lands. */
async function streamSeed(
  res: Response,
  run: (onStep: (r: StepResult) => void) => Promise<{ success: boolean; summary: unknown; results: StepResult[] }>,
  extra?: object,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const write = (obj: unknown): void => {
    if (res.writableEnded) return;
    try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ }
  };
  if (extra) write({ type: 'provision', ...extra });
  const result = await run((r) => write({ type: 'step', ...r }));
  write({ type: 'summary', success: result.success, summary: result.summary, ...(extra ? { provision: extra } : {}) });
  if (!res.writableEnded) res.end();
}

export function registerAgentOpsRoutes(app: Express, deps: Deps): void {
  // "Load demo data" — idempotent per-tenant seed across registered domains.
  app.post('/v1/host/openwop-app/example-data/seed', async (req, res, next) => {
    try {
      // `heal: true` = the EXPLICIT "Load demo data" action — restores missing
      // boards/schedules/chart for existing personas. The silent auto-seed on
      // page entry omits it, so it can never resurrect deliberate deletions.
      const heal = (req.body as { heal?: unknown } | undefined)?.heal === true;
      const result = await seedEverything(tenantOf(req), deps.storage, { heal });
      // The read-only `__showcase__` tenant that powers the always-on workforce
      // dashboards is seeded at server startup (self-healing; see index.ts
      // `main()` → seedShowcaseWorkforces), NOT here: piggybacking it on the
      // caller's already-~50s full reseed overran the ~60s proxy budget and 502'd.
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── /demo-data dashboard surface (extensible seeder registry) ─────────────
  // Per-step live inventory: one row per registered demo data type with its
  // current count. Drives the dashboard's "N present" + checkboxes. `enabled`
  // reflects the OPENWOP_DEMO_SEED_ENABLED kill-switch (posture-dependent
  // default, DUR-3/ADR 0195) so the dashboard can disclose "seeding disabled"
  // honestly instead of rendering a success-shaped no-op. Clearing existing
  // example data stays available either way (removal is never gated).
  app.get('/v1/host/openwop-app/example-data/status', async (req, res, next) => {
    try {
      res.status(200).json({
        enabled: exampleDataSeedEnabled(),
        // Drives the FE's superadmin-only "Provision demo tenant" affordance
        // (SEED-RS-UX1) — server-authoritative, so the button hides for a
        // non-superadmin instead of showing then 403-ing.
        superadmin: isSuperadmin(req),
        steps: await exampleDataStatus(tenantOf(req), deps.storage),
      });
    } catch (err) {
      next(err);
    }
  });

  // Seed selected steps (all when none given). `dryRun` previews without writing.
  // Returns per-step results + a summary (created/skipped/errors), so the
  // dashboard can show exactly what each type did — no more silent omissions.
  app.post('/v1/host/openwop-app/example-data/run', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { steps?: unknown; dryRun?: unknown };
      const steps = Array.isArray(body.steps) ? body.steps.filter((s): s is string => typeof s === 'string') : undefined;
      const dryRun = body.dryRun === true;
      const tenantId = tenantOf(req);
      // Dry-run writes nothing — no lock needed. A real seed takes the per-tenant
      // seed lock so a concurrent re-click can't race the seeders' read-then-create
      // guards and duplicate rows (SEED concurrency fix).
      if (dryRun) {
        res.status(200).json(await runExampleDataSeed(tenantId, deps.storage, { steps, dryRun: true }));
        return;
      }
      await withSeedLock(deps.storage, tenantId, async () => {
        // Stream when asked (default UI path) so the full reseed never trips the
        // 30s / ~60s timeouts; otherwise return the aggregate JSON in one shot
        // (the batch request-timeout budget covers it — ADR 0292).
        if (wantsStream(req)) {
          await streamSeed(res, (onStep) => runExampleDataSeed(tenantId, deps.storage, { steps, onStep }));
          return;
        }
        res.status(200).json(await runExampleDataSeed(tenantId, deps.storage, { steps }));
      });
    } catch (err) {
      next(err);
    }
  });

  // Superadmin: provision a full demo tenant (DG-SEED-7). Enables the demo
  // feature toggles FOR THIS TENANT ONLY (per-tenant override — never global),
  // then runs the full seed so the previously-gated surfaces (CRM, commerce,
  // merchandising, CDP, territories, …) actually populate. The toggle flip lives
  // here, above the pure seeders — a seeder still never flips a toggle itself.
  app.post('/v1/host/openwop-app/example-data/provision-demo', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Demo-tenant provisioning');
      const tenantId = tenantOf(req);
      if (!exampleDataSeedEnabled()) {
        throw new OpenwopError('conflict', 'Demo seeding is disabled on this deployment (OPENWOP_DEMO_SEED_ENABLED=false).', 409);
      }
      // Serialize under the per-tenant seed lock: the full reseed is long enough
      // that an impatient re-click would otherwise launch a concurrent pass and
      // race the seeders' read-then-create guards, duplicating rows (SEED
      // concurrency fix). A concurrent provision now gets a clean 409.
      await withSeedLock(deps.storage, tenantId, async () => {
        const provision = await provisionDemoFeatures(tenantId, actorOf(req));
        if (wantsStream(req)) {
          await streamSeed(res, (onStep) => runExampleDataSeed(tenantId, deps.storage, { onStep }), provision);
          return;
        }
        const result = await runExampleDataSeed(tenantId, deps.storage, {});
        res.status(200).json({ provision, ...result });
      });
    } catch (err) {
      next(err);
    }
  });

  // Clear selected steps (all when none given) — removes the canonical demo
  // entities only (never user-authored data). Confirmed in the UI.
  app.post('/v1/host/openwop-app/example-data/clear', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { steps?: unknown };
      const steps = Array.isArray(body.steps) ? body.steps.filter((s): s is string => typeof s === 'string') : undefined;
      const tenantId = tenantOf(req);
      // Clear is a long, cascade-heavy write (roster deletes, thousands of CDP
      // rows). Under the seed lock so it can't race a concurrent seed/clear, and
      // streamed when asked so it flushes headers first — dodging the Firebase
      // `/api` ~60s cap (the UI hits the direct *.run.app URL) and the request
      // timer, bounded only by Cloud Run's outer timeout (ADR 0292 / ADR 0321).
      await withSeedLock(deps.storage, tenantId, async () => {
        if (wantsStream(req)) {
          await streamSeed(res, (onStep) => runDemoClear(tenantId, deps.storage, { steps, onStep }));
          return;
        }
        res.status(200).json(await runDemoClear(tenantId, deps.storage, { steps }));
      });
    } catch (err) {
      next(err);
    }
  });

  // Agent heartbeat "Check now" — claim the first eligible To Do card and run it.
  app.post('/v1/host/openwop-app/roster/:rosterId/check', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const entry = await getRosterEntry(tenantId, req.params.rosterId);
      if (!entry) {
        throw new OpenwopError('not_found', 'Agent not found.', 404, { rosterId: req.params.rosterId });
      }
      if (!entry.enabled) {
        res.status(200).json({ picked: false, reason: 'paused' });
        return;
      }

      // Shared with the autonomous heartbeat daemon so the two can't drift —
      // including the review-mode "agents propose, humans dispose" branch.
      const result = await runHeartbeatOnce(deps, entry);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Per-agent activity feed — recent runs attributed to this agent (heartbeat
  // pick-ups, schedule fires, board-card triggers), each with a real timestamp,
  // outcome, and links. Derived from the durable runs store, so it carries the
  // run status + completion time the board-state-derived fleet feed can't.
  app.get('/v1/host/openwop-app/roster/:rosterId/activity', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const entry = await getRosterEntry(tenantId, req.params.rosterId);
      if (!entry) {
        throw new OpenwopError('not_found', 'Agent not found.', 404, { rosterId: req.params.rosterId });
      }
      const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const optionalStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
      // Indexed lookup (agent_run_activity → runs join) — no recent-run scan, so
      // no truncation ceiling. The projector still derives source/persona/etc.
      const runs = await deps.storage.listAgentRunActivity({ tenantId, rosterId: entry.rosterId, status: optionalStatus, limit });
      const items = projectAgentActivity(runs, {}).slice(0, limit);
      res.status(200).json({ rosterId: entry.rosterId, items, truncated: false });
    } catch (err) {
      next(err);
    }
  });

  // Fleet-wide activity feed — recent agent-attributed runs across the whole
  // roster, each carrying its rosterId/persona so the dashboard can show a
  // single timeline + a failures view (`?status=failed`). Backed by the
  // attribution index (no recent-run scan). Optional `?rosterId=` narrows to one
  // member without the path param.
  app.get('/v1/host/openwop-app/fleet/activity', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const rosterId = typeof req.query.rosterId === 'string' ? req.query.rosterId : undefined;
      const runs = await deps.storage.listAgentRunActivity({ tenantId, status, rosterId, limit });
      const items = projectAgentActivity(runs, {}).slice(0, limit);
      res.status(200).json({ items, truncated: false });
    } catch (err) {
      next(err);
    }
  });
}
