/**
 * `<Notice>` announcement contract.
 *
 * The defect this pins: a conditionally-mounted live region enters the DOM with
 * its text already inside, and is therefore not reliably announced. `Notice`
 * shipped that shape for its whole life behind a docstring claiming otherwise.
 *
 * These assert the ANNOUNCEMENT — the text reaching the app-shell region — not
 * the presence of a `role` attribute. That distinction is the entire lesson of
 * #2615/#2616: the attribute was there and nothing was ever spoken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import { GlobalLiveRegion } from '../announce.js';
import { Notice } from '../Notice.js';

function mount(node: React.ReactNode): void {
  render(<><GlobalLiveRegion /><div data-testid="page">{node}</div></>);
}
const polite = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? '';
const assertive = (): string => document.querySelector('[aria-live="assertive"]')?.textContent ?? '';
const page = (): ReturnType<typeof within> => within(screen.getByTestId('page'));

beforeEach(() => { /* each render starts from a clean document */ });
afterEach(cleanup);

describe('Notice — opt-in announcement', () => {
  it('SPEAKS the given text through the app-shell region', () => {
    mount(<Notice variant="warning" announce="Showing the last known queue">Showing the last known queue</Notice>);
    expect(polite()).toContain('Showing the last known queue');
  });

  it('routes an ERROR to the assertive region, not the polite one', () => {
    mount(<Notice variant="error" announce="Payment failed">Payment failed</Notice>);
    expect(assertive()).toContain('Payment failed');
    expect(polite()).not.toContain('Payment failed');
  });

  it('speaks the ANNOUNCE text, not the children — children may be JSX or a raw error blob', () => {
    mount(
      <Notice variant="warning" announce="The refresh failed">
        <span>The refresh failed: ECONNRESET at 10.0.0.4:5432</span>
      </Notice>,
    );
    expect(polite()).toContain('The refresh failed');
    expect(polite()).not.toContain('ECONNRESET');
  });

  it('DROPS its own live region when announcing — never two regions for one message', () => {
    // The DS-8 pairing (`toast.tsx:80`). Delegating AND carrying a role is the
    // double-announce; this asserts the notice element itself is not a region.
    mount(<Notice variant="warning" announce="Stale">Stale</Notice>);
    const el = page().getByText('Stale');
    expect(el.closest('[role="status"]')).toBeNull();
    expect(el.closest('[role="alert"]')).toBeNull();
  });

  it('is UNCHANGED without the prop — still carries its own role, still says nothing', () => {
    // The other arm. Existing call sites must not start behaving differently just
    // because the prop exists; the sweep is deliberate, not automatic.
    mount(<Notice variant="warning">Quiet</Notice>);
    const el = page().getByText('Quiet');
    expect(el.closest('[role="status"]')).not.toBeNull();
    expect(polite()).not.toContain('Quiet');
  });
});
