/**
 * ADR 0137 Phase 1 — the PURE run-signature + recurrence clustering.
 *
 * A run's signature is its agent + the consecutive-deduped ordered sequence of tool
 * NAMES (no args/content → privacy-safe). `clusterAndDetect` groups runs by exact
 * signature and emits a WorkflowSuggestion for each pattern seen ≥ minCount times. The
 * suggestionId is a deterministic hash of tenantId+signature so a re-sweep upserts the
 * same row (idempotent) rather than duplicating it.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import type { RunSignatureInput, WorkflowSuggestion } from './types.js';

const EXAMPLE_CAP = 10;

/** Collapse consecutive repeats: [a,a,b,a] → [a,b,a] (keeps order; the pattern shape). */
function dedupeConsecutive(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/** A stable, non-crypto string hash → base36 (deterministic suggestion id). */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The work-pattern signature for one run, or null when it called no tools (nothing to
 *  cluster — a chat-only turn isn't a "workflow"). */
export function computeRunSignature(input: RunSignatureInput): { signature: string; toolSequence: string[] } | null {
  const toolSequence = dedupeConsecutive(input.toolNames.filter((n) => n.length > 0));
  if (toolSequence.length === 0) return null;
  return { signature: `${input.agentId ?? 'none'}|${toolSequence.join('>')}`, toolSequence };
}

export function suggestionIdFor(tenantId: string, signature: string): string {
  return `ws-${stableHash(`${tenantId}:${signature}`)}`;
}

/** Group runs by exact signature; emit a suggestion per pattern seen ≥ minCount times. */
export function clusterAndDetect(
  tenantId: string,
  inputs: readonly RunSignatureInput[],
  opts: { minCount: number },
): WorkflowSuggestion[] {
  const groups = new Map<string, { toolSequence: string[]; runs: RunSignatureInput[] }>();
  for (const input of inputs) {
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
      suggestionId: suggestionIdFor(tenantId, signature),
      tenantId,
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
