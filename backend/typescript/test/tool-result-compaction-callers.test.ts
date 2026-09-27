/**
 * TOCC-1 / TOCC-6 (ADR 0604) — the COMPACTION caller-enumeration ratchet, the
 * sibling `tool-result-fence-callers.test.ts` has had since RFC 0137 §F1 and
 * this seam never got.
 *
 * WHY THE FENCE GOT ONE AND COMPACTION DID NOT, AND WHY THAT MATTERED. The
 * fence ratchet exists *because* the voice bridge once drifted unfenced: it was
 * added later, reused `executeTool`, and silently skipped a fence placed only in
 * the tool loop. Compaction has exactly the same shape and exactly the same
 * drift, and nothing was watching:
 *
 *   - `host/conversationToolLoop.ts` — the interactive `/` chat — passed FIFTEEN
 *     keys into `runChatToolLoop` and `compaction` was not one of them, so
 *     `applyToolResultTransform` short-circuited on `!ctx.decision` at every
 *     chat turn. The feature was IDENTITY on the lane that `FEATURES.md`,
 *     `ARCHITECTURE.md` ("Covers chat…") and ADR 0099 all named as its flagship
 *     surface. Fixed; this file is what keeps it fixed.
 *   - `features/voice/realtime/toolBridge.ts` fences but does not compact, which
 *     makes `host/toModelToolResult.ts`'s own docblock claim that "compaction
 *     runs BEFORE fencing" false on one of the two paths that file enumerates.
 *     Recorded here as an explicit, reasoned exemption rather than left as an
 *     invisible gap.
 *
 * The instrument is the caller SET, not a grep for a spelling: every file that
 * calls `executeTool` OR applies the transform is classified, and a new one
 * fails this test until somebody decides.
 *
 * CORRECTED (ADR 0604 review, LOW): the population used to be `executeTool`
 * alone, under a header claiming "every place a tool result is produced". It
 * was not: `bootstrap/nodes.ts` compacts a SUB-RUN tool result and never calls
 * `executeTool`, so the file that most needed a row was invisible to the census
 * that was supposed to find it. The population is now the UNION of the two
 * spellings, which is what makes the header sentence true.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './helpers/stripComments.js';

const SRC = join(process.cwd(), 'src');

type Kind =
  /** Drives a model round-trip and MUST hand the loop a compaction decision. */
  | 'MUST_SUPPLY'
  /** Applies the transform itself — the seam's implementation side. */
  | 'APPLIES'
  /** Exempt, with a stated reason. */
  | 'EXEMPT';

/**
 * file → why it appears. Adding a caller REQUIRES a row here.
 *
 * `decisionSource` (MUST_SUPPLY only, ADR 0604 review LOW) — the EXPRESSION
 * this file's decision must come from. The old leg only checked that a
 * `compaction:` key appeared on the options object, so
 * `const compaction = undefined` with the spread intact stayed green: the
 * regex proved a KEY was written, never that a DECISION reached the loop.
 * Naming the source per file is what makes the row load-bearing — and the
 * legal sources are exactly two, `readCompactionDecision(...)` off a frozen
 * blob or a forwarded `ctx.compaction`, so an invented third fails here.
 */
