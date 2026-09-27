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
import { OpenwopError } from '../../types.js';
import { compactToolOutput } from './compact.js';
import type { CompactionDecision } from '../../executor/types.js';

const MODES = ['off', 'lossless', 'lossy'] as const;

/**
 * ADR 0680 D1a — refuse an unrecognised mode instead of defaulting to `lossless`.
 *
 * This used to be `v === 'lossy' || v === 'off' ? v : 'lossless'`, which mapped ANY
 * unrecognised string to `lossless`. The filed row probed only the harmless direction (a
 * failed *upgrade*, which safely degrades). MEASURED, the direction that matters:
 * `'Off'`, `'OFF'` and `' off'` all resolved to `lossless` — so a caller who explicitly asked
 * to leave a payload alone silently got it rewritten.
 *
 * What that costs is NOT "a saving was applied". `lossless` deletes insignificant whitespace
 * and changes no other byte, so on tool output it costs nothing. But this lane takes a
 * CALLER-SUPPLIED string (see the `compact` docblock below), where `off` means **"do not touch
 * my bytes"** — the guarantee a caller hashing, signing or diffing a payload depends on. A
 * DOWNGRADE to lossless loses only savings; an UPGRADE from `off` loses that guarantee.
 *
 * Case-insensitive after trimming, because the same slip is the one that produced the defect.
 * The legal values are published in `schemas/compact.input.json` (D1b) — the enum has to exist
 * before the refusal does, since the Workflow Architect authors configs for this node from the
 * manifest and nothing validates config on the authoring path.
 */
function parseMode(v: string | undefined): CompactionDecision['mode'] {
  if (v === undefined) return 'lossless';
  const norm = v.trim().toLowerCase();
  const hit = MODES.find((m) => m === norm);
  if (hit) return hit;
  throw new OpenwopError(
    'validation_error',
    `unknown compaction mode ${JSON.stringify(v)} — expected one of ${MODES.join(', ')}. `
    + 'A misspelled mode is NOT defaulted, because silently substituting `lossless` for a failed '
    + '`off` rewrites bytes the caller asked to keep (ADR 0680 D1a).',
    400,
  );
}

/**
 * ADR 0680 D1c — the same shape as `parseMode`, two lines away, and the reason the class is
 * fixed rather than the instance. This used to return `undefined` for `head:"20"`, `head:3.5`
 * or `head:-1`, after which `compact.ts` substitutes DEFAULT_HEAD/DEFAULT_TAIL — so the caller
 * got **a different elision than it asked for, reported as success**.
 *
 * NOT the shared `surfaceOptCount` (`host/featureSurfaces.ts`), which is the helper built for
 * this class under ADR 0602/`NBWF-1`: it requires `>= 1`, and `head`/`tail` legitimately accept
 * **0** (keep no leading elements — tail-only elision). Swapping it in verbatim would refuse a
 * legal value, so this mirrors its posture with the floor this surface actually has. The floor
 * is published in the input schema as `minimum: 0`.
 */
function parseCount(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new OpenwopError(
    'validation_error',
    `\`${field}\` expected a whole number >= 0, received ${typeof v === 'number' ? String(v) : `${typeof v} ${JSON.stringify(v)}`}`
    + ' — a count arg is not coerced, because a wrong-sized result returned as a success is the defect ADR 0602 closed.',
    400,
  );
}

export function buildToolOutputCompactionSurface(_scope: BundleScope): FeatureSurface {
  return {
    /**
     * Compact a tool-output string. `mode` defaults to `lossless`, which
     * DELETES INSIGNIFICANT WHITESPACE from the source text and changes no other
     * byte (ADR 0604 review H2 — this lane takes a CALLER-SUPPLIED string, so
     * the byte-level guarantee is the one that matters here). `lossy`
     * re-serialises, drops structurally-empty fields (disclosed as `_emptied`)
     * and elides long arrays (`_elided`). Non-JSON input is returned untouched.
     * Returns the output plus before/after char counts for visibility.
     */
    compact: async (args) => {
      const input = str(args.input);
      const decision: CompactionDecision = { mode: parseMode(optStr(args.mode)) };
      const head = parseCount(args.head, 'head');
      const tail = parseCount(args.tail, 'tail');
      const minChars = parseCount(args.minChars, 'minChars');
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
