/**
 * ADR 0368 — the shipped-tour coverage tripwire, DEFAULT-CI half (backend).
 *
 * The FE `tourCoverage.test.ts` pins that the registry HAS the ids a tour
 * references — but it hardcodes that list, so a change to the shipped tour
 * DEFINITION could drift past it silently. This test derives the referenced
 * ids FROM the shipped definition and pins them against the canonical set, so
 * ANY edit to the tour (a new/renamed step) FAILS here in default CI — forcing
 * the author to consciously update the registration + the FE coverage too. The
 * true cross-half guard (does the FE registry actually resolve them at
 * runtime) has NO test: the opt-in `TOUR_E2E` replay never ran and was
 * deleted 2026-10-17 (/grade-tests wave 53; WALK-REPLAY-1).
 *
 * Together: backend pins WHAT the tour references; FE pins the registry HAS
 * them. Whether the FE registry RESOLVES them at runtime is NOT tested anywhere
 * (corrected grade-tests w63: this line used to say "the e2e pins they RESOLVE
 * live. No half is vacuous" two sentences after saying that e2e was deleted).
 *
 * The id lists below are a deliberate change-detector: literal canonical sets,
 * so an edit to a shipped walkthrough definition fails here on purpose.
 *
 * The ADR 0440 identity block reads BOTH detection rules through the product,
 * never a copy: the page's rule is `workflowKind()` (`host/workflowId.ts`, the
 * `kind` the list route stamps) and the ctx rule is what
 * `buildWalkthroughsSurface(...).listWalkthroughs()` actually returns for the
 * chain-backed system walkthroughs `registerWalkthroughWorkflows()` registers.
 * (Round 1 found the block re-implementing surface.ts's private `isWalkthrough`
 * over the in-tree fixture metadata — which production does not read: the
 * chain-backed registration re-marks `walkthrough: true` in its postProcess.)
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { workflowKind } from '../src/host/workflowId.js';
import { buildWalkthroughsSurface } from '../src/features/walkthroughs/surface.js';
import { registerWalkthroughWorkflows } from '../src/features/walkthroughs/feature.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
// ADR 0435 — the two SAMPLE walkthroughs moved out of the builtin set into the
// `demo-walkthroughs` seeder; their definitions now live with that seeder. The
// page-spotlight walkthroughs are still builtins (manual-test infrastructure).
import { DEMO_WALKTHROUGHS } from '../src/host/demoWalkthroughsSeed.js';
import { WALKTHROUGH_WORKFLOWS } from '../src/features/walkthroughs/feature.js';
import { AGENTS_WALKTHROUGH, WORKFLOWS_WALKTHROUGH, RUNS_WALKTHROUGH, KEYS_WALKTHROUGH, FUNNELS_WALKTHROUGH, MODELS_WALKTHROUGH, BOARDS_WALKTHROUGH, WORKFORCES_WALKTHROUGH, INBOX_WALKTHROUGH, PROJECTS_WALKTHROUGH, AGENT_TEMPLATES_WALKTHROUGH, ROSTER_WALKTHROUGH, MEDIA_WALKTHROUGH, CMS_WALKTHROUGH, PUBLISHING_WALKTHROUGH, PROMPTS_WALKTHROUGH, MEMORY_WALKTHROUGH, CAPABILITIES_WALKTHROUGH, CLI_WALKTHROUGH, FEATURE_TOGGLES_WALKTHROUGH, ORGS_WALKTHROUGH, USERS_WALKTHROUGH, CONNECTIONS_WALKTHROUGH, EXAMPLE_DATA_WALKTHROUGH } from '../src/features/walkthroughs/feature.js';

const [CAMPAIGN_STUDIO_WALKTHROUGH, CHAT_WALKTHROUGH] = DEMO_WALKTHROUGHS;

/** Canonical referenced-id set — the ONE list the FE registration + FE
 *  coverage test must also cover. Change here ⇔ change there (this test is
 *  what makes "forgot to" loud). */
const EXPECTED_ACTION_IDS = [
  'campaign-studio.new-brief.click',
  'campaign-studio.brief-name.fill',
  'campaign-studio.create-brief.click',
  'campaign-studio.campaigns-tab.click',
] as const;
const EXPECTED_CHECKPOINTS = ['campaign-studio.brief-exists'] as const;

function referencedIds(def: (typeof DEMO_WALKTHROUGHS)[number]): { actions: string[]; checkpoints: string[] } {
  const actions: string[] = [];
  const checkpoints: string[] = [];
  for (const node of def.nodes) {
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    if (node.typeId === 'ui.walkthrough.step' && typeof cfg.actionId === 'string') actions.push(cfg.actionId);
    if (node.typeId === 'ui.walkthrough.checkpoint' && typeof cfg.expect === 'string') checkpoints.push(cfg.expect);
  }
  return { actions, checkpoints };
}

describe('Campaign Studio tour — referenced-id coverage (ADR 0368)', () => {
  it('the shipped tour references exactly the canonical id set (drift here fails CI)', () => {
    const { actions, checkpoints } = referencedIds(CAMPAIGN_STUDIO_WALKTHROUGH);
    expect(actions).toEqual([...EXPECTED_ACTION_IDS]); // order + membership
    expect(checkpoints).toEqual([...EXPECTED_CHECKPOINTS]);
  });

  it('every referenced id is well-formed (non-empty, dotted, no placeholder) — no vacuous pass', () => {
    const { actions, checkpoints } = referencedIds(CAMPAIGN_STUDIO_WALKTHROUGH);
    expect(actions.length + checkpoints.length).toBeGreaterThan(0);
    for (const id of [...actions, ...checkpoints]) {
      expect(id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/); // e.g. campaign-studio.new-brief.click
      expect(id.startsWith('unregistered.')).toBe(false); // a real registered id, not a Tier-2 placeholder
    }
  });
});

