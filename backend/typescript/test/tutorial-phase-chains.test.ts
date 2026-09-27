/**
 * ADR 0488 D2 — the NESTING PROOF.
 *
 * The ADR's own de-risking instruction was: *prove sub-chain nesting on ONE
 * 3-phase tutorial before converting the library*. This is that proof, and it
 * runs through the REAL chain-pack loader rather than a synthetic registry —
 * the ADR 0442 lesson, where synthetic-registry tests MASKED a production
 * pack-loader bug (draft-07 vs Ajv2020 + a shared `$id`) for a whole phase.
 *
 * What must hold for "Show me this phase" to be real:
 *  1. the pack LOADS through the built loader with zero errors;
 *  2. each PHASE chain resolves on its own and expands to a runnable definition
 *     (that is what makes a phase independently launchable);
 *  3. the PARENT declares its children in `subChains[]` and references them via
 *     `config.subChainRef` — never a pinned `config.workflowId` (RFC 0133 §1.2);
 *  4. composition validation passes and the graph is acyclic;
 *  5. every step in every phase chain points at a REGISTERED action, so a
 *     phase cannot dead-end the player at runtime.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  validateChainComposition,
  detectSubChainCycles,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const PACK_ROOT = join(import.meta.dirname, '../../../examples/workflow-chain-packs');

const PARENT = 'tutorial.connect-your-ai';
const PHASES = [
  'tutorial.connect-your-ai.phase-2',
  'tutorial.connect-your-ai.phase-3',
  'tutorial.connect-your-ai.phase-4',
] as const;

let outcome: ReturnType<typeof loadWorkflowChainPacks>;

beforeAll(() => {
  _resetChainRegistryForTest();
  outcome = loadWorkflowChainPacks({ roots: [PACK_ROOT] });
});

describe('ADR 0488 D2 — tutorial phase sub-chains load through the REAL loader', () => {
  it('the pack loads with no errors (non-vacuous — a broken manifest fails here first)', () => {
    // If the loader silently found nothing, every assertion below would pass
    // vacuously, so assert it actually loaded chains.
    expect(listChains().length).toBeGreaterThan(0);
    const ourErrors = (outcome.errors ?? []).filter((e) => JSON.stringify(e).includes('tutorial-connect-your-ai'));
    expect(ourErrors, JSON.stringify(ourErrors)).toEqual([]);
  });

  it('every phase chain resolves INDEPENDENTLY — that is what makes a phase launchable', () => {
    for (const id of PHASES) {
      const found = getChain(id);
      expect(found, `phase chain ${id} did not resolve`).toBeTruthy();
      expect(found!.chain.chainId).toBe(id);
    }
  });

  it('each phase EXPANDS to a runnable definition with real walkthrough steps', () => {
    for (const id of PHASES) {
      const def = expandChain(getChain(id)!.chain);
      expect(def.nodes.length, `${id} expanded to no nodes`).toBeGreaterThan(0);
      for (const n of def.nodes) {
        expect(n.typeId).toMatch(/^ui\.walkthrough\.(step|checkpoint)$/);
      }
    }
  });

  it('the multi-node phase keeps its ORDER (a HITL step then its checkpoint)', () => {
    const def = expandChain(getChain('tutorial.connect-your-ai.phase-4')!.chain);
    expect(def.nodes).toHaveLength(2);
    expect(def.nodes[0]!.typeId).toBe('ui.walkthrough.step');
    expect(def.nodes[1]!.typeId).toBe('ui.walkthrough.checkpoint');
    expect(def.edges).toHaveLength(1);
  });

  it('the PARENT composes the phases as sub-chains, and pins no workflowId (RFC 0133 §1.2)', () => {
    const parent = getChain(PARENT);
    expect(parent, 'parent chain did not resolve').toBeTruthy();
    const chain = parent!.chain;

    const declared = (chain.subChains ?? []).map((s) => (typeof s.ref === 'string' ? s.ref : s.ref.chainId));
    expect(declared.sort()).toEqual([...PHASES].sort());

    for (const n of chain.dag.nodes) {
      // A pinned workflowId is host-specific and is exactly what the RFC forbids.
      expect(n.config?.workflowId, `node ${n.id} pins a concrete workflowId`).toBeUndefined();
      expect(n.config?.subChainRef, `node ${n.id} has no subChainRef`).toBeTruthy();
      expect(declared).toContain(n.config!.subChainRef);
    }
  });

  it('composition validates and the graph is ACYCLIC', () => {
    for (const id of [PARENT, ...PHASES]) {
      expect(validateChainComposition(getChain(id)!.chain), `composition invalid for ${id}`).toBeNull();
    }
    const all = listChains().map((c) => c.chain);
    const cycles = detectSubChainCycles(all).filter((c) => c.includes('tutorial.connect-your-ai'));
    expect(cycles).toEqual([]);
  });

  it('every phase step points at an action the FRONTEND registers (no dead-end phase)', () => {
    // The frontend owns the action registry, so the ids are pinned here against
    // the same registrations the walkthrough packs already rely on. A typo'd
    // actionId would leave the player in `needs-update` mid-tutorial.
    const KNOWN = new Set(['keys.page.view', 'models.page.view', 'chat.composer.send-message']);
    const seen: string[] = [];
    for (const id of PHASES) {
      for (const n of expandChain(getChain(id)!.chain).nodes) {
        const actionId = (n.config as { actionId?: string } | undefined)?.actionId;
        if (actionId) { seen.push(actionId); expect(KNOWN, `unknown actionId ${actionId}`).toContain(actionId); }
      }
    }
    expect(seen.length, 'no actionIds seen — the walk found nothing').toBeGreaterThan(0);
  });
});
