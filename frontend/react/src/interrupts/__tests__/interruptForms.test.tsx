import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ClarificationDialog } from '../ClarificationDialog.js';
import { ApprovalCard } from '../ApprovalCard.js';
import { RefinementForm } from '../RefinementForm.js';

afterEach(cleanup);

/**
 * Verifies the Field-primitive migration of the HITL interrupt forms: each
 * (previously hand-labelled, ref-focused) control resolves by accessible label.
 * Field now forwards refs, so the autofocus refs still attach.
 */
const common = { runId: 'r', nodeId: 'n', token: 't', onResolved: () => {} };

describe('interrupt forms (Field migration)', () => {
  it('ClarificationDialog answer field is label-associated', () => {
    render(<ClarificationDialog {...common} data={{ question: 'Q?' }} />);
    expect(screen.getByLabelText('Your answer').tagName).toBe('TEXTAREA');
  });

  it('ApprovalCard comment field is label-associated', () => {
    render(<ApprovalCard {...common} data={{ prompt: 'Approve?' }} />);
    expect(screen.getByLabelText('Comment (optional)').tagName).toBe('INPUT');
  });

  it('RefinementForm draft field is label-associated and seeded', () => {
    render(<RefinementForm {...common} data={{ current: 'draft text' }} />);
    const draft = screen.getByLabelText('Draft') as HTMLTextAreaElement;
    expect(draft.value).toBe('draft text');
  });
});
