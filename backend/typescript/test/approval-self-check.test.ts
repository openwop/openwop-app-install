/**
 * ADR 0905 P2a — the shared separation-of-duties core (`host/approvalSelfCheck.ts`),
 * hoisted out of `features/cms/contentApproval.ts` so `email-campaign-send` can call
 * the same one. Behaviour is unchanged for CMS (its review suites stay green); this pins
 * the identity rules themselves:
 *  - a decider who is not a submitter is never refused;
 *  - a submitter IS refused while someone else can approve, and is NOT when they are
 *    the only approver (a sole approver is never locked out);
 *  - "someone else" excludes every submitter (two co-submitters are not each other's
 *    escape hatch);
 *  - no recorded submitter ⇒ allowed (and logged);
 *  - an identity that cannot be canonicalised is treated as the submitter: fail closed.
 *
 * Sabotage-witnessed: returning false for an unresolvable decider reds the fail-closed
 * case; not passing the submitters as `exclude` reds the co-submitter case.
 */
import { describe, expect, it } from 'vitest';
import { selfApprovalBlockedCore } from '../src/host/approvalSelfCheck.js';

const base = { tenantId: 't1', approvalId: 'a1', logTag: 'test_review' };
/** "Another approver exists" iff the pool holds someone outside {decider} ∪ exclude. */
const pool = (members: string[]) => async (decider: string, exclude: string[]): Promise<boolean> =>
  members.some((m) => m !== decider && !exclude.includes(m));

describe('ADR 0905 P2a — selfApprovalBlockedCore', () => {
  it('a decider who did not submit is never refused', async () => {
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'bob', submitters: ['alice'], otherApproverExists: pool(['alice', 'bob']) })).toBe(false);
  });
  it('a submitter is refused while another approver exists, and not when sole', async () => {
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'alice', submitters: ['alice'], otherApproverExists: pool(['alice', 'bob']) })).toBe(true);
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'alice', submitters: ['alice'], otherApproverExists: pool(['alice']) })).toBe(false);
  });
  it('co-submitters are not each other\'s "someone else"', async () => {
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'alice', submitters: ['alice', 'bob'], otherApproverExists: pool(['alice', 'bob']) })).toBe(false);
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'alice', submitters: ['alice', 'bob'], otherApproverExists: pool(['alice', 'bob', 'carol']) })).toBe(true);
  });
  it('no recorded submitter ⇒ allowed', async () => {
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'alice', submitters: [], otherApproverExists: pool(['alice', 'bob']) })).toBe(false);
  });
  it('an unresolvable delegated decider is treated as the submitter (fail closed)', async () => {
    // A delegated-key subject whose delegation does not exist canonicalises to null.
    expect(await selfApprovalBlockedCore({ ...base, decidedBy: 'apikey:missing-delegation', submitters: ['alice'], otherApproverExists: pool(['alice', 'bob']) })).toBe(true);
  });
});
