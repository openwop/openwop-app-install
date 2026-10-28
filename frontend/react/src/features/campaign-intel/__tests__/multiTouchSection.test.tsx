/**
 * ADR 0956 D2 — the multi-touch section: hidden while the sub-toggle is off,
 * one model at a time plus the all-models comparison, "make default" saves
 * with the version it read, and a failed read is announced.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../i18n/index.js';
import type { AttributionModelReport } from '../campaignIntelClient.js';

const getAttributionModels = vi.fn();
const saveAttributionSettings = vi.fn();
vi.mock('../campaignIntelClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getAttributionModels: (...a: unknown[]) => getAttributionModels(...a),
    saveAttributionSettings: (...a: unknown[]) => saveAttributionSettings(...a),
  };
});

import { MultiTouchSection } from '../MultiTouchSection.js';
import { FeatureDisabledError } from '../campaignIntelClient.js';

const zero = { last_click: 0, first_touch: 0, linear: 0, time_decay: 0, position_based: 0 };
function report(model: AttributionModelReport['model'], defaultModel: AttributionModelReport['model'] = 'last_click'): AttributionModelReport {
  return {
    model,
    settings: { lookbackDays: 30, halfLifeDays: 7, defaultModel },
    settingsVersion: 3,
    rows: [{ campaignId: 'c1', name: 'Spring', units: 1_500_000, conversions: 1.5, value: [{ currency: 'USD', minor: 1000 }] }],
    unmapped: { campaignId: null, name: null, units: 500_000, conversions: 0.5, value: [] },
    comparison: [
      { campaignId: 'c1', name: 'Spring', byModel: { ...zero, linear: 1.5, last_click: 2 } },
      { campaignId: null, name: null, byModel: { ...zero, linear: 0.5 } },
    ],
    creditedPaths: 2,
    coverage: { conversions: 2, contactPaths: 1, sessionPaths: 1, noTouch: 0 },
    computedAt: '2026-10-20T00:00:00Z',
  };
}

beforeEach(() => { getAttributionModels.mockReset(); saveAttributionSettings.mockReset(); });

describe('MultiTouchSection', () => {
  it('renders nothing while the multi-touch sub-toggle is off', async () => {
    getAttributionModels.mockRejectedValue(new FeatureDisabledError('not enabled'));
    const { container } = render(<MultiTouchSection orgId="o1" />);
    await waitFor(() => expect(getAttributionModels).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows the selected model, the unmapped credit, every model compared, and the org default', async () => {
    getAttributionModels.mockResolvedValue(report('linear'));
    render(<MultiTouchSection orgId="o1" />);
    expect(await screen.findByRole('heading', { name: 'Multi-touch attribution' })).toBeTruthy();
    expect(screen.getAllByText('Spring').length).toBe(2); // credit table + comparison
    expect(screen.getAllByText('No matching campaign').length).toBe(2);
    expect(screen.getByText(/Default model: Last click\. Lookback: 30 days/)).toBeTruthy();
    expect(screen.getByRole('button', { name: "Make this client's default" })).toBeTruthy();
  });

  it('switching the model reloads with it; "make default" saves with the version it read', async () => {
    getAttributionModels.mockResolvedValueOnce(report('last_click')).mockResolvedValueOnce(report('linear')).mockResolvedValue(report('linear', 'linear'));
    saveAttributionSettings.mockResolvedValue({ settings: { lookbackDays: 30, halfLifeDays: 7, defaultModel: 'linear' }, version: 4 });
    render(<MultiTouchSection orgId="o1" />);
    expect(await screen.findByText("This client's default")).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'linear' } });
    await waitFor(() => expect(getAttributionModels).toHaveBeenLastCalledWith('o1', 'linear'));
    fireEvent.click(await screen.findByRole('button', { name: "Make this client's default" }));
    await waitFor(() => expect(saveAttributionSettings).toHaveBeenCalledWith('o1', { lookbackDays: 30, halfLifeDays: 7, defaultModel: 'linear' }, 3));
    expect(await screen.findByText('Linear is now this client\'s default model.')).toBeTruthy();
  });

  it('a failed read is shown in plain words, not silently dropped or as a raw server string', async () => {
    getAttributionModels.mockRejectedValue(new Error('boom'));
    render(<MultiTouchSection orgId="o1" />);
    expect(await screen.findByText('Could not load the multi-touch attribution report.')).toBeTruthy();
    expect(screen.queryByText('boom')).toBeNull();
  });
});
