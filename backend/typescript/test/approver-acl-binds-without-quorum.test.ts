/**
 * ADR 0677 D1 (`ISWF-20`) — a DECLARED approver ACL binds regardless of `requiredApprovals`.
 *
 * Born red: both eligibility lanes opened with
 *   `const requiredApprovals = … > 1 ? … : 0; if (requiredApprovals === 0) return;`
 * so they returned BEFORE `approverRefs` was ever read. A gate declaring an explicit approver
 * list but no quorum threshold was an OPEN gate — and the route's own docblock told authors
 * "authors who want an ACL set `approverRefs`", which was false as written.
 *
 * This is a normative MUST, not a hardening preference: `v2-approver-enforced.test.ts:83`
 * pins "a host advertising `interrupt` MUST refuse a resolver not in approversList with 403
 * (RFC 0173 §B — enforcement, not advice)" over a fixture that carries NO `requiredApprovals`
 * and is resolved by a BEARER — i.e. by this lane.
 *
 * Leg 3 is the guard that keeps the fix from drifting into a conformance break:
 * `openwop-interrupt-quorum` is pure vote-counting and `conformance-interrupt-quorum.json`
 * pins `approversList: []` as an OPEN gate. Only a NON-EMPTY declaration may bind.
 */
import { describe, expect, it } from 'vitest';
import { __assertTokenQuorumVoteForTests as assertTokenQuorumVote } from '../src/routes/interrupts.js';
import type { InterruptRecord } from '../src/types.js';

const gate = (data: Record<string, unknown>): InterruptRecord =>
  ({ interruptId: 'int-1', runId: 'run-1', nodeId: 'n1', reason: 'approval', status: 'pending', data, token: 'tok-1' } as unknown as InterruptRecord);

describe('ADR 0677 D1 — a non-empty ACL binds on the token lane without a quorum', () => {
  it('leg 1: a voter NOT on the list is refused 403 — with NO requiredApprovals at all', () => {
    const it_ = gate({ approverRefs: ['urn:conformance:listed-approver'] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:someone:else' }, true))
      .toThrowError(/not an eligible approver/i);
  });

  it('leg 2: a voter ON the list passes — the ACL admits, it does not merely refuse', () => {
    const it_ = gate({ approverRefs: ['urn:conformance:listed-approver'] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:conformance:listed-approver' }, true)).not.toThrow();
  });

  it('leg 3 (CONFORMANCE GUARD): an EMPTY list is still an open gate — any voter admissible', () => {
    // `conformance-interrupt-quorum.json` pins `approversList: []`. If this leg ever goes
    // red, the fix has drifted into breaking the `openwop-interrupt-quorum` profile.
    const it_ = gate({ approversList: [] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:anyone' }, true)).not.toThrow();
    expect(() => assertTokenQuorumVote(gate({}), { voter: 'urn:anyone' }, true)).not.toThrow();
  });

  it('leg 4: a list of BLANKS is an open gate, not a refuse-everyone gate', () => {
    // `approvals.two-stage-sign-off` defaults both approver params to "" and documents
    // "blank = any team member"; chain config freezes params at expansion, so the shipped
    // default really is `approverRefs: [""]`. Treating that as a binding ACL would refuse
    // every member of every tenant using the pack's default instantiation.
    expect(() => assertTokenQuorumVote(gate({ approverRefs: ['', '  '] }), { voter: 'urn:anyone' }, true)).not.toThrow();
  });

  it('leg 5: the legacy `approversList` spelling binds too — not just `approverRefs`', () => {
    const it_ = gate({ approversList: ['urn:listed'] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:other' }, true)).toThrowError(/not an eligible approver/i);
  });

  it('leg 6: a non-token caller on an ACL gate fails closed', () => {
    const it_ = gate({ approverRefs: ['urn:listed'] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:listed' }, false))
      .toThrowError(/requires an authenticated approver or a valid interrupt token/i);
  });

  it('leg 7: quorum gates are UNCHANGED — the HMAC binding still applies at threshold > 1', () => {
    // The per-recipient HMAC's rationale is that a SHARED emailed token let one recipient
    // cast ALL listed approvers' votes — a multi-approver concern. ADR 0677 deliberately
    // leaves it scoped to quorum gates; widening it would 403 legitimately-emailed
    // single-approver links. Filed as `ISWF-23`.
    const it_ = gate({ requiredApprovals: 2, approverRefs: ['urn:listed'] });
    expect(() => assertTokenQuorumVote(it_, { voter: 'urn:listed', voterSig: 'bogus' }, true))
      .toThrowError(/signed per-approver link/i);
  });
});
