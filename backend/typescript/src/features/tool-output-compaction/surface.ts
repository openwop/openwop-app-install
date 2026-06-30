/**
 * ADR 0099 Phase 3 — `ctx.features['tool-output-compaction']` workflow surface
 * (ADR 0014). One method: `compact`, a deterministic pure transform over an
 * input string, running the SAME kernel as the automatic tool-result boundary
 * (one implementation). Lets a workflow author compact a large payload mid-graph
 * explicitly, and lets a pack that hand-rolls its own tool loop compact its
 * results (closing the Phase-1 residual) — no separate `ctx.compactToolOutput`
 * core field needed.
 *
 * Toggle-gated by `host/featureSurfaces.ts` (throws `host_capability_disabled`
 * when the tenant toggle is OFF — the EXPLICIT node hard-fails, unlike the
 * automatic boundary which fails open; intentional, ADR 0099 §gate-asymmetry).
 * Pure + side-effect-free ⇒ recorded node output is replay-safe.
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { compactToolOutput } from './compact.js';
import type { CompactionDecision } from '../../executor/types.js';

function parseMode(v: string | undefined): CompactionDecision['mode'] {
  return v === 'lossy' || v === 'off' ? v : 'lossless';
}
function parseNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function buildToolOutputCompactionSurface(_scope: BundleScope): FeatureSurface {
  return {
    /**
     * Compact a tool-output string. `mode` defaults to `lossless`; `lossy`
     * elides long arrays (head/tail). Non-JSON input is returned untouched.
     * Returns the output plus before/after char counts for visibility.
     */
    compact: async (args) => {
      const input = str(args.input);
      const decision: CompactionDecision = { mode: parseMode(optStr(args.mode)) };
      const head = parseNum(args.head);
      const tail = parseNum(args.tail);
      const minChars = parseNum(args.minChars);
      if (head !== undefined) decision.head = head;
      if (tail !== undefined) decision.tail = tail;
      if (minChars !== undefined) decision.minChars = minChars;
      const output = compactToolOutput(input, decision);
      return {
        output,
        mode: decision.mode,
        originalChars: input.length,
        compactedChars: output.length,
      };
    },
  };
}
