/**
 * ADR 0488 D1 — the narrative→spine BINDING must always resolve.
 *
 * A tutorial step's `run.chainId` points at an RFC 0013 workflow-chain. If that
 * id stops resolving — a chain renamed, a pack dropped, a typo — the learner
 * gets a "Show me" button that launches nothing. That is the exact rot the
 * semantic-binding design exists to prevent, and it is invisible to `tsc`
 * because both sides are just strings.
 *
 * So this pins BOTH directions of the seam:
 *   - every `chainId` a shipped tutorial references RESOLVES to something
 *     runnable (a chain-backed workflow, a registered workflow, or one of the
 *     ADR 0435 seeded sample walkthroughs);
 *   - the reference set is NON-EMPTY, so the test cannot pass by finding nothing.
 *
 * It reads the FRONTEND authored content as well as the backend seed, because
 * until ADR 0488 P4/P5 retires the frontend copy BOTH can carry bindings and a
 * dangling one in either is equally dead to the learner.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_TUTORIALS } from '../src/features/tutorials/seedTutorials.js';
import { registerWalkthroughWorkflows } from '../src/features/walkthroughs/feature.js';
import { registerTutorialChainWorkflows } from '../src/features/tutorials/feature.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { loadWorkflowChainPacks, listChains, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { DEMO_WALKTHROUGHS } from '../src/host/demoWalkthroughsSeed.js';
import { LEGACY_CAMPAIGN_STUDIO_ID, CAMPAIGN_STUDIO_WALKTHROUGH_ID } from '../src/features/walkthroughs/walkthroughIds.js';

const FE_CONTENT = join(import.meta.dirname, '../../../frontend/react/src/features/tutorials/content');

/** Every id the shipped tutorials reference, from BOTH copies of the content. */
function referencedChainIds(): string[] {
  const ids = new Set<string>();
  // Backend seed (the canonical library).
  for (const t of SEED_TUTORIALS) {
    for (const p of t.phases) {
      if (p.chainId) ids.add(p.chainId);
      for (const s of p.steps) {
        if (s.run?.chainId) ids.add(s.run.chainId);
        if (s.walkthroughId) ids.add(s.walkthroughId);
      }
    }
  }
  // Frontend authored modules (still live until P4/P5).
  if (existsSync(FE_CONTENT)) {
    for (const f of readdirSync(FE_CONTENT)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(FE_CONTENT, f), 'utf8');
      for (const m of src.matchAll(/chainId:\s*'([^']+)'/g)) ids.add(m[1]!);
      for (const m of src.matchAll(/walkthroughId:\s*'([^']+)'/g)) ids.add(m[1]!);
    }
  }
  return [...ids];
}

/** Ids the player can actually launch. */
let launchable: Set<string>;

beforeAll(() => {
  // §Correction (grade-code `TUT-2`) — THIS TEST USED TO CERTIFY DEAD BUTTONS.
  //
  // It built `launchable` from `listChains()`, i.e. every chain LOADED from a
  // pack. But production resolves a run through `getChainBackedWorkflow`, which
  // reads the REGISTERED set — a strictly smaller thing. Loaded-but-unregistered
  // chains therefore passed this test and 404'd for the learner, which is
  // precisely the failure the docblock above says cannot happen. Four "Show me"
  // buttons shipped that way.
  //
  // So the launchable set is now built from what the RUN RESOLVER would accept:
  // the feature's own registration path runs, and membership is asserted through
  // `getChainBackedWorkflow`. Everything else is an explicitly-named alternative
  // resolution source, not a blanket "it exists somewhere" allowance.
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [join(import.meta.dirname, '../../../examples/workflow-chain-packs')] });
  // The REAL registration paths, exactly as the features run them at boot.
  registerWalkthroughWorkflows();
  registerTutorialChainWorkflows();
  launchable = new Set<string>([
    ...listChains().map((c) => c.chain.chainId).filter((id) => getChainBackedWorkflow(id) !== undefined),
    // ADR 0435 — the two SAMPLE walkthroughs are seeded example data, not
    // builtins, so they are launchable by id without being in the registry here.
    ...DEMO_WALKTHROUGHS.map((d) => d.workflowId),
    // ADR 0376 — the pre-rename alias still resolves for in-flight content.
    LEGACY_CAMPAIGN_STUDIO_ID,
    CAMPAIGN_STUDIO_WALKTHROUGH_ID,
  ]);
});

describe('ADR 0488 D1 — tutorial→chain binding drift', () => {
  it('tutorials actually reference chains (non-vacuous — an empty set would pass everything)', () => {
    expect(referencedChainIds().length).toBeGreaterThan(0);
  });

  it('the launchable set is non-empty (a broken registration fails here first)', () => {
    expect(launchable.size).toBeGreaterThan(0);
  });

  it('EVERY referenced chainId resolves to something the player can launch', () => {
    const dangling = referencedChainIds().filter((id) => !launchable.has(id));
    expect(
      dangling,
      'These tutorial bindings point at chains that do not resolve — each is a "Show me" '
      + 'button that launches nothing. Fix the id, or ship the chain (ADR 0488 D1).',
    ).toEqual([]);
  });

  it('no step binds BOTH the legacy walkthroughId and a run.chainId (one source of truth per step)', () => {
    const both: string[] = [];
    for (const t of SEED_TUTORIALS) {
      for (const p of t.phases) {
        for (const s of p.steps) {
          if (s.run?.chainId && s.walkthroughId) both.push(`${t.id}/${s.id}`);
        }
      }
    }
    expect(both, 'Migrate these steps to `run` and drop `walkthroughId`.').toEqual([]);
  });

  /**
   * ADR 0488 D2 — ONE SPINE PER PHASE.
   *
   * A phase `chainId` means "the spine that COVERS this phase". If the phase's
   * own steps also carry `run.chainId`, the surface renders two buttons driving
   * overlapping work through different chains — "Show me this phase" and "Show
   * me" — and the learner cannot tell which is authoritative or what either one
   * will actually cover.
   *
   * This is not hypothetical: it shipped in #2558 on all three phase-chained
   * phases of connect-your-ai, where the phase pointed at the new phase chain
   * while its step still pointed at the old single-step page spotlight. Caught by
   * the /architect review of the P4 "blocker", fixed here, pinned so it stays fixed.
   *
   * The authoring obligation the test cannot check — that the chain genuinely
   * drives every step of the phase — is stated in the ADR. What IS mechanical is
   * the double affordance, and that is what this forbids.
   */
  it('ADR 0488 D2 — a phase-chained phase has ONE spine (no step-level run inside it)', () => {
    const doubled: string[] = [];
    for (const t of SEED_TUTORIALS) {
      for (const p of t.phases) {
        if (!p.chainId) continue; // a phase without a spine may bind per step
        for (const s of p.steps) {
          if (s.run?.chainId || s.walkthroughId) doubled.push(`${t.id}/phase-${p.number}/${s.id}`);
        }
      }
    }
    expect(
      doubled,
      'These steps sit inside a phase that already declares a chainId, so they render a SECOND "Show me" '
      + 'competing with "Show me this phase". Drop the step-level binding — the phase chain owns the spine.',
    ).toEqual([]);
  });

  it('ADR 0488 D2 — a phase `chainId`, where present, also resolves', () => {
    const dangling: string[] = [];
    for (const t of SEED_TUTORIALS) {
      for (const p of t.phases) {
        if (p.chainId && !launchable.has(p.chainId)) dangling.push(`${t.id}/phase-${p.number}: ${p.chainId}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