const CLASSIFIED: Record<string, { kind: Kind; why: string; decisionSource?: RegExp }> = {
  'host/agentDispatch.ts': {
    kind: 'APPLIES',
    why: 'Owns runChatToolLoop and applies the transform at the tool-result boundary.',
  },
  'host/conversationToolLoop.ts': {
    kind: 'MUST_SUPPLY',
    why: 'The interactive `/` chat. Reads the run-start-frozen decision off run.metadata (ADR 0604).',
    decisionSource: /const\s+compaction\s*=\s*readCompactionDecision\s*\(\s*run\.metadata\s*\)/,
  },
  'host/agentRunnerNode.ts': {
    kind: 'MUST_SUPPLY',
    why: 'The workflow agent node. Forwards ctx.compaction, which the executor read from run.metadata.',
    decisionSource: /compaction:\s*ctx\.compaction/,
  },
  'host/anonymousActor.ts': {
    kind: 'EXEMPT',
    why:
      'ADR 0604 (recorded, not fixed): the anon lane creates its run with a bare `storage.insertRun`, ' +
      'bypassing `insertRunWithStartContext`, so no frozen decision exists to supply. Routing it through ' +
      'the seam also runs the AUTHORITY contributor for an ANONYMOUS principal — a security-relevant ' +
      'change that needs its own decision, not a token-savings fix.',
  },
  'features/voice/realtime/toolBridge.ts': {
    kind: 'EXEMPT',
    why:
      'ADR 0604 (recorded, not fixed): the realtime voice bridge has no run and no frozen decision — it ' +
      'is dispatched from a live session, not a run record. It DOES fence (RFC 0137 §F1). Until it has a ' +
      'run-scoped decision it cannot compact, and guessing one live would break the run-start freeze.',
  },
  'routes/agents.ts': {
    kind: 'MUST_SUPPLY',
    why: 'The runless live-dispatch lane. Resolves via stampRunStartContext({}, {...}) — the blessed reuse.',
    decisionSource: /const\s+compaction\s*=\s*readCompactionDecision\s*\(\s*compactionMeta\s*\)/,
  },
  'features/destination-sync/agentTools.ts': {
    kind: 'EXEMPT',
    why: 'Prose only — the comment references the executor seam; there is no tool-loop dispatch in this file.',
  },
  'features/voice/realtime/delegation.ts': {
    kind: 'EXEMPT',
    why: 'Prose only — names the shared executor in a comment; the realtime result path is toolBridge.ts.',
  },
  'host/agentToolProvider.ts': {
    kind: 'EXEMPT',
    why: 'DEFINES executeTool. It produces the raw content; the transform is applied by the consumer, and applying it here would double-compact on lanes that already do.',
  },
  'host/toolSchemaValidation.ts': {
    kind: 'EXEMPT',
    why: 'ADR 0547 — validates tool INPUT before dispatch and never touches a tool RESULT. Input shape and output compaction are orthogonal layers.',
  },
  'host/toModelToolResult.ts': {
    kind: 'EXEMPT',
    why: 'Names the seam in prose only (the "compaction runs BEFORE fencing" note); never calls it.',
  },
  // ── Added by the ADR 0604 review (LOW): the population miss ──────────────
  'bootstrap/nodes.ts': {
    kind: 'APPLIES',
    why:
      'The agent/heartbeat node applies the transform to a SUB-RUN tool result at its typed boundary '
      + '(`applyToolResultTransform(formatSubRunResult(...), { decision: ctx.compaction, ... })`), reading the '
      + 'run-start-frozen decision off ctx. It never calls executeTool, which is exactly why the '
      + 'executeTool-only population could not see it.',
  },
  'executor/types.ts': {
    kind: 'EXEMPT',
    why: 'Declares CompactionDecision and documents the seam in prose; the core owns the TYPE, never the transform (ADR 0001 inversion).',
  },
  'features/tool-output-compaction/feature.ts': {
    kind: 'EXEMPT',
    why: 'The feature that REGISTERS the transform into the core seam (registerToolResultTransform). Wiring, not a caller — it produces no tool result.',
  },
  'host/toolResultTransform.ts': {
    kind: 'APPLIES',
    why: 'IS the seam: owns applyToolResultTransform, the exemption predicate and the fail-open identity default.',
  },
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const f = join(d, e);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
  });
}

