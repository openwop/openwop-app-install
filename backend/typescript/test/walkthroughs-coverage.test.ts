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
 * runtime) remains the opt-in `TOUR_E2E` replay, which runs the real tour.
 *
 * Together: backend pins WHAT the tour references; FE pins the registry HAS
 * them; the e2e pins they RESOLVE live. No half is vacuous.
 */
import { describe, it, expect } from 'vitest';
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
 *   - `/walkthroughs` (the page) filters on `workflowId.startsWith('walkthrough.')`
 *   - `ctx.features.walkthroughs.listWalkthroughs` filters on `metadata.walkthrough`
 *
 * They agree today only because all three creation paths (seeded, recorded,
 * agent-authored) happen to set both. Nothing enforced it — and a definition
 * that satisfies one rule but not the other is INVISIBLE on one surface while
 * live on the other, which is exactly the failure mode ADR 0440 exists to fix
 * (an autosave used to strip `metadata.walkthrough`, dropping walkthroughs out
 * of the ctx surface while the page kept listing them).
 */
describe('walkthrough identity — the two detection rules agree (ADR 0440)', () => {
  const isWalkthroughFlagged = (d: { metadata?: Record<string, unknown> }): boolean =>
    d.metadata?.walkthrough === true || d.metadata?.tour === true;

  it('every flagged builtin also carries the `walkthrough.*` id prefix', () => {
    const flagged = WALKTHROUGH_WORKFLOWS.filter(isWalkthroughFlagged);
    expect(flagged.length).toBeGreaterThan(0); // no vacuous pass
    for (const def of flagged) {
      expect(def.workflowId, `${def.workflowId} is flagged but lacks the prefix`).toMatch(/^(walkthrough|tour)\./);
    }
  });

  it('every `walkthrough.*` builtin is also flagged', () => {
    const prefixed = WALKTHROUGH_WORKFLOWS.filter((d) => /^(walkthrough|tour)\./.test(d.workflowId));
    expect(prefixed.length).toBeGreaterThan(0);
    for (const def of prefixed) {
      expect(isWalkthroughFlagged(def), `${def.workflowId} has the prefix but is not flagged`).toBe(true);
    }
  });
});
