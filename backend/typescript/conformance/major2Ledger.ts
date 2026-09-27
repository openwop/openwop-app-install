/**
 * The v2 FAMILY records this host does not declare at target major 2, stated as an
 * honest opt-out so a `--certify` run at major 2 records them
 * `skipped (operator declared an honest opt-out)` instead of `executed-fail`.
 *
 * RFC 0148 §B: a host MUST NOT both advertise and opt out — the two are
 * contradictory claims and a reader cannot tell which one is true.
 *
 * WHY THIS IS ITS OWN MODULE, and it is the whole point of the file.
 *
 * The docblock this text replaces asserted that the list "is checked against the
 * served v2 root by the certify lane". IT WAS NOT. There was no such check
 * anywhere: `agrade-wire-blocked-residue.test.ts` has the right SHAPE for it
 * (advert and opt-out must move together) but iterates `HONESTY_PAIRS`, which is
 * EMPTY and whose own guard test says an empty set is correct today. So the
 * sentence described a mechanism that did not exist, and the contradiction it
 * claimed to prevent shipped: `family.idempotency` was advertised on the v2 root
 * in one commit while staying on this ledger, and the lane stayed green until the
 * corpus caught it at suite time (`v2-effect-identity-business-key`, suite 2.0.3).
 *
 * A ledger cross-check cannot live in `run.ts`, which calls `main()` at top level
 * and so cannot be imported by a test. That is why the false claim was easy to
 * make and impossible to keep: the list was unreachable from the only place that
 * could have verified it. Hence this module — the list is now importable, and
 * `test/major2-undeclared-ledger.test.ts` derives the other side from
 * `buildV2Advertisement()` and fails on any overlap.
 *
 * An entry here is a TODO ledger, never a licence to ignore the surface. Applies
 * ONLY when the lane runs at major 2; at major 1 every one of these capabilities
 * is advertised and exercised.
 */
export const MAJOR2_UNDECLARED_FAMILIES = [
  // (`family.replay` REMOVED 2026-09-06, ADR 0637. Its condition was that this
  //  host answered 501 to a mid-sequence replay fork; that 501 is gone and
  //  `replay-fork-arbitrary` passes all three legs. Advertised on the v2 root in
  //  the SAME commit — which the ledger cross-check requires.)
  // (`family.idempotency` REMOVED 2026-09-05. Its stated removal condition was
  //  "GET /runs/{id}/effects lands with the seams work", and that landed: the
  //  RFC 0173 §C.2 effects projection ships in `routes/runs.ts` with a
  //  deterministic per-attempt `effectId`, and the v2 root advertises the family.
  //  The row outliving the work is what produced the RFC 0148 §B contradiction.)
  // (TWO entries REMOVED 2026-09-13, ADR 0670: `family.feedback` and
  //  `family.workflowChainPacks`. It was going to be five. Each of the five
  //  carried the reason "no closed v2 record declared yet", and MEASURED that
  //  reason was stale —
  //  `schemas/v2/capabilities.schema.json` declares all five, and this host has
  //  served every one of the behaviours at major 1 all along. They are now
  //  advertised on the v2 root in this SAME commit, which is what the RFC 0148
  //  §B cross-check requires and what the `family.idempotency` incident above
  //  is a record of failing to do.
  //
  //  Worth stating plainly, because this file's own docblock is about exactly
  //  this: the entries were right when written and their REASONS rotted. A
  //  ledger row justified by a fact about someone else's repo needs re-reading
  //  when that repo moves, and nothing here made that happen.)
  // THE OTHER THREE STAYED, with their reasons REPLACED rather than removed.
  // Declaring a family UN-SKIPS the scenarios gated on it, and these three then
  // executed for the first time and FAILED. The ledger rows were right; their
  // stated reasons were not. That distinction is the whole lesson here — I read
  // a stale justification and concluded the DECISION was stale too.
  'family.compensation',           // MEASURED 2026-09-13 via `v2-compensation-read-projection`:
                                   // "a host advertising `compensation` MUST serve GET /runs/{runId}/compensation"
                                   // (security-defaults.md §Compensation). This host does not serve that route.
  'family.forms',                  // MEASURED via `v2-form-when-reuses-edge-conditions`: a field carrying
                                   // `when: { type: "equals", left, right }` is not honoured
                                   // (form-content-packs.md §"Conditional visibility", RFC 0177 §E.4).
  'connections.packsSupported',    // MEASURED via `v2-provider-conflict`: "the later registration of a bare
                                   // provider id MUST NOT install over the qualified form"
                                   // (connection-packs.md §"Provider identity", RFC 0177 §D.1).
  'family.sandbox',                // sandbox.isolationModel — the pack sandbox names no v2 isolation model. STILL TRUE:
                                   // measured 2026-09-13, `sandbox` is absent from this host's v1 document too, so
                                   // there is no behaviour to declare. This one is an honest opt-out, not a stale row.
];
