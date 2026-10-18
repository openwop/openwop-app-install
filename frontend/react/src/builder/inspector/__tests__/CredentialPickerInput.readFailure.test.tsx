/**
 * EMPTY-ON-FAIL-1 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed stored-keys read
 * is NOT "No keys stored yet".
 *
 * The catch set `refs` to [], so the picker's headline was the info alert "No
 * openai keys stored yet. Manage keys to add one." with the real error demoted to a
 * muted footnote — telling the user to add a key they may already have. The error
 * is now the failed state, checked before loading and empty, with a Retry.
 *
 * Break it by moving the `if (error !== null)` branch below the
 * `visible.length === 0` branch in CredentialPickerInput (or by restoring
 * `setRefs([])` in the catch with the error branch removed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listStoredRefs = vi.fn<() => Promise<readonly string[]>>();
vi.mock('../../../byok/lib/byokClient.js', () => ({
  listStoredRefs: () => listStoredRefs(),
}));

const { CredentialPickerInput } = await import('../CredentialPickerInput.js');

const FAILED = 'Couldn’t load your stored keys, so we can’t tell whether any are stored.';
const EMPTY = /No openai keys stored yet\./;

function view(): void {
  render(<MemoryRouter><CredentialPickerInput value={undefined} onChange={() => undefined} providerFilter="openai" /></MemoryRouter>);
}

beforeEach(() => { listStoredRefs.mockReset(); });
afterEach(cleanup);

describe('EMPTY-ON-FAIL-1 — a failed keys read is not "no keys stored"', () => {
  it('a rejected read shows the failure (with the server message), and NOT "No openai keys stored yet."', async () => {
    listStoredRefs.mockRejectedValue(new Error('secrets_503'));
    view();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.getByText('secrets_503')).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then says no keys are stored', async () => {
    listStoredRefs.mockRejectedValueOnce(new Error('secrets_503')).mockResolvedValue([]);
    view();
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(listStoredRefs).toHaveBeenCalledTimes(2);
  });

  it('a successful read holding no openai key still says "No openai keys stored yet." (positive control)', async () => {
    listStoredRefs.mockResolvedValue(['anthropic:default']);
    view();
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
