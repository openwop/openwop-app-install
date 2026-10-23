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
 *
 * Round 2 (8fw1g4) made all three cases BEHAVIOURAL. They used to grep source
 * text, and case 3 was vacuous for its own claim: `'replay_source_missing'` also
 * occurs in a COMMENT in runEffectContext.ts, so changing the guard's real code
 * stayed green (probe sup-guardcode). Now the cases read the BUILT v2 document
 * and drive the real guard + classifier. Sabotages that red it: stating a
 * `sideEffectSuppression` key on the replay record, changing the advertised
 * modes, changing the guard error's code / not throwing in a replay, and
 * dropping either classification path (the derived manifest set or the hand
 * patterns) from `isSideEffectingNode`.
 */

import { describe, expect, it } from 'vitest';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import type { AppConfig } from '../src/index.js';
import { runWithEffectContext, assertEffectAllowed } from '../src/host/runEffectContext.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';

const CONFIG: AppConfig = {
  port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
};

describe('RFC 0140 — the replay side-effect-suppression advertisement', () => {
  // ADR 0812 P4 deleted the v1 discovery document, which was the only place
  // this host stated `sideEffectSuppression` (last value: `none`, withdrawn from
  // `recorded-outcome` 2026-08-15 per the docblock above). v2 deleted the field
  // outright (capabilities.md §Deleted fields): v2 `replay` is a family record.
  // So the pin moves from "the value is `none`" to "no value is stated at all",
  // and restoring `recorded-outcome` still means deleting this test.
  it('states no suppression level, and never `recorded-outcome`', () => {
    const doc = buildV2Advertisement(CONFIG);
    const replay = doc['replay'];
    expect(replay, 'the replay record must exist for the absence below to mean anything').toBeTypeOf('object');
    expect(replay !== null && typeof replay === 'object' ? Object.keys(replay) : []).not.toContain('sideEffectSuppression');
    expect(JSON.stringify(doc)).not.toContain('sideEffectSuppression');
    expect(JSON.stringify(doc)).not.toContain('recorded-outcome');
  });

  it('the v2 replay family is present, so the absence above is not vacuous', () => {
    // If the builder stopped emitting the family, the negative assertions above
    // would pass against a document with no replay record at all.
    const doc = buildV2Advertisement(CONFIG);
    expect(doc['replay']).toMatchObject({ status: 'experimental', modes: ['replay', 'branch'] });
  });

  it('the runtime guards the advert used to rest on are STILL present', () => {
    // The load-bearing assertion. Withdrawing the claim must not be mistaken
    // for — or quietly become — removing the protection. If someone reads
    // `none` as "suppression is off" and deletes a seam, this goes red.
    let thrown: unknown;
    runWithEffectContext({ runId: 'sup-replay', replaying: true }, () => {
      try { assertEffectAllowed('notification', 'sup-probe'); } catch (err) { thrown = err; }
    });
    expect(thrown, 'a replay reached an effect seam and the guard did not throw').toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ code: 'replay_source_missing', effectKind: 'notification' });
    // Positive control: outside a replay the same seam is a no-op.
    expect(() => runWithEffectContext({ runId: 'sup-live', replaying: false }, () => assertEffectAllowed('notification')))
      .not.toThrow();

    // ADR 0572 P3 — the DERIVED half (manifest floor), now the primary mechanism.
    // `ads.image.generate` is served ONLY by the manifest set (no hand pattern).
    // Deleting that path would silently return pack nodes to hand-list-only protection.
    expect(MANIFEST_FAST_PATH_SERVED.has('ads.image.generate'), 'fixture: pick another manifest-only type').toBe(true);
    expect(isSideEffectingNode('ads.image.generate')).toBe(true);
    // …and the hand-listed half: `feature.notifications.nodes.notify` is matched ONLY
    // by SIDE_EFFECTING_TYPE_PATTERNS (absent from the manifest set).
    expect(MANIFEST_FAST_PATH_SERVED.has('feature.notifications.nodes.notify'), 'fixture: pick another pattern-only type').toBe(false);
    expect(isSideEffectingNode('feature.notifications.nodes.notify')).toBe(true);
    // Negative control: a pure node is not classified.
    expect(isSideEffectingNode('core.noop')).toBe(false);
  });
});