/**
 * The population is `executeTool` ∪ `applyToolResultTransform` — a SUPERSET of
 * `tool-result-fence-callers.test.ts`'s universe, deliberately. A tool result is
 * produced where `executeTool` is called, and ALSO transformed where the seam is
 * applied without one (`bootstrap/nodes.ts` — the miss the review found), so
 * both properties a result must satisfy before it
 * reaches a model — it is fenced (RFC 0137 §F1) and it is compacted per the
 * run's frozen decision (ADR 0099) — are decided over the same denominator. Two
 * ratchets over two different populations is how one of them ends up with a
 * blind spot the other cannot see, which is precisely what happened here: the
 * fence ratchet listed `conversationToolLoop.ts` as PROGRAMMATIC ("the loop
 * fences"), which was true, and nothing anywhere asked whether the loop also
 * COMPACTS — it did not, because this caller never handed it a decision.
 */
const callers = walk(SRC)
  .filter((f) => !f.includes('__tests__'))
  .filter((f) => {
    const s = readFileSync(f, 'utf8');
    // UNION (review LOW): a tool result is produced where `executeTool` is
    // called, AND wherever the transform is applied — `bootstrap/nodes.ts` is
    // the second without being the first.
    return s.includes('executeTool') || s.includes('applyToolResultTransform');
  })
  .map((f) => f.slice(SRC.length + 1));

describe('ADR 0604 — every tool-loop caller is classified for compaction', () => {
  it('found the call sites at all (anti-vacuity)', () => {
    // A broken walk or a renamed seam would return [] and make every assertion
    // below vacuously true — the exact shape of the gate this file replaces.
    expect(callers).toContain('host/agentDispatch.ts');
    expect(callers).toContain('host/conversationToolLoop.ts');
    expect(callers).toContain('features/voice/realtime/toolBridge.ts');
    expect(callers.length).toBeGreaterThan(8);
  });

  it('NO unclassified caller — a new model-driving path must fail here', () => {
    const unclassified = callers.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      'a new `runChatToolLoop` / `applyToolResultTransform` caller appeared. Classify it in CLASSIFIED: ' +
        'MUST_SUPPLY (hand the loop a run-start-frozen compaction decision), APPLIES (it is the seam), ' +
        'or EXEMPT (say why — "no run to freeze a decision on" is the only reason that has held so far).',
    ).toEqual([]);
  });

  it('every MUST_SUPPLY caller actually passes a compaction decision', () => {
    const musts = Object.entries(CLASSIFIED).filter(([, v]) => v.kind === 'MUST_SUPPLY');
    expect(musts.length, 'the loop below is vacuous with no MUST_SUPPLY rows').toBeGreaterThanOrEqual(3);
    for (const [file, v] of musts) {
      // COMMENTS STRIPPED (ADR 0604 review): every file here carries a docblock
      // about compaction, so an un-stripped read lets the prose satisfy the grep.
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      expect(code, `${file} is MUST_SUPPLY but never mentions compaction in CODE`).toMatch(/compaction/);
      // The spelling that actually reaches `ChatToolLoopOpts` / the request —
      // a file could name `compaction` and pass nothing.
      expect(code, `${file} names compaction but never puts it on the loop options`).toMatch(
        /compaction\s*\?\s*\{\s*compaction|compaction:\s*\w/,
      );
      // …and the value must come from the DECLARED source. Without this, the
      // key-presence check above passes on `const compaction = undefined` with
      // the spread left intact — a key written, no decision supplied.
      expect(v.decisionSource, `${file} is MUST_SUPPLY with no declared decisionSource`).toBeInstanceOf(RegExp);
      expect(code, `${file} writes a compaction key that does not come from ${String(v.decisionSource)}`)
        .toMatch(v.decisionSource!);
    }
  });

  it('every EXEMPT row states a reason (an exemption with no mechanism is a hole)', () => {
    for (const [file, v] of Object.entries(CLASSIFIED)) {
      if (v.kind !== 'EXEMPT') continue;
      expect(v.why.length, `${file} is EXEMPT with no stated reason`).toBeGreaterThan(60);
    }
  });

  it('the classification is not stale — every row still touches the seam', () => {
    for (const file of Object.keys(CLASSIFIED)) {
      expect(callers, `${file} is classified but no longer touches the seam — remove the row`).toContain(file);
    }
  });
});
