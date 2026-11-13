/**
 * ADR 1058 PR-B / RFC 0183 §A.2 — an approval card's `refine` carries
 * `refineFeedback`, which the host requires and a declared refine loopback
 * (RFC 0258 §C.4) hands to the re-entered producer. Every other action keeps
 * the `{ action, comment }` shape both cards always sent.
 */
import { describe, expect, it } from 'vitest';
import { approvalResumeValue } from '../approvalResumeValue.js';

describe('approvalResumeValue', () => {
  it('refine sends refineFeedback scoped to the whole artifact, with the comment as its text', () => {
    expect(approvalResumeValue('refine', '  Darker, and shorter. ')).toEqual({
      action: 'refine',
      refineFeedback: { scope: 'whole', text: 'Darker, and shorter.' },
      comment: 'Darker, and shorter.',
    });
  });

  it('refine with no comment still carries the required refineFeedback', () => {
    expect(approvalResumeValue('refine', '')).toEqual({ action: 'refine', refineFeedback: { scope: 'whole' } });
  });

  it('every other action is unchanged', () => {
    expect(approvalResumeValue('approve', 'ok')).toEqual({ action: 'approve', comment: 'ok' });
    expect(approvalResumeValue('reject', '')).toEqual({ action: 'reject', comment: undefined });
  });
});
