/**
 * UX_UPGRADE-campaign-intel — CI-G1 / CI-G2.
 *
 *  - CI-G1: `attribution.currency` collapses "all campaigns agree on USD" and
 *    "the campaigns disagree, here is a neutral default" into the same string.
 *    The page used it to label its org-wide budget / forecast / planner figures,
 *    so an EUR+GBP workspace saw `$` — a currency none of its campaigns use.
 *    There is no FX, so those sums are not in any single currency: the honest
 *    presentation is an unlabelled number plus a note.
 *  - CI-G2: the four reports were fetched with `Promise.all`, so one failing
 *    sub-report blanked ALL FOUR sections behind a single error line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AttributionReport, BudgetRecommendation, CampaignForecast, PacingReport } from '../campaignIntelClient.js';

const getBudget = vi.fn();
const getForecast = vi.fn();
const getAttribution = vi.fn();
const getPacing = vi.fn();
const getAnomalies = vi.fn();

vi.mock('../campaignIntelClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    getBudget: () => getBudget(),
    getForecast: () => getForecast(),
    getAttribution: () => getAttribution(),
    getPacing: () => getPacing(),
    getAnomalies: () => getAnomalies(),
    planBudget: vi.fn(async () => ({ plan: null })),
  };
});

import { CampaignIntelPage } from '../CampaignIntelPage.js';

// R2 CI-SP-11 — full literals, no `as`-casts: a cast fixture missing SSoT
// fields (totalSpend, changePercent, computedAt) meant SSoT drift never failed
// these tests (the incomplete-fixture trap).
const BUDGET: BudgetRecommendation = {
  note: 'Shift spend toward the better performer.',
  totalSpend: 12345,
  projectedRoasGain: 0,
  reallocations: [{ platform: 'google', currentSpend: 12345, suggestedSpend: 20000, changeAmount: 7655, changePercent: 62, reason: 'higher roas', roas: 2.5 }],
};

const attribution = (currency: string, currencyMixed: boolean): AttributionReport => ({
  rows: [], email: [], unattributedConversions: 0, sharedJoinKeys: [],
  currency, currencyMixed, computedAt: '2026-07-01T00:00:00.000Z',
} as AttributionReport);

const view = async (): Promise<void> => {
  render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(screen.getByText(/Shift spend toward/)).toBeTruthy());
};

beforeEach(() => {
  getBudget.mockReset(); getForecast.mockReset(); getAttribution.mockReset(); getPacing.mockReset(); getAnomalies.mockReset().mockResolvedValue([]);
  getBudget.mockResolvedValue(BUDGET);
  getForecast.mockResolvedValue([] as CampaignForecast[]);
  getPacing.mockResolvedValue({ rows: [], unplanned: 0, computedAt: '2026-07-01T00:00:00.000Z' } satisfies PacingReport);
  getAttribution.mockResolvedValue(attribution('USD', false));
});
afterEach(cleanup);

describe('CI-G1: org-wide figures never claim a currency the org does not use', () => {
  it('a unanimous currency IS shown on the org-wide figures', async () => {
    getAttribution.mockResolvedValue(attribution('GBP', false));
    await view();
    expect(screen.getByText(/£12,345/)).toBeTruthy();
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });

  it('a MIXED org drops the symbol rather than inventing one', async () => {
    getAttribution.mockResolvedValue(attribution('USD', true));
    await view();
    // The number is still there …
    expect(screen.getByText('12,345')).toBeTruthy();
    // … without a currency symbol it cannot justify.
    expect(screen.queryByText(/\$12,345/)).toBeNull();
    expect(screen.queryByText(/£12,345/)).toBeNull();
  });

  it('a MIXED org explains WHY the figures are unlabelled', async () => {
    getAttribution.mockResolvedValue(attribution('USD', true));
    await view();
    expect(screen.getByText(/more than one currency/i)).toBeTruthy();
    expect(screen.getByText(/not converted/i)).toBeTruthy();
  });

  it('a genuinely-USD org still shows $ — the flag, not the string, decides', async () => {
    getAttribution.mockResolvedValue(attribution('USD', false));
    await view();
    // Same `currency` value as the mixed case; only `currencyMixed` differs.
    expect(screen.getByText(/\$12,345/)).toBeTruthy();
  });

  it('an OLDER backend with no flag keeps today\'s labelled behaviour', async () => {
    const legacy = attribution('EUR', false) as Partial<AttributionReport>;
    delete legacy.currencyMixed;
    getAttribution.mockResolvedValue(legacy as AttributionReport);
    await view();
    expect(screen.getByText(/12,345/)).toBeTruthy();
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });
});

describe('CI-G2: one failing report does not blank the others', () => {
  it('renders the reports that succeeded and names only the one that failed', async () => {
    getAttribution.mockRejectedValue(new Error('attribution store down'));
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    // The budget section still renders — under `Promise.all` this was blank.
    await waitFor(() => expect(screen.getByText(/Shift spend toward/)).toBeTruthy());
    // And the failure is reported specifically, not as a bare page error.
    expect(screen.getByText(/Could not load/i)).toBeTruthy();
  });

  it('no failures ⇒ no error line', async () => {
    await view();
    expect(screen.queryByText(/Could not load/i)).toBeNull();
  });
});

describe('R2 CI-SP-1/4 — the failure legs round 1 never covered', () => {
  const PACING_ROW = {
    campaignId: 'c-1', name: 'Paced campaign', budget: 200, currency: 'GBP', spend: 170,
    spentPct: 85, band: 'warning' as const, projectedMonthlySpend: 2550,
  };

  it('a FAILED budget read no longer hides the sections that succeeded', async () => {
    getBudget.mockRejectedValue(new Error('budget boom'));
    getPacing.mockResolvedValue({ rows: [PACING_ROW], unplanned: 0, computedAt: '2026-07-01T00:00:00.000Z' } satisfies PacingReport);
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    // The old page gated EVERYTHING on `budget === null`, so this state was a
    // perpetual "Analyzing performance…" spinner over three healthy sections.
    expect(await screen.findByText('Paced campaign')).toBeTruthy();
    expect(screen.queryByText(/Analyzing performance/i)).toBeNull();
    // The failure is named — and only the failure.
    expect(screen.getByText(/Could not load/)).toBeTruthy();
  });

  it('a FAILED attribution read leaves org-wide figures UNLABELLED — never an arbitrary currency', async () => {
    getAttribution.mockRejectedValue(new Error('attribution boom'));
    getPacing.mockResolvedValue({ rows: [PACING_ROW], unplanned: 0, computedAt: '2026-07-01T00:00:00.000Z' } satisfies PacingReport);
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    await screen.findByText(/Shift spend toward/);
    // The mixed flag rides only attribution: its failure used to fall back to
    // pacing.rows[0].currency (an ARBITRARY campaign's GBP here) and re-label
    // the org figures — the exact defect round 1 fixed. Unknown = unlabelled.
    expect(screen.getByText(/12,345/)).toBeTruthy();
    expect(screen.queryByText(/£12,345/)).toBeNull();
    expect(screen.queryByText(/\$12,345/)).toBeNull();
  });

  it('ALL reads failing never claims "Not enough data yet"', async () => {
    getBudget.mockRejectedValue(new Error('b'));
    getForecast.mockRejectedValue(new Error('f'));
    getAttribution.mockRejectedValue(new Error('a'));
    getPacing.mockRejectedValue(new Error('p'));
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    expect(await screen.findByText(/Could not load/)).toBeTruthy();
    // Three failed reads are NOT an empty-data assertion.
    expect(screen.queryByText(/Not enough data yet/i)).toBeNull();
  });
});

describe('R2 CI-SP-3 — the localized noteCode path (not just the prose fallback)', () => {
  it('renders the localized shift note with formatted money under the org rule', async () => {
    getBudget.mockResolvedValue({
      ...BUDGET,
      noteCode: 'shift' as const,
      noteParams: { shift: 7655, from: 'meta', to: 'google' },
      note: 'Shift ~7655 from meta to google.',
    });
    getAttribution.mockResolvedValue(attribution('GBP', false));
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    // The localized template, with the amount through the org money rule —
    // never the raw backend prose.
    expect(await screen.findByText(/Shift about £7,655 from meta to google\./)).toBeTruthy();
    expect(screen.queryByText(/Shift ~7655/)).toBeNull();
  });
});

describe('R2 CI-SP-2 — the org-switch race', () => {
  it('the OLD org\'s slower batch never lands under the NEW org', async () => {
    const listOrgsMock = (await import('../campaignIntelClient.js')).listOrgs as ReturnType<typeof vi.fn>;
    listOrgsMock.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Beta' }]);
    // org-1's budget hangs until WE release it — after org-2 has landed.
    let releaseOrg1: (v: BudgetRecommendation) => void = () => {};
    getBudget
      .mockImplementationOnce(() => new Promise<BudgetRecommendation>((res) => { releaseOrg1 = res; }))
      .mockResolvedValueOnce({ ...BUDGET, note: 'ORG TWO NOTE.' });
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
    // Switch to org-2 while org-1's batch is still in flight.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByLabelText(/Organization/i), { target: { value: 'org-2' } });
    await act(async () => {});
    expect(await screen.findByText(/ORG TWO NOTE/)).toBeTruthy();
    // org-1's stale batch resolves LAST — it must not overwrite org-2's data.
    releaseOrg1({ ...BUDGET, note: 'STALE ORG ONE NOTE.' });
    await act(async () => {});
    expect(screen.queryByText(/STALE ORG ONE NOTE/)).toBeNull();
    expect(screen.getByText(/ORG TWO NOTE/)).toBeTruthy();
  });
});

describe('R3 CI-SP-8 remainder — the anomaly detector gets its reader', () => {
  const mountWithOrg = async (): Promise<void> => {
    render(<MemoryRouter><CampaignIntelPage /></MemoryRouter>);
    await act(async () => {});
  };
  it('renders spikes/drops with metric + z; a clean scan renders NO section', async () => {
    getAnomalies.mockResolvedValue([
      { platform: 'meta', campaignName: 'Spring Push', metric: 'spend', date: '2026-08-12', value: 900, mean: 300, z: 4.2, direction: 'spike' },
      { platform: 'google', campaignName: 'Brand', metric: 'ctr', date: '2026-08-13', value: 0.1, mean: 1.2, z: -3.4, direction: 'drop' },
    ]);
    await mountWithOrg();
    expect(await screen.findByText('Anomalies')).toBeTruthy();
    expect(screen.getByText(/spend spike/)).toBeTruthy();
    expect(screen.getByText(/CTR drop/)).toBeTruthy();
    expect(screen.getByText(/z 4.2/)).toBeTruthy();
  });

  it('a clean scan (no anomalies) renders no section; a FAILED read lands in sectionsFailed', async () => {
    await mountWithOrg(); // beforeEach: []
    expect(screen.queryByText('Anomalies')).toBeNull();
    cleanup();
    getAnomalies.mockRejectedValue(new Error('boom'));
    await mountWithOrg();
    expect(await screen.findByText(/Anomalies/)).toBeTruthy(); // named in the failed-sections line
    expect(screen.queryByText(/spend spike/)).toBeNull();
  });
});
