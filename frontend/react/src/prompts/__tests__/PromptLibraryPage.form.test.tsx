import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

// Mock the page's data sources so it renders without a backend.
vi.mock('../promptsClient.js', () => ({
  listPrompts: vi.fn(() => Promise.resolve([])),
  renderLocal: vi.fn(() => ''),
}));
vi.mock('../../client/runsClient.js', () => ({
  getCapabilities: vi.fn(() => Promise.resolve({})),
}));

import { PromptLibraryPage } from '../PromptLibraryPage.js';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

/**
 * Verifies the Field-primitive migration of PromptLibraryPage: every form
 * control resolves by its accessible label (proves label↔control association
 * survived the migration), for both the always-visible filters and the editor
 * modal opened via "+ New prompt".
 */
describe('PromptLibraryPage forms (Field migration)', () => {
  it('filter controls are label-associated', async () => {
    render(<PromptLibraryPage />);
    await waitFor(() => expect(screen.getByLabelText('Search')).toBeTruthy());
    expect(screen.getByLabelText('Kind')).toBeTruthy(); // filter Kind select
  });

  it('the editor modal exposes all fields by label', async () => {
    render(<PromptLibraryPage />);
    await waitFor(() => expect(screen.getByText('+ New prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('+ New prompt'));

    const dialog = await screen.findByRole('dialog', { name: 'New prompt' });
    const q = within(dialog);
    expect(q.getByLabelText(/Name/)).toBeTruthy();
    expect(q.getByLabelText('Kind')).toBeTruthy();
    expect(q.getByLabelText('Description')).toBeTruthy();
    expect(q.getByLabelText(/Prompt text/)).toBeTruthy();
    expect(q.getByLabelText(/Tags/)).toBeTruthy();
    // required fields carry aria-required (Field `required` prop)
    expect(q.getByLabelText(/Name/).getAttribute('aria-required')).toBe('true');
    expect(q.getByLabelText(/Prompt text/).getAttribute('aria-required')).toBe('true');
  });
});
