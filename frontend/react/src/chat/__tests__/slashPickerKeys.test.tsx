/**
 * ADR 0768 follow-up D4 — the slash picker shows its keys, and the words are
 * TRUE: Tab picks (like Enter) and Esc closes. The design drew "⇥ fill
 * inputs"; that is not what Tab does here, so the tip does not say it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }), Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey }));
vi.mock('../lib/workflowMentions.js', async (orig) => ({
  ...(await orig<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
  listWorkflowMentions: () => [{ displayName: 'Summarize', slug: 'summarize', description: 'd', toolName: 't', workflowId: 'wf_1' }],
  workflowMentionLoadFailed: () => false,
}));

import { SlashAutocomplete } from '../SlashAutocomplete.js';

afterEach(cleanup);

describe('slash picker keys (ADR 0768 D4)', () => {
  it('shows the key tip', () => {
    render(<SlashAutocomplete text="/sum" onPick={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('slashPickerKeys')).toBeTruthy();
  });

  it('Tab picks, as the tip says', () => {
    const onPick = vi.fn();
    render(<SlashAutocomplete text="/sum" onPick={onPick} onDismiss={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onPick).toHaveBeenCalledWith('/summarize ');
  });

  it('Esc closes, as the tip says', () => {
    const onDismiss = vi.fn();
    render(<SlashAutocomplete text="/sum" onPick={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });
});
