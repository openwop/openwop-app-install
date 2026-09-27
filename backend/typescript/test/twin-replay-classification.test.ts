/**
 * ADR 0666 D4 — pin the DELIBERATE non-classification of `local.openwop-app.agent-runner`.
 *
 * The property: the node is absent from every classification source, so `isSideEffectingNode`
 * is false, `replayServed` stays null (`executor/executor.ts`) and the node RE-EXECUTES on a
 * `:fork` — re-reading twin consent live. That live re-read is why revocation survives a fork,
 * and `host/agentRunnerNode.ts` says so in prose: "Do NOT classify this node side-effecting".
 *
 * WHY THIS ASSERTS AGAINST THE REAL MODULE, not `null`. `isSideEffectingNode(typeId, module)`
 * has three legs and the second is `module?.sideEffecting === true`, which the executor
 * evaluates against the REAL module. Passing `null` makes that leg unreachable — so adding
 * `sideEffecting: true` to the NodeModule, which is the most likely way anyone would classify
 * this node and literally the thing the prose warns against, would leave a `null`-based
 * assertion GREEN. The sibling witness
 * (`test/assistant-node-replay-classification.test.ts`) passes `null` too, so that is a shared
 * blind spot rather than a precedent; filed as `PKWF-14` for that feature's own pass.
 */
import { describe, expect, it } from 'vitest';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { AGENT_RUNNER_TYPE_ID } from '../src/host/agentRunnerNode.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { MANIFEST_FAST_PATH_SERVED, MANIFEST_SIDE_EFFECT_FLOOR } from '../src/executor/sideEffectFloor.generated.js';

describe('ADR 0666 D4 — the agent-runner node stays live on a fork', () => {
  it('anti-vacuity: the predicate really does consult the module argument', () => {
    // If this stopped holding, the real-module assertion below would be no stronger than the
    // `null` one it replaced, and the blind spot would be back without anything going red.
    expect(isSideEffectingNode('some.unclassified.node', { sideEffecting: true })).toBe(true);
    expect(isSideEffectingNode('some.unclassified.node', null)).toBe(false);
  });

  it('isSideEffectingNode is FALSE for the REAL module — all three legs', () => {
    // The exact call the executor makes. Classifying the node by ANY of the three routes —
    // the generated manifest, the module flag, or a type pattern — turns this red.
    expect(isSideEffectingNode(AGENT_RUNNER_TYPE_ID, agentRunnerNode)).toBe(false);
  });

  it('the module does not declare `sideEffecting` at all', () => {
    // So the assertion above fails for the RIGHT reason rather than incidentally: a declared
    // `false` would also satisfy it, and would be a different (deliberate) statement.
    expect(Object.prototype.hasOwnProperty.call(agentRunnerNode, 'sideEffecting')).toBe(false);
  });

  it('and it is in neither generated manifest set', () => {
    expect(MANIFEST_FAST_PATH_SERVED.has(AGENT_RUNNER_TYPE_ID)).toBe(false);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(AGENT_RUNNER_TYPE_ID)).toBe(false);
  });

  it('the type id is the one the executor will see (a rename must not silently pass)', () => {
    expect(AGENT_RUNNER_TYPE_ID).toBe('local.openwop-app.agent-runner');
    expect(agentRunnerNode.typeId).toBe(AGENT_RUNNER_TYPE_ID);
  });
});
