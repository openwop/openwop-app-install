/**
 * ADR 0472 Phase 0 — the `builtinWorkflows` retirement RATCHET.
 *
 * WHY this exists: fresh sessions keep reaching for the deprecated
 * `BackendFeature.builtinWorkflows` seam because it is the path of least
 * resistance and nothing FAILS when they do — a code-pinned workflow is
 * invisible to `/builder` + the `/` picker (both list only the ownership index
 * / chain gallery), so it silently forfeits the product's core selling points
 * (UI ownership, clone/edit in the visual builder, `/`-slash ignition). Prose in
 * CLAUDE.md / ARCHITECTURE.md did not hold. This test is the durable gate that
 * does: it makes ADDING a new builtin a RED build.
 *
 * Two guards:
 *   1. NO-GROWTH (the ratchet): every currently-declared builtin id MUST be in
 *      the frozen baseline snapshot. A NEW id (a fresh `builtinWorkflows` entry)
 *      is not in the baseline ⇒ fail. Transitional guard for Phases 0-2; Phase 3
 *      DELETES the field, making new builtins impossible at the type level.
 *   2. MIGRATION REACHABILITY: every id that has ALREADY migrated out MUST NOT be
 *      a builtin anymore AND MUST be reachable as a chain (gallery + `/` picker).
 *      Proves a removed builtin didn't just vanish — it became a first-class,
 *      user-reachable workflow.
 *
 * The baseline shrinks as migrations land (an id leaves both the field and the
 * baseline). It NEVER grows. See docs/adr/0472-retire-builtin-workflows-seam.md.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TRUSTING THIS FILE (ADR 0643 / `KBWF-9`).
 * **This file is NOT the gate that enforces the invariant.** Every assertion here
 * reads `LEGACY_PINNED_WORKFLOWS`, which is now EMPTY — so all four legs are
 * anchored on `[]` and none of them scans the source tree. A brand-new boot-path
 * `registerWorkflow({...literal})` in a feature's `registerRoutes` passes this
 * file today.
 *
 * The real gate is **`test/workflow-pin-site-ratchet.test.ts`**, which resolves
 * every `registerWorkflow`/`registerWorkflowDurable` call site by DEFINITION
 * ORIGIN rather than by spelling, quarantines the surviving sites exact-match in
 * both directions and shrink-only, and carries an executable probe
 * ('a FRESH boot-path literal is detected') for exactly the shape that shipped
 * past THIS ratchet for months.
 *
 * This file remains useful as the ADR 0472 *migration* record (the quarantine is
 * drained, the module is deleted, the migrated ids are reachable as chains). It
 * is a historical ratchet, not the invariant. A 2026-09-03 grading pass mis-read
 * it as authoritative — because the two comments below said so — and had to
 * retract a Blocker. The comments now say only what this file checks.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PINNED_WORKFLOWS } from '../src/features/index.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const baseline = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'builtin-workflow-baseline.json'), 'utf8'),
) as { count: number; ids: string[] };

// ADR 0472 Phase 3 — the `BackendFeature.builtinWorkflows` FIELD is DELETED (a feature
// can no longer DECLARE a builtin — a TypeScript error). The only remaining pin site is
// the explicit, shrink-only `LEGACY_PINNED_WORKFLOWS` quarantine in the features barrel.
function currentBuiltinIds(): string[] {
  return LEGACY_PINNED_WORKFLOWS.map((wf) => wf.workflowId);
}

/** Builtins that have MIGRATED out → { old builtin id, new chainId } — the
 *  reachability direction of the ratchet. Grows as migrations land. */
