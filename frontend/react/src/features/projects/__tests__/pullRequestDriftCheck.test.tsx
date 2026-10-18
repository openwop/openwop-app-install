/**
 * ADR 0855 P5 — "Check a pull request" on the Ledger tab.
 *   - sends the trimmed URL; a found departure says how many and asks the
 *     parent to refresh Possible decisions; a clean check says so;
 *   - each failure is said by its cause (no connection, not found, bad URL,
 *     budget, anything else), never shown as "nothing found".
 *
 * Double guard (w52, probe prd-trim came back vacuous): the address field is
 * `<input type="url">`, whose value sanitisation strips leading/trailing
 * whitespace before React reads it, so the `url.trim()` in `check()` cannot be
 * seen from here — the padded value typed below arrives already trimmed. The
 * assertion still pins what is SENT (exact args); the trim is the second guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

type Client = typeof import('../teamLedgerClient.js');
const h = vi.hoisted(() => ({ check: vi.fn<Client['checkPullRequestDrift']>() }));
vi.mock('../teamLedgerClient.js', async (orig) => ({ ...(await orig<Client>()), checkPullRequestDrift: h.check }));

import { PullRequestDriftCheck } from '../PullRequestDriftCheck.js';

const URL = 'https://github.com/acme/site/pull/7';
beforeEach(() => { h.check.mockReset(); });
afterEach(cleanup);

async function submit(onChecked = vi.fn()) {
  render(<PullRequestDriftCheck projectId="p1" onChecked={onChecked} />);
  fireEvent.change(screen.getByLabelText('Pull request address'), { target: { value: `  ${URL}  ` } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  return onChecked;
}

describe('PullRequestDriftCheck', () => {
  it('found departures are counted and refresh Possible decisions; a clean check says so', async () => {
    h.check.mockResolvedValue({ pullRequest: URL, ledgerVersion: 3, findings: 3, unexplained: 2, suggestionIds: ['a', 'b'] });
    const onChecked = await submit();
    expect(await screen.findByText(/Found 2 changes no recorded decision explains/)).toBeTruthy();
    expect(h.check).toHaveBeenCalledWith('p1', URL);
    expect(onChecked).toHaveBeenCalled();
    cleanup();
    h.check.mockResolvedValue({ pullRequest: URL, ledgerVersion: 3, findings: 0, unexplained: 0, suggestionIds: [] });
    const quiet = await submit();
    expect(await screen.findByText(/departs from the ledger without a decision/)).toBeTruthy();
    expect(quiet).not.toHaveBeenCalled();
  });

  it.each([
    [424, /Connect GitHub \(read pull requests\)/],
    [404, /no pull request at that address/],
    [400, /Use a GitHub pull request address/],
    [429, /budget for this workspace is used up/],
    [502, /did not finish/],
  ])('a %i is said by its cause', async (status, text) => {
    h.check.mockRejectedValue(Object.assign(new Error('x'), { status }));
    await submit();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText(/departs from the ledger without a decision/)).toBeNull();
  });

  it('the button is off until there is an address', () => {
    render(<PullRequestDriftCheck projectId="p1" onChecked={() => undefined} />);
    expect((screen.getByRole('button', { name: 'Check' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
