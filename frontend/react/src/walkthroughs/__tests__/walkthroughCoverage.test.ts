/**
 * ADR 0368 — the shipped-tour coverage tripwire, FE half. Derives the
 * referenced ids from the ONE exported canonical list (no hand-maintained
 * mirror) and pins that the registration resolves each. The backend
 * `guided-tours-coverage.test` pins the tour DEFINITION references exactly the
 * same set. No test pins that they resolve LIVE (the opt-in `TOUR_E2E` replay
 * never ran and was deleted 2026-10-17, WALK-REPLAY-1); a drift on either
 * side of the reference set fails in default CI.
 *
 * w51 r2 (/grade-tests): "either side" was not true. Every expectation here was the
 * FE's own canonical export, and the backend test pins the DEF against its own
 * literal — nothing compared the two, so dropping an id from BOTH the FE list and
 * its registration stayed green everywhere (probe wc-backend-def was vacuous). The
 * campaign and chat cases now READ the shipped definitions
 * (`backend/typescript/src/host/demoWalkthroughsSeed.ts`) and pin the FE canonical
 * lists to the ids those definitions reference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerCampaignStudioWalkthroughActions,
  CAMPAIGN_STUDIO_TOUR_ACTION_IDS,
  CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS,
} from '../../features/campaign-brief/walkthroughActions.js';
import { getWalkthroughAction, getWalkthroughCheckpoint, listWalkthroughActionIds, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';
import {
  registerChatWalkthroughActions,
  CHAT_WALKTHROUGH_ACTION_IDS,
  CHAT_WALKTHROUGH_CHECKPOINT_IDS,
} from '../../chat/walkthroughActions.js';

const SEED = readFileSync(join(process.cwd(), '../../backend/typescript/src/host/demoWalkthroughsSeed.ts'), 'utf8');

/** The step `actionId`s and checkpoint `expect`s one shipped definition references, in order. */
function shippedIds(constName: string, nextConst: string | null): { actions: string[]; checkpoints: string[] } {
  const from = SEED.indexOf(`const ${constName}: WorkflowDefinition`);
  expect(from, `${constName} is gone from demoWalkthroughsSeed.ts — this test is reading nothing`).toBeGreaterThan(-1);
  const to = nextConst ? SEED.indexOf(`const ${nextConst}: WorkflowDefinition`, from) : SEED.length;
  const block = SEED.slice(from, to > from ? to : SEED.length);
  return {
    actions: [...block.matchAll(/actionId: '([^']+)'/g)].map((m) => m[1] ?? ''),
    checkpoints: [...block.matchAll(/expect: '([^']+)'/g)].map((m) => m[1] ?? ''),
  };
}

describe('campaign-studio tour coverage', () => {
  it('the registration resolves every canonical id (non-empty — no vacuous pass)', () => {
    __resetWalkthroughRegistryForTests();
    registerCampaignStudioWalkthroughActions();
    expect(CAMPAIGN_STUDIO_TOUR_ACTION_IDS.length + CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS.length).toBeGreaterThan(0);
    // The FE canonical list IS what the shipped definition references (cross-tree).
    const shipped = shippedIds('CAMPAIGN_STUDIO_WALKTHROUGH', 'CHAT_WALKTHROUGH');
    expect([...CAMPAIGN_STUDIO_TOUR_ACTION_IDS]).toEqual(shipped.actions);
    expect([...CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS]).toEqual(shipped.checkpoints);
    for (const id of CAMPAIGN_STUDIO_TOUR_ACTION_IDS) expect(getWalkthroughAction(id), id).toBeTruthy();
    for (const id of CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS) expect(getWalkthroughCheckpoint(id), id).toBeTruthy();
  });

  it('the registration registers EXACTLY the canonical actions (an extra/orphan registration fails too)', () => {
    __resetWalkthroughRegistryForTests();
    registerCampaignStudioWalkthroughActions();
    expect(listWalkthroughActionIds().sort()).toEqual([...CAMPAIGN_STUDIO_TOUR_ACTION_IDS].sort());
  });
});

