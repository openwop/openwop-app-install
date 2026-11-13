/**
 * RFC 0137 §F1 — the caller-enumeration ratchet.
 *
 * A test that checks "the fence is applied" can only check paths it already
 * knows about, which is exactly how the voice bridge went unfenced: it was added
 * later, deliberately reused `executeTool` ("the SAME executeTool the chat path
 * uses"), and would have silently skipped a fence placed only in the tool loop.
 *
 * So this asserts the CALLER SET instead. Every `executeTool` call site is
 * classified MODEL_FACING (must route through `toModelToolResult`) or
 * PROGRAMMATIC (exempt, with a stated reason). A new dispatch path fails this
 * test until someone classifies it — complete-by-construction, rather than a
 * grep for a fence that a new spelling evades.
 *
 * ADR 0999 D2 widened the population to both seam spellings (`executeTool`, and
 * the provider dispatcher's `onToolUse`), and TOC2CD-14 made the two provider
 * dispatchers model-facing. Each MODEL_FACING row names the ONE fence entry point
 * it must call (`FENCE_OF`), and the check reads the source with comments
 * stripped (`helpers/stripComments`), so a docblock naming the fence no longer
 * satisfies it (wave 107; it did before). It is still a source ratchet: it proves
 * the call is in the code, not what the call does. The fence's behaviour is
 * covered where it is applied (agentDispatch, the voice tool bridge, the
 * toc2cd14-* tests). The anti-vacuity case pins the found caller set to EXACTLY
 * the classified rows (MEASURED at 356b3109f: 17 = 17).
 *
 * Red when (probe-witnessed, w107): a model-facing caller drops its fence call or
 * leaves it only in a comment; a new file names `executeTool` or `onToolUse`
 * without a row; a classified file stops naming the seam.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './helpers/stripComments.js';

const SRC = join(process.cwd(), 'src');

/** file → why it calls `executeTool`. Adding a caller REQUIRES a row here. */
const CLASSIFIED: Record<string, 'MODEL_FACING' | 'PROGRAMMATIC'> = {
  // Builds the model's tool message. Fences via toModelToolResult.
  'host/agentDispatch.ts': 'MODEL_FACING',
  // Returns the result to a realtime voice model, bypassing runChatToolLoop.
  'features/voice/realtime/toolBridge.ts': 'MODEL_FACING',
  // Defines the provider; does not consume a result for a model.
  'host/agentToolProvider.ts': 'PROGRAMMATIC',
  // Wraps/forwards the provider into runChatToolLoop — the loop fences.
  'host/anonymousActor.ts': 'PROGRAMMATIC',
  // Passes the provider INTO runChatToolLoop; never builds a model message.
  'host/conversationToolLoop.ts': 'PROGRAMMATIC',
  'host/agentRunnerNode.ts': 'PROGRAMMATIC',
  // ADR 0889 D3 — the ad-hoc dispatch lane (moved from routes/agents.ts).
  'host/liveDispatchLane.ts': 'PROGRAMMATIC',
  // ADR 0889 D9 — wraps the executor to record the boundary; returns the inner
  // result unchanged to the loop, which fences it.
  'host/evals/toolBoundary.ts': 'PROGRAMMATIC',
  // ADR 1002 D4 — wraps the run-lane executor to record results and serve them
  // on a replay fork; returns the result unchanged to the loop, which fences it.
  'host/replayToolResults.ts': 'PROGRAMMATIC',
  // Prose only (comments referencing the seam).
  'features/destination-sync/agentTools.ts': 'PROGRAMMATIC',
  'features/voice/realtime/delegation.ts': 'PROGRAMMATIC',
  // The fence helper itself — names the seam in prose, never calls it.
  'host/toModelToolResult.ts': 'PROGRAMMATIC',
  // ADR 0547 — validates tool INPUT before dispatch; never touches a tool
  // RESULT, so §F1 fencing does not apply (input shape and output trust are
  // orthogonal layers). Names the seam in prose only.
  'host/toolSchemaValidation.ts': 'PROGRAMMATIC',
  // ADR 0999 D2 (TOC2CD-2) — the WORKFLOW-AS-TOOL lane. Never calls `executeTool`:
  // its `onToolUse` returns a child RUN's output to the provider dispatcher, so it
  // was invisible to this ratchet while it sent that output to a model unfenced.
  // Fences via `toModelWorkflowToolResult`.
  'bootstrap/nodes.ts': 'MODEL_FACING',
  // TOC2CD-14 — the provider dispatchers AUTHOR a tool result when `onToolUse`
  // throws, and it goes straight to the model, so they are model-facing: the throw
  // is fenced via toModelToolResult (`toc2cd14-dispatcher-catch-ratchet` pins how).
  'providers/dispatchAnthropicTools.ts': 'MODEL_FACING',
  'providers/dispatchMiniMaxTools.ts': 'MODEL_FACING',
  // The compaction seam — names `onToolUse` in prose; transforms a result but
  // never builds a model message (fencing is deliberately NOT folded into it).
  'host/toolResultTransform.ts': 'PROGRAMMATIC',
};

