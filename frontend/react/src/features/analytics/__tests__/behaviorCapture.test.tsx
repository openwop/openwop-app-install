/**
 * ADR 0951 P0 — the "Behavior capture" status section.
 *
 *  - hidden while both sub-toggles are off;
 *  - session replay ON without durable blob storage says "Not configured" (a
 *    labelled chip plus the reason), never "On";
 *  - storage configured but consent management off says what is missing;
 *  - fully available says "On" and states the retention window.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnalyticsSummary, BehaviorSettings } from '../analyticsClient.js';
import type * as Client from '../analyticsClient.js';
import { messages as en } from '../i18n/en.js';

const getBehaviorSettings = vi.fn<typeof Client.getBehaviorSettings>();
const summary: AnalyticsSummary = { total: 5, sessions: 2, byType: { pageview: 5, event: 0, conversion: 0 }, topPaths: [], utmSources: [] };

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../chat/ChatPocket.js', () => ({ ChatPocket: () => null }));
vi.mock('../analyticsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSummary: async () => ({ summary }),
  getEvents: async () => [],
  getTrend: async () => [],
  getNavReport: async () => ({ weeks: [], rows: [] }),
  getBehaviorSettings: (...a: Parameters<typeof Client.getBehaviorSettings>) => getBehaviorSettings(...a),
  getHeatPages: async () => [],
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
const toggles: Record<string, boolean> = {};
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: toggles[id] ?? (id === 'analytics'), loading: false }),
}));

const { AnalyticsPage } = await import('../AnalyticsPage.js');
const renderPage = () => render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
const settings = (replay: Partial<BehaviorSettings['replay']>, heat = false): BehaviorSettings => ({
  heatmaps: { enabled: heat },
  replay: { enabled: true, storageConfigured: true, consentEnabled: true, available: true, retentionDays: 30, ...replay },
});

beforeEach(() => { getBehaviorSettings.mockReset(); });
afterEach(() => { cleanup(); for (const k of Object.keys(toggles)) delete toggles[k]; });

describe('ADR 0951 — behavior capture status', () => {
  it('is hidden while both sub-toggles are off (and reads nothing)', async () => {
    renderPage();
    await screen.findByText('Pageviews');
    expect(screen.queryByRole('heading', { name: en.behaviorHeading })).toBeNull();
    expect(getBehaviorSettings).not.toHaveBeenCalled();
  });

  it('replay ON without blob storage says "Not configured", with the reason', async () => {
    toggles['analytics.session-replay'] = true;
    getBehaviorSettings.mockResolvedValue(settings({ storageConfigured: false, available: false }));
    renderPage();
    expect(await screen.findByText(en.behaviorNotConfigured)).toBeTruthy();
    expect(screen.getByText(en.behaviorReplayNoStorage)).toBeTruthy();
    expect(getBehaviorSettings).toHaveBeenCalledWith('org:1');
  });

  it('storage configured but consent management off names what is missing', async () => {
    toggles['analytics.session-replay'] = true;
    getBehaviorSettings.mockResolvedValue(settings({ consentEnabled: false, available: false }));
    renderPage();
    expect(await screen.findByText(en.behaviorNeedsConsent)).toBeTruthy();
  });

  it('fully available says On and states the retention window', async () => {
    toggles['analytics.heatmaps'] = true;
    getBehaviorSettings.mockResolvedValue(settings({ retentionDays: 30 }, true));
    renderPage();
    expect(await screen.findByText(en.behaviorReplayReady.replace('{{days}}', '30'))).toBeTruthy();
    expect(screen.getAllByText(en.behaviorOn)).toHaveLength(2);
  });

  it('a failed read says so', async () => {
    toggles['analytics.heatmaps'] = true;
    getBehaviorSettings.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(en.behaviorUnavailable)).toBeTruthy();
  });

  it('configuration alone does not claim a recorder is available', async () => {
    toggles['analytics.session-replay'] = true;
    getBehaviorSettings.mockResolvedValue(settings({ available: false }));
    renderPage();
    expect(await screen.findByText('Not available')).toBeTruthy();
    expect(screen.queryByText(en.behaviorReplayReady.replace('{{days}}', '30'))).toBeNull();
  });
});
