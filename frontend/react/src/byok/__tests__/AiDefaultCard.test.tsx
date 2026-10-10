/**
 * AiDefaultCard (ADR 0110 Phase 3) — the "Default AI provider for media" form.
 * byokClient is mocked. Covers: the empty-state (no stored keys), the save flow
 * (provider+model+ref → setAiDefault), and the audio-capability guidance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../lib/byokClient.js', () => ({
  getAiDefault: vi.fn().mockResolvedValue(null),
  setAiDefault: vi.fn().mockResolvedValue({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod' }),
  clearAiDefault: vi.fn().mockResolvedValue(undefined),
}));
import { getAiDefault, setAiDefault } from '../lib/byokClient.js';
import { AiDefaultCard } from '../AiDefaultCard.js';

beforeEach(() => { vi.mocked(getAiDefault).mockClear(); vi.mocked(setAiDefault).mockClear(); });
afterEach(cleanup);

describe('AiDefaultCard (ADR 0110)', () => {
  it('shows the empty-state prompt when there are no stored keys', () => {
    render(<AiDefaultCard refs={[]} />);
    expect(screen.getByText(/Add a provider API key above first/i)).toBeTruthy();
    expect(screen.queryByText('Save default')).toBeNull();
  });

  it('saves {provider, model, credentialRef} once model + key are chosen', async () => {
    render(<AiDefaultCard refs={['g:prod']} />);
    await waitFor(() => expect(getAiDefault).toHaveBeenCalled());
    // Save is disabled until model + key are set
    const save = screen.getByText('Save default') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-2.0-flash' } });
    fireEvent.change(screen.getByLabelText('API key to use'), { target: { value: 'g:prod' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    // ADR 0821 D5 — the background-AI opt-in is always sent, OFF unless switched on.
    await waitFor(() => expect(setAiDefault).toHaveBeenCalledWith({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod', preferForText: false }));
  });

  it('warns that audio needs Google when a vision-only provider is picked', () => {
    render(<AiDefaultCard refs={['c:prod']} />);
    expect(screen.queryByText(/Audio transcription needs Google/i)).toBeNull(); // google default → no warn
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    expect(screen.getByText(/Audio transcription needs Google/i)).toBeTruthy();
  });

  it('ADR 0779 D7 — a failed READ says so (it used to render as "no default")', async () => {
    vi.mocked(getAiDefault).mockRejectedValueOnce(new Error('boom'));
    render(<AiDefaultCard refs={['g:prod']} />);
    expect(await screen.findByText(/couldn’t load the current default/)).toBeTruthy();
    // Nothing to save against an unknown state.
    expect((screen.getByText('Save default') as HTMLButtonElement).disabled).toBe(true);
  });

  describe('ADR 0821 D5 — "use this key for background AI"', () => {
    const SWITCH = /Use this key for background AI/;

    it('is OFF by default and says who pays when it is on', async () => {
      render(<AiDefaultCard refs={['g:prod']} />);
      await waitFor(() => expect(getAiDefault).toHaveBeenCalled());
      const sw = screen.getByRole('switch', { name: SWITCH }) as HTMLInputElement;
      expect(sw.checked).toBe(false);
      expect(screen.getByText(/billed to your provider account instead of the workspace’s included AI allowance/)).toBeTruthy();
    });

    it('ADR 0821 D5 follow-up — the copy covers auto-titles and memory extraction (they now honour the switch)', async () => {
      render(<AiDefaultCard refs={['g:prod']} />);
      await waitFor(() => expect(getAiDefault).toHaveBeenCalled());
      const help = screen.getByText(/billed to your provider account/).textContent ?? '';
      expect(help).toMatch(/chat auto-titles/);
      expect(help).toMatch(/memory extraction/);
      expect(help, 'the pre-follow-up copy said these stayed on the allowance — now false').not.toMatch(/still use the included allowance/);
    });

    it('switching it on saves preferForText: true with the binding', async () => {
      vi.mocked(setAiDefault).mockResolvedValueOnce({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod', preferForText: true });
      render(<AiDefaultCard refs={['g:prod']} />);
      await waitFor(() => expect(getAiDefault).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-2.0-flash' } });
      fireEvent.change(screen.getByLabelText('API key to use'), { target: { value: 'g:prod' } });
      fireEvent.click(screen.getByRole('switch', { name: SWITCH }));
      fireEvent.click(screen.getByText('Save default'));
      await waitFor(() => expect(setAiDefault).toHaveBeenCalledWith({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod', preferForText: true }));
      expect((screen.getByRole('switch', { name: SWITCH }) as HTMLInputElement).checked).toBe(true);
    });

    it('reflects a saved opt-in on load', async () => {
      vi.mocked(getAiDefault).mockResolvedValueOnce({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod', preferForText: true });
      render(<AiDefaultCard refs={['g:prod']} />);
      await waitFor(() => expect((screen.getByRole('switch', { name: SWITCH }) as HTMLInputElement).checked).toBe(true));
    });
  });
});
