/**
 * Campaign Studio SHOWCASE content (campaign gap-analysis Phase A / A4) — one
 * coherent fictional DTC brand ("Solstice Roasters") exercised end-to-end across
 * the Campaign Studio cluster: a Brand with a real voice profile + guardrails
 * (ADR 0155), two content-targeting Personas + a confirmed CampaignBrief with a
 * messaging kernel (ADR 0156), the finalized MarketingCampaign (ADR 0158), and a
 * two-platform, 14-day ad-performance series feeding the KPI/intelligence
 * surfaces (ADR 0159/0160). Static content only — the seeder
 * (`host/campaignShowcaseSeed.ts`) owns ids, gating, and idempotency.
 */
import type { BriefChannel, BriefMessaging, BuyerStage, MessagingKernel } from '../../features/campaign-brief/types.js';

export const CAMPAIGN_SHOWCASE = {
  brand: {
    name: 'Solstice Roasters',
    description:
      'A small-batch specialty coffee subscription: single-origin beans roasted to order and shipped within 48 hours of the roast.',
    voiceProfile: {
      voice: 'Warm, craft-obsessed, and plainspoken — an expert friend, never a salesman.',
      guidelines:
        '- Lead with the craft (origin, roast date, tasting notes), not discounts.\n' +
        '- Short sentences. Concrete images over adjectives.\n' +
        '- Never shame the reader’s current coffee; invite the upgrade.',
      formalityLevel: 2,
      samplePhrases: [
        'Roasted Tuesday. On your counter Thursday.',
        'Coffee this fresh doesn’t need sugar.',
      ],
      avoidPhrases: ['artisanal excellence', 'elevate your experience'],
      toneRegisters: [],
    },
    positioning: {
      tagline: 'Small-batch coffee, roasted to your morning.',
      elevatorPitch:
        'Solstice Roasters ships single-origin coffee within 48 hours of roasting, matched to how you actually brew — so every cup tastes like the roaster intended.',
      differentiators: [
        'Roast-date honesty: every bag stamped, nothing older than 48 hours at ship',
        'Brew-matched profiles (espresso / filter / cold brew), not one-roast-fits-all',
        'Direct farm relationships published per lot',
      ],
      competitiveFrame: 'Against supermarket beans and big-box subscriptions that ship months-old stock.',
    },
    keyPhrases: {
      approvedTaglines: ['Small-batch coffee, roasted to your morning.'],
      valuePropositions: ['Fresher than the store can sell', 'Matched to how you brew'],
      productDescriptors: ['single-origin', 'roast-to-order', 'brew-matched'],
      bannedPhrases: ['world-class', 'revolutionary', 'game-changing'],
    },
    /** SEED-1 — a REAL compliance policy so the ADR 0354 ads-dispatch gate
     *  demos on demo data. `threshold`/60 exercises BOTH gate legs: a banned
     *  phrase caps the deterministic score at ≤30 (blocked), and stacked
     *  off-voice phrasing can sink below 60 (blocked) — while clean on-brand
     *  copy (the kernel's own language) scores 100 and dispatches freely, so
     *  the policy never wedges the seeded campaign's flow (the seeder itself
     *  never dispatches ads; the gate only runs at the adsAdapter edge). */
    governance: {
      lockLevel: 'none',
      allowedEditors: [],
      requireApproval: false,
      compliance: { blockPublish: 'threshold', blockThreshold: 60 },
    },
  },

  personas: [
    {
      name: 'Home-brew upgrader',
      role: 'Remote knowledge worker',
      buyerStage: 'problem_aware' as BuyerStage,
      painPoints: [
        'Supermarket beans taste flat and inconsistent',
        'No idea when the beans were actually roasted',
        'Overwhelmed by specialty jargon',
      ],
      objections: ['Subscriptions pile up unused', 'Specialty coffee feels pretentious and pricey'],
      goals: ['A noticeably better daily cup without becoming a hobbyist'],
      demographics: '28–45, works from home, owns a decent grinder or is one nudge away from buying one.',
    },
    {
      name: 'Office coffee buyer',
      role: 'Office / operations manager',
      buyerStage: 'solution_aware' as BuyerStage,
      painPoints: [
        'The office machine gets daily complaints',
        'Ordering coffee is one more recurring chore',
        'Needs invoicing, not a consumer checkout',
      ],
      objections: ['Switching suppliers is friction', 'Volume pricing beats quality pitches'],
      goals: ['A set-and-forget standing order the team stops complaining about'],
      demographics: 'Buys for 15–60 people; cares about reliability and a monthly invoice.',
    },
  ],

  brief: {
    name: 'Summer Solstice Subscription Launch',
    objective:
      'Launch the summer single-origin lineup and grow subscription starts 20% in the quarter, leading with roast-date freshness.',
    productName: 'Solstice Subscription',
    productDescription:
      'A flexible coffee subscription: pick your brew method, get brew-matched single-origin bags roasted to order and shipped within 48 hours. Pause or swap any time.',
    /** MUST equal `SOLSTICE_MEDIA_INDUSTRY` (seed-data/solsticeDemo.ts) — the
     *  demo media facets stamp the same string so `assets/select` matches the
     *  industry dimension on demo data (SEED-3). */
    industryVertical: 'Specialty coffee / DTC subscription',
    /** SEED-1 — ADR 0351 P2: ground generation in the KB when possible,
     *  proceed otherwise ('strict' would fail the demo closed whenever no KB
     *  collection is attached — best-effort showcases grounding without
     *  wedging generation). */
    groundingPolicy: 'best-effort',
    /** SEED-1 — ADR 0355 P5: real DTC-coffee competitors so the differentiation
     *  prompt block + the "never parrot their claims" QA guard demo. */
    competitors: ['Trade Coffee', 'Atlas Coffee Club', 'Blue Bottle Coffee'],
    /** creative_briefs stays disabled — shows selective channel fan-out. */
    channels: [
      { type: 'landing_page', enabled: true, config: {} },
      { type: 'ad_variants', enabled: true, config: {} },
      { type: 'email_sequence', enabled: true, config: {} },
      { type: 'creative_briefs', enabled: false, config: {} },
      { type: 'social_posts', enabled: true, config: {} },
    ] as BriefChannel[],
    messaging: {
      primaryValueProp: 'Coffee fresher than the store can legally pretend to be — roasted to order, shipped in 48 hours.',
      toneOverride: '',
      proofPoints: [
        'Every bag stamped with its roast date',
        'Brew-matched roast profiles for espresso, filter, and cold brew',
        'Farm and lot published for every origin',
      ],
      ctaStrategy: 'First bag free on every new subscription',
    } as BriefMessaging,
  },

  /** SEED-3 — which demo-media manifest keys (`seed-data/solsticeDemo.ts`
   *  SOLSTICE_MEDIA) each showcase persona is stamped onto. The seeder resolves
   *  the runtime persona ids after creating the personas and writes them into
   *  each asset's `marketing.personaIds`, so `assets/select` scores the persona
   *  dimension against REAL ids on demo data. Keys, not asset ids — the media
   *  seeder owns ids; the two stay in lockstep via the deterministic key tags. */
  personaMediaKeys: {
    'Home-brew upgrader': [
      'ethiopia-yirgacheffe', 'colombia-huila', 'single-origin-sampler', 'subscription-box',
      'pour-over-kit', 'burr-grinder', 'blog-pour-over', 'blog-subscription',
    ],
    'Office coffee buyer': ['office-blend-wholesale', 'green-beans-wholesale', 'blog-wholesale'],
  } as Record<string, readonly string[]>,

  /** The kernel the channels echo. `generatedAt` is stamped by the seeder. */
  kernel: {
    headline: 'Roasted Tuesday. On your counter Thursday.',
    supportingStatement:
      'Solstice ships single-origin coffee within 48 hours of roasting, matched to how you brew — so your daily cup finally tastes like the roaster intended.',
    proofPoints: [
      'Roast date stamped on every bag',
      'Brew-matched profiles, not one-roast-fits-all',
      'Direct farm relationships, published per lot',
    ],
    primaryCta: 'Start your subscription — first bag free',
    secondaryCta: 'Explore the summer origins',
    tone: 'warm, plainspoken, craft-forward',
    channelTones: { ad_variants: 'punchy and concrete', email_sequence: 'personal, like a note from the roaster' },
    sourceDocIds: [],
  } as Omit<MessagingKernel, 'generatedAt'>,

  performance: {
    adSet: 'prospecting',
    days: 14,
    /** Per-platform daily baselines; the seeder adds a deterministic day-index wobble. */
    platforms: [
      { platform: 'meta' as const, spend: 118, impressions: 15200, clicks: 372, conversions: 19, revenue: 585 },
      { platform: 'google' as const, spend: 96, impressions: 6100, clicks: 244, conversions: 14, revenue: 512 },
    ],
  },

  /** ADR 0353 — the showcase VISUAL creative brief (the hero shot the ad
   *  variants would run on), tied to the campaign brief by the seeder. Seeded
   *  only when the `creative-briefs` feature is enabled (DG-SEED-5). */
  creativeBrief: {
    title: 'Hero shot — roast-date stamp close-up',
    assetType: 'image',
    sceneDescription:
      'Macro shot of a Solstice Roasters bag on a sunlit kitchen counter, the roast-date stamp crisp and in focus; a pour-over mid-brew softly blurred behind it, steam catching the morning light.',
    composition: 'Rule of thirds: stamp lower-left, pour upper-right; shallow depth of field.',
    cameraAngle: 'low three-quarter, macro on the stamp',
    lighting: 'warm window light, no fill — an honest morning kitchen',
    brandPalette: ['#3E2723', '#FF8F00', '#FFF8E1'],
    messagingIntent:
      'Prove the freshness claim visually — the roast-date stamp IS the headline ("Roasted Tuesday. On your counter Thursday.").',
    platformSpec: { platform: 'instagram', format: 'feed', textRulePct: 10 },
    directions: [
      { label: 'Stamp as hero', rationale: 'The roast date is the product truth — make it the subject' },
      { label: 'Morning ritual', rationale: 'Place the brand inside the buyer’s existing routine' },
    ],
  },
} as const;