describe('chat walkthrough coverage (ADR 0378 P4)', () => {
  it('the def references exactly the FE canonical chat ids', () => {
    const { actions, checkpoints } = referencedIds(CHAT_WALKTHROUGH);
    expect(actions).toEqual(['chat.composer.send-message']);
    expect(checkpoints).toEqual(['chat.response-received']);
  });
});

describe('core-page walkthrough defs coverage (ADR 0378 P4)', () => {
  it('each def references exactly its pack action', () => {
    const expected: Array<[typeof AGENTS_WALKTHROUGH, string]> = [
      [AGENTS_WALKTHROUGH, 'agents.page.view'],
      [WORKFLOWS_WALKTHROUGH, 'workflows.page.view'],
      [RUNS_WALKTHROUGH, 'runs.page.view'],
      [KEYS_WALKTHROUGH, 'keys.page.view'],
      [FUNNELS_WALKTHROUGH, 'funnels.page.view'],
      [MODELS_WALKTHROUGH, 'models.page.view'],
    ];
    for (const [def, actionId] of expected) {
      const { actions, checkpoints } = referencedIds(def);
      expect(actions).toEqual([actionId]);
      expect(checkpoints).toEqual([]);
    }
  });
});

describe('P4-continuation page spotlights coverage', () => {
  it('each def references exactly its spotlight action', () => {
    const rows: Array<[typeof BOARDS_WALKTHROUGH, string]> = [
      [BOARDS_WALKTHROUGH, 'boards.page.view'], [WORKFORCES_WALKTHROUGH, 'workforces.page.view'],
      [INBOX_WALKTHROUGH, 'inbox.page.view'], [PROJECTS_WALKTHROUGH, 'projects.page.view'],
      [AGENT_TEMPLATES_WALKTHROUGH, 'agent-templates.page.view'], [ROSTER_WALKTHROUGH, 'roster.page.view'],
      [MEDIA_WALKTHROUGH, 'media.page.view'], [CMS_WALKTHROUGH, 'cms.page.view'],
      [PUBLISHING_WALKTHROUGH, 'publishing.page.view'], [PROMPTS_WALKTHROUGH, 'prompts.page.view'],
      [MEMORY_WALKTHROUGH, 'memory.page.view'], [CAPABILITIES_WALKTHROUGH, 'capabilities.page.view'],
      [CLI_WALKTHROUGH, 'cli.page.view'], [FEATURE_TOGGLES_WALKTHROUGH, 'feature-toggles.page.view'],
      [ORGS_WALKTHROUGH, 'orgs.page.view'], [USERS_WALKTHROUGH, 'users.page.view'],
      [CONNECTIONS_WALKTHROUGH, 'connections.page.view'], [EXAMPLE_DATA_WALKTHROUGH, 'example-data.page.view'],
    ];
    for (const [def, actionId] of rows) {
      const { actions, checkpoints } = referencedIds(def);
      expect(actions).toEqual([actionId]);
      expect(checkpoints).toEqual([]);
    }
  });
});

/**
 * ADR 0440 P1 (UX-review follow-up) — the walkthrough surfaces use TWO
 * detection rules for one concept:
 *
 *   - `/walkthroughs` (the page) reads the summary's `kind`, which the list
 *     route stamps from `workflowKind(workflowId)` (the `walkthrough.` prefix)
 *   - `ctx.features.walkthroughs.listWalkthroughs` filters on `metadata.walkthrough`
 *
 * A definition that satisfies one rule but not the other is INVISIBLE on one
 * surface while live on the other, which is exactly the failure mode ADR 0440
 * exists to fix (an autosave used to strip `metadata.walkthrough`, dropping
 * walkthroughs out of the ctx surface while the page kept listing them).
 * Witnessed (grade-tests w63 r2): the registration's `walkthrough: true`
 * re-mark dropped → case 2 red; `workflowKind` answering 'workflow' → both red.
 */
describe('walkthrough identity — the two detection rules agree (ADR 0440)', () => {
  let listed: string[] = [];
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    registerWalkthroughWorkflows();
    const out = await buildWalkthroughsSurface({ tenantId: 't-wc-identity' }).listWalkthroughs!({}) as { walkthroughs: Array<{ walkthroughId: string }> };
    listed = out.walkthroughs.map((w) => w.walkthroughId);
  });

  it('every walkthrough the ctx surface lists carries the page rule\'s `walkthrough` kind', () => {
    expect(listed.length).toBeGreaterThan(0); // no vacuous pass
    for (const id of listed) expect(workflowKind(id), `${id} is listed by ctx but the page reads it as a plain workflow`).toBe('walkthrough');
  });

  it('every system walkthrough the page rule calls a walkthrough is listed by the ctx surface', () => {
    const prefixed = WALKTHROUGH_WORKFLOWS.map((d) => d.workflowId).filter((id) => workflowKind(id) === 'walkthrough');
    expect(prefixed.length).toBeGreaterThan(0);
    for (const id of prefixed) expect(listed, `${id} has the page kind but the ctx surface does not list it`).toContain(id);
  });
});
