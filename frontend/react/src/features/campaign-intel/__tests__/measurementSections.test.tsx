/**
 * ADR 0956 D6 — the reconciliation and AdMap sections: the sustained-inflation
 * flag and the overlap line are shown, landing pages and funnel steps resolve,
 * the ledger cap is said, and a failed read is shown in plain words.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n/index.js';
import type { AdMapReport, ReconciliationReport } from '../campaignIntelClient.js';

const getReconciliation = vi.fn();
const getAdMap = vi.fn();
vi.mock('../campaignIntelClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, getReconciliation: (...a: unknown[]) => getReconciliation(...a), getAdMap: (...a: unknown[]) => getAdMap(...a) };
});

import { ReconciliationSection } from '../ReconciliationSection.js';
import { AdMapSection } from '../AdMapSection.js';
import { FeatureDisabledError } from '../campaignIntelClient.js';

const recon: ReconciliationReport = {
  model: 'linear',
  rows: [{
    campaignId: 'c1', campaignName: 'Spring', platform: 'meta', currency: 'USD', spend: 100,
    reportedConversions: 7, reportedRevenue: 700, reportedRoas: 7, measuredConversions: 2, measuredRevenue: 200, measuredValueOther: [], measuredRoas: 2,
    inflation: { ratio: 3.5, measuredZero: false, flagged: true, daysAbove: 7 },
  }],
  overlap: [{ campaignId: 'c1', campaignName: 'Spring', platformClaims: 3, measured: 1, overlap: 2 }],
  threshold: 1.5, sustainDays: 7, calibration: null, calibrationReason: 'no_valid_lift_test',
  lineage: { spendRows: 1, latestSpendDate: '2026-10-19', creditedPaths: 1, asOf: '2026-10-20' }, computedAt: '2026-10-20T00:00:00Z',
};
const admap: AdMapReport = {
  model: 'last_click', unplacedLegacyRows: 0, ledgerCapped: true, computedAt: '2026-10-20T00:00:00Z',
  rows: [{
    platform: 'meta', platformAdId: 'ad1', platformCampaignId: 'pc1', adRef: 'ref-1', campaignId: 'c1', campaignName: 'Spring',
    landingUrl: 'https://ex.com/p/spring', landing: { kind: 'cms_page', pageId: 'p1', slug: 'spring', title: 'Spring offer', funnelSteps: [{ funnelId: 'f1', funnelName: 'Launch', stepId: 's1' }] },
    variantKey: 'arm-b', landingSessions: 4, conversions: 1.5, messageMatch: { status: 'owed', reason: 'adr_0933_content_rules_pending' }, dispatchedAt: '2026-10-19T00:00:00Z',
  }],
};

beforeEach(() => { getReconciliation.mockReset(); getAdMap.mockReset(); });

describe('ReconciliationSection', () => {
  it('shows the sustained-inflation flag and the overlap line', async () => {
    getReconciliation.mockResolvedValue(recon);
    render(<ReconciliationSection orgId="o1" />);
    expect(await screen.findByRole('heading', { name: 'Platform claims vs measured' })).toBeTruthy();
    expect(screen.getByText(/3\.5× for 7 days/)).toBeTruthy();
    expect(screen.getByText(/platforms claim 3 conversions, the site measured 1 \(2 claimed more than once/)).toBeTruthy();
  });
  it('hides while the feature is off; a failed read is shown', async () => {
    getReconciliation.mockRejectedValueOnce(new FeatureDisabledError('not enabled'));
    const { container, unmount } = render(<ReconciliationSection orgId="o1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('section')).toBeNull();
    unmount();
    getReconciliation.mockRejectedValueOnce(new Error('boom'));
    render(<ReconciliationSection orgId="o2" />);
    expect(await screen.findByText('Could not load the platform-claims comparison.')).toBeTruthy();
  });
});

describe('AdMapSection', () => {
  it('shows unavailable tracking measurements explicitly instead of formatting null as zero', async () => {
    getAdMap.mockResolvedValue({ ...admap, rows: admap.rows.map((row) => ({ ...row, landingSessions: null, conversions: null })) });
    render(<AdMapSection orgId="o1" />);
    expect(await screen.findAllByText('Not available')).toHaveLength(2);
    expect(screen.getByText(/reference is missing or shared/)).toBeTruthy();
  });
  it('resolves the landing page and funnel step, shows the variant, and says the ledger is capped', async () => {
    getAdMap.mockResolvedValue(admap);
    render(<AdMapSection orgId="o1" />);
    expect(await screen.findByText('Spring offer')).toBeTruthy();
    expect(screen.getByText('Funnel: Launch')).toBeTruthy();
    expect(screen.getByText('arm-b')).toBeTruthy();
    expect(screen.getByText(/most recent 500 ad dispatches/)).toBeTruthy();
  });
});
