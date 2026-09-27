/**
 * ADR 0368 — the shipped-tour coverage tripwire, FE half. Derives the
 * referenced ids from the ONE exported canonical list (no hand-maintained
 * mirror) and pins that the registration resolves each. The backend
 * `guided-tours-coverage.test` pins the tour DEFINITION references exactly the
 * same set; the opt-in `TOUR_E2E` replay pins they resolve live. No half is
 * vacuous, and a drift on either side fails in default CI.
 */
import { describe, it, expect } from 'vitest';
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

describe('campaign-studio tour coverage', () => {
  it('the registration resolves every canonical id (non-empty — no vacuous pass)', () => {
    __resetWalkthroughRegistryForTests();
    registerCampaignStudioWalkthroughActions();
    expect(CAMPAIGN_STUDIO_TOUR_ACTION_IDS.length + CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS.length).toBeGreaterThan(0);
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
