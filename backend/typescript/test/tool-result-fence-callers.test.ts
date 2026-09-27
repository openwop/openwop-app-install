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
  'routes/agents.ts': 'PROGRAMMATIC',
  // Prose only (comments referencing the seam).
  'features/destination-sync/agentTools.ts': 'PROGRAMMATIC',
  'features/voice/realtime/delegation.ts': 'PROGRAMMATIC',
  // The fence helper itself — names the seam in prose, never calls it.
  'host/toModelToolResult.ts': 'PROGRAMMATIC',
  // ADR 0547 — validates tool INPUT before dispatch; never touches a tool
  // RESULT, so §F1 fencing does not apply (input shape and output trust are
  // orthogonal layers). Names the seam in prose only.
  'host/toolSchemaValidation.ts': 'PROGRAMMATIC',
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
  });
}

const callers = walk(SRC)
  .filter((f) => !f.includes('__tests__'))
  .filter((f) => readFileSync(f, 'utf8').includes('executeTool'))
  .map((f) => f.slice(SRC.length + 1));

describe('RFC 0137 §F1 — every executeTool caller is classified', () => {
  it('found the call sites at all (anti-vacuity)', () => {
    // A broken walk or filter would return [] and make every assertion below
    // vacuously true — the failure mode this whole ratchet exists to prevent.
    expect(callers).toContain('host/agentDispatch.ts');
    expect(callers).toContain('features/voice/realtime/toolBridge.ts');
    expect(callers.length).toBeGreaterThan(4);
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
      expect(src, `${file} is MODEL_FACING but never calls toModelToolResult`).toContain('toModelToolResult(');
    }
  });

  it('the classification is not stale — every row still calls executeTool', () => {
    // Stops CLASSIFIED rotting into a list of files that no longer exist or no
    // longer call the seam, which would hide a real gap behind stale rows.
    for (const file of Object.keys(CLASSIFIED)) {
      expect(callers, `${file} is classified but no longer calls executeTool — remove the row`).toContain(file);
    }
  });
});
