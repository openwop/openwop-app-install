/**
 * RFC 0140 — what this host advertises for `replay.sideEffectSuppression`, and
 * why it is currently `none`.
 *
 * The value was `recorded-outcome` and is WITHDRAWN (ADR 0572's ruling note,
 * upstream #999 / suite 1.104.0). Nothing about the runtime got weaker: both the
 * ADR 0341 fast path and the ADR 0531 seam guards are still in place and nothing
 * escapes a replay. What changed is the reading of the requirement — requirements
 * 1 and 2 are two obligations, a guarded seam discharges "do not perform" and
 * NOT "resolve the outcome", so a throw-only path is **safe and non-conformant**.
 *
 * WHY THIS FILE EXISTS AT ALL. Before this, `sideEffectSuppression` was
 * advertised on the wire with **no test anywhere pinning its value** — grep
 * `test/` for the field and it returned nothing. So the strongest replay claim
 * this host made could have changed in either direction, silently. That is the
 * same shape as the ADR 0533 tripwire that scanned for the wrong syntax: an
 * assurance nobody could observe breaking.
 *
 * Restoring `recorded-outcome` should therefore require deleting a test that
 * says, in words, why it was withdrawn — not editing a string.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCOVERY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'discovery.ts');

describe('RFC 0140 — the replay side-effect-suppression advertisement', () => {
  // ADR 0812 P4 deleted the v1 discovery document, which was the only place
  // this host stated `sideEffectSuppression` (last value: `none`, withdrawn from
  // `recorded-outcome` 2026-08-15 per the docblock above). v2 deleted the field
  // outright (capabilities.md §Deleted fields): v2 `replay` is a family record.
  // So the pin moves from "the value is `none`" to "no value is stated at all",
  // and restoring `recorded-outcome` still means deleting this test.
  it('states no suppression level, and never `recorded-outcome`', () => {
    const src = readFileSync(DISCOVERY, 'utf8');
    // Match an object-literal KEY, not prose (comments may name the field).
    expect(src).not.toMatch(/^\s*sideEffectSuppression:/m);
    expect(src).not.toMatch(/^\s*[a-zA-Z]+:\s*'recorded-outcome'/m);
  });

  it('the v2 replay family is present, so the absence above is not vacuous', () => {
    // If the builder moved out of this file, the two negative assertions above
    // would pass against an unrelated file. Pin the family they are about.
    const src = readFileSync(DISCOVERY, 'utf8');
    expect(src).toMatch(/^\s*replay: \{$/m);
    expect(src).toContain('modes: [...FORK_MODES]');
    expect(src).toContain("effectSeamsManifest: V2_EFFECT_SEAMS_PATH");
  });

  it('the runtime guards the advert used to rest on are STILL present', () => {
    // The load-bearing assertion. Withdrawing the claim must not be mistaken
    // for — or quietly become — removing the protection. If someone reads
    // `none` as "suppression is off" and deletes a seam, this goes red.
    const guard = readFileSync(join(dirname(DISCOVERY), '..', 'host', 'runEffectContext.ts'), 'utf8');
    expect(guard).toContain('replay_source_missing');
    const classifier = readFileSync(join(dirname(DISCOVERY), '..', 'executor', 'sideEffects.ts'), 'utf8');
    expect(classifier).toContain('SIDE_EFFECTING_TYPE_PATTERNS');
    // ADR 0572 P3 — and the DERIVED half, which is now the primary mechanism.
    // Deleting it would silently return 196 pack nodes to hand-list-only
    // protection, which is the drift requirement 4 exists to stop.
    expect(classifier).toContain('MANIFEST_FAST_PATH_SERVED.has(typeId)');
  });
});
