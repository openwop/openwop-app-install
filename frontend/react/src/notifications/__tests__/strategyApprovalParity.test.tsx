/**
 * `SGU-2` / `SGU-3` — the strategy-activation group is a first-class citizen of the
 * shared approvals inbox.
 *
 * Both kinds sit in the SAME inbox with the same consequence shape (approve commits,
 * reject sends the subject back to draft). Content-publish got the reject-with-reason
 * bar — and with it the two focus behaviours earned through bugs — while strategy got
 * bare buttons and a kind-blind "Proposal dismissed." toast for an outcome that is
 * actually "back in draft, resubmittable".
 *
 * These legs pin the PARITY, not the implementation: if a future kind is added with
 * bare buttons, the first leg is the one that notices.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(here, '..', p), 'utf8');

describe('SGU-2 — both approval kinds get the same decide affordance', () => {
  it('the decide bar is named for what it IS, not for its first consumer', () => {
    const bar = read('ContentReviewContext.tsx');
    expect(bar).toContain('export function ApprovalDecideBar');
    expect(bar, 'the old name is why strategy shipped bare buttons').not.toContain('export function ContentReviewDecideBar');
  });

  it('the full inbox renders it for the strategy group, not just content-publish', () => {
    const inbox = read('ApprovalsInbox.tsx');
    const strategyBlock = inbox.slice(inbox.indexOf('strategyActivation.length > 0'));
    expect(strategyBlock).toContain('<ApprovalDecideBar');
    expect(strategyBlock, 'reject must carry the reviewer note').toContain('onReject={(note) => reject(a, note)}');
  });

  /**
   * RATCHET, shrink-only. Writing this test as "no group may use a bare reject" was the
   * first instinct and it FAILED — correctly. This inbox has five card groups
   * (content-publish, strategy-activation, scenario, spend, commerce-spend) plus a
   * DataTable branch, and only the first two now offer a reason. The other three belong
   * to other features and their reject semantics are not this iteration's to judge; the
   * table branch genuinely cannot host an expanding textarea inside a cell.
   *
   * So the honest assertion is a COUNT that may only fall: it records that the gap is
   * known and bounded, and a NEW group added with bare buttons pushes it up and reds.
   */
  it('RATCHET: the bare-reject sites are a known, shrink-only set (was 5 before this)', () => {
    const inbox = read('ApprovalsInbox.tsx');
    const bare = inbox.split('onClick={() => void reject(a)}').length - 1;
    expect(bare, 'a NEW approval group must not ship a reject that drops the reviewer note').toBeLessThanOrEqual(4);
  });
});

describe('SGU-3 — the reject toast says what actually happened', () => {
  it('a rejected strategy activation is reported as back-in-draft, in both inboxes', () => {
    for (const f of ['ApprovalsInbox.tsx', 'NeedsYouInbox.tsx']) {
      expect(read(f), `${f} must not report a reversible reject as a dismissal`)
        .toContain('toastStrategyRejectedToDraft');
    }
  });

  it('the copy exists in all four locales (no fallback leak)', () => {
    for (const loc of ['en', 'es', 'fr', 'pt-BR']) {
      expect(read(`i18n/${loc}.ts`)).toContain('toastStrategyRejectedToDraft');
    }
  });

  it('and it says the strategy can be resubmitted — the fact the old copy hid', () => {
    expect(read('i18n/en.ts')).toMatch(/toastStrategyRejectedToDraft:.*resubmitted/);
  });
});
