/**
 * ADR 0989 — the conformance-reserved memory tool `conformance.eval:memory`
 * (`conformance/fixtures.md` §Eval-suite fixtures, RFC 0244 §B / G3).
 *
 * It exists so the suite can OBSERVE trial isolation. Every call is answered from
 * the CURRENT trial's eval memory: the store `fixtures.memorySeed` seeds and the
 * agent's own writes land in. That is the per-trial port `ephemeralMemory()`
 * builds, the same factory the agent lane hands to dispatch, so the tool reads
 * the store trials really use (the contract forbids any other).
 *
 * It is never served from `toolResponses`, never a fixture miss, and reaches
 * nothing outside the trial, so it has no external effect. The door to it is
 * opened ONLY for a fixture-sourced suite (ADR 0977 D2, `agentEvalRun.ts`).
 */
import type { EphemeralMemory } from './agentEvalRun.js';

export const MEMORY_TOOL = 'conformance.eval:memory';

/** The scope the tool writes under; reads by `id` see every scope. */
export const MEMORY_TOOL_SCOPE = 'conformance.eval';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type MemoryToolResult =
  | { ok: true; value: { id: string } | { id: string; content: string | null } }
  | { ok: false; code: 'invalid_memory_input'; message: string };

/** Answer one memory call from `memory`. Never throws for bad input. */
export async function runMemoryTool(memory: EphemeralMemory, input: Record<string, unknown>): Promise<MemoryToolResult> {
  const { op, id, content } = input;
  if (typeof id !== 'string' || !ID.test(id) || (op !== 'read' && op !== 'write') || (op === 'write' && typeof content !== 'string')) {
    return { ok: false, code: 'invalid_memory_input', message: 'memory input must be {op: "read", id} or {op: "write", id, content: string}' };
  }
  if (op === 'write') {
    await memory.write(MEMORY_TOOL_SCOPE, { id, content: content as string });
    return { ok: true, value: { id } };
  }
  return { ok: true, value: { id, content: memory.get(id)?.content ?? null } };
}
