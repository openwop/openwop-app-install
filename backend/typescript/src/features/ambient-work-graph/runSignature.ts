/**
 * ADR 0137 Phase 1 — the PURE run-signature + recurrence clustering.
 *
 * A run's signature is its agent + the consecutive-deduped ordered sequence of tool
 * NAMES (no args/content → privacy-safe). `clusterAndDetect` groups ONE owner's runs by
 * exact signature and emits a WorkflowSuggestion for each pattern seen ≥ minCount times
 * (ADR 0930 D1 — clustering never crosses owners). The suggestionId is a deterministic
 * hash of tenantId+owner+signature so a re-sweep upserts the same row (idempotent).
 *
 * @see docs/adr/0137-ambient-work-graph.md
 * @see docs/adr/0930-ambient-work-graph-per-owner.md
 */
import { createHash } from 'node:crypto';
import type { RunSignatureInput, WorkflowSuggestion } from './types.js';

const EXAMPLE_CAP = 10;

/** Collapse consecutive repeats: [a,a,b,a] → [a,b,a] (keeps order; the pattern shape). */
function dedupeConsecutive(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) if (out[out.length - 1] !== n) out.push(n);
  return out;
}


/** The work-pattern signature for one run, or null when it called no tools (nothing to
 *  cluster — a chat-only turn isn't a "workflow"). */
export function computeRunSignature(input: RunSignatureInput): { signature: string; toolSequence: string[] } | null {
  const toolSequence = dedupeConsecutive(input.toolNames.filter((n) => n.length > 0));
  if (toolSequence.length === 0) return null;
  return { signature: `${input.agentId ?? 'none'}|${toolSequence.join('>')}`, toolSequence };
}

/** ADR 0930 A7 — 96 bits of sha256. The store's keyspace is global, and the 32-bit djb2
 *  this replaced made birthday collisions plausible once rows were per owner. */
export function suggestionIdFor(tenantId: string, ownerKey: string, signature: string): string {
  return `ws-${createHash('sha256').update(`${tenantId}\u0000${ownerKey}\u0000${signature}`, 'utf8').digest('hex').slice(0, 24)}`;
}

/** Group ONE owner's runs by exact signature; emit a suggestion per pattern seen ≥
 *  minCount times. Inputs under any other owner key are ignored, never merged. */
export function clusterAndDetect(
  tenantId: string,
  ownerKey: string,
  inputs: readonly RunSignatureInput[],
  opts: { minCount: number },
): WorkflowSuggestion[] {
  const groups = new Map<string, { toolSequence: string[]; runs: RunSignatureInput[] }>();
  for (const input of inputs) {
    if (input.ownerKey !== ownerKey) continue;
    const sig = computeRunSignature(input);
    if (!sig) continue;
    const g = groups.get(sig.signature) ?? { toolSequence: sig.toolSequence, runs: [] };
    g.runs.push(input);
    groups.set(sig.signature, g);
  }
  const out: WorkflowSuggestion[] = [];
  for (const [signature, g] of groups) {
    if (g.runs.length < opts.minCount) continue;
    const sorted = [...g.runs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const latest = sorted[sorted.length - 1]!;
    out.push({
      suggestionId: suggestionIdFor(tenantId, ownerKey, signature),
      tenantId,
      ownerPrincipal: ownerKey,
      signature,
      toolSequence: g.toolSequence,
      count: g.runs.length,
      exampleRunIds: sorted.slice(-EXAMPLE_CAP).map((r) => r.runId),
      ...(latest.goal ? { sampleGoal: latest.goal } : {}),
      status: 'suggested',
      firstSeenAt: sorted[0]!.createdAt,
      lastSeenAt: latest.createdAt,
    });
  }
  return out;
}
