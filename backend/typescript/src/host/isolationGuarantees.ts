/**
 * ADR 0555 P2 — what an isolation adapter ENFORCES versus what it can only
 * ATTEST, and the tier requirements those are compared against.
 *
 * This module exists because the alternative is the failure mode this ADR has
 * spent four corrections avoiding: a security mechanism that is described
 * accurately in a docblock and then consumed as if it were stronger. An
 * adapter's containment is not uniform — on Cloud Run, Node's permission model
 * genuinely denies filesystem, subprocess, worker, native-addon and dynamic-code
 * access, and genuinely does NOT deny network egress, because Node has no
 * network permission and the platform gives no seccomp or netns control. Both
 * halves of that sentence have to be machine-readable, or the second half stops
 * being true in anyone's head about a week after it is written.
 *
 * ── WHY A RECORD AND NOT A SET ────────────────────────────────────────────
 *
 * A `Set<IsolationGuarantee>` of enforced names makes ABSENCE ambiguous: a
 * missing member reads identically as "this adapter does not enforce it" and
 * "whoever wrote this adapter did not think about it". Those are different
 * facts and only one of them is safe to ship. `AdapterGuarantees` is therefore
 * an exhaustive `Record`, so adding a guarantee name is a COMPILE ERROR in
 * every adapter until each one states its position — the same discipline the
 * error mapper uses, for the same reason.
 *
 * ── HOW THE COMPARISON BITES ──────────────────────────────────────────────
 *
 * `unmetGuarantees(tier, adapter)` returns what the tier requires and the
 * adapter does not enforce. A non-empty answer REFUSES the dispatch. It never
 * downgrades to a weaker adapter and never falls back in-process: a silent
 * downgrade is how "untrusted code is isolated" becomes a claim with an
 * exception nobody can find.
 *
 * `network-denied` is deliberately a name NO adapter currently provides. It is
 * not decoration — it is what keeps the comparison falsifiable, because a
 * requirement set that every adapter already satisfies cannot be observed to
 * refuse anything. `pack-isolation-escape.test.ts` requires it and asserts the
 * refusal.
 */

import type { PackTrustTier } from './packTrust.js';

/**
 * One containment property, named from the ATTACKER's side.
 *
 * Closed on purpose. A new member is a decision about what isolation means on
 * this host, not a free-form label — and, per the Record above, it is a change
 * every adapter must answer.
 */
export type IsolationGuarantee =
  /** Pack code runs in an OS process the host can terminate. */
  | 'separate-process'
  /** The host's environment (and therefore its secrets) is not visible. */
  | 'scrubbed-env'
  /** Reads and writes are confined to an explicit allowlist. */
  | 'filesystem-allowlist'
  /** `child_process` is unavailable. */
  | 'no-subprocess'
  /** `worker_threads` is unavailable. */
  | 'no-worker-threads'
  /** Native addons cannot be loaded (an addon escapes every JS-level control). */
  | 'no-native-addons'
  /** `eval` / `new Function` are unavailable. */
  | 'no-dynamic-code'
  /** A heap ceiling the runtime enforces by terminating. */
  | 'memory-cap'
  /** Wall-clock and CPU exhaustion end in termination, not abandonment. */
  | 'cpu-wall-clock-kill'
  /** One dispatch cannot read another dispatch's scratch space or pack. */
  | 'cross-dispatch-isolation'
  /**
   * Outbound network is denied.
   *
   * NO adapter on this host provides this today and none can: Node's permission
   * model has no network dimension, Cloud Run exposes no seccomp or network
   * namespace control, and the one in-realm route to refusing `node:net` —
   * `module.register()` — itself requires the WorkerThreads permission, so
   * buying it would cost `no-worker-threads`. Attenuating the globals
   * (`fetch`, `WebSocket`, `EventSource`) is real but bypassable via
   * `node:net`, so it is NOT this guarantee and is not claimed as one.
   */
  | 'network-denied';

export const ISOLATION_GUARANTEES: readonly IsolationGuarantee[] = [
  'separate-process',
  'scrubbed-env',
  'filesystem-allowlist',
  'no-subprocess',
  'no-worker-threads',
  'no-native-addons',
  'no-dynamic-code',
  'memory-cap',
  'cpu-wall-clock-kill',
  'cross-dispatch-isolation',
  'network-denied',
];

/**
 * `enforced` means a mechanism outside the pack's reach makes the property
 * true. Anything a pack could undo from inside its own realm is `not-enforced`,
 * however much it raises the cost.
 */
export type GuaranteeLevel = 'enforced' | 'not-enforced';

/** Exhaustive by construction — see the module docblock. */
export type AdapterGuarantees = Readonly<Record<IsolationGuarantee, GuaranteeLevel>>;

/** Every guarantee `not-enforced`; the base an adapter narrows from. */
export const NO_GUARANTEES: AdapterGuarantees = Object.freeze(
  Object.fromEntries(ISOLATION_GUARANTEES.map((g) => [g, 'not-enforced'])) as Record<IsolationGuarantee, GuaranteeLevel>,
);

/**
 * What each trust tier REQUIRES of the adapter that runs its code.
 *
 * `untrusted` requires everything an OS-level adapter can actually deliver on
 * this host, and deliberately NOT `network-denied` — requiring a property no
 * adapter can provide would make the untrusted tier permanently undispatchable,
 * which is a gate nobody can enable rather than a gate that fails closed. The
 * gap is recorded in the ADR with its concrete unlock instead of being papered
 * over here.
 *
 * The trusted tiers require NOTHING, because isolation is a containment measure
 * for code this host does not vouch for. A steward pack forced through an
 * adapter would be paying a process per node to contain the host's own release
 * artifact. (`revoked` never reaches a dispatch at all — `packTrust.ts` refuses
 * the import — but it is listed so the record is exhaustive rather than relying
 * on that being remembered.)
 */
export const TIER_REQUIRED_GUARANTEES: Readonly<Record<PackTrustTier, readonly IsolationGuarantee[]>> = Object.freeze({
  steward: [],
  'operator-trusted': [],
  untrusted: [
    'separate-process',
    'scrubbed-env',
    'filesystem-allowlist',
    'no-subprocess',
    'no-worker-threads',
    'no-native-addons',
    'no-dynamic-code',
    'memory-cap',
    'cpu-wall-clock-kill',
    'cross-dispatch-isolation',
  ],
  revoked: ISOLATION_GUARANTEES,
});

/**
 * What `tier` requires that `guarantees` does not enforce.
 *
 * Empty ⇒ the adapter may run this tier. Non-empty ⇒ REFUSE. There is no third
 * answer and in particular no "run it somewhere weaker".
 */
export function unmetGuarantees(
  tier: PackTrustTier,
  guarantees: AdapterGuarantees,
  required: Readonly<Record<PackTrustTier, readonly IsolationGuarantee[]>> = TIER_REQUIRED_GUARANTEES,
): IsolationGuarantee[] {
  return (required[tier] ?? []).filter((g) => guarantees[g] !== 'enforced');
}
