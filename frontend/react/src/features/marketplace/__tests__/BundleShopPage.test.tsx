/**
 * The feature store (ADR 0419 + ADR 0820 §5/§7 UI) — BundleShopPage after the
 * redesign: one page-level cadence, the other cadence always shown, grouping
 * from catalog DATA, status + "requires" derived from data, a deep-linkable
 * detail panel, the plans × bundles comparison, filter counts, and the
 * member (no-buy) posture. The white-label composer moved to its own route
 * (DistributionComposerPage.test.tsx).
 *
 * Sabotage-witnessed (/grade-tests wave 10), each red in its own case: not
 * remembering / not restoring the cadence, buying at the wrong cadence, offering
 * Buy on a non-purchasable (complimentary) bundle, listing a not-for-sale bundle,
 * dropping the cross-bundle "Requires", offering Buy to a member, a "worth" line
 * on Free, "Free for now" outside the current plan's column, ignoring `?feature=`,
 * folding a failed subscription / commerce read into success, the billing-off
 * notice, closing the panel without clearing `?bundle=`, the walkthrough anchor,
 * the embedded/standalone H1 split, and a trial FAQ line with no trial.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';
import type { BundleCommerce, FeatureBundleCatalog, PublicPlanTier } from '../marketplaceClient.js';

const api = vi.hoisted(() => ({
  fetchFeatureBundles: vi.fn(), fetchBundleCommerce: vi.fn(), fetchPublicPricing: vi.fn(),
  buyBundle: vi.fn(), buyPlan: vi.fn(), getSubscription: vi.fn(), getTokenPacks: vi.fn(),
}));
vi.mock('../marketplaceClient.js', () => ({
  fetchFeatureBundles: api.fetchFeatureBundles, fetchBundleCommerce: api.fetchBundleCommerce, fetchPublicPricing: api.fetchPublicPricing,
}));
// ADR 0786 D5 — purchases are billing writes; the store calls billing's client.
vi.mock('../../billing/billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buyBundle: api.buyBundle, buyPlan: api.buyPlan, getSubscription: api.getSubscription,
  // ADR 0821 D7 — the credit-pack strip (its own tests: creditPacks.test.tsx).
  getTokenPacks: api.getTokenPacks,
}));
// The billing page's own meter is reused, not re-implemented — a stub proves it mounts.
vi.mock('../../billing/AiCreditMeter.js', () => ({ AiCreditMeter: () => <div>AI credit meter (billing)</div> }));
const access = vi.hoisted(() => {
  const owner: EffectiveAccess = { basis: 'tenant-owner', roles: [], scopes: [] };
  return { current: { access: owner, resolved: true } };
});
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));
let enabled = true;
let billingEnabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => {
    const on = id === 'billing' ? billingEnabled : enabled;
    return makeFeatureAccess({ enabled: on });
  },
}));
import { BundleShopPage } from '../BundleShopPage.js';
import { HubProvider } from '../../../chrome/hubContext.js';

const F = (id: string, label: string, dependsOn: string[] = [], description?: string) =>
  ({ id, label, dependsOn, registered: true, ...(description ? { description } : {}) });
const CATALOG: FeatureBundleCatalog = {
  available: true,
  groups: ['sell-grow', 'ai-work'],
  bundles: [
    { id: 'crm', label: 'CRM', group: 'sell-grow', features: [F('crm', 'Accounts', [], 'Contacts and deals')] },
    // territories hard-depends on crm, which lives in another bundle ⇒ "Requires CRM".
    { id: 'sales', label: 'Sales', group: 'sell-grow', features: [F('territories', 'Territories', ['crm'])] },
    {
      id: 'marketing', label: 'Marketing', group: 'sell-grow',
      features: [F('campaigns', 'Campaigns', [], 'One console for every campaign'), F('funnels', 'Funnels'), F('webinars', 'Webinars'), F('domains', 'Custom domains'), F('briefs', 'Briefs')],
    },
    { id: 'agents', label: 'Agents', group: 'ai-work', features: [F('agents', 'Board of Advisors')] },
    { id: 'studio', label: 'Studio', group: 'ai-work', features: [F('studio', 'Studio')] },
  ],
  standalone: [],
  core: [F('orgs', 'Organizations'), F('chat', 'Chat')],
};
const P = (price: string, priceAnnual?: string) => ({
  price, cadence: '/mo', ...(priceAnnual ? { priceAnnual, cadenceAnnual: '/yr' } : {}),
});
const COMMERCE: BundleCommerce[] = [
  { bundleId: 'crm', forSale: true, owned: false, includedInPlan: false, freeForNow: false, purchasable: true, cadences: ['month', 'year'], priceDisplay: { ...P('$49', '$490'), blurb: 'Contacts, deals, customer success' } },
  // PROD shape: the FREE plan lists sales as a complimentary notice period ⇒ free for now, checkout would 409.
  { bundleId: 'sales', forSale: true, owned: false, includedInPlan: false, freeForNow: true, purchasable: false, cadences: ['month', 'year'], priceDisplay: P('$29', '$290') },
  { bundleId: 'marketing', forSale: true, owned: false, includedInPlan: false, freeForNow: false, purchasable: true, cadences: ['month', 'year'], trialDays: 7, priceDisplay: P('$79', '$790') },
  { bundleId: 'agents', forSale: true, owned: true, includedInPlan: false, freeForNow: false, purchasable: false, cadences: ['month'], priceDisplay: P('$29') },
  { bundleId: 'studio', forSale: false, owned: false, includedInPlan: false, freeForNow: false, cadences: [] },
];
const PLANS: PublicPlanTier[] = [
  // The free list carries `territories` (Sales) as the complimentary period.
  { tier: 'free', name: 'Free', features: ['orgs', 'territories'], limits: {}, display: { price: '$0' } },
  { tier: 'pro', name: 'Pro', features: ['agents'], limits: {}, display: { ...P('$39', '$390'), highlighted: true } },
  { tier: 'team', name: 'Team', features: ['crm', 'territories', 'campaigns', 'funnels', 'webinars', 'domains', 'briefs', 'agents'], limits: {}, display: P('$149', '$1,490') },
  { tier: 'enterprise', name: 'Enterprise', features: '*', limits: {} },
];

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <output data-testid="loc">{loc.search}</output>;
}
const page = (entry = '/marketplace/bundles') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/marketplace/bundles" element={<><BundleShopPage /><LocationProbe /></>} /></Routes>
  </MemoryRouter>,
);
const card = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('heading', { level: 4, name })).closest('article') as HTMLElement;

beforeEach(() => {
  enabled = true; billingEnabled = true;
  try { window.localStorage.clear(); } catch { /* jsdom */ }
  access.current = { access: { basis: 'tenant-owner', roles: [], scopes: [] }, resolved: true };
  api.fetchFeatureBundles.mockReset().mockResolvedValue(CATALOG);
  api.fetchBundleCommerce.mockReset().mockResolvedValue(COMMERCE);
  api.fetchPublicPricing.mockReset().mockResolvedValue(PLANS);
  api.getSubscription.mockReset().mockResolvedValue({ tenantId: 't', planTier: 'free', status: 'none' });
  api.buyBundle.mockReset().mockResolvedValue({ url: 'demo:x', mode: 'demo' });
  api.buyPlan.mockReset().mockResolvedValue({ sessionId: 's', url: 'demo:x', mode: 'demo' });
  api.getTokenPacks.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

