/**
 * ADR 0565 — selection-scoped rewrite (Phase 1, append-only shape).
 *
 * Select a span in a COMPLETED assistant bubble → a floating Rewrite /
 * Shorter / Longer toolbar; a verb quotes the span (blockquote + localized
 * instruction) into the ALREADY-MOUNTED composer via the composerSeed live
 * lane. Both polarities are pinned: where the affordance appears (completed
 * assistant, inside the feed) and where it must NOT (user bubbles, streaming
 * bubbles, selections outside the feed) — plus the seam contract that a live
 * sink consumes INSTEAD of the one-shot stage, with the stage as fallback.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// The recorder hook touches MediaRecorder; stub it so ChatInput mounts in jsdom.
const recorderState = { isSupported: false, isRecording: false };
vi.mock('../hooks/useAudioRecorder.js', () => ({
  useAudioRecorder: () => ({
    isSupported: recorderState.isSupported,
    isRecording: recorderState.isRecording,
    error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
  }),
  blobToBase64: vi.fn(),
}));

import { SelectionRewriteOverlay } from '../SelectionRewrite.js';
import { ChatInput } from '../ChatInput.js';
import { seedLiveComposer, subscribeLiveComposer, takeStagedComposerDraft } from '../composerSeed.js';

/** Build a fake feed: a container holding one message bubble with a text node. */
function renderFeedWith(bubbleAttrs: { role: string; streaming?: boolean }, opts?: { detachedBox?: boolean }) {
  const containerRef = createRef<HTMLDivElement>();
  const utils = render(
    <div>
      <div ref={containerRef} data-testid="feed">
        {!opts?.detachedBox && (
          <div className="msgbubble-box" data-role={bubbleAttrs.role} {...(bubbleAttrs.streaming ? { 'data-streaming': 'true' } : {})}>
            The quick brown fox jumps over the lazy dog
          </div>
        )}
      </div>
      {opts?.detachedBox && (
        <div className="msgbubble-box" data-role={bubbleAttrs.role}>
          The quick brown fox jumps over the lazy dog
        </div>
      )}
      <SelectionRewriteOverlay containerRef={containerRef} />
    </div>,
  );
  return { containerRef, ...utils };
}

/** Select the bubble's text node and fire selectionchange. */
function selectBubbleText(): void {
  const box = document.querySelector('.msgbubble-box')!;
  const textNode = box.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 4); // "quick brown fox…"
  range.setEnd(textNode, 19);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => { fireEvent(document, new Event('selectionchange')); });
}

beforeEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  takeStagedComposerDraft(); // drain residue between tests
});
afterEach(() => { cleanup(); });

describe('SelectionRewriteOverlay (ADR 0565)', () => {
  it('shows the Rewrite / Shorter / Longer toolbar for a selection in a completed assistant bubble', () => {
    renderFeedWith({ role: 'assistant' });
    selectBubbleText();
    const toolbar = screen.getByRole('toolbar', { name: 'selRewriteToolbarAria' });
    expect(toolbar).toBeTruthy();
    for (const verb of ['selRewrite', 'selShorter', 'selLonger']) {
      expect(screen.getByRole('button', { name: verb })).toBeTruthy();
    }
  });

  it('does NOT appear for a selection in a USER bubble', () => {
    renderFeedWith({ role: 'user' });
    selectBubbleText();
    expect(screen.queryByRole('toolbar', { name: 'selRewriteToolbarAria' })).toBeNull();
  });

  it('does NOT appear while the assistant bubble is still streaming', () => {
    renderFeedWith({ role: 'assistant', streaming: true });
    selectBubbleText();
    expect(screen.queryByRole('toolbar', { name: 'selRewriteToolbarAria' })).toBeNull();
  });

  it('does NOT appear for an assistant bubble outside the feed container', () => {
    renderFeedWith({ role: 'assistant' }, { detachedBox: true });
    selectBubbleText();
    expect(screen.queryByRole('toolbar', { name: 'selRewriteToolbarAria' })).toBeNull();
  });

  it('a verb seeds the live composer with the blockquoted span + that verb\'s instruction, then hides', () => {
    const seeded: string[] = [];
    const unsub = subscribeLiveComposer((text) => { seeded.push(text); return true; });
    try {
      renderFeedWith({ role: 'assistant' });
      selectBubbleText();
      fireEvent.click(screen.getByRole('button', { name: 'selShorter' }));
      expect(seeded).toEqual(['> quick brown fox\n\nselShorterInstruction']);
      // Live sink consumed it — nothing left on the one-shot stage.
      expect(takeStagedComposerDraft()).toBeNull();
      expect(screen.queryByRole('toolbar', { name: 'selRewriteToolbarAria' })).toBeNull();
    } finally { unsub(); }
  });

  it('multi-line selections are quoted line-by-line', () => {
    const seeded: string[] = [];
    const unsub = subscribeLiveComposer((text) => { seeded.push(text); return true; });
    try {
      const containerRef = createRef<HTMLDivElement>();
      render(
        <div>
          <div ref={containerRef}>
            <div className="msgbubble-box" data-role="assistant">{'line one\nline two'}</div>
          </div>
          <SelectionRewriteOverlay containerRef={containerRef} />
        </div>,
      );
      const textNode = document.querySelector('.msgbubble-box')!.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 17);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      act(() => { fireEvent(document, new Event('selectionchange')); });
      fireEvent.click(screen.getByRole('button', { name: 'selRewrite' }));
      expect(seeded).toEqual(['> line one\n> line two\n\nselRewriteInstruction']);
    } finally { unsub(); }
  });
});

describe('composerSeed live lane (ADR 0565)', () => {
  it('falls back to the one-shot stage when no live composer is mounted', () => {
    seedLiveComposer('> quoted\n\nselRewriteInstruction');
    expect(takeStagedComposerDraft()).toBe('> quoted\n\nselRewriteInstruction');
  });

  it('a mounted ChatInput consumes a live seed into its textarea (and the stage stays empty)', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => { seedLiveComposer('> quoted span\n\nselShorterInstruction'); });
    expect(ta.value).toBe('> quoted span\n\nselShorterInstruction');
    expect(takeStagedComposerDraft()).toBeNull();
  });

  it('a live seed APPENDS below in-progress text instead of clobbering it', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'my own thought' } });
    act(() => { seedLiveComposer('> quoted\n\nselLongerInstruction'); });
    expect(ta.value).toBe('my own thought\n\n> quoted\n\nselLongerInstruction');
  });
});