/**
 * MODEL_FACING file → the fence entry point of `host/toModelToolResult.ts` it
 * must call. One spelling per file: accepting any of the three would let a file
 * lose its own fence while an unrelated call to another one stays.
 */
const FENCE_OF: Record<string, 'toModelToolResult(' | 'toModelWorkflowToolResult(' | 'fenceThrownToolError('> = {
  'host/agentDispatch.ts': 'toModelToolResult(',
  'features/voice/realtime/toolBridge.ts': 'toModelToolResult(',
  // ADR 0999 D2 — the workflow-as-tool lane.
  'bootstrap/nodes.ts': 'toModelWorkflowToolResult(',
  // TOC2CD-14 — the import-free leaf the provider dispatchers use.
  'providers/dispatchAnthropicTools.ts': 'fenceThrownToolError(',
  'providers/dispatchMiniMaxTools.ts': 'fenceThrownToolError(',
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
  });
}

/**
 * ADR 0999 D2 — the population is EVERY way a tool result can be produced for a
 * model, not one spelling of it. `executeTool` is the builtin lane; `onToolUse` is
 * the provider-dispatcher callback the workflow-as-tool lane answers. Keyed on
 * `executeTool` alone, this ratchet could not see `bootstrap/nodes.ts`, which is
 * how a child run's output reached the model with no fence — the same population
 * hole `tool-result-compaction-callers.test.ts` closed by taking the union.
 */
const SEAM_SPELLINGS = ['executeTool', 'onToolUse'] as const;
const mentionsSeam = (f: string): boolean => {
  const src = readFileSync(f, 'utf8');
  return SEAM_SPELLINGS.some((k) => src.includes(k));
};

const callers = walk(SRC)
  .filter((f) => !f.includes('__tests__'))
  .filter(mentionsSeam)
  .map((f) => f.slice(SRC.length + 1));

describe('RFC 0137 §F1 — every executeTool caller is classified', () => {
  it('found the call sites at all (anti-vacuity)', () => {
    // A broken walk or filter would return [] and make every assertion below
    // vacuously true — the failure mode this whole ratchet exists to prevent.
    expect(callers).toContain('host/agentDispatch.ts');
    expect(callers).toContain('features/voice/realtime/toolBridge.ts');
    expect(callers).toContain('bootstrap/nodes.ts'); // the `onToolUse` spelling
    // Exact: the walk found every classified row and nothing else.
    expect([...callers].sort()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('NO unclassified caller — a new model-facing path must fail here', () => {
    const unclassified = callers.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      'a new `executeTool` caller appeared. Classify it in CLASSIFIED: MODEL_FACING ' +
        '(must route the result through `toModelToolResult`) or PROGRAMMATIC (exempt — say why).',
    ).toEqual([]);
  });

  it('every MODEL_FACING caller actually routes through toModelToolResult', () => {
    // Every MODEL_FACING row names its fence, and nothing else does.
    const modelFacing = Object.entries(CLASSIFIED).filter(([, k]) => k === 'MODEL_FACING').map(([f]) => f);
    expect(modelFacing.sort()).toEqual(Object.keys(FENCE_OF).sort());
    for (const file of modelFacing) {
      // Comments stripped: prose naming the fence is not a call to it.
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      expect(code, `${file} is MODEL_FACING but never calls ${FENCE_OF[file]}`).toContain(FENCE_OF[file]);
    }
  });

  it('the classification is not stale — every row still calls executeTool', () => {
    // Stops CLASSIFIED rotting into a list of files that no longer exist or no
    // longer call the seam, which would hide a real gap behind stale rows.
    for (const file of Object.keys(CLASSIFIED)) {
      expect(callers, `${file} is classified but no longer names executeTool / onToolUse — remove the row`).toContain(file);
    }
  });
});
