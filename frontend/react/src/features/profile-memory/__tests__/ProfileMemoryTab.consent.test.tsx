/**
 * ADR 0120 — the memory-learning consent control's THREE load outcomes.
 *
 * The sibling `memoryExtractionClient.test.ts` already pins the client half
 * (404 → null, 200 → grant), and its docstring says "a 404 … returns null so the
 * toggle hides". The component then collapsed a THIRD outcome into that same
 * hide: an empty `.catch()` commented "feature unavailable — stay hidden" also
 * swallowed 403 ("Sign in to manage memory extraction"), 500 and network errors.
 *
 * So the control a user opens this tab to switch OFF could be silently absent
 * while auto-learning was still running — and absence reads as "not enabled".
 *
 * All three arms are asserted, including the legitimate 404 hide: pinning only
 * the failure arm would stay green if the component regressed to "always show
 * the error", and pinning only the hide is what let this through the first time.
 *
 * ADR 0982 D2 adds a fourth: an account that can never extract (anonymous, or no
 * personal workspace) sees its reason instead of a checkbox, and one still holding
 * a grant can always opt OUT. D7 / MAE2UX-6: the hint says when it runs and what it
 * reads, and is the checkbox's accessible description.
 *
 * Sabotage-witnessed (w12 grade-tests; re-probed wave 108): showing the control on
 * a null grant, an inverted `checked`, a detached hint, a checkbox for an
 * unavailable account, the wrong unavailable reason, no Turn-off for a held grant
 * or a Turn-off that turns it on, a swallowed load error, and a checkbox in the
 * error branch each turn a named case red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ProfileMemoryTab } from '../ProfileMemoryTab.js';
import type { ExtractionGrant } from '../memoryExtractionClient.js';

// Typed against the real client signatures, so a fixture that drifts from
// `ExtractionGrant` fails `tsc` rather than passing as an untyped mock.
const getExtractionGrant = vi.fn<() => Promise<ExtractionGrant | null>>();
const setExtractionGrant = vi.fn<(granted: boolean) => Promise<ExtractionGrant>>();

vi.mock('../memoryExtractionClient.js', () => ({
  getExtractionGrant: () => getExtractionGrant(),
  setExtractionGrant: (granted: boolean) => setExtractionGrant(granted),
}));

// The tab composes MemoryBrowser, which drives these. Kept inert so the
// assertions below are about the consent control only.
vi.mock('../profileMemoryClient.js', () => ({
  // F5 — the tab now reads notes + `recallOnlyCount` in ONE request, so this
  // mock supplies the combined shape. `listMemories` stays exported because the
  // module still offers it to other callers.
  listMemoriesWithRecall: vi.fn(async () => ({ notes: [] })),
  listMemories: vi.fn(async () => []),
  addMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

const CONSENT_LABEL = /Automatically learn durable facts from my chats/i;
const FAILED_COPY = /Could not read whether memory-learning is on/i;

beforeEach(() => { getExtractionGrant.mockReset(); setExtractionGrant.mockReset(); });

describe('ConsentToggle — a failed read is not an absent feature', () => {
  it('404 (null) hides the control entirely — the feature really is unavailable', async () => {
    getExtractionGrant.mockResolvedValue(null);
    render(<ProfileMemoryTab />);
    // Wait for the browser below to settle before asserting an ABSENCE, or this
    // passes vacuously against a tree that simply hasn't rendered yet.
    expect(await screen.findByText(/No memories yet/i)).toBeTruthy();
    // ...and for the grant read itself: the list settling is a different load.
    expect(getExtractionGrant).toHaveBeenCalledTimes(1);
    await act(async () => { await getExtractionGrant.mock.results[0]?.value; });
    expect(screen.queryByText(CONSENT_LABEL)).toBeNull();
    expect(screen.queryByText(FAILED_COPY)).toBeNull();
  });

  it('200 shows the checkbox reflecting the granted state', async () => {
    getExtractionGrant.mockResolvedValue({ granted: true, updatedAt: '2026-07-25', available: true });
    render(<ProfileMemoryTab />);
    expect(await screen.findByText(CONSENT_LABEL)).toBeTruthy();
    const box = screen.getByRole('checkbox');
    expect(box).toBeInstanceOf(HTMLInputElement);
    expect(box instanceof HTMLInputElement && box.checked).toBe(true);
    // ADR 0982 D7 — the hint says when it runs and what it reads, not "during chats".
    expect(screen.getByText(/only chats in your personal workspace/i)).toBeTruthy();
    expect(screen.getByText(/each time you start a new chat/i)).toBeTruthy();
    // MAE2UX-6 — the disclosure is the box's accessible description, not a nearby paragraph.
    const hintId = box.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId ?? '')?.textContent).toMatch(/only chats in your personal workspace/);
  });

  it('ADR 0982 D2 — an account that can never extract sees why, and no checkbox', async () => {
    getExtractionGrant.mockResolvedValue({ granted: false, updatedAt: null, available: false, unavailableReason: 'no-personal-workspace' });
    render(<ProfileMemoryTab />);
    expect(await screen.findByText(/needs a personal workspace/i)).toBeTruthy();
    expect(screen.getByText(CONSENT_LABEL)).toBeTruthy();
    expect(screen.queryByText(/Sign in to let your assistant learn/i)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // No grant held ⇒ nothing to turn off (the control for the case below).
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
  });

  it('an unavailable account still holding a grant can turn it OFF (code-review #4)', async () => {
    getExtractionGrant.mockResolvedValue({ granted: true, updatedAt: '2026-07-25', available: false, unavailableReason: 'no-personal-workspace' });
    setExtractionGrant.mockResolvedValue({ granted: false, updatedAt: '2026-07-26', available: false, unavailableReason: 'no-personal-workspace' });
    render(<ProfileMemoryTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    // The button is the write: exactly one revoke, never a grant.
    expect(setExtractionGrant).toHaveBeenCalledTimes(1);
    expect(setExtractionGrant).toHaveBeenCalledWith(false);
    // The revoked grant replaces the held one: nothing left to turn off.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('ADR 0982 D2 — an anonymous visitor is told to sign in, and gets no checkbox', async () => {
    getExtractionGrant.mockResolvedValue({ granted: false, updatedAt: null, available: false, unavailableReason: 'sign-in' });
    render(<ProfileMemoryTab />);
    expect(await screen.findByText(/Sign in to let your assistant learn/i)).toBeTruthy();
    expect(screen.queryByText(/needs a personal workspace/i)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a non-404 failure surfaces the control as UNKNOWN — never hidden', async () => {
    getExtractionGrant.mockRejectedValue(new Error('Sign in to manage memory extraction.'));
    render(<ProfileMemoryTab />);
    // Settle on copy present in BOTH the fixed and the silently-hidden state, so
    // every assertion below is actually REACHED when the fix is reverted. Waiting
    // on FAILED_COPY threw first, which meant the two checks after it were never
    // evaluated under sabotage — the file went red on the wait, not on them.
    expect(await screen.findByText(/No memories yet/i)).toBeTruthy();
    // The label must be on screen so the setting's EXISTENCE is known...
    expect(screen.getByText(CONSENT_LABEL)).toBeTruthy();
    expect(screen.getByText(FAILED_COPY)).toBeTruthy();
    // ...but NO checkbox: an unchecked box would assert an "off" state we never read.
    //
    // NB this assertion guards a DIFFERENT regression from the one above. Hiding the
    // control silently also leaves no checkbox, so it survives that sabotage — it
    // only fires if the error branch starts rendering the ordinary toggle. Probed
    // separately rather than assumed live.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
