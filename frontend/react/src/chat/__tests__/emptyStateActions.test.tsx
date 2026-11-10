/**
 * ADR 1040 D3 — an empty state can FILL the composer as well as send.
 *
 * `renderEmptyState(send, { fill, send })`: the first argument stays the send
 * callback every existing consumer uses; `fill` seeds the composer (what the
 * host's own welcome does) without sending.
 *
 * Red when: ConversationView stops passing the second argument, wires `fill`
 * to the send callback, or wires `send` to the composer seed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../ChatInput.js', () => ({
  ChatInput: ({ seed }: { seed?: { text: string } }) => <div data-testid="composer">{seed?.text ?? ''}</div>,
}));

import { ConversationView, type EmptyStateActions } from '../ConversationView.js';

afterEach(cleanup);

function renderView(onPickSuggestion: (t: string) => void): void {
  render(
    <ConversationView
      messages={[]} tenantId="t" error={null} isSending={false}
      onPickSuggestion={onPickSuggestion}
      renderEmptyState={(send, actions: EmptyStateActions) => (
        <div>
          <button type="button" onClick={() => send('legacy send')}>legacy</button>
          <button type="button" onClick={() => actions.fill('Outline chapter 3')}>fill</button>
          <button type="button" onClick={() => actions.send('Summarize my book')}>send</button>
        </div>
      )}
      onSend={vi.fn()} onCancel={null}
      supportsAudioInput={false} supportsImageInput={false} supportsPdfInput={false}
      onResolveInterrupt={vi.fn(async () => undefined)} onRegenerate={vi.fn()} onReconfigureBYOK={vi.fn()}
      hasOlderMessages={false} isLoadingEarlier={false} onLoadEarlier={vi.fn()}
    />,
  );
}

describe('ADR 1040 D3 — empty-state actions', () => {
  it('fill seeds the composer and sends nothing', () => {
    const onPick = vi.fn();
    renderView(onPick);
    fireEvent.click(screen.getByText('fill'));
    expect(screen.getByTestId('composer').textContent).toBe('Outline chapter 3');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('send (and the legacy first argument) send the text and leave the composer empty', () => {
    const onPick = vi.fn();
    renderView(onPick);
    fireEvent.click(screen.getByText('send'));
    fireEvent.click(screen.getByText('legacy'));
    expect(onPick.mock.calls).toEqual([['Summarize my book'], ['legacy send']]);
    expect(screen.getByTestId('composer').textContent).toBe('');
  });
});
