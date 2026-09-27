/**
 * ADR 0546 D4 — the scoreboard's honesty, in the UI.
 *
 * The backend distinguishes "nobody replied" (rate 0) from "you have not
 * applied" (rate null). That distinction survives only if the UI honours it —
 * rendering null as 0% would tell someone who has applied to nothing that their
 * approach is failing, which is the most discouraging possible lie told to the
 * person least able to evaluate it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const EMPTY = {
  reachedStage: { applied: 0, screening: 0, interviewing: 0, offer: 0 },
  responseRate: { numerator: 0, denominator: 0, rate: null },
  conversions: [],
  warmVsCold: { warm: { numerator: 0, denominator: 0, rate: null }, cold: { numerator: 0, denominator: 0, rate: null } },
  medianHoursToFirstResponse: null,
  bySource: [],
  silent: 0,
  pipelineFound: true,
};

const WITH_DATA = {
  ...EMPTY,
  responseRate: { numerator: 2, denominator: 40, rate: 0.05 },
  warmVsCold: { warm: { numerator: 2, denominator: 3, rate: 0.667 }, cold: { numerator: 0, denominator: 37, rate: 0 } },
  bySource: [
    { source: 'greenhouse', rate: { numerator: 2, denominator: 10, rate: 0.2 } },
    { source: 'silent-board', rate: { numerator: 0, denominator: 30, rate: 0 } },
  ],
  silent: 38,
};

const funnel = vi.fn(async () => EMPTY as unknown);
const followUps = vi.fn(async () => [] as unknown[]);
const drafts = vi.fn(async () => [] as unknown[]);
const approve = vi.fn(async () => undefined);

vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getFunnel: (...a: unknown[]) => funnel(...(a as [])),
  getFollowUps: (...a: unknown[]) => followUps(...(a as [])),
  getDrafts: (...a: unknown[]) => drafts(...(a as [])),
  // JSUX-FUN-2 (R3) — the page reads ONE bundle now; compose it from the same
  // three per-test fixtures so every existing arrangement keeps working.
  getFunnelBundle: async (...a: unknown[]) => ({
    report: await funnel(...(a as [])),
    followUps: await followUps(...(a as [])),
    drafts: await drafts(...(a as [])),
  }),
  completeFollowUp: vi.fn(async () => undefined),
  approveDraft: (...a: unknown[]) => approve(...(a as [])),
}));

import { FunnelPage } from '../FunnelPage.js';

describe('the scoreboard', () => {
  it('a MISSING pipeline renders the named state, never a healthy empty funnel (grade-trio finding 9)', async () => {
    funnel.mockResolvedValueOnce({ ...EMPTY, pipelineFound: false });
    render(<FunnelPage />);
    await screen.findByText(/pipeline was not found/i);
    expect(screen.queryByText(/no employer action|silent/i)).toBeNull();
  });

  beforeEach(() => {
    funnel.mockReset(); followUps.mockReset(); drafts.mockReset(); approve.mockReset();
    funnel.mockImplementation(async () => EMPTY);
    followUps.mockImplementation(async () => []);
    drafts.mockImplementation(async () => []);
    approve.mockImplementation(async () => undefined);
  });
  afterEach(cleanup);

  it('never renders “not enough data” as 0%', async () => {
    render(<FunnelPage />);
    expect(await screen.findAllByText(/not enough yet/i)).not.toHaveLength(0);
    expect(screen.queryByText(/^0%$/), 'a null rate must not become a claim of zero').toBeNull();
    expect(screen.getByText(/it is unknown/i)).toBeTruthy();
  });

  it('renders a genuine zero AS zero', async () => {
    // The other half: 0 of 37 really is 0%, and softening it would hide a
    // failing approach.
    funnel.mockImplementation(async () => WITH_DATA);
    render(<FunnelPage />);
    await screen.findByText(/67%/);
    expect(screen.getAllByText(/0%/).length, 'cold at 0/37 is genuinely zero').toBeGreaterThan(0);
  });

  it('shows a board that never replies, with its denominator', async () => {
    funnel.mockImplementation(async () => WITH_DATA);
    render(<FunnelPage />);
    expect(await screen.findByText(/silent-board/)).toBeTruthy();
    expect(screen.getByText(/\(0\/30\)/), 'the denominator is what makes 0% actionable').toBeTruthy();
  });

  it('leads with warm-vs-cold, the dominant variable', async () => {
    funnel.mockImplementation(async () => WITH_DATA);
    const { container } = render(<FunnelPage />);
    await screen.findByText(/67%/);
    const text = container.textContent ?? '';
    expect(text.indexOf('Through someone you know'), 'warm must precede the response-rate panel')
      .toBeLessThan(text.indexOf('Response rate'));
  });

  it('states that drafts are never sent for you', async () => {
    // A user who assumed an approved interview reply went out would wait for a
    // response that never happened.
    drafts.mockImplementation(async () => [{ dealId: 'deal:1', dealTitle: 'Staff Backend Engineer — Northwind', kind: 'interview-reply', body: 'Thursday works.' }]);
    render(<FunnelPage />);
    expect(await screen.findByText(/ever sent for you/i)).toBeTruthy();
    expect(screen.getByText(/sending stays yours/i)).toBeTruthy();
  });

  it('approving records a decision and does not claim to send', async () => {
    drafts.mockImplementation(async () => [{ dealId: 'deal:1', dealTitle: 'Staff Backend Engineer — Northwind', kind: 'interview-reply', body: 'Thursday works.' }]);
    render(<FunnelPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    // The first version of this assertion was a loose negative on /sent/, which
    // matched the page's own lede ("Applications SENT is not the number that
    // matters") — a fuzzy negative flags the copy that agrees with it. Assert
    // the specific thing instead: the never-sent notice is still on screen
    // after approving, so the act cannot be mistaken for a delivery.
    expect(screen.getByText(/ever sent for you/i)).toBeTruthy();
    expect(screen.getByText(/sending stays yours/i)).toBeTruthy();
  });

  it('a failed read offers a retry rather than an empty scoreboard', async () => {
    // An all-zero scoreboard for a failed read would report a healthy pipeline
    // as a dead one.
    funnel.mockImplementation(async () => { throw new Error('down'); });
    render(<FunnelPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText(/not enough yet/i)).toBeNull();
  });
});


describe('the action panels name the application', () => {
  beforeEach(() => {
    funnel.mockReset(); followUps.mockReset(); drafts.mockReset();
    funnel.mockImplementation(async () => EMPTY);
    followUps.mockImplementation(async () => []);
    drafts.mockImplementation(async () => []);
  });
  afterEach(cleanup);

  it('shows the ROLE, never a raw deal id', async () => {
    // `/grade-ux` finding: both panels rendered `deal:9f3c…`, which tells a user
    // nothing about which application is waiting on them — the one fact they
    // need in order to act. The earlier tests passed with `dealTitle` absent,
    // so they could not have caught it.
    followUps.mockImplementation(async () => [
      { dealId: 'deal:9f3c', dealTitle: 'Staff Backend Engineer — Northwind', stage: 'interviewing', dueAt: '2026-03-01' },
    ]);
    drafts.mockImplementation(async () => [
      { dealId: 'deal:9f3c', dealTitle: 'Staff Backend Engineer — Northwind', kind: 'prep-sheet', body: 'Likely questions…' },
    ]);
    render(<FunnelPage />);

    expect((await screen.findAllByText(/Staff Backend Engineer — Northwind/)).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/deal:9f3c/), 'a raw id is not an application').toBeNull();
  });
});