const MIGRATED: ReadonlyArray<{ builtinId: string; chainId: string }> = [
  { builtinId: 'openwop-app.kicktodo.challenge-factory', chainId: 'openwop-app.kicktodo.challenge-factory' },
  { builtinId: 'openwop-app.kicktodo.lesson-batch', chainId: 'openwop-app.kicktodo.lesson-batch' },
  { builtinId: 'campaign-studio.campaign-orchestration', chainId: 'campaign-studio.campaign-orchestration' },
  { builtinId: 'campaign-studio.channel.landing-page', chainId: 'campaign-studio.channel.landing-page' },
  { builtinId: 'campaign-studio.channel.ad-variants', chainId: 'campaign-studio.channel.ad-variants' },
  { builtinId: 'campaign-studio.channel.email-sequence', chainId: 'campaign-studio.channel.email-sequence' },
  { builtinId: 'campaign-studio.channel.creative-briefs', chainId: 'campaign-studio.channel.creative-briefs' },
  { builtinId: 'campaign-studio.channel.social-posts', chainId: 'campaign-studio.channel.social-posts' },
  { builtinId: 'openwop-app.cdp.sync-to-openwop-host', chainId: 'openwop-app.cdp.sync-to-openwop-host' },
  { builtinId: 'openwop-app.kicktodo.replan', chainId: 'openwop-app.kicktodo.replan' },
  { builtinId: 'campaign-studio.market-intel', chainId: 'campaign-studio.market-intel' },
  { builtinId: 'campaign-studio.messaging-kernel', chainId: 'campaign-studio.messaging-kernel' },
  { builtinId: 'openwop-app.kicktodo.calendar-sync', chainId: 'openwop-app.kicktodo.calendar-sync' },
  { builtinId: 'openwop-app.kicktodo.session-reminder', chainId: 'openwop-app.kicktodo.session-reminder' },
  { builtinId: 'openwop-app.kicktodo.plan-generation', chainId: 'kicktodo.plan-generation' }, // #2430
  { builtinId: 'openwop-app.kicktodo.research', chainId: 'kicktodo.research' }, // ADR 0472 P2
  // ADR 0472 P2 — insights trio: chain-backed under the SAME ids (ignition/replay unchanged).
  { builtinId: 'openwop-app.insights.weekly-variance', chainId: 'openwop-app.insights.weekly-variance' },
  { builtinId: 'openwop-app.insights.anniversary-draft', chainId: 'openwop-app.insights.anniversary-draft' },
  { builtinId: 'openwop-app.insights.talent-prep', chainId: 'openwop-app.insights.talent-prep' },
  { builtinId: 'openwop-app.creative-briefs-reel', chainId: 'openwop-app.creative-briefs-reel' }, // ADR 0472 P4
  { builtinId: 'openwop-app.workflow-author', chainId: 'openwop-app.workflow-author' }, // ADR 0472 P4
  { builtinId: 'slides.design', chainId: 'slides.design' }, // ADR 0472 P4
  { builtinId: 'walkthrough.agents.roster', chainId: 'walkthrough.agents.roster' }, // ADR 0472 P4 walkthrough
  { builtinId: 'walkthrough.runs.index', chainId: 'walkthrough.runs.index' }, // ADR 0472 P4 walkthrough
  { builtinId: 'walkthrough.example-data.dashboard', chainId: 'walkthrough.example-data.dashboard' }, // ADR 0472 P4 walkthrough
  { builtinId: 'docs.mcp.docs_get', chainId: 'docs.mcp.docs_get' }, // ADR 0472 P4 MCP
  { builtinId: 'notebooks.mcp.search', chainId: 'notebooks.mcp.search' }, // ADR 0472 P4 MCP
  { builtinId: 'commerce.ucp.mcp.catalog-search', chainId: 'commerce.ucp.mcp.catalog-search' }, // ADR 0472 P4 MCP
  { builtinId: 'app-builder.mcp.catalog', chainId: 'app-builder.mcp.catalog' }, // ADR 0472 P4 MCP
  { builtinId: 'openwop-app.kicktodo.enrollment', chainId: 'openwop-app.kicktodo.enrollment' }, // ADR 0472 P4
  { builtinId: 'openwop-app.kicktodo.daily-loop', chainId: 'openwop-app.kicktodo.daily-loop' }, // ADR 0472 P4
  { builtinId: 'openwop-app.kicktodo.reminder-loop', chainId: 'openwop-app.kicktodo.reminder-loop' }, // ADR 0472 P4
  { builtinId: 'notebooks.summarize', chainId: 'notebooks.summarize' }, // ADR 0472 P4 notebooks
  { builtinId: 'notebooks.transform', chainId: 'notebooks.transform' }, // ADR 0472 P4 notebooks
  { builtinId: 'notebooks.ingest-audio', chainId: 'notebooks.ingest-audio' }, // ADR 0472 P4 notebooks
  { builtinId: 'notebooks.ingest-youtube', chainId: 'notebooks.ingest-youtube' }, // ADR 0472 P4 notebooks
  { builtinId: 'podcasts.generate', chainId: 'podcasts.generate' }, // ADR 0472 P4
  { builtinId: 'openwop-app.production.plan', chainId: 'openwop-app.production.plan' }, // ADR 0472 P4
  // WF-KB-1 — never a `LEGACY_PINNED_WORKFLOWS` member (which is exactly why this
  // ratchet could not see it: it read one array, not the invariant). Recorded here
  // for the REACHABILITY half, and policed at its real seam by
  // `workflow-pin-site-ratchet.test.ts`, which classifies every registerWorkflow
  // call site by the DEFINITION'S ORIGIN.
  { builtinId: 'feature.agent-knowledge.auto-ingest', chainId: 'feature.agent-knowledge.auto-ingest' },
];

