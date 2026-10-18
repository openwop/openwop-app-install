/**
 * EMPTY-ON-FAIL-7 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed forms read is NOT
 * "No forms in this organization yet".
 *
 * The forms catch set the list to [], so opening "Link registration form" said "No
 * forms in this organization yet — create one first." with no error — and since
 * WEB-G1 made binding a picker, it also removed the only bind control. The failure
 * is now its own state with a Retry; the empty copy needs a successful read.
 *
 * Break it by dropping the `formsFailed ?` branch in WebinarsPage's bind form (or by
 * restoring `setForms([])` in the forms catch with the flag ignored, or an inert
 * Retry) — each sabotage-witnessed in /grade-tests w52. On failure the bind
 * CONTROL is gone too (no picker, no "Link form"): offering it over a read that
 * failed is the form-on-failure family. `formBinding.test.tsx` carries the
 * picker's success paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MarketingEvent, OrgRef } from '../webinarsClient.js';
import type { FormDef } from '../../forms/formsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const listForms = vi.fn<(orgId: string) => Promise<FormDef[]>>();
const ORGS: OrgRef[] = [{ orgId: 'org-1', name: 'Acme' }];
const FORM_A: FormDef = {
  formId: 'form-a', orgId: 'org-1', title: 'Webinar signup', status: 'published', fields: [],
  createToContact: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const EVENT: MarketingEvent = {
  eventId: 'ev-1', provider: 'zoom', providerEventId: 'z-1', title: 'Launch webinar',
  createdAt: '2026-07-01T00:00:00.000Z', counts: { registrantCount: 3, attendeeCount: 2, noShowCount: 1 },
};

vi.mock('../webinarsClient.js', async (orig) => ({
  ...(await orig<typeof import('../webinarsClient.js')>()),
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => ORGS),
  listWebinarEvents: vi.fn(async (): Promise<MarketingEvent[]> => [EVENT]),
}));
vi.mock('../../forms/formsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../forms/formsClient.js')>()),
  listForms: (orgId: string) => listForms(orgId),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));

const { WebinarsPage } = await import('../WebinarsPage.js');

const FAILED = 'Couldn’t load this organization’s forms, so none can be picked right now.';
const EMPTY = 'No forms in this organization yet — create one first.';

async function openBindForm(): Promise<void> {
  render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
  await act(async () => {});
  await screen.findByText('Launch webinar');
  fireEvent.click(screen.getByRole('button', { name: 'Link registration form' }));
}

beforeEach(() => { listForms.mockReset(); });
afterEach(cleanup);

describe('EMPTY-ON-FAIL-7 — a failed forms read is not "no forms"', () => {
  it('a rejected forms read shows the failure, and NOT "No forms in this organization yet"', async () => {
    listForms.mockRejectedValue(new Error('forms_500'));
    await openBindForm();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
    // No bind control over a failed read.
    expect(screen.queryByRole('combobox', { name: /registration form/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^link form$/i })).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then says there are none', async () => {
    listForms.mockRejectedValueOnce(new Error('forms_500')).mockResolvedValue([]);
    await openBindForm();
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(listForms).toHaveBeenCalledTimes(2);
    expect(listForms).toHaveBeenLastCalledWith('org-1');
  });

  it('Retry into a NON-empty read restores the picker with the real forms', async () => {
    listForms.mockRejectedValueOnce(new Error('forms_500')).mockResolvedValue([FORM_A]);
    await openBindForm();
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const select = await screen.findByRole('combobox', { name: /registration form/i });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toContain('Webinar signup');
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('a successful empty read still says "No forms in this organization yet" (positive control)', async () => {
    listForms.mockResolvedValue([]);
    await openBindForm();
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
