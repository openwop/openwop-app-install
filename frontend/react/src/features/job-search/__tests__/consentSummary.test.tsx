/**
 * ADR 0541 P4 — the consent surface, after `/ux-review`.
 *
 * The review found two real gaps and these pin the fixes:
 *
 *  1. The form collected six bounds and let the user authorise automatic
 *     submission without ever seeing them said back. A user who cannot describe
 *     what they authorised has not consented to it.
 *  2. Issuing had LESS friction than revoking — the higher-stakes act was the
 *     easier one. The submit is now gated on a complete, restated set of bounds.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listGrants: vi.fn(async () => []),
  createGrant: vi.fn(async () => ({})),
  revokeGrant: vi.fn(async () => undefined),
}));

import { ApplyGrantPage } from '../ApplyGrantPage.js';

const field = (label: RegExp): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;

async function fillEverything(): Promise<void> {
  fireEvent.change(field(/campaign/i), { target: { value: 'spring-search' } });
  fireEvent.change(field(/maximum applications/i), { target: { value: '25' } });
  fireEvent.change(field(/queued for review/i), { target: { value: '10' } });
  fireEvent.change(field(/applications per hour/i), { target: { value: '4' } });
  fireEvent.change(field(/^sites/i), { target: { value: 'boards.example.com\njobs.example.com' } });
  fireEvent.change(field(/expires/i), { target: { value: '2027-03-14' } });
}

describe('the consent restatement', () => {
  beforeEach(() => { render(<ApplyGrantPage />); });
  afterEach(cleanup);

  it('will not let a user authorise until every bound is set', async () => {
    const issue = await screen.findByRole('button', { name: /issue grant/i });
    expect((issue as HTMLButtonElement).disabled, 'issuing must not be easier than revoking').toBe(true);
    expect(screen.getByText(/fill in every limit/i)).toBeTruthy();
  });

  it('states the bounds back in plain language once they are complete', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    // The specific numbers must appear — a generic "you are authorising this
    // campaign" would be the same non-consent in friendlier words.
    const summary = screen.getByText(/you are authorising up to/i);
    expect(summary.textContent).toContain('25');
    expect(summary.textContent).toContain('4');
    expect(summary.textContent, 'the site COUNT is part of the scope being consented to').toContain('2 sites');
    expect(summary.textContent, 'revocability is part of what makes this safe to agree to').toMatch(/revoke/i);
  });

  it('enables issuing only once the restatement exists', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    expect((screen.getByRole('button', { name: /issue grant/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('makes the restatement the BUTTON’s description, not text beside it', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    const issue = screen.getByRole('button', { name: /issue grant/i });
    const describedBy = issue.getAttribute('aria-describedby');
    expect(describedBy, 'a screen-reader user must hear the bounds as part of the control').toBe('job-search-consent');
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/you are authorising up to/i);
  });

  it('withdraws the restatement when a bound is removed', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    // Clearing the sites removes the SCOPE, so the consent is no longer
    // describable and the button must lock again rather than silently
    // authorising an unscoped grant.
    fireEvent.change(field(/^sites/i), { target: { value: '' } });
    expect((screen.getByRole('button', { name: /issue grant/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/fill in every limit/i)).toBeTruthy();
  });
});
