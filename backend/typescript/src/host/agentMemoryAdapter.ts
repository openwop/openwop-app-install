/**
 * Per-agent memory adapter — back-compat shim (ADR 0041).
 *
 * The memory port + namespace now live in `host/subjectMemory.ts`, the single
 * owner that serves BOTH agents (`agent:<id>`) and humans (`user:<id>`). This
 * module re-exports the agent specialization so every pre-existing importer
 * (dispatch, the `agent-knowledge` feature, the advisory board, agent routes)
 * keeps the same symbols with IDENTICAL behavior — the no-fork guarantee.
 *
 * Originally A4/A5 (RFC 0004 + RAG); see `subjectMemory.ts` for the contract.
 *
 * @see docs/adr/0041-subject-memory.md
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 */

import { subjectMemoryScope, createSubjectMemoryPort, countSubjectMemoryByTag } from './subjectMemory.js';

/** Stable per-agent memory namespace within a tenant — `agent:<id>`, the agent
 *  specialization of `subjectMemoryScope`. */
export function agentMemoryScope(agentId: string): string {
  return subjectMemoryScope({ kind: 'agent', id: agentId });
}

/** Build an `AgentMemoryPort` bound to one tenant (the dispatch read/write port). */
export const createAgentMemoryPort = createSubjectMemoryPort;

/** Count entries in a scope carrying `tag` (tenant-scoped, tag-aware). */
export function countAgentMemoryByTag(tenantId: string, scope: string, tag: string): number {
  return countSubjectMemoryByTag(tenantId, scope, tag);
}
