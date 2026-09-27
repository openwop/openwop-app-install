/**
 * UX_UPGRADE-crm-console ROUND 2 — CC-SP-3: currency honesty.
 *
 * `Deal.currency` rode the wire (agent-settable) while every console surface
 * rendered amounts unitless and summed them mixed-currency-blind. The rules
 * pinned here: a currency renders as REAL currency formatting; no currency
 * renders as a bare number (never an invented unit); sums group by currency
 * and are never one blind total; an invalid agent-written code degrades,
 * never crashes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatDealAmount, formatGroupedSums } from '../dealMoney.js';

describe('formatDealAmount', () => {
  it('renders real currency formatting when a currency is set', () => {
    expect(formatDealAmount(5000, 'USD')).toMatch(/\$|US/);
    expect(formatDealAmount(5000, 'EUR')).toMatch(/€|EUR/);
  });

  it('renders a bare localized number when no currency exists — no invented unit', () => {
    const out = formatDealAmount(5000);
    expect(out).not.toMatch(/[$€£]|USD|EUR/);
  });

  it('an invalid agent-written code degrades to number + code, never throws', () => {
    expect(() => formatDealAmount(10, 'NOPE!')).not.toThrow();
    expect(formatDealAmount(10, 'NOPE!')).toContain('NOPE!');
  });
});

describe('formatGroupedSums — never one blind total across currencies', () => {
  it('groups by currency', () => {
    const out = formatGroupedSums([
      { amount: 100, currency: 'USD' },
      { amount: 200, currency: 'USD' },
      { amount: 50, currency: 'EUR' },
    ]);
    // 300 USD and 50 EUR as separate figures — the blind 350 must not appear.
    expect(out).toMatch(/300/);
    expect(out).toMatch(/50/);
    expect(out).not.toMatch(/350/);
  });

  it('unitless deals form their own group beside a currency group', () => {
    const out = formatGroupedSums([
      { amount: 100, currency: 'USD' },
      { amount: 25 },
    ]);
    expect(out).toMatch(/100/);
    expect(out).toMatch(/25/);
    expect(out).not.toMatch(/125/);
  });
});

const getDeal = vi.fn();
const updateDeal = vi.fn();
const createDeal = vi.fn();
const listPipelines = vi.fn();
const listCompanies = vi.fn();
const listDeals = vi.fn();
const listActivities = vi.fn(async (..._a: unknown[]) => []);
vi.mock('../crmOrgClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDeal: (...a: unknown[]) => getDeal(...a),
  updateDeal: (...a: unknown[]) => updateDeal(...a),
  createDeal: (...a: unknown[]) => createDeal(...a),
  listPipelines: (...a: unknown[]) => listPipelines(...a),
  listCompanies: (...a: unknown[]) => listCompanies(...a),
  listDeals: (...a: unknown[]) => listDeals(...a),
  listActivities: (...a: unknown[]) => listActivities(...a),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return { useFeatureAccess: () => makeFeatureAccess() };
});
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('deal forms finally SET currency (it was agent-only)', () => {
  it('DealsTab create sends the uppercased code with the amount', async () => {
    const { DealsTab } = await import('../DealsTab.js');
    listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'P', stages: [{ stageId: 's1', name: 'S', probability: 10 }] }]);
    listDeals.mockResolvedValue([]);
    listCompanies.mockResolvedValue([]);
    createDeal.mockResolvedValue({ dealId: 'd9', title: 'X', stageId: 's1' });
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText(/^title$/i), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText(/^currency$/i), { target: { value: 'eur' } });
    fireEvent.click(screen.getByRole('button', { name: /add deal/i }));
    await waitFor(() => expect(createDeal).toHaveBeenCalled());
    expect(createDeal.mock.calls[0]![1]).toMatchObject({ amount: 900, currency: 'EUR' });
  });
});