describe('ADR 0472 — builtinWorkflows retirement ratchet', () => {
  it('NO-GROWTH: no new builtin may be declared beyond the frozen baseline', () => {
    const current = currentBuiltinIds();
    const novel = current.filter((id) => !baseline.ids.includes(id));
    expect(
      novel,
      `New builtinWorkflows declared (forbidden — ship a chain pack or stack instead; ` +
        `see docs/adr/0472 + CLAUDE.md §"Workflows — never hard-code"): ${novel.join(', ')}`,
    ).toEqual([]);
  });

  it('SHRINK-ONLY: the baseline never grows (its count is the frozen ceiling)', () => {
    // A raised baseline count is itself the smell the ratchet forbids — the file
    // header says shrink-only. If this ever needs to go UP, the change is wrong.
    expect(baseline.count).toBeLessThanOrEqual(74);
    expect(baseline.ids.length).toBe(baseline.count);
  });

  it('PHASE 3: the ONLY pin site is the LEGACY_PINNED quarantine (the field is deleted)', () => {
    // The `BackendFeature.builtinWorkflows` field is gone (a TypeScript error to
    // declare one), so `LEGACY_PINNED_WORKFLOWS` is the sole remaining source of
    // workflows pinned THROUGH THAT FIELD — and it is a subset of the frozen
    // baseline (shrink-only). It is NOT the sole source of code-pinned workflows:
    // `registerWorkflow({...literal})` is a different spelling this file cannot
    // see, and live instances exist (see the quarantine in
    // `workflow-pin-site-ratchet.test.ts`, the file that actually polices them).
    const current = currentBuiltinIds();
    expect(current.every((id) => baseline.ids.includes(id))).toBe(true);
    // No duplicate ids in the quarantine (a dropped/duplicated def on refactor).
    expect(new Set(current).size).toBe(current.length);
  });

  it('PHASE 4 TERMINAL: the quarantine is DRAINED and the registry module is DELETED', () => {
    // ADR 0472 Phase 4 — the terminal state FOR THIS SEAM. Every builtin migrated to
    // a chain pack (or re-pointed mechanism); the quarantine is empty and STAYS empty
    // (NO-GROWTH above is now anchored at zero). The `host/builtinWorkflows.ts`
    // registry module is deleted, so the `builtinWorkflows` FIELD is unexpressible at
    // every layer. That is a narrower claim than the one this comment used to make:
    // it said a code-pinned, UI-unreachable workflow "is no longer expressible at ANY
    // layer", which is false — `registerWorkflow` with an in-tree literal still is,
    // and `workflow-pin-site-ratchet.test.ts` is what keeps that shrink-only.
    expect(currentBuiltinIds(), 'the LEGACY_PINNED quarantine must be empty').toEqual([]);
    expect(baseline.count, 'the frozen baseline is drained to zero').toBe(0);
    const modulePath = join(__dirname, '..', 'src', 'host', 'builtinWorkflows.ts');
    expect(existsSync(modulePath), 'host/builtinWorkflows.ts must be deleted (ADR 0472 P4)').toBe(false);
  });

  describe('MIGRATION REACHABILITY: a migrated builtin is gone AND reachable as a chain', () => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    it('all vendored chain packs load clean', () => {
      expect(errors).toEqual([]);
    });
    for (const m of MIGRATED) {
      it(`${m.builtinId} is no longer a builtin and IS a loadable chain (${m.chainId})`, () => {
        expect(currentBuiltinIds()).not.toContain(m.builtinId);
        const entry = getChain(m.chainId);
        expect(entry, `migrated workflow must be reachable as chain ${m.chainId}`).not.toBeNull();
      });
    }
  });
});
