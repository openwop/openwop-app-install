/**
 * ADR 0948 P2c — the money steps of the public funnel viewer, as the visitor's
 * browser sees them.
 *
 * 1. A checkout step shows its OFFER (the offered products and add-ons, read from
 *    the public product route), no bare Continue, and pays with exactly the chosen
 *    ids plus the funnel ref; never a price. The demo lane says nothing was charged.
 * 2. Back from Stripe: the purchase capability is read from the URL FRAGMENT and
 *    removed from the address bar; the viewer waits for "paid", then advances with
 *    the capability in HEADERS (never the URL).
 * 3. An upsell with the capability: Accept posts one-click for the offered product
 *    at quantity 1 with `ft`; No thanks posts the decline; either way the next step
 *    comes from the server. A bank decline is said and offers Continue.
 * 4. An upsell without a purchase (a direct visit) is plain content with Continue.
 * 5. Never a dead end for a paying buyer (/code-review): an offer with no product,
 *    an archived product, a refused accept, and a `?paid=1` return with no purchase
 *    in this tab each say so and offer Continue.
 *
 * Sabotage-witnessed: sending the price/quantity of the visitor's choosing, the
 * capability in the `next` URL instead of headers, leaving the fragment in the
 * address bar, and showing Continue on a checkout step each turn a leg red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { config } from '../../../../client/config.js';
import { FunnelViewerPage } from '../FunnelViewerPage.js';

const PUBLIC = `${config.baseUrl}/host/openwop-app/public/org%3A1`;
const STORE = `${config.baseUrl}/host/openwop-app/public-store/org%3A1`;
const FUNNEL = { slug: 'launch', name: 'Launch' };
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const page = (title: string) => ({ slug: 's', title, sections: [{ sectionId: 'x', type: 'richText', data: { text: title } }], updatedAt: '', seo: {} });
const offer = { productIds: ['main', 'alt'], bumpProductIds: ['bump'] };
const checkoutStep = { ix: 0, stepId: 'c', kind: 'checkout', pageSlug: 'pc', offer, formContext: { funnelId: 'fun:1', stepId: 'c' } };
const upsellStep = { ix: 1, stepId: 'u', kind: 'upsell', pageSlug: 'pu', offer: { productIds: ['up'], oneClickProductId: 'up' }, formContext: { funnelId: 'fun:1', stepId: 'u' } };
const thanks = { ix: 3, stepId: 't', kind: 'thankyou', pageSlug: 'pt', formContext: { funnelId: 'fun:1', stepId: 't' } };
const product = (productId: string, name: string, price: number) => json({ product: { productId, name, price, currency: 'USD' } });

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }
function mock(routes: Record<string, (c: Call) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const c: Call = { url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    if (!u.includes('/public-consent/')) calls.push(c);
    const hit = routes[`${c.method} ${u}`];
    return hit ? hit(c) : new Response('{}', { status: 404 });
  }));
  return calls;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><FunnelViewerPage orgId="org:1" slug="launch" /></MemoryRouter>);

beforeEach(() => { try { window.sessionStorage.clear(); } catch { /* ignore */ } window.history.replaceState(null, '', '/'); });
afterEach(() => vi.unstubAllGlobals());

