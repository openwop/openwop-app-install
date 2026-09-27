/**
 * ADR 0555 P1 — isolation ELIGIBILITY and the dispatch-placement decision.
 *
 * Two questions, kept apart on purpose:
 *
 *   1. CAN this node run under the contract?  (`packNodeEligibility`)
 *   2. SHOULD this dispatch be isolated?      (`resolveIsolationPlan`)
 *
 * The first is a property of the pack — decided from its MANIFEST at load time,
 * never from reading its code — and it is the reason the fail-closed arm exists
 * before P2 has a real adapter. A pack that needs something the contract cannot
 * express and is ALSO untrusted must not fall back to running in-process: that
 * would make "untrusted code is isolated" a claim with a silent exception, which
 * is the failure mode CORRECTION 4 of this ADR describes for gates nobody
 * enables. It is refused with `pack_isolation_ineligible` instead.
 *
 * ── WHY THE TWO INELIGIBILITY SIGNALS ARE MANIFEST FACTS ──────────────────
 *
 *   `secrets`     `peerDependencies['secrets.resolveInPack']`. Exactly the three
 *                 packs that touch `ctx.secrets` declare it, and a pack that
 *                 wanted the capability without declaring it would already be
 *                 broken on a host that refuses undeclared peer-dependencies.
 *   callback       the node TYPE ID. `ctx.mcp.subscribeResource` is the one
 *   stream         `NodeContext` member taking a function argument, and exactly
 *                  one node uses it. `pack-isolation-eligibility.test.ts`
 *                  ratchets that: any pack whose entry references
 *                  `subscribeResource` must declare a typeId in the set below,
 *                  so a second consumer cannot appear silently.
 *
 * Deriving either from the pack's SOURCE would mean the host greps third-party
 * code to decide policy — unreliable (a computed member access defeats it) and
 * exactly the "attestation by reading" shape P0 rejected.
 */

import type { IsolationEligibility, PackNodeOrigin } from './packWorkerContract.js';
import { ISOLATION_GUARANTEE_UNMET_CODE, ISOLATION_INELIGIBLE_CODE } from './packWorkerContract.js';
import { unmetGuarantees, type AdapterGuarantees } from './isolationGuarantees.js';
import type { PackTrustTier } from './packTrust.js';

/** Manifest peer-dependency keys that imply cleartext BYOK inside the node. */
export const SECRETS_PEER_DEPENDENCY_KEYS: readonly string[] = ['secrets.resolveInPack', 'secrets'];

/**
 * Node typeIds whose implementation drives a host CALLBACK stream.
 *
 * One member, and it should stay that way: the request/response contract can
 * carry data, not functions, so a second entry here is a signal that the
 * contract needs a streaming shape rather than that the list needs a line.
 */
export const CALLBACK_STREAM_NODE_TYPE_IDS: readonly string[] = ['core.openwop.mcp.subscribe-resource'];

/**
 * Decide whether ONE node of a pack can run under the isolated-worker contract.
 *
 * @param manifest the pack's parsed `pack.json` (peer-dependency block only)
 * @param typeId   the node being registered
 */
export function packNodeEligibility(
  manifest: { peerDependencies?: Record<string, unknown> } | undefined,
  typeId: string,
): IsolationEligibility {
  const peers = manifest?.peerDependencies ?? {};
  for (const key of SECRETS_PEER_DEPENDENCY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(peers, key)) {
      return { eligible: false, reason: 'secrets_unsupported' };
    }
  }
  if (CALLBACK_STREAM_NODE_TYPE_IDS.includes(typeId)) {
    return { eligible: false, reason: 'callback_stream_unsupported' };
  }
  return { eligible: true };
}

/* -------------------------------------------------------------------------- *
 * Placement
 * -------------------------------------------------------------------------- */

/**
 * `OPENWOP_PACK_ISOLATION` — WHICH dispatches are isolated.
 * (`OPENWOP_PACK_ISOLATION_ADAPTER` decides what does the isolating.)
 *
 *   `untrusted` **(default, ADR 0555 P2)** eligible pack nodes from `untrusted`
 *               packs are isolated; every trusted tier runs in-process exactly
 *               as before. See below for why this is the default.
 *   `off`       every pack node runs in-process, exactly as before P1.
 *   `all`       every eligible pack node is isolated regardless of tier. An
 *               operator opt-in: it costs a process per node to contain the
 *               host's own release artifact.
 *   `fake`      P1's value, kept verbatim so its meaning does not silently
 *               change under an existing deployment or test: isolate everything
 *               eligible. Combined with the fake adapter's empty guarantee
 *               record it can no longer be what runs untrusted code — the tier
 *               comparison refuses that — so it is now what its name always
 *               claimed: a contract harness.
 *
 * ── WHY THE DEFAULT MOVED FROM `off` TO `untrusted` ───────────────────────
 *
 * CORRECTION 4 of this ADR is explicit that a security gate nobody enables is a
 * gate that cannot fail, and this program has shipped several. `off` by default
 * would have made P2 exactly that.
 *
 * `untrusted` changes the behaviour of precisely one population: packs that are
 * BOTH untrusted AND dispatchable — which, under P0's default-ON policy, means
 * the operator has explicitly set the fail-open
 * `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` break-glass. That is the exact set of
 * packs isolation exists for. Every trusted tier is byte-identical to P1, so no
 * steward or operator-trusted pack changes placement, and no host that never
 * touched the break-glass sees any difference at all.
 */
