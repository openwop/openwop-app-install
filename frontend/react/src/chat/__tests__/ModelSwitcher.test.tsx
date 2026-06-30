/**
 * ADR 0124 Phase 2c — ModelSwitcher component coverage. Lists the host's advertised
 * provider/model options, fires onChange with the choice, and degrades to nothing
 * when no models are advertised. The capabilities client is mocked → pure test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../client/chatSessionsClient.js', () => ({ fetchModelCapabilities: vi.fn() }));
import { fetchModelCapabilities, type ProviderCapabilities } from '../../client/chatSessionsClient.js';
import { ModelSwitcher, type ModelChoice } from '../ModelSwitcher.js';

const mockCaps = vi.mocked(fetchModelCapabilities);
const prov = (provider: string, models: Array<{ id: string; label: string }>): ProviderCapabilities =>
  ({ provider, capabilities: ['tools'], models: models.map((m) => ({ ...m, capabilities: [], recommended: false })) });

beforeEach(() => mockCaps.mockReset());
afterEach(cleanup);

describe('ModelSwitcher (ADR 0124 Phase 2c)', () => {
  it('renders the advertised provider/model options + fires onChange', async () => {
    mockCaps.mockResolvedValue([prov('anthropic', [{ id: 'opus', label: 'Opus' }]), prov('openai', [{ id: 'gpt', label: 'GPT' }])]);
    const onChange = vi.fn();
    render(<ModelSwitcher value={null} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    expect(screen.getByRole('option', { name: 'anthropic · Opus' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openai:gpt' } });
    expect(onChange).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt' } satisfies ModelChoice);
  });

  it('selecting the blank default clears the override (onChange null)', async () => {
    mockCaps.mockResolvedValue([prov('anthropic', [{ id: 'opus', label: 'Opus' }])]);
    const onChange = vi.fn();
    render(<ModelSwitcher value={{ provider: 'anthropic', model: 'opus' }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders NOTHING when the host advertises no models (graceful default)', async () => {
    mockCaps.mockResolvedValue([{ provider: 'anthropic', capabilities: [], models: [] }]);
    const { container } = render(<ModelSwitcher value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockCaps).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });

  it('ADR 0164 P3 — scopes options to the active provider + drops the redundant prefix', async () => {
    mockCaps.mockResolvedValue([
      prov('anthropic', [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }]),
      prov('openai', [{ id: 'gpt', label: 'GPT' }]),
    ]);
    render(<ModelSwitcher value={null} onChange={vi.fn()} provider="anthropic" />);
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
    // Only anthropic's models, labelled WITHOUT the "anthropic · " prefix.
    expect(screen.getByRole('option', { name: 'Opus' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeTruthy();
    // The other provider's model is absent (can't override to a provider you lack a key for).
    expect(screen.queryByRole('option', { name: 'GPT' })).toBeNull();
    expect(screen.queryByRole('option', { name: /openai/ })).toBeNull();
  });

  it('ADR 0164 P3 — renders nothing when the active provider advertises no models', async () => {
    // A managed/openwop-free provider isn't in the (post-honesty-fix) capabilities list.
    mockCaps.mockResolvedValue([prov('anthropic', [{ id: 'opus', label: 'Opus' }])]);
    const { container } = render(<ModelSwitcher value={null} onChange={vi.fn()} provider="openwop-free" />);
    await waitFor(() => expect(mockCaps).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });
});