describe('one page-level cadence (ADR 0820 §7 UI)', () => {
  it('monthly by default: prices, the other cadence underneath with the REAL saving, and buy charges monthly', async () => {
    page();
    const crm = await card('CRM');
    expect(within(crm).getByText('$49')).toBeTruthy();
    expect(within(crm).getByText('or $490/yr · save $98')).toBeTruthy();
    const buy = within(crm).getByRole('button', { name: 'Buy the CRM bundle monthly for $49/mo' });
    expect(buy.textContent).toBe('Buy monthly · $49/mo');
    fireEvent.click(buy);
    await waitFor(() => expect(api.buyBundle).toHaveBeenCalledWith('crm', 'month'));
  });

  it('switching to Yearly changes every price, the other-cadence line and what Buy charges — and is remembered', async () => {
    page();
    await card('CRM');
    const group = screen.getByRole('radiogroup', { name: 'Billing cycle' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Yearly' }));
    expect(within(group).getByRole('radio', { name: 'Yearly' }).getAttribute('aria-checked')).toBe('true');
    const crm = await card('CRM');
    expect(within(crm).getByText('$490')).toBeTruthy();
    expect(within(crm).getByText('Save $98 a year vs monthly')).toBeTruthy();
    const buy = within(crm).getByRole('button', { name: 'Buy the CRM bundle yearly for $490/yr' });
    expect(buy.textContent).toBe('Buy yearly · $490/yr');
    fireEvent.click(buy);
    await waitFor(() => expect(api.buyBundle).toHaveBeenCalledWith('crm', 'year'));
    // Plans follow the same switch.
    const pro = (screen.getByRole('heading', { level: 3, name: 'Pro' })).closest('article') as HTMLElement;
    expect(within(pro).getByText('$390')).toBeTruthy();
    expect(window.localStorage.getItem('openwop.featureStore.cadence')).toBe('year');
  });

  it('a remembered Yearly choice is restored for the viewer', async () => {
    window.localStorage.setItem('openwop.featureStore.cadence', 'year');
    page();
    expect(within(await card('CRM')).getByText('$490')).toBeTruthy();
  });

  it('a saving is never fabricated: no yearly price ⇒ no "or …" line; a yearly price that saves nothing ⇒ no "save"', async () => {
    api.fetchBundleCommerce.mockResolvedValue([
      { ...COMMERCE[0], priceDisplay: P('$49', '$588') }, // 12 × 49 = 588 → no saving
      { ...COMMERCE[2], cadences: ['month'], priceDisplay: P('$79') },
    ]);
    page();
    const crm = await card('CRM');
    expect(within(crm).getByText('or $588/yr')).toBeTruthy();
    expect(within(crm).queryByText(/save/i)).toBeNull();
    const marketing = await card('Marketing');
    expect(within(marketing).queryByText(/^or /)).toBeNull();
  });

  it('a bundle not sold yearly keeps a MONTHLY button that says so while Yearly is selected', async () => {
    window.localStorage.setItem('openwop.featureStore.cadence', 'year');
    api.fetchBundleCommerce.mockResolvedValue([{ ...COMMERCE[0], cadences: ['month'], priceDisplay: P('$49') }]);
    page();
    const crm = await card('CRM');
    expect(within(crm).getByText('Sold monthly only')).toBeTruthy();
    fireEvent.click(within(crm).getByRole('button', { name: 'Buy the CRM bundle monthly for $49/mo' }));
    await waitFor(() => expect(api.buyBundle).toHaveBeenCalledWith('crm', 'month'));
  });
});

describe('grouping, status and requires — all from data', () => {
  it('groups cards under the catalog `groups`, in that order, with i18n labels', async () => {
    page();
    await card('CRM');
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads.indexOf('Sell & grow')).toBeLessThan(heads.indexOf('Work smarter with AI'));
    const sell = screen.getByRole('heading', { level: 3, name: 'Sell & grow' }).parentElement!.parentElement as HTMLElement;
    expect(within(sell).getByRole('heading', { level: 4, name: 'CRM' })).toBeTruthy();
    expect(within(sell).queryByRole('heading', { level: 4, name: 'Agents' })).toBeNull();
  });

  it('a group id the UI has no label for still renders (data wins), and an ungrouped bundle lands in "More bundles"', async () => {
    api.fetchFeatureBundles.mockResolvedValue({
      ...CATALOG, groups: ['brand-new'],
      bundles: [{ ...CATALOG.bundles[0], group: 'brand-new' }, { ...CATALOG.bundles[3], group: undefined }],
    });
    page();
    expect(await screen.findByRole('heading', { level: 3, name: 'brand-new' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'More bundles' })).toBeTruthy();
  });

  it('status chips: Owned / Free for now / Available; the owned bundle offers Manage, not Buy', async () => {
    page();
    expect(within(await card('Agents')).getByText('Owned')).toBeTruthy();
    expect(within(await card('Agents')).getByRole('link', { name: 'Manage' })).toBeTruthy();
    expect(within(await card('Agents')).queryByRole('button', { name: /Buy the Agents/ })).toBeNull();
    expect(within(await card('Sales')).getByText('Free for now')).toBeTruthy();
    expect(within(await card('CRM')).getByText('Available')).toBeTruthy();
    // Not for sale and not owned ⇒ not in the store at all.
    expect(screen.queryByRole('heading', { level: 4, name: 'Studio' })).toBeNull();
  });

  it('a plan-included bundle reads "Included in your plan" with NO Buy (control: an uncovered one keeps Buy)', async () => {
    api.fetchBundleCommerce.mockResolvedValue([{ ...COMMERCE[0], includedInPlan: true, purchasable: false }, COMMERCE[2]]);
    page();
    expect(within(await card('CRM')).getByText('Included in your plan')).toBeTruthy();
    expect(within(await card('CRM')).queryByRole('button', { name: /Buy the CRM/ })).toBeNull();
    expect(within(await card('Marketing')).getByRole('button', { name: /Buy the Marketing bundle monthly/ })).toBeTruthy();
  });

  it('"Requires CRM" comes from a cross-bundle dependsOn edge, and only there', async () => {
    page();
    expect(within(await card('Sales')).getByText('Requires CRM')).toBeTruthy();
    expect(within(await card('Marketing')).queryByText(/Requires/)).toBeNull();
  });

  it('shows the top 3 features and "+N more features"', async () => {
    page();
    const m = await card('Marketing');
    expect(within(m).getByText('Campaigns')).toBeTruthy();
    expect(within(m).queryByText('Custom domains')).toBeNull();
    expect(within(m).getByRole('button', { name: 'Details of the Marketing bundle' }).textContent).toBe('+2 more features');
  });
});

describe('PR #4481 review — a complimentary (free-plan-listed) bundle', () => {
  it('reads "Free for now" with the introductory-period note and NO buy button (its checkout would 409)', async () => {
    page();
    const sales = await card('Sales');
    expect(within(sales).getByText('Free for now')).toBeTruthy();
    expect(within(sales).queryByText('Included in your plan')).toBeNull();
    expect(within(sales).getByText(/Free during the introductory period/)).toBeTruthy();
    expect(within(sales).queryByRole('button', { name: /^Buy the Sales/ })).toBeNull();
    // Control: a purchasable bundle on the same page keeps its button.
    expect(within(await card('CRM')).getByRole('button', { name: /^Buy the CRM bundle/ })).toBeTruthy();
  });

  it('its detail panel shows the note instead of Continue to payment', async () => {
    page('/marketplace/bundles?bundle=sales');
    const dialog = await screen.findByRole('dialog', { name: 'Sales' });
    expect(within(dialog).getByText(/Free during the introductory period/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Continue to payment/ })).toBeNull();
  });

  it('with the paywall OFF (free for now but purchasable) the buy button stays — checkout would succeed', async () => {
    api.fetchBundleCommerce.mockResolvedValue([{ ...COMMERCE[1], purchasable: true }]);
    page();
    const sales = await card('Sales');
    expect(within(sales).getByText('Free for now')).toBeTruthy();
    expect(within(sales).getByRole('button', { name: /^Buy the Sales bundle monthly/ })).toBeTruthy();
    expect(within(sales).queryByText(/Free during the introductory period/)).toBeNull();
  });

  it('the Free plan card claims neither "worth" nor "includes" for its complimentary bundles; the comparison says Free for now', async () => {
    page();
    const free = (await screen.findByRole('heading', { level: 3, name: 'Free' })).closest('article') as HTMLElement;
    expect(within(free).queryByText(/worth/)).toBeNull();
    expect(within(free).queryByText(/Includes .*Sales/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans and bundles' }));
    const table = await screen.findByRole('table', { name: 'Which bundles each plan includes' });
    const sales = within(table).getByRole('rowheader', { name: /^Sales/ }).closest('tr') as HTMLElement;
    expect(within(sales).getAllByRole('cell')[0]!.textContent).toBe('Free for now');
  });
});

describe('filters', () => {
  it('chips carry counts and aria-pressed, and filter the cards', async () => {
    page();
    await card('CRM');
    const filters = screen.getByRole('group', { name: 'Filter bundles' });
    const all = within(filters).getByRole('button', { name: /^All/ });
    expect(all.textContent).toBe('All 4');
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(within(filters).getByRole('button', { name: /^Available/ }).textContent).toBe('Available 2');
    const free = within(filters).getByRole('button', { name: /^Free for now/ });
    expect(free.textContent).toBe('Free for now 1');
    expect(within(filters).getByRole('button', { name: /^Owned/ }).textContent).toBe('Owned 1');
    expect(within(filters).queryByRole('button', { name: /^Included/ })).toBeNull(); // none included ⇒ no chip
    fireEvent.click(free);
    expect(free.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { level: 4, name: 'Sales' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 4, name: 'CRM' })).toBeNull();
  });
});

describe('status strip', () => {
  it('shows the current plan, the bundles summary and the billing page’s own AI meter for an admin', async () => {
    page();
    const strip = await screen.findByRole('region', { name: 'Your workspace' });
    expect(await within(strip).findByText('Free')).toBeTruthy();
    expect(within(strip).getByText('1 owned · 0 included · 1 free for now')).toBeTruthy();
    expect(await within(strip).findByText('AI credit meter (billing)')).toBeTruthy();
  });

  it('a failed subscription read says so — never a fabricated "Free"', async () => {
    api.getSubscription.mockRejectedValue(new Error('503'));
    page();
    const strip = await screen.findByRole('region', { name: 'Your workspace' });
    expect(await within(strip).findByText('Your plan could not be loaded.')).toBeTruthy();
    expect(within(strip).queryByText('Free')).toBeNull();
  });
});

describe('plans', () => {
  it('marks the current plan, shows an honest worth line, subscribes at the selected cadence, Enterprise → contact', async () => {
    page();
    const free = (await screen.findByRole('heading', { level: 3, name: 'Free' })).closest('article') as HTMLElement;
    expect(within(free).getByText('Current plan')).toBeTruthy();
    const team = screen.getByRole('heading', { level: 3, name: 'Team' }).closest('article') as HTMLElement;
    // crm $49 + sales $29 + marketing $79 + agents $29 = $186 — every covered price parsed.
    expect(within(team).getByText('Includes bundles worth $186/mo')).toBeTruthy();
    fireEvent.click(within(team).getByRole('button', { name: 'Subscribe to Team monthly for $149/mo' }));
    await waitFor(() => expect(api.buyPlan).toHaveBeenCalledWith('team', 'month'));
    const ent = screen.getByRole('heading', { level: 3, name: 'Enterprise' }).closest('article') as HTMLElement;
    expect(within(ent).getByText(/contact the team/)).toBeTruthy();
    // An unrestricted ('*') plan gets no worth line — that would be a claim about every bundle.
    expect(within(ent).queryByText(/worth/)).toBeNull();
  });

  it('omits the worth line when a covered bundle’s price does not parse', async () => {
    api.fetchBundleCommerce.mockResolvedValue([{ ...COMMERCE[0], priceDisplay: { price: 'Ask us', cadence: '' } }, ...COMMERCE.slice(1)]);
    page();
    const team = (await screen.findByRole('heading', { level: 3, name: 'Team' })).closest('article') as HTMLElement;
    expect(within(team).queryByText(/worth/)).toBeNull();
  });
});

describe('detail panel (deep-linkable)', () => {
  it('opens from ?bundle=, lists every feature with its description, upsells a cheaper plan, and closes on Escape', async () => {
    page('/marketplace/bundles?bundle=marketing');
    const dialog = await screen.findByRole('dialog', { name: 'Marketing' });
    expect(within(dialog).getByText('What you get · 5 features')).toBeTruthy();
    expect(within(dialog).getByText('One console for every campaign')).toBeTruthy();
    expect(within(dialog).getByText('Custom domains')).toBeTruthy();
    // Team ($149) covers Marketing AND is worth $186 > $149 ⇒ a computed upsell.
    expect(within(dialog).getByText('Better value as part of Team.')).toBeTruthy();
    // 7-day trial for this workspace ⇒ $0 due today, then the price.
    expect(within(dialog).getByText('$0')).toBeTruthy();
    expect(within(dialog).getByText('7-day free trial, then $79/mo.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc').textContent).not.toContain('bundle=');
  });

  it('ADR 0419 §8 — a locked nav link (?feature=<id>) opens the bundle that sells that feature', async () => {
    page('/marketplace/bundles?feature=webinars');
    expect(await screen.findByRole('dialog', { name: 'Marketing' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('?bundle=marketing'));
  });

  it('ADR 0419 §8 — ?feature= for a feature no bundle sells just lands on the store', async () => {
    page('/marketplace/bundles?feature=chat');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(''));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"+N more" opens it and writes the deep link; its cadence choice drives Continue to payment', async () => {
    page();
    fireEvent.click(within(await card('Marketing')).getByRole('button', { name: 'Details of the Marketing bundle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Marketing' });
    expect(screen.getByTestId('loc').textContent).toContain('bundle=marketing');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Yearly/ }));
    const go = within(dialog).getByRole('button', { name: 'Continue to payment for the Marketing bundle at $790/yr' });
    expect(go.textContent).toContain('Continue to payment · $790/yr');
    fireEvent.click(go);
    await waitFor(() => expect(api.buyBundle).toHaveBeenCalledWith('marketing', 'year'));
  });
});