describe('funnel viewer — money steps (ADR 0948 P2c)', () => {
  it('a checkout shows its offer, no Continue, and pays with ids only (demo: nothing charged)', async () => {
    const calls = mock({
      [`GET ${PUBLIC}/funnels/launch`]: () => json({ funnel: FUNNEL, stepCount: 4, step: checkoutStep }),
      [`GET ${PUBLIC}/pages/pc`]: () => json(page('Get the course')),
      [`GET ${STORE}/products/main`]: () => product('main', 'Course', 100),
      [`GET ${STORE}/products/alt`]: () => product('alt', 'Course lite', 80),
      [`GET ${STORE}/products/bump`]: () => product('bump', 'Workbook', 15),
      [`POST ${STORE}/checkout`]: () => json({ orderId: 'o1', mode: 'demo' }, 201),
      [`GET ${PUBLIC}/funnels/launch/next?from=c`]: () => json({ funnel: FUNNEL, stepCount: 4, step: thanks }),
      [`GET ${PUBLIC}/pages/pt`]: () => json(page('Thank you')),
    });
    renderAt('/fn/org:1/launch');
    await screen.findByText('Course lite');
    expect(screen.queryByRole('button', { name: 'Continue' }), 'a checkout never offers a bare Continue').toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Course lite/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Workbook/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'a@b.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByText(/no payment was taken/)).toBeTruthy();
    const pay = calls.find((c) => c.method === 'POST' && c.url === `${STORE}/checkout`);
    expect(pay?.body).toEqual({
      email: 'a@b.test', savePaymentMethod: false,
      lines: [{ productId: 'alt', quantity: 1 }], bumps: [{ productId: 'bump' }],
      funnel: { funnelId: 'fun:1', stepId: 'c' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
  });

  it('back from Stripe: reads the fragment, clears it, waits for paid, advances with header capability', async () => {
    window.history.replaceState(null, '', '/fn/org:1/launch?step=0&paid=1#order=o1&ft=tok');
    const calls = mock({
      [`GET ${PUBLIC}/funnels/launch/steps/0`]: () => json({ funnel: FUNNEL, stepCount: 4, step: checkoutStep }),
      [`GET ${PUBLIC}/pages/pc`]: () => json(page('Get the course')),
      [`POST ${STORE}/orders/o1/funnel-offer`]: () => json({ paid: true, open: false }),
      [`GET ${PUBLIC}/funnels/launch/next?from=c`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
      [`GET ${STORE}/products/up`]: () => product('up', 'Coaching', 50),
    });
    renderAt('/fn/org:1/launch?step=0&paid=1');
    expect(window.location.hash, 'the capability must leave the address bar').toBe('');
    await screen.findByText('Add coaching?');
    const next = calls.find((c) => c.url.startsWith(`${PUBLIC}/funnels/launch/next`));
    expect(next?.url).not.toContain('tok');
    expect(next?.headers).toMatchObject({ 'x-openwop-funnel-order': 'o1', 'x-openwop-funnel-offer': 'tok' });
    expect(calls.find((c) => c.url.endsWith('/funnel-offer'))?.body).toEqual({ funnel: { funnelId: 'fun:1', stepId: 'c' }, ft: 'tok' });
  });

  it('an upsell with the purchase: Accept charges the offered product once; No thanks declines', async () => {
    window.sessionStorage.setItem('funnel-purchase:org:1:launch', JSON.stringify({ orderId: 'o1', ft: 'tok' }));
    const base = {
      [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
      [`GET ${STORE}/products/up`]: () => product('up', 'Coaching', 50),
      [`GET ${PUBLIC}/funnels/launch/next?from=u`]: () => json({ funnel: FUNNEL, stepCount: 4, step: thanks }),
      [`GET ${PUBLIC}/pages/pt`]: () => json(page('Thank you')),
    };
    const calls = mock({ ...base, [`POST ${STORE}/orders/o1/one-click`]: () => json({ orderId: 'c1', paid: true }, 201) });
    const first = renderAt('/fn/org:1/launch?step=1');
    await screen.findByText('Coaching');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, add it' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/one-click'))?.body).toEqual({ productId: 'up', quantity: 1, funnel: { funnelId: 'fun:1', stepId: 'u' }, ft: 'tok' });
    first.unmount();

    const calls2 = mock({ ...base, [`POST ${STORE}/orders/o1/funnel-decline`]: () => json({ declined: true }) });
    renderAt('/fn/org:1/launch?step=1');
    fireEvent.click(await screen.findByRole('button', { name: 'No thanks' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    expect(calls2.find((c) => c.url.endsWith('/funnel-decline'))?.body).toEqual({ funnel: { funnelId: 'fun:1', stepId: 'u' }, ft: 'tok' });
    expect(calls2.some((c) => c.url.endsWith('/one-click'))).toBe(false);
  });

  it('a bank decline is said, and Continue moves on', async () => {
    window.sessionStorage.setItem('funnel-purchase:org:1:launch', JSON.stringify({ orderId: 'o1', ft: 'tok' }));
    mock({
      [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
      [`GET ${STORE}/products/up`]: () => product('up', 'Coaching', 50),
      [`POST ${STORE}/orders/o1/one-click`]: () => json({ declined: true, reason: 'insufficient_funds' }, 402),
      [`GET ${PUBLIC}/funnels/launch/next?from=u`]: () => json({ funnel: FUNNEL, stepCount: 4, step: thanks }),
      [`GET ${PUBLIC}/pages/pt`]: () => json(page('Thank you')),
    });
    renderAt('/fn/org:1/launch?step=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, add it' }));
    expect(await screen.findByText(/card was declined/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
  });

  it('an upsell without a purchase is plain content with Continue', async () => {
    mock({
      [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
    });
    renderAt('/fn/org:1/launch?step=1');
    await screen.findByText('Add coaching?');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Yes, add it' })).toBeNull();
  });

  it('never a dead end: no product, an archived product, a refused accept, or a return with no purchase', async () => {
    window.sessionStorage.setItem('funnel-purchase:org:1:launch', JSON.stringify({ orderId: 'o1', ft: 'tok' }));
    const after = {
      [`GET ${PUBLIC}/funnels/launch/next?from=u`]: () => json({ funnel: FUNNEL, stepCount: 4, step: thanks }),
      [`GET ${PUBLIC}/pages/pt`]: () => json(page('Thank you')),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
    };
    // An offer that names no one-click product.
    mock({ ...after, [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: { ...upsellStep, offer: { productIds: ['up'] } } }) });
    const a = renderAt('/fn/org:1/launch?step=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    a.unmount();

    // The offered product was archived (its public read is a 404).
    mock({ ...after, [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }) });
    const b = renderAt('/fn/org:1/launch?step=1');
    expect(await screen.findByText('This offer is no longer available.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    b.unmount();

    // Accept refused for this purchase (no saved card): said, with Continue.
    mock({
      ...after,
      [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${STORE}/products/up`]: () => product('up', 'Coaching', 50),
      [`POST ${STORE}/orders/o1/one-click`]: () => json({ error: 'validation_error', message: 'No saved payment method for this purchase.' }, 400),
    });
    const c = renderAt('/fn/org:1/launch?step=1');
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, add it' }));
    expect(await screen.findByText('This offer is no longer available.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    c.unmount();

    // `?paid=1` with no purchase in this tab: no endless spinner.
    window.sessionStorage.clear();
    mock({
      [`GET ${PUBLIC}/funnels/launch/steps/0`]: () => json({ funnel: FUNNEL, stepCount: 4, step: checkoutStep }),
      [`GET ${PUBLIC}/pages/pc`]: () => json(page('Get the course')),
    });
    renderAt('/fn/org:1/launch?step=0&paid=1');
    expect(await screen.findByText(/still being confirmed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('an empty checkout offer says so with Continue; a failed offer read retries', async () => {
    // Every offered product is gone (404): a notice and the way on.
    mock({
      [`GET ${PUBLIC}/funnels/launch`]: () => json({ funnel: FUNNEL, stepCount: 4, step: checkoutStep }),
      [`GET ${PUBLIC}/pages/pc`]: () => json(page('Get the course')),
      [`GET ${PUBLIC}/funnels/launch/next?from=c`]: () => json({ funnel: FUNNEL, stepCount: 4, step: thanks }),
      [`GET ${PUBLIC}/pages/pt`]: () => json(page('Thank you')),
    });
    const a = renderAt('/fn/org:1/launch');
    expect(await screen.findByText('This offer is not available right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Thank you')).toBeTruthy();
    a.unmount();

    // An upsell product read fails once (500), then the retry loads it.
    window.sessionStorage.setItem('funnel-purchase:org:1:launch', JSON.stringify({ orderId: 'o1', ft: 'tok' }));
    let reads = 0;
    mock({
      [`GET ${PUBLIC}/funnels/launch/steps/1`]: () => json({ funnel: FUNNEL, stepCount: 4, step: upsellStep }),
      [`GET ${PUBLIC}/pages/pu`]: () => json(page('Add coaching?')),
      [`GET ${STORE}/products/up`]: () => (++reads === 1 ? new Response('{}', { status: 500 }) : product('up', 'Coaching', 50)),
    });
    renderAt('/fn/org:1/launch?step=1');
    expect((await screen.findAllByText('We couldn’t load this offer. Nothing was charged.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Yes, add it' })).toBeTruthy();
  });
});
