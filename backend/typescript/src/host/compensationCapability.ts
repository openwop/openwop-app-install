/**
 * RFC 0151 §A — the SINGLE SOURCE OF TRUTH for what this host claims about
 * compensation, and for the two runtime constants that claim is made of.
 *
 * WHY THIS MODULE EXISTS, rather than a literal in `routes/discovery.ts`.
 * `compensation.md` §D makes the advert and `RunSnapshot.compensationStatus` a
 * PAIR — "a host that does not advertise MUST omit the field; a host that
 * advertises MUST include it on every snapshot" — and RFC 0151 §C makes
 * `profileVersion` part of the inverse-action identity while §A makes
 * `orderingModels` a promise about how the unwind is ORDERED. Three separate
 * files therefore have to agree with each other:
 *
 *   - `routes/discovery.ts`            — what a peer reads,
 *   - `routes/runs.ts`                 — whether the snapshot carries the field,
 *   - `host/workflowDefinitionValidation.ts` — whether `settings.compensation`
 *                                        is refused with `capability_required`,
 *                                        and which `orderingModel` /
 *                                        `profileVersion` it accepts.
 *
 * A literal in each is three chances to drift, and the drift would be silent in
 * the direction that matters most: an advert claiming an ordering model the
 * unwind does not run, or a registration refusing a policy the advert invites.
 * So the values live here ONCE, this module has NO imports (nothing can make it
 * a cycle, and nothing about the runtime can make it fail to load), and the
 * runtime modules that used to own the constants re-export them from here so
 * every existing call site keeps reading the same value.
 *
 * HONESTY OF EACH FIELD, stated so a future edit has to argue with it:
 *
 *   - `supported: true` — `host/compensationUnwind.ts` claims obligations from
 *     the durable ledger, orders them, retries them, gates them on RFC 0051
 *     approval, and records the six §D events; `executor/executor.ts`
 *     `finalizeRun` drives it at the terminal-failure choke (ADR 0554 P2,
 *     #3274). The host orders, persists and retries the unwind, which is
 *     exactly what §A says the advert means.
 *   - `orderingModels: ['reverse-completion']` — ONLY the mandatory model.
 *     `dependency-graph` is optional and is not implemented; claiming it would
 *     be an ordering guarantee with no DAG walk behind it.
 *   - `profileVersion: '1'` — the value the ledger actually mints identities
 *     under (`compensationInverseActionId`). It is not a version number for
 *     this host's implementation; it names the ordering rules the recorded ids
 *     were minted under, so it may only move when those rules do.
 *   - `manualIntervention: true` — `compensationUnwind.markManual` records
 *     `manual_intervention_required` on the durable row AND emits the §D event
 *     at three real sites (a declaration that vanished between registration and
 *     the unwind, an inverse that cannot run at all, and a `requiresApproval`
 *     inverse with no approval gate wired), and the §D fold reports `manual`
 *     for it. §C's clause is "the host can record `manual-intervention-required`
 *     rather than silently abandoning an unwind", and it can.
 *
 * @see spec/v1/compensation.md §A · schemas/capabilities.schema.json
 * @see docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md
 */

/**
 * RFC 0151 §A/§C `profileVersion`. Part of the inverse-action identity, so a
 * profile change yields new ids rather than colliding with recorded ones.
 *
 * Re-exported by `host/compensationLedger.ts`, which mints the identities.
 */
export const COMPENSATION_PROFILE_VERSION = '1';

/**
 * RFC 0151 §A. The MANDATORY ordering model, and the only one this host
 * implements — `dependency-graph` is the optional second model and claiming it
 * without a DAG walk would be an advert we could not honour.
 *
 * Re-exported by `host/compensationUnwind.ts`, which runs the ordering.
 */
export const COMPENSATION_ORDERING_MODEL = 'reverse-completion' as const;

/** The advertised set. A tuple, because §A's `orderingModels` is a closed enum
 *  array and this host's membership in it is a claim, not a configuration. */
export const COMPENSATION_ORDERING_MODELS: readonly [typeof COMPENSATION_ORDERING_MODEL] = [
  COMPENSATION_ORDERING_MODEL,
];

/** RFC 0151 §C — the host records `manual_intervention_required` rather than
 *  silently abandoning an unwind (`compensationUnwind.markManual`). */
export const COMPENSATION_MANUAL_INTERVENTION = true;

/** The `capabilities.compensation` object, exactly as
 *  `capabilities.schema.json` closes it (`additionalProperties: false`,
 *  `required: ['supported']`). */
export interface CompensationCapability {
  readonly supported: boolean;
  readonly profileVersion: string;
  readonly orderingModels: readonly string[];
  readonly manualIntervention: boolean;
}

/**
 * What `/.well-known/openwop` advertises at `capabilities.compensation`, and
 * the single predicate every capability-gated compensation branch reads.
 *
 * Frozen so a caller cannot mutate the advert out from under the snapshot
 * projection that is paired with it.
 */
export const COMPENSATION_CAPABILITY: CompensationCapability = Object.freeze({
  supported: true,
  profileVersion: COMPENSATION_PROFILE_VERSION,
  orderingModels: COMPENSATION_ORDERING_MODELS,
  manualIntervention: COMPENSATION_MANUAL_INTERVENTION,
});

/**
 * The §D pairing predicate, named rather than inlined.
 *
 * `RunSnapshot.compensationStatus` is projected IFF this is true. Reading the
 * same constant the advert is built from is what makes "advertiser MUST carry
 * the field" hold by construction instead of by two files agreeing today.
 */
export function advertisesCompensation(): boolean {
  return COMPENSATION_CAPABILITY.supported;
}