describe('compare view', () => {
  it('toggles a plans × bundles table on the same page (Included / Add-on / Free for now)', async () => {
    page();
    const toggle = await screen.findByRole('button', { name: 'Compare plans and bundles' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const table = await screen.findByRole('table', { name: 'Which bundles each plan includes' });
    const row = (name: string) => within(table).getByRole('rowheader', { name: new RegExp(`^${name}`) }).closest('tr') as HTMLElement;
    const cells = (name: string) => within(row(name)).getAllByRole('cell').map((c) => c.textContent);
    // Free · Pro · Team · Enterprise
    expect(cells('CRM')).toEqual(['Add-on', 'Add-on', 'Included', 'Included']);
    // "Free for now" only in the CURRENT plan's column (free).
    expect(cells('Sales')).toEqual(['Free for now', 'Add-on', 'Included', 'Included']);
    expect(cells('Agents')).toEqual(['Add-on', 'Included', 'Included', 'Included']);
    expect(screen.getByTestId('loc').textContent).toContain('view=compare');
  });
});

describe('admins only buy (ADR 0786 D5)', () => {
  it('a MEMBER sees why, and no buy, subscribe, meter or composer link', async () => {
    access.current = { access: { basis: 'member', roles: ['editor'], scopes: ['workspace:read', 'workspace:write'] }, resolved: true };
    page();
    expect(await screen.findByText('Only workspace owners and admins can buy bundles.')).toBeTruthy();
    await card('CRM');
    expect(screen.queryByRole('button', { name: /^Buy the / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Subscribe to / })).toBeNull();
    expect(screen.queryByText('AI credit meter (billing)')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the distribution composer' })).toBeNull();
  });
  it('an ADMIN (host:billing:manage) is offered Buy (control); the composer is the hub\'s Distribution tab, not an inline link', async () => {
    access.current = { access: { basis: 'member', roles: ['billing-admin'], scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true };
    page();
    expect(within(await card('CRM')).getByRole('button', { name: /^Buy the CRM bundle/ })).toBeTruthy();
    expect(document.querySelector('a[href="/marketplace/distribution"]')).toBeNull();
    expect(screen.queryByText('Only workspace owners and admins can buy bundles.')).toBeNull();
  });
});

describe('designed states', () => {
  it('billing off → the catalog without prices, statuses or buttons, and a notice saying why', async () => {
    billingEnabled = false;
    page();
    expect(await screen.findByText(/bundles are listed without prices/)).toBeTruthy();
    const crm = await card('CRM');
    expect(within(crm).queryByText('$49')).toBeNull();
    expect(within(crm).queryByRole('button', { name: /^Buy/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter bundles' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your workspace' })).toBeNull();
  });

  it('billing on but nothing for sale → the designed empty store', async () => {
    api.fetchBundleCommerce.mockResolvedValue([{ bundleId: 'crm', forSale: false, owned: false }]);
    page();
    expect(await screen.findByText('Nothing for sale yet')).toBeTruthy();
  });

  it('MKT-G1 — a thrown commerce read warns with retry; the healed retry restores the store', async () => {
    api.fetchBundleCommerce.mockRejectedValueOnce(new Error('503'));
    page();
    await screen.findByText(/store pricing couldn’t be loaded/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/store pricing couldn’t be loaded/i)).toBeNull());
    expect(await card('CRM')).toBeTruthy();
  });

  it('no catalog → the designed empty state', async () => {
    api.fetchFeatureBundles.mockResolvedValue({ available: false, groups: [], bundles: [], standalone: [], core: [] });
    page();
    expect(await screen.findByText('No bundle catalog')).toBeTruthy();
  });

  it('standalone: its own H1 and walkthrough anchor, and no inline "back to the marketplace" link (control for the embedded case)', async () => {
    page();
    await card('CRM');
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(document.querySelector('[data-walkthrough="marketplace-bundles.page"]')).not.toBeNull();
    // The hub tabs are the wayfinding.
    expect(document.querySelector('a[href="/marketplace"]')).toBeNull();
  });

  it('embedded in the hub: drops its own H1, keeps its anchor (the hub owns the header)', async () => {
    render(
      <MemoryRouter initialEntries={['/marketplace/bundles']}>
        <HubProvider><BundleShopPage /></HubProvider>
      </MemoryRouter>,
    );
    await card('CRM');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('[data-walkthrough="marketplace-bundles.page"]')).not.toBeNull();
  });

  it('"Always free" lists the catalog core; the FAQ states a trial only because a bundle has one', async () => {
    page();
    await card('CRM');
    expect(screen.getByText('2 core features are included on every plan:')).toBeTruthy();
    expect(screen.getByText('Some bundles start with a free trial of up to 7 days.')).toBeTruthy();
    // Control: with no bundle offering a trial, the FAQ makes no trial claim.
    cleanup();
    api.fetchBundleCommerce.mockResolvedValue(COMMERCE.filter((c) => !c.trialDays));
    page();
    await card('CRM');
    expect(screen.queryByText(/free trial/)).toBeNull();
  });
});