export type IsolationMode = 'off' | 'fake' | 'untrusted' | 'all';

const MODES: readonly IsolationMode[] = ['off', 'fake', 'untrusted', 'all'];

export function isolationMode(env: NodeJS.ProcessEnv = process.env): IsolationMode {
  const raw = env.OPENWOP_PACK_ISOLATION;
  if (raw === undefined || raw === '') return 'untrusted';
  // An unrecognised value falls back to the DEFAULT rather than to `off`: a
  // typo in an operator's config must not silently disable containment.
  return MODES.includes(raw as IsolationMode) ? (raw as IsolationMode) : 'untrusted';
}

export type IsolationPlan =
  | { readonly kind: 'in-process' }
  /** Carries the origin so the caller never re-derives (or non-null-asserts) it. */
  | { readonly kind: 'isolate'; readonly origin: PackNodeOrigin }
  | { readonly kind: 'refuse'; readonly code: typeof ISOLATION_INELIGIBLE_CODE; readonly message: string };

/**
 * Where this dispatch runs.
 *
 * The refuse arm fires only for an UNTRUSTED pack, and that combination is
 * reachable today: `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` (P0's break-glass) makes
 * an untrusted pack dispatchable WITHOUT reclassifying it, so its modules carry
 * `tier: 'untrusted'` into this function. A trusted pack that is ineligible
 * simply runs in-process — isolation is a containment measure for code the host
 * does not vouch for, not a requirement placed on its own steward corpus.
 */
export function resolveIsolationPlan(input: {
  readonly mode: IsolationMode;
  readonly origin?: PackNodeOrigin;
}): IsolationPlan {
  const { mode, origin } = input;
  // No origin ⇒ a host built-in module. This host's own code is never routed
  // through a contract designed to contain third-party code.
  if (!origin) return { kind: 'in-process' };
  if (mode === 'off') return { kind: 'in-process' };
  // ADR 0555 P2 — `untrusted` mode scopes isolation to the tier it is for. A
  // trusted pack under this mode is not merely "allowed" in-process, it never
  // reaches the eligibility question at all, so a steward pack that declares
  // `secrets.resolveInPack` keeps working exactly as it does today.
  if (mode === 'untrusted' && origin.tier !== 'untrusted') return { kind: 'in-process' };
  if (origin.isolation.eligible) return { kind: 'isolate', origin };
  if (origin.tier === 'untrusted') {
    return {
      kind: 'refuse',
      code: ISOLATION_INELIGIBLE_CODE,
      message:
        `Pack '${origin.packName}@${origin.packVersion}' is untrusted and node '${origin.typeId}' cannot run under the`
        + ` isolated-worker contract (${origin.isolation.reason}). It will not be executed in-process`
        + ` (ADR 0555 P1).`,
    };
  }
  return { kind: 'in-process' };
}

/* -------------------------------------------------------------------------- *
 * ADR 0555 P2 — is THIS adapter allowed to run THIS tier?
 * -------------------------------------------------------------------------- */

export type AdapterAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: typeof ISOLATION_GUARANTEE_UNMET_CODE; readonly message: string };

/**
 * Compare a tier's required containment against what the adapter enforces.
 *
 * Separate from `resolveIsolationPlan` on purpose: placement is a property of
 * the PACK and is decided in the executor, while this is a property of the
 * ADAPTER and can only be decided where one is in hand. Folding it into the
 * plan would have meant an optional adapter argument, and an optional argument
 * to a security check is a check that is skipped by default.
 *
 * There is no downgrade arm. A host holding only an adapter too weak for the
 * tier refuses the dispatch; it does not run the code somewhere weaker and it
 * does not fall back in-process, because both of those turn "untrusted code is
 * isolated" into a claim with an exception no operator can see.
 */
export function admitAdapterForTier(
  tier: PackTrustTier,
  adapter: { readonly id: string; readonly guarantees: AdapterGuarantees },
): AdapterAdmission {
  const unmet = unmetGuarantees(tier, adapter.guarantees);
  if (unmet.length === 0) return { ok: true };
  return {
    ok: false,
    code: ISOLATION_GUARANTEE_UNMET_CODE,
    message:
      `Isolation adapter '${adapter.id}' does not enforce ${unmet.join(', ')}, which the '${tier}' trust tier requires.`
      + ` The dispatch was refused rather than run under weaker containment (ADR 0555 P2).`,
  };
}
