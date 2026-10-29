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
 * HONEST CEILING (wave 61): the MODEL_FACING check is a substring presence of
 * `toModelToolResult(` in the caller's source, so a comment naming it would
 * satisfy it. That is the limit of a source ratchet; the fence's behaviour is
 * covered where it is applied (agentDispatch / the voice tool bridge tests).
 * The anti-vacuity case now pins the found caller set to EXACTLY the
 * classified rows (MEASURED 2026-10-23: 12 = 12), not a `> 4` floor.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
    for (const [file, kind] of Object.entries(CLASSIFIED)) {
      if (kind !== 'MODEL_FACING') continue;
      const src = readFileSync(join(SRC, file), 'utf8');
      // ADR 0999 D2 — either fence entry point of the ONE module that owns the
      // RFC 0021 threat model (`host/toModelToolResult.ts`).
      expect(
        // TOC2CD-14: `fenceThrownToolError` is the import-free leaf the provider dispatchers use.
        src.includes('toModelToolResult(') || src.includes('toModelWorkflowToolResult(') || src.includes('fenceThrownToolError('),
        `${file} is MODEL_FACING but never calls toModelToolResult / toModelWorkflowToolResult`,
      ).toBe(true);
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
