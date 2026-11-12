/**
 * ADR 1100 D3 — the accessibility panel says WHERE each issue is. Before, it
 * dropped `nodeRef`, so a page with three unlabelled pictures showed the same
 * line three times with no section named.
 *
 * Red when: the location line is not rendered (case 1); a ref the host cannot
 * describe renders an empty line (case 2); the location is not a way there when
 * the host can take the author to it (case 3).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { A11yIssuesPanel } from '../A11yIssuesPanel.js';
import type { A11yIssue } from '../contentA11y.js';

const issue = (id: string, nodeRef?: string): A11yIssue => ({ id, kind: 'missing-alt', severity: 'error', wcag: '1.1.1', messageKey: 'missingAlt', ...(nodeRef ? { nodeRef } : {}) });

describe('A11yIssuesPanel location', () => {
  it('names the section each issue is in', () => {
    render(<A11yIssuesPanel issues={[issue('a', 's1'), issue('b', 's2')]} describeRef={(r) => ({ s1: 'Section 1: Hero', s2: 'Section 4: Columns' } as Record<string, string>)[r]} />);
    expect(screen.getByText('Section 1: Hero')).toBeTruthy();
    expect(screen.getByText('Section 4: Columns')).toBeTruthy();
    expect(screen.getAllByText('An image is missing alternative text.')).toHaveLength(2);
  });

  it('shows no location for a ref the host cannot describe, or without describeRef', () => {
    const { container } = render(<A11yIssuesPanel issues={[issue('a', 'gone'), issue('b')]} describeRef={() => undefined} />);
    expect(container.querySelectorAll('.u-text-muted.u-label-sm')).toHaveLength(1); // only the summary line
    render(<A11yIssuesPanel issues={[issue('c', 's1')]} />);
    expect(screen.queryByText(/Section/)).toBeNull();
  });

  it('with onLocate the location is a button that takes the author there', () => {
    const onLocate = vi.fn();
    render(<A11yIssuesPanel issues={[issue('a', 'c1#2')]} describeRef={() => 'Section 2: Columns, image 2'} onLocate={onLocate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to Section 2: Columns, image 2' }));
    expect(onLocate).toHaveBeenCalledWith('c1#2');
  });

  it('an incomplete check is never presented as an all-clear', () => {
    render(<A11yIssuesPanel issues={[]} incomplete="A shared section could not be read." />);
    expect(screen.getByText('A shared section could not be read.')).toBeTruthy();
    expect(screen.queryByText('No accessibility issues found.')).toBeNull();
  });

  it('an incomplete check with issues shows the warning beside the list', () => {
    render(<A11yIssuesPanel issues={[issue('a', 's1')]} incomplete="A shared section could not be read." />);
    expect(screen.getByText('A shared section could not be read.')).toBeTruthy();
    expect(screen.getByText('An image is missing alternative text.')).toBeTruthy();
  });
});
