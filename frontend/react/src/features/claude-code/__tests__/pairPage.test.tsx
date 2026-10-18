/**
 * ADR 0785 P1 — the device approval page is a consent surface.
 *
 * What it must never do: approve something the user did not read. So the
 * assertions are that the provider's sentence is shown verbatim, that Approve
 * stays disabled until the acknowledgement is ticked, that the approval sends
 * back the hash of the text SHOWN, and that a text change mid-page reloads it
 * rather than approving the old one.
 *
 * Sabotage-witnessed (w52): Approve enabled without the tick, the hash taken from
 * the consent version, the tick not cleared on reload, no reload on 409, the
 * feature marker ignored either way, Deny gated on the tick, the workspace not
 * shown. 'IGNORES a code in the URL' guards an ABSENCE (no code reads the query)
 * and has no sabotage short of adding a reader — an honest ceiling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Client = typeof import('../claudeCodeClient.js');
const getReq = vi.fn<Client['getPairRequest']>();
const approve = vi.fn<Client['approvePairRequest']>();
const deny = vi.fn<Client['denyPairRequest']>();
vi.mock('../claudeCodeClient.js', async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getPairRequest: (...a: Parameters<Client['getPairRequest']>) => getReq(...a),
  approvePairRequest: (...a: Parameters<Client['approvePairRequest']>) => approve(...a),
  denyPairRequest: (...a: Parameters<Client['denyPairRequest']>) => deny(...a),
}));

import { ClaudeCodePairPage } from '../ClaudeCodePairPage.js';
import { ClaudeCodeApiError as FakeApiError, type PairRequestView } from '../claudeCodeClient.js';

const QUOTE = 'Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.';
// A DIFFERENT sentence for the "terms changed" case, so the reload is seen to
// show the NEW text (the round-1 fixture reloaded the same quote).
const QUOTE2 = 'Updated terms: pairing a device lets workflows reach it only after you allow workflow tasks on it.';
const view = (hash: string, quote: string = QUOTE): PairRequestView => ({
  request: { userCode: 'BCDF-GH23', label: 'work mac', platform: 'darwin-arm64', requestedFrom: '203.0.113.7', createdAt: '2026-09-29T12:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' },
  workspaceId: 'org:acme',
  consent: { version: 'v1', quote, source: 'https://code.claude.com/docs/en/legal-and-compliance', fetchedAt: '2026-09-26', acknowledgements: ['I run it on my own machine.'] },
  consentHash: hash,
});

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/claude-code/pair" element={<ClaudeCodePairPage />} /></Routes>
    </MemoryRouter>,
  );
}

/** Open the page and TYPE the code, the only way in (RFC 8628 §5.4). */
function openWithTypedCode(code = 'BCDF-GH23') {
  renderAt('/claude-code/pair');
  fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

describe('the Claude Code device approval page', () => {
  beforeEach(() => { getReq.mockReset(); approve.mockReset(); deny.mockReset(); });
  afterEach(cleanup);

  it('shows the provider sentence verbatim and keeps Approve disabled until acknowledged', async () => {
    getReq.mockResolvedValue(view('h1'));
    openWithTypedCode();
    expect(await screen.findByText(QUOTE)).toBeTruthy();
    expect(screen.getByText('work mac')).toBeTruthy();
    const approveBtn = screen.getByRole('button', { name: /approve device/i }) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approveBtn.disabled).toBe(false);
  });

  it('approves with the hash of the text it SHOWED, then says to go back to the terminal', async () => {
    getReq.mockResolvedValue(view('h1'));
    approve.mockResolvedValue(undefined);
    openWithTypedCode();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /approve device/i }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('BCDF-GH23', 'h1'));
    expect(await screen.findByText(/device paired/i)).toBeTruthy();
  });

  it('a consent change mid-page reloads the text and requires a fresh tick — it never approves the old text', async () => {
    getReq.mockResolvedValueOnce(view('h1')).mockResolvedValueOnce(view('h2', QUOTE2));
    approve.mockRejectedValueOnce(new FakeApiError('changed', 409, 'consent_outdated'));
    openWithTypedCode();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /approve device/i }));
    expect(await screen.findByText(/terms on this page changed/i)).toBeTruthy();
    await waitFor(() => expect(getReq).toHaveBeenCalledTimes(2));
    // The NEW text is what is now on screen, and the old one is gone.
    expect(await screen.findByText(QUOTE2)).toBeTruthy();
    expect(screen.queryByText(QUOTE)).toBeNull();
    const approveBtn = await screen.findByRole('button', { name: /approve device/i }) as HTMLButtonElement;
    expect(approveBtn.disabled, 'the old acknowledgement does not carry over').toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  // Twin of 'an unknown-code 404 (no feature marker)…' below (same featureless 404);
  // kept (protected consent surface) and sharpened to the state's OTHER half:
  // nothing approvable is shown for a code that does not resolve.
  it('an expired or unknown code is its own state, not a generic error', async () => {
    getReq.mockRejectedValue(new FakeApiError('nope', 404));
    openWithTypedCode('ZZZZ-ZZZZ');
    expect(await screen.findByText(/code is not valid/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve device/i })).toBeNull();
    expect(getReq).toHaveBeenCalledWith('ZZZZ-ZZZZ');
  });

  it('IGNORES a code in the URL — a pre-filled link is a phishing lure; the user must type it', async () => {
    getReq.mockResolvedValue(view('h1'));
    renderAt('/claude-code/pair?code=BCDF-GH23');
    expect(screen.getByLabelText(/pairing code/i)).toBeTruthy();
    expect(getReq).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /approve device/i })).toBeNull();
  });

  it('shows where and when the request started, and which workspace it joins, before anyone approves', async () => {
    getReq.mockResolvedValue(view('h1'));
    openWithTypedCode();
    expect(await screen.findByText('203.0.113.7')).toBeTruthy();
    expect(screen.getByText('org:acme')).toBeTruthy();
    expect(screen.getByText(/did not start this on your own machine/i)).toBeTruthy();
  });

  it('sends the code the user typed, trimmed', async () => {
    renderAt('/claude-code/pair');
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: '  bcdf gh23  ' } });
    getReq.mockResolvedValue(view('h1'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(getReq).toHaveBeenCalledWith('bcdf gh23'));
  });

  it('deny is one click and needs no acknowledgement', async () => {
    getReq.mockResolvedValue(view('h1'));
    deny.mockResolvedValue(undefined);
    openWithTypedCode();
    fireEvent.click(await screen.findByRole('button', { name: /^deny$/i }));
    await waitFor(() => expect(deny).toHaveBeenCalledWith('BCDF-GH23'));
    expect(await screen.findByText(/request denied/i)).toBeTruthy();
  });

  it('a feature-gate 404 says the feature is off, NOT that a correctly typed code is invalid', async () => {
    getReq.mockRejectedValue(new FakeApiError('Claude Code is not enabled for this tenant.', 404, undefined, 'claude-code'));
    openWithTypedCode();
    expect(await screen.findByText(/not turned on for you/i)).toBeTruthy();
    expect(screen.queryByText(/that code is not valid/i)).toBeNull();
  });

  it('an unknown-code 404 (no feature marker) still says the code is not valid', async () => {
    getReq.mockRejectedValue(new FakeApiError('That pairing code is unknown or has expired.', 404));
    openWithTypedCode();
    expect(await screen.findByText(/that code is not valid/i)).toBeTruthy();
  });
});
