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
    await waitFor(() => expect(setAiDefault).toHaveBeenCalledWith({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'g:prod' }));
  });

  it('warns that audio needs Google when a vision-only provider is picked', () => {
    render(<AiDefaultCard refs={['c:prod']} />);
    expect(screen.queryByText(/Audio transcription needs Google/i)).toBeNull(); // google default → no warn
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    expect(screen.getByText(/Audio transcription needs Google/i)).toBeTruthy();
  });
});
