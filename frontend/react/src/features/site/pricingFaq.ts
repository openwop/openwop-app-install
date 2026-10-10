/**
 * ADR 0820 §7 — the public `/pricing` fallback's FAQ, built as the data of an
 * ordinary CMS `faq` section (the SAME block an operator can author on a
 * `pricing` CMS page, which then replaces this whole fallback).
 *
 * Every answer is a claim about live billing behaviour, so the rules are:
 * - a NUMBER that comes from operator config (trial length, the past-due and
 *   public-lapse grace windows, credit allowances, packs, standalone bundles)
 *   is read from the public pricing payload, never written into copy — the
 *   server reads it from the same parsers that enforce it;
 * - a sentence whose fact is not configured is LEFT OUT, never defaulted (no
 *   trial configured ⇒ no trial question);
 * - no paid offer at all (an unpriced self-host) ⇒ no billing FAQ.
 *
 * `t` may be any namespace's: keys are `site:`-qualified.
 * Code sources for each claim are cited in the PR and ADR 0820 §7's note.
 */
import type { TFunction } from 'i18next';
import { loadPublicBundlePricing, loadPublicPricing, type BillingPolicy, type CreditPack, type PublicBundle, type PublicTier } from './publicPricingClient.js';

export interface PricingFaqFacts {
  tiers: PublicTier[];
  creditPacks: CreditPack[];
  billingPolicy?: BillingPolicy | undefined;
  /** `null` = the bundle read FAILED (standalone bundles unknown ⇒ unsaid). */
  bundles: PublicBundle[] | null;
}
export interface FaqItem { q: string; a: string }

const join = (...parts: Array<string | null | undefined | false>): string => parts.filter(Boolean).join(' ');
/** Paragraphs: the faq renderer keeps `\n\n` (white-space: pre-line). */
const paras = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');

function monthlyCredits(tier: PublicTier): number {
  const v = tier.limits?.aiCreditsMonthly;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** The FAQ items, or `null` when there is nothing paid to ask about. */
export function buildPricingFaq(t: TFunction, list: (items: string[]) => string, facts: PricingFaqFacts): FaqItem[] | null {
  const bundles = facts.bundles ?? [];
  const paidOffer = facts.tiers.some((x) => x.tier !== 'free' && Boolean(x.display?.price))
    || bundles.some((b) => Boolean(b.priceDisplay?.price));
  if (!paidOffer) return null;

  const hasAllowance = facts.tiers.some((x) => monthlyCredits(x) > 0);
  const hasPacks = facts.creditPacks.length > 0;
  const items: FaqItem[] = [];

  items.push({
    q: t('site:pricingFaqCreditsQ'),
    a: paras(
      join(t('site:pricingFaqCreditsA'), hasAllowance && t('site:pricingFaqCreditsAllowance'), hasPacks && t('site:pricingFaqCreditsPacks')),
      t('site:pricingFaqCreditsByok'),
    ),
  });

  // Trials: grouped by length so two plans with the same trial read as one
  // sentence. Only tiers the server says carry a trial.
  const byDays = new Map<number, string[]>();
  for (const x of facts.tiers) {
    if (typeof x.trialDays !== 'number' || x.trialDays < 1) continue;
    byDays.set(x.trialDays, [...(byDays.get(x.trialDays) ?? []), x.name]);
  }
  if (byDays.size > 0) {
    const offers = [...byDays.entries()].map(([count, names]) => t('site:pricingFaqTrialOffer', { count, plans: list(names) }));
    items.push({ q: t('site:pricingFaqTrialQ'), a: join(...offers, t('site:pricingFaqTrialA')) });
  }

  items.push({ q: t('site:pricingFaqCancelQ'), a: t('site:pricingFaqCancelA') });
  items.push({ q: t('site:pricingFaqSeatsQ'), a: t('site:pricingFaqSeatsA') });

  const policy = facts.billingPolicy;
  const pastDue = policy && policy.pastDueGraceDays > 0 ? t('site:pricingFaqDataPastDue', { count: policy.pastDueGraceDays }) : null;
  let publicPages: string | null = null;
  if (policy) {
    const lapse = policy.publicLapseGraceDays;
    publicPages = lapse === null ? t('site:pricingFaqDataPublicStays')
      : lapse > 0 ? t('site:pricingFaqDataPublicGrace', { count: lapse })
        : t('site:pricingFaqDataPublicNow');
  }
  items.push({ q: t('site:pricingFaqDataQ'), a: paras(t('site:pricingFaqDataA'), join(pastDue, publicPages)) });

  const standalone = bundles.filter((b) => b.standalone).map((b) => b.label);
  items.push({
    q: t('site:pricingFaqPlanQ'),
    a: join(
      t('site:pricingFaqPlanA'),
      hasAllowance && t('site:pricingFaqPlanCredits'),
      standalone.length > 0 && t('site:pricingFaqPlanStandalone', { count: standalone.length, bundles: list(standalone) }),
    ),
  });

  if (hasAllowance || hasPacks) {
    items.push({
      // Ask only what this deployment can answer.
      q: hasAllowance && hasPacks ? t('site:pricingFaqRolloverQ') : hasAllowance ? t('site:pricingFaqRolloverAllowanceQ') : t('site:pricingFaqRolloverPacksQ'),
      a: join(hasAllowance && t('site:pricingFaqRolloverMonthly'), hasPacks && t('site:pricingFaqRolloverPacks')),
    });
  }
  return items;
}

/** Read both public pricing endpoints and build the FAQ. A failed bundle read
 *  only hides the "sold separately" sentence (`bundles: null`); a failed pricing
 *  read rejects (the caller shows no FAQ — the tier grid already says why).
 *  Imported DYNAMICALLY by `PricingPage`, so this module and the shared pricing
 *  client stay out of the entry chunk's preload map. */
export async function loadPricingFaq(t: TFunction, list: (items: string[]) => string): Promise<FaqItem[] | null> {
  const bundleRead = loadPublicBundlePricing().then(
    (bundles) => ({ failed: false as const, bundles }),
    () => ({ failed: true as const }),
  );
  const [pricing, b] = await Promise.all([loadPublicPricing(), bundleRead]);
  return buildPricingFaq(t, list, {
    tiers: pricing.tiers, creditPacks: pricing.creditPacks, billingPolicy: pricing.billingPolicy,
    bundles: b.failed ? null : b.bundles,
  });
}
