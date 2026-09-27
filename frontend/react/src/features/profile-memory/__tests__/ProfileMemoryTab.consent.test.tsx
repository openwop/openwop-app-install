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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileMemoryTab } from '../ProfileMemoryTab.js';

const getExtractionGrant = vi.fn();

vi.mock('../memoryExtractionClient.js', () => ({
  getExtractionGrant: (...a: unknown[]) => getExtractionGrant(...a),
  setExtractionGrant: vi.fn(),
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

beforeEach(() => { getExtractionGrant.mockReset(); });

describe('ConsentToggle — a failed read is not an absent feature', () => {
  it('404 (null) hides the control entirely — the feature really is unavailable', async () => {
    getExtractionGrant.mockResolvedValue(null);
    render(<ProfileMemoryTab />);
    // Wait for the browser below to settle before asserting an ABSENCE, or this
    // passes vacuously against a tree that simply hasn't rendered yet.
    expect(await screen.findByText(/No memories yet/i)).toBeTruthy();
    expect(screen.queryByText(CONSENT_LABEL)).toBeNull();
    expect(screen.queryByText(FAILED_COPY)).toBeNull();
  });

  it('200 shows the checkbox reflecting the granted state', async () => {
    getExtractionGrant.mockResolvedValue({ granted: true, updatedAt: '2026-07-25' });
    render(<ProfileMemoryTab />);
    expect(await screen.findByText(CONSENT_LABEL)).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
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
