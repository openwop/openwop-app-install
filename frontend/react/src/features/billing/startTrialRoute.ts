/**
 * ADR 1097 — the public trial entry: `/start-trial?plan=<tier>` or
 * `/start-trial?bundle=<id>`, optionally `&cadence=year`. A marketing CTA (a CMS
 * button on the operator's own site, or a link from another domain) points here.
 *
 * The keys match the billing knobs' `plan:<tier>` / `bundle:<id>` keys
 * (`OPENWOP_BILLING_TRIAL_DAYS`, `OPENWOP_BILLING_TRIAL_CARD`). Parsing is strict:
 * exactly one of `plan` / `bundle`, a paid tier, a bundle id in the catalog id
 * shape, and `month` / `year` for the cadence. Anything else is `null`, which the
 * page renders as "this link does not name a plan" — never a guessed target.
 */
import type { TrialTarget } from './billingClient.js';

export { START_TRIAL_ROUTE, matchStartTrialRoute } from './startTrialMatch.js';

export interface ParsedTrialLink { target: TrialTarget; cadence: 'month' | 'year' }

const PLANS = new Set(['pro', 'team', 'enterprise']);
/** Bundle ids are lower-case slugs (`crm`, `job-search`). */
const BUNDLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseTrialLink(search: string): ParsedTrialLink | null {
  const q = new URLSearchParams(search);
  const plans = q.getAll('plan');
  const bundles = q.getAll('bundle');
  const cadences = q.getAll('cadence');
  if (plans.length + bundles.length !== 1 || cadences.length > 1) return null;
  const cadence = cadences[0] ?? 'month';
  if (cadence !== 'month' && cadence !== 'year') return null;
  const plan = plans[0];
  if (plan !== undefined) {
    if (!PLANS.has(plan)) return null;
    return { target: { plan: plan as 'pro' | 'team' | 'enterprise' }, cadence };
  }
  const bundleId = bundles[0]!;
  if (!BUNDLE_ID.test(bundleId)) return null;
  return { target: { bundleId }, cadence };
}
