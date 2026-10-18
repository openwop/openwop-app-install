import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

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
 * Accessible names on PromptLibraryPage's form controls (the Field-primitive
 * migration, #65; DESIGN.md `ui/Field`). Every control resolves by its accessible
 * label — the always-visible filters (aria-label) and the editor modal opened via
 * "+ New prompt" (Field label↔control association) — and required editor fields
 * carry `aria-required`. A screen-reader user cannot otherwise tell the fields apart.
 * Breaks if: a filter's aria-label or a Field `label` is dropped, or `required` is
 * removed from Name / Prompt text (probes w24g1-plf-*, /grade-tests wave 24).
 */
describe('PromptLibraryPage forms (Field migration)', () => {
  it('filter controls are label-associated', async () => {
    render(<PromptLibraryPage />);
    // Filter controls are label-associated via aria-label (the filter bar uses
    // raw inputs with descriptive accessible names, distinct from the dialog's
    // Field labels). getByLabelText resolves the aria-label.
    await screen.findByLabelText('Search prompts');
    expect(screen.getByLabelText('Filter by kind').tagName).toBe('SELECT'); // filter Kind select
  });

  it('the editor modal exposes all fields by label', async () => {
    render(<PromptLibraryPage />);
    // "+ New prompt" renders twice (page header action + empty-state action);
    // either opens the same editor, so click the first.
    fireEvent.click((await screen.findAllByText('+ New prompt'))[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'New prompt' });
    const q = within(dialog);
    // getByLabelText throws when no control carries the label — each line is an assertion.
    q.getByLabelText(/Name/);
    q.getByLabelText('Kind');
    q.getByLabelText('Description');
    q.getByLabelText(/Prompt text/);
    q.getByLabelText(/Tags/);
    // required fields carry aria-required (Field `required` prop)
    expect(q.getByLabelText(/Name/).getAttribute('aria-required')).toBe('true');
    expect(q.getByLabelText(/Prompt text/).getAttribute('aria-required')).toBe('true');
  });
});
