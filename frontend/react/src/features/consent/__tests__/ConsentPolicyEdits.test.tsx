/**
 * CONS-G3 + CONS-G4 (docs/steward/UX_UPGRADE-consent.md, closed 2026-08-01).
 *
 * G3: unsaved policy edits used to be silently discarded on org switch, and
 * Save was always enabled with no dirty indication. Now: dirty edits show an
 * "Unsaved changes" chip, Save gates on dirty, and switching org while dirty
 * asks first (cancel keeps the org AND the edits).
 *
 * G4: a failed `listRecords` used to render the "No consent records yet"
 * empty state — on the surface an operator consults for GDPR accountability.
 * Now it renders a designed failure card with retry; a genuinely empty org
 * still gets the real empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

let confirmAnswer = true;
const confirmFn = vi.fn(async () => confirmAnswer);
let recordsImpl: () => Promise<unknown[]> = async () => [];

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Globex' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: ['EU'], defaultMode: 'opt-in' }, legalHold: null })),
  listRecords: vi.fn(() => recordsImpl()),
  getSubject: vi.fn(async () => null),
  deleteSubject: vi.fn(async () => ({ ok: true, consentRecord: true, erasure: { total: 0, failed: 0, keysResolved: 0 } })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmFn(...(a as [])) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

const regionsInput = (): HTMLInputElement => screen.getByDisplayValue('EU') as HTMLInputElement;

beforeEach(() => { vi.clearAllMocks(); confirmAnswer = true; recordsImpl = async () => []; });
afterEach(cleanup);

describe('CONS-G3 — unsaved policy edits', () => {
  it('shows a dirty chip and enables Save only when something changed', async () => {
    render(<ConsentPage />);
    await waitFor(() => expect(regionsInput()).toBeTruthy());
    const save = screen.getByRole('button', { name: /save policy/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // clean = nothing to save
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
    fireEvent.change(regionsInput(), { target: { value: 'EU, UK' } });
    expect((screen.getByRole('button', { name: /save policy/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it('asks before an org switch discards dirty edits — cancel keeps both', async () => {
    render(<ConsentPage />);
    await waitFor(() => expect(regionsInput()).toBeTruthy());
    fireEvent.change(regionsInput(), { target: { value: 'EU, UK' } });
    confirmAnswer = false;
    const picker = screen.getByLabelText(/workspace|organization/i) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'org-2' } });
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(picker.value).toBe('org-1'); // stayed
    expect((screen.getByDisplayValue('EU, UK') as HTMLInputElement)).toBeTruthy(); // edits kept
  });

  it('a clean org switch never asks', async () => {
    render(<ConsentPage />);
    await waitFor(() => expect(regionsInput()).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/workspace|organization/i), { target: { value: 'org-2' } });
    expect(confirmFn).not.toHaveBeenCalled();
  });
});

describe('CONS-G4 — records read honesty', () => {
  it('a failed read renders the failure card with retry, NOT the empty state', async () => {
    recordsImpl = async () => { throw new Error('503'); };
    render(<ConsentPage />);
    await screen.findByText(/couldn’t load consent records/i);
    expect(screen.queryAllByText(/no consent records yet/i).length).toBe(0);
    // Retry with the read healed shows the real empty state.
    recordsImpl = async () => [];
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findAllByText(/no consent records yet/i);
  });

  it('a genuinely empty org still gets the real empty state', async () => {
    render(<ConsentPage />);
    await screen.findAllByText(/no consent records yet/i);
    expect(screen.queryAllByText(/couldn’t load consent records/i).length).toBe(0);
  });
});
