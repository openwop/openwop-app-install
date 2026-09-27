/**
 * ADR 0477 §3 — the LLM-judge assertion evaluator. A HEADLESS one-shot model
 * call through the ADR 0110 resolver (`resolveHeadlessAi`) — the single owner
 * of "which provider does a headless op dispatch to" (managed-if-capable →
 * tenant BYOK default → null). Runs OUTSIDE any recorded run (verdicts land
 * in eval-result rows, never run events — the ADR 0110 replay caveat holds).
 *
 * Exchange rules (LLM-EXCHANGE-AUDIT rowed):
 *  - the judge sees ONLY the rubric + a size-capped output excerpt — never
 *    pins, inputs, or tenant state;
 *  - the verdict is parsed CLOSED-WORLD (`{"pass": bool, "reason": string}`
 *    extracted from the first JSON object in the reply); unparseable ⇒
 *    `judge_error`, counted as FAILED with the raw-shape reason visible —
 *    never success-with-empty;
 *  - no provider resolves ⇒ `judge_unavailable`, counted as FAILED with the
 *    named reason (an assertion you cannot evaluate is not passing);
 *  - ONE bounded retry on transport error.
 */

import { resolveHeadlessAi } from './headlessAi.js';
import type { EvalJudge } from './workflowEvalRunner.js';

const JUDGE_OUTPUT_EXCERPT_CHARS = 6000;
const JUDGE_MAX_TOKENS = 300;
const JUDGE_TIMEOUT_MS = 30_000;

function excerptOutput(output: unknown): string {
  const json = JSON.stringify(output ?? null, null, 1);
  return json.length > JUDGE_OUTPUT_EXCERPT_CHARS
    ? `${json.slice(0, JUDGE_OUTPUT_EXCERPT_CHARS)}\n…(truncated)`
    : json;
}

function parseVerdict(reply: string): { pass: boolean; score?: number; reason: string } | null {
  const start = reply.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching close brace of the FIRST object (judges often wrap
  // JSON in prose/code fences; trailing text must not break the parse).
  let depth = 0;
  for (let i = start; i < reply.length; i += 1) {
    if (reply[i] === '{') depth += 1;
    else if (reply[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const obj = JSON.parse(reply.slice(start, i + 1)) as Record<string, unknown>;
          if (typeof obj.pass !== 'boolean') return null;
          return {
            pass: obj.pass,
            ...(typeof obj.score === 'number' && obj.score >= 0 && obj.score <= 1 ? { score: obj.score } : {}),
            reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 400) : '',
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The judge, bound to the caller's tenant (the runner treats every failure
 *  as a FAILED assertion with the reason visible — ADR 0477 §3). */
export function tenantEvalJudge(tenantId: string): EvalJudge {
  return async ({ criteria, output, threshold }) => {
    const dispatch = await resolveHeadlessAi(tenantId, 'text');
    if (!dispatch) {
      return { pass: false, detail: 'judge_unavailable: no managed or tenant-default AI provider is configured (Settings → AI defaults)' };
    }
    const messages = [
      {
        role: 'system' as const,
        content:
          'You are an evaluation judge for workflow outputs. Judge ONLY against the stated criteria. '
          + 'Reply with EXACTLY one JSON object: {"pass": true|false, "score": 0..1, "reason": "<one sentence>"} and nothing else.',
      },
      {
        role: 'user' as const,
        content: `Criteria: ${criteria}\n\nWorkflow output (JSON):\n${excerptOutput(output)}`,
      },
    ];
    let reply: string;
    try {
      reply = await dispatch(messages, { maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS });
    } catch {
      // ONE bounded retry on transport error, then an honest failure.
      try {
        reply = await dispatch(messages, { maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS });
      } catch (err2) {
        return { pass: false, detail: `judge_error: dispatch failed (${err2 instanceof Error ? err2.message : String(err2)})` };
      }
    }
    const verdict = parseVerdict(reply);
    if (!verdict) {
      return { pass: false, detail: `judge_error: unparseable verdict (${reply.slice(0, 120)})` };
    }
    if (threshold !== undefined && verdict.score !== undefined) {
      const pass = verdict.score >= threshold;
      return { pass, detail: `judge: score ${verdict.score} ${pass ? '≥' : '<'} threshold ${threshold} — ${verdict.reason}` };
    }
    // Grade-code L8 — when a threshold was configured but the judge returned
    // no score, the verdict silently degraded to the boolean; DISCLOSE that
    // the threshold could not be applied.
    const thresholdNote = threshold !== undefined ? ` (threshold ${threshold} not applied — judge returned no score)` : '';
    return { pass: verdict.pass, detail: `judge: ${verdict.reason || (verdict.pass ? 'criteria met' : 'criteria not met')}${thresholdNote}` };
  };
}