describe('chat walkthrough coverage (ADR 0378 P4)', () => {
  it('the chat registration resolves every canonical id (non-empty)', () => {
    __resetWalkthroughRegistryForTests();
    registerChatWalkthroughActions();
    expect(CHAT_WALKTHROUGH_ACTION_IDS.length + CHAT_WALKTHROUGH_CHECKPOINT_IDS.length).toBeGreaterThan(0);
    const shipped = shippedIds('CHAT_WALKTHROUGH', null);
    expect([...CHAT_WALKTHROUGH_ACTION_IDS]).toEqual(shipped.actions);
    expect([...CHAT_WALKTHROUGH_CHECKPOINT_IDS]).toEqual(shipped.checkpoints);
    for (const id of CHAT_WALKTHROUGH_ACTION_IDS) expect(getWalkthroughAction(id), id).toBeTruthy();
    for (const id of CHAT_WALKTHROUGH_CHECKPOINT_IDS) expect(getWalkthroughCheckpoint(id), id).toBeTruthy();
  });

  it('registers EXACTLY the canonical chat actions', () => {
    __resetWalkthroughRegistryForTests();
    registerChatWalkthroughActions();
    expect(listWalkthroughActionIds().sort()).toEqual([...CHAT_WALKTHROUGH_ACTION_IDS].sort());
  });
});

describe('core-page walkthrough packs coverage (ADR 0378 P4)', () => {
  it('each pack resolves its canonical action', async () => {
    const packs = [
      { reg: (await import('../../agents/walkthroughActions.js')).registerAgentsWalkthroughActions, ids: (await import('../../agents/walkthroughActions.js')).AGENTS_WALKTHROUGH_ACTION_IDS },
      { reg: (await import('../../builder/walkthroughActions.js')).registerWorkflowsWalkthroughActions, ids: (await import('../../builder/walkthroughActions.js')).WORKFLOWS_WALKTHROUGH_ACTION_IDS },
      { reg: (await import('../../runs/walkthroughActions.js')).registerRunsWalkthroughActions, ids: (await import('../../runs/walkthroughActions.js')).RUNS_WALKTHROUGH_ACTION_IDS },
      { reg: (await import('../../byok/walkthroughActions.js')).registerKeysWalkthroughActions, ids: (await import('../../byok/walkthroughActions.js')).KEYS_WALKTHROUGH_ACTION_IDS,
        checkpoints: (await import('../../byok/walkthroughActions.js')).KEYS_WALKTHROUGH_CHECKPOINT_IDS },
      { reg: (await import('../../features/funnels/walkthroughActions.js')).registerFunnelsWalkthroughActions, ids: (await import('../../features/funnels/walkthroughActions.js')).FUNNELS_WALKTHROUGH_ACTION_IDS },
      { reg: (await import('../../features/models/walkthroughActions.js')).registerModelsWalkthroughActions, ids: (await import('../../features/models/walkthroughActions.js')).MODELS_WALKTHROUGH_ACTION_IDS },
      // ADR 0488 P4 — the commerce spotlight backing the funnel tutorial's
      // commerce step. Anchored by the #2572 drawdown; an anchor with no
      // registration is unreachable, so the pair is pinned together here.
      { reg: (await import('../../features/commerce/walkthroughActions.js')).registerCommerceWalkthroughActions, ids: (await import('../../features/commerce/walkthroughActions.js')).COMMERCE_WALKTHROUGH_ACTION_IDS },
    ];
    for (const pack of packs) {
      const { reg, ids } = pack;
      const checkpoints = (pack as { checkpoints?: readonly string[] }).checkpoints ?? [];
      __resetWalkthroughRegistryForTests();
      reg();
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(getWalkthroughAction(id), id).toBeTruthy();
      expect(listWalkthroughActionIds().sort()).toEqual([...ids].sort());
      // ADR 0489 D1 — a pack may also ship CHECKPOINTS; an unregistered one is a
      // walkthrough that dead-ends mid-run, so pin them alongside the actions.
      for (const id of checkpoints) expect(getWalkthroughCheckpoint(id), id).toBeTruthy();
    }
  });
});
