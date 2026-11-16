/**
 * Accessible names on PromptLibraryPage's form controls (the `/prompts` page of
 * ADR 0993, migrated to the `ui/Field` primitives in #65; DESIGN.md `ui/Field`).
 * Every control resolves by its accessible label to the RIGHT control: the
 * always-visible filters (aria-label, scoped to the filter bar) and the editor modal
 * opened via "+ New prompt" (Field label↔control association). Required editor
 * fields carry `aria-required`. A screen-reader user cannot otherwise tell the
 * fields apart.
 * Breaks if: a filter's aria-label or a Field `label` is dropped, a field renders the
 * wrong control, or `required` is removed from Name / Prompt text (or from `ui/Field`).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render as rtlRender, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

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
// The page binds its tab to `?tab=` (ADR 0993 D8), so it renders inside a router, as in the app.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
beforeEach(() => localStorage.clear());

describe('PromptLibraryPage forms (Field migration)', () => {
  it('filter controls are label-associated', async () => {
    render(<PromptLibraryPage />);
    // Filter controls are label-associated via aria-label (the filter bar uses
    // raw inputs with descriptive accessible names, distinct from the dialog's
    // Field labels). Scoped to the filter bar, so another control cannot answer.
    const filters = within(await screen.findByRole('group', { name: 'Filter prompts' }));
    expect(filters.getByLabelText('Search prompts').getAttribute('type')).toBe('search');
    expect(filters.getByLabelText('Filter by kind').tagName).toBe('SELECT'); // filter Kind select
  });

  it('the editor modal exposes all fields by label', async () => {
    render(<PromptLibraryPage />);
    // "+ New prompt" renders twice (page header action + empty-state action);
    // either opens the same editor, so click the first.
    fireEvent.click((await screen.findAllByText('+ New prompt'))[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'New prompt' });
    const q = within(dialog);
    // getByLabelText throws when no control carries the label; the tag pins that the
    // label names the RIGHT control.
    expect(q.getByLabelText(/Name/).tagName).toBe('INPUT');
    expect(q.getByLabelText('Kind').tagName).toBe('SELECT');
    expect(q.getByLabelText('Description').tagName).toBe('INPUT');
    expect(q.getByLabelText(/Prompt text/).tagName).toBe('TEXTAREA');
    expect(q.getByLabelText(/Tags/).tagName).toBe('INPUT');
    // required fields carry aria-required (Field `required` prop)
    expect(q.getByLabelText(/Name/).getAttribute('aria-required')).toBe('true');
    expect(q.getByLabelText(/Prompt text/).getAttribute('aria-required')).toBe('true');
  });
});
