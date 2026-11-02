/**
 * ADR 1001 D3.1 — the continuation checkpoint of an agent turn paused on a
 * clarification.
 *
 * A re-invoke resume re-runs the agent node from the top. Without this, every
 * tool call and provider call before the ask would run again. The node saves
 * what it needs to CONTINUE instead: the transcript after the first message,
 * the round, the lifted questions (to rebuild the interrupt key and read the
 * answer), and the effect-ordinal cursor (D3.3).
 *
 * What is NOT here, by design (ADR 1001 D3.4, review B2): the first message.
 * It carries borrowed twin recall, memory and context blocks, and those must
 * re-resolve live on every resume so a revoked grant holds
 * (`agentRunnerNode.ts`, "That live re-read is WHY revocation holds").
 *
 * Server-only (never in interrupt `data`, which every responder reads). One
 * host_ext_kv row per (run, node, round) under the prefix the storage adapters
 * delete on every run-delete path (`storage/runKvKeys.ts`).
 */
import type { AiCallMessage } from '../executor/types.js';
import type { Storage } from '../storage/storage.js';
import { CLARIFICATION_CHECKPOINT_PREFIX } from '../storage/runKvKeys.js';
import type { LiftedQuestion } from './clarificationLift.js';

/** Over this, the ask is refused to the model instead of paused (D3.1). */
export const CLARIFICATION_CHECKPOINT_MAX_BYTES = 256 * 1024;

export interface ClarificationCheckpoint {
  v: 1;
  tenantId: string;
  runId: string;
  nodeId: string;
  /** 1-based round this checkpoint pauses on. */
  round: number;
  /** The loop's messages AFTER `messages[0]`, up to and including the ask. */
  transcriptTail: AiCallMessage[];
  questions: LiftedQuestion[];
  questionsDigest: string;
  /** `peekNodeActivityOrdinal` at the pause (D3.3). */
  ordinalCursor: number;
  /** The wire data's `contextType`, so a re-raise is byte-identical. */
  contextType?: string;
  /** D4 — the approvers the ask was restricted to, so a re-raise keeps them. */
  approverRefs?: string[];
  /** The asking agent's display name, so a re-raise keeps the card's header. */
  askedBy?: string;
  /** D4 — the ask was written from untrusted context (sticky across rounds). */
  untrusted?: boolean;
  createdAt: string;
}

function nodeSegment(nodeId: string): string {
  return encodeURIComponent(nodeId);
}

/** Zero-padded so a key-ordered list is round-ordered. */
export function clarificationCheckpointKey(runId: string, nodeId: string, round: number): string {
  return `${CLARIFICATION_CHECKPOINT_PREFIX}${runId}:${nodeSegment(nodeId)}:${String(round).padStart(3, '0')}`;
}

export type SaveCheckpointResult = { ok: true } | { ok: false; reason: 'too_large' };

export async function saveClarificationCheckpoint(storage: Storage, cp: ClarificationCheckpoint): Promise<SaveCheckpointResult> {
  const body = JSON.stringify(cp);
  if (Buffer.byteLength(body, 'utf8') > CLARIFICATION_CHECKPOINT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  await storage.kvSet(clarificationCheckpointKey(cp.runId, cp.nodeId, cp.round), body);
  return { ok: true };
}

function parse(raw: string, tenantId: string, runId: string, nodeId: string): ClarificationCheckpoint | null {
  try {
    const cp = JSON.parse(raw) as ClarificationCheckpoint;
    // A row is only ever read back by the run and node that wrote it; anything
    // else (a tampered or mis-keyed row) is treated as absent.
    if (cp?.v !== 1 || cp.tenantId !== tenantId || cp.runId !== runId || cp.nodeId !== nodeId) return null;
    if (!Number.isInteger(cp.round) || cp.round < 1 || !Array.isArray(cp.transcriptTail) || !Array.isArray(cp.questions)) return null;
    return cp;
  } catch {
    return null;
  }
}

/** The newest checkpoint this run wrote for this node, or null. */
export async function latestClarificationCheckpoint(
  storage: Storage,
  scope: { tenantId: string; runId: string; nodeId: string },
): Promise<ClarificationCheckpoint | null> {
  const prefix = `${CLARIFICATION_CHECKPOINT_PREFIX}${scope.runId}:${nodeSegment(scope.nodeId)}:`;
  const rows = [...await storage.kvList(prefix)].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const cp = parse(rows[i]!.value, scope.tenantId, scope.runId, scope.nodeId);
    if (cp) return cp;
  }
  return null;
}
