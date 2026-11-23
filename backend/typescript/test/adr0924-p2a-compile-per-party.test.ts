/**
 * ADR 0924 P2a (review H1) — `compileApproverSpec` carries every quorum-bearing
 * field of an ADR 0942 `ApproverSpec` onto the PendingApproval lane's
 * `ApprovalPolicy`, and refuses (never drops) a field it cannot carry.
 *
 * Why it exists: the compiler used to build `ApprovalPolicy` without `perParty`
 * or `clientApprover` (`compile.ts:80-89` at `beebfb28b7`). A `client_and_agency`
 * spec would have compiled to a bare `requiredApprovals: 2`, which two agency
 * votes satisfy with no client vote at all: the exact hazard ADR 0942 D9's
 * 2026-10-19 correction forbids. It was latent only because no change-set row
 * carried a policy yet.
 *
 * Pins:
 *  - a two-party spec round-trips `perParty` and `clientApprover`, so the tally
 *    sees the parties (and the bare count alone is not a quorum);
 *  - `COMPILED_APPROVER_FIELDS` lists every key of a fully-populated spec, and a
 *    spec carrying any other key is refused with `autonomy_field_not_carried`;
 *  - `majority` with `perParty` is refused (any eligible reject rejects);
 *  - the interrupt lane still refuses `perParty`.
 *
 * Red witness: on `main`, `src/host/autonomyPolicy/compile.ts` drops `perParty`
 * and `clientApprover` (the round-trip case fails) and exports no
 * `COMPILED_APPROVER_FIELDS` (the ratchet case fails to import). Sabotage
 * (to run at the gate): delete the `perParty` line in the compiled
 * `approvalPolicy` → the round-trip case and the tally case go red; drop the
 * uncarried-key refusal → the unknown-field case goes red.
 */
import { describe, expect, it } from 'vitest';
import { compileApproverSpec, COMPILED_APPROVER_FIELDS } from '../src/host/autonomyPolicy/compile.js';
import type { ApproverSpec } from '../src/host/autonomyPolicy/types.js';
import { evaluateQuorumTally } from '../src/host/reviewDecisionLedger.js';
import { OpenwopError } from '../src/types.js';

/** The refusal reason a compile throws, or `null` when it compiles. */
function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof OpenwopError)) throw err;
    return (err.details as { reason?: string } | undefined)?.reason ?? 'no_reason';
  }
}

/** The `client_and_agency` shape ADR 0924 review § 3.1 maps a client to. */
const TWO_PARTY: ApproverSpec = {
  roleRefs: ['admin'],
  clientApprover: true,
  requiredApprovals: 2,
  rejectionPolicy: 'any',
  perParty: [{ party: 'agency', refs: 'roleRefs', min: 1 }, { party: 'client', refs: 'clientApprover', min: 1 }],
  delegation: 'none',
  sla: { expireAfterMs: 14 * 24 * 60 * 60 * 1000 },
};

/** Every field of `ApproverSpec` set at once: the ratchet's input. */
const FULL: ApproverSpec = {
  ...TWO_PARTY,
  groupRefs: ['grp-reviewers'],
  subjectRefs: ['user:named'],
  sla: { remindAfterMs: 60_000, escalateAfterMs: 120_000, expireAfterMs: 180_000 },
  escalateTo: { roleRefs: ['owner'] },
};

const compileForChangeSet = (spec: ApproverSpec) =>
  compileApproverSpec(spec, { actionClass: 'campaign.change-set.apply', lane: 'approval' }).approvalPolicy;

describe('ADR 0924 P2a — the compiler carries the per-party quorum', () => {
  it('a two-party spec keeps perParty and clientApprover on the compiled policy', () => {
    const policy = compileForChangeSet(TWO_PARTY);
    expect(policy).toMatchObject({
      requiredApprovals: 2,
      approverRoleRefs: ['admin'],
      rejectionPolicy: 'any',
      perParty: [{ party: 'agency', min: 1 }, { party: 'client', min: 1 }],
      clientApprover: true,
      allowDelegation: false,
      sla: { expireAfterMs: 14 * 24 * 60 * 60 * 1000 },
    });
  });

  it('with the compiled policy, two agency votes are not a quorum; one of each is', () => {
    const policy = compileForChangeSet(TWO_PARTY);
    const twoAgency = { accepts: ['user:a', 'user:b'], rejects: [], acceptsByParty: { agency: ['user:a', 'user:b'], client: [] } };
    const oneEach = { accepts: ['user:a', 'client-approver:c'], rejects: [], acceptsByParty: { agency: ['user:a'], client: ['client-approver:c'] } };
    expect(evaluateQuorumTally(twoAgency, policy)).toBe('pending');
    expect(evaluateQuorumTally(oneEach, policy)).toBe('accept');
  });

  it('every ApproverSpec field is a carried field (the ratchet)', () => {
    expect(Object.keys(FULL).sort()).toEqual(Object.keys(COMPILED_APPROVER_FIELDS).sort());
    const policy = compileForChangeSet(FULL);
    // Each spec field lands on a named compiled field; none is silently dropped.
    expect(policy).toMatchObject({
      approverRoleRefs: FULL.roleRefs,
      approverGroupRefs: FULL.groupRefs,
      approverRefs: FULL.subjectRefs,
      clientApprover: true,
      requiredApprovals: FULL.requiredApprovals,
      rejectionPolicy: FULL.rejectionPolicy,
      perParty: [{ party: 'agency', min: 1 }, { party: 'client', min: 1 }],
      allowDelegation: false,
      sla: FULL.sla,
      escalateTo: FULL.escalateTo,
    });
  });

  it('a spec field the compiler does not know is refused, never dropped', () => {
    const withExtra = { ...TWO_PARTY, partyWeights: { client: 2 } };
    expect(refusalOf(() => compileForChangeSet(TWO_PARTY)), 'positive control: the same spec without the extra field compiles').toBeNull();
    expect(refusalOf(() => compileForChangeSet(withExtra))).toBe('autonomy_field_not_carried');
  });

  it('majority is refused with a per-party quorum', () => {
    expect(refusalOf(() => compileForChangeSet({ ...TWO_PARTY, rejectionPolicy: 'majority' }))).toBe('autonomy_per_party_majority');
  });

  it('the in-run gate lane still refuses a per-party quorum', () => {
    const agencyOnly: ApproverSpec = { roleRefs: ['admin'], requiredApprovals: 2, perParty: [{ party: 'agency', refs: 'roleRefs', min: 2 }], delegation: 'allowed' };
    expect(refusalOf(() => compileApproverSpec(agencyOnly, { actionClass: 'campaign.change-set.apply', lane: 'interrupt' }))).toBe('autonomy_per_party_unsupported');
  });
});
