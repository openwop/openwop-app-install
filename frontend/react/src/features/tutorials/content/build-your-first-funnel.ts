/**
 * Tutorial: Build Your First Sales Funnel (ADR 0490) — the flagship
 * walkthrough, mirroring the MyndHyve "Complete Marketing Setup" format on
 * THIS app's real surfaces (ADR 0293–0297). Authored English content (the
 * manual-tests posture); every claim below matches shipped behavior — where a
 * capability is API-only or operator-gated, the tutorial says so.
 */
import type { TutorialData } from '../tutorialTypes.js';

export const buildYourFirstFunnel: TutorialData = {
  id: 'build-your-first-funnel',
  category: 'marketing',
  title: 'Build Your First Sales Funnel',
  description: 'From a blank workspace to a published, measured, A/B-tested sales funnel — pages, routing, checkout, upsells, analytics, and AI optimization.',
  hero: {
    title: 'Build Your First Sales Funnel',
    subtitle: 'From zero to a revenue-measured funnel in 10 phases',
  },
  goal: 'This hands-on guide walks you through the full funnel stack: design the pages, assemble and publish the funnel, route visitors, take payment, measure every step, run an experiment, and let the Funnel Architect propose the next improvement.',
  learningObjectives: [
    'Design and publish funnel pages in the CMS Page Builder',
    'Assemble ordered funnel steps and control the visitor path with routing rules',
    'Publish a funnel to a shareable public URL',
    'Sell through the storefront with affiliate attribution, order bumps, and one-click upsells',
    'Read per-step analytics (views, completions, conversion, revenue)',
    'Run an honest 50/50 challenger experiment on a step',
    'Use the Funnel Architect agent and the optimization chain to improve conversion',
  ],
  prerequisites: [
    'A workspace where you hold the editor or owner role',
    'Admin access to feature toggles (or ask your administrator)',
  ],
  estimatedMinutes: 45,
  difficulty: 'beginner',
  surfaces: ['/funnels'],
  phases: [
    {
      number: 1,
      title: 'Turn On the Funnel Stack',
      description: 'Funnels ship OFF by default — flip the toggles once per workspace.',
      goal: 'Enable the features this walkthrough uses.',
      outcome: 'Funnels appears in your sidebar; the commerce surfaces are ready for the selling phases.',
      steps: [
        {
          id: '1.1',
          title: 'Enable Funnels (and E-Commerce)',
          run: { chainId: 'walkthrough.feature-toggles.list' },
          content: [
            { type: 'instructions', items: [
              { text: 'Open **Admin → Feature toggles**.' },
              { text: 'Turn on **Funnels** — the multi-step funnel builder this tutorial is about.' },
              { text: 'Turn on **E-Commerce** too if you want the selling phases (6–7); Funnels recommends it but runs without it.' },
            ] },
            { type: 'callout', variant: 'info', title: 'Where things live', body: 'Funnels compose surfaces you may already use: pages come from the CMS Page Builder, payments ride Commerce + Stripe, analytics land on the CDP event spine. Nothing in this tutorial creates a second copy of those systems.' },
          ],
        },
        {
          id: '1.2',
          title: 'Know the map',
          content: [
            { type: 'feature-grid', items: [
              { label: 'Funnels', desc: 'Ordered steps, each serving one of your CMS pages' },
              { label: 'CMS Page Builder', desc: 'Where every step’s page is designed and published' },
              { label: 'Storefront', desc: 'Public checkout at /store — bumps, refs, one-click upsells' },
              { label: 'Analytics', desc: 'Per-step views, completions, conversion, and revenue' },
            ] },
          ],
        },
      ],
    },
    {
      number: 2,
      title: 'Design Your Pages',
      description: 'A funnel step serves a published CMS page — build three of them.',
      goal: 'Create and publish the landing, offer, and thank-you pages.',
      outcome: 'Three published pages ready to become funnel steps.',
      steps: [
        {
          id: '2.1',
          title: 'Create the three pages',
          run: { chainId: 'walkthrough.cms.pages' },
          content: [
            { type: 'instructions', items: [
              { text: 'Open the **CMS** and create a page called **Landing** — your hook: headline, the promise, one call-to-action.' },
              { text: 'Create **Offer** — the sales pitch: what they get, proof, price, one buy button.' },
              { text: 'Create **Thanks** — the confirmation: what happens next, and (later) your upsell copy.' },
            ] },
            { type: 'callout', variant: 'tip', title: 'One job per page', body: 'Every funnel step should have exactly one call-to-action. If a page tries to do two things, split it into two steps — steps are cheap, confused visitors are not.' },
          ],
        },
        {
          id: '2.2',
          title: 'Publish each page',
          content: [
            { type: 'instructions', items: [
              { text: 'Open each page and hit **Publish**. Publishing is the serving gate: a funnel can reference a draft page, but the public step 404s until the page is published.' },
            ] },
            { type: 'callout', variant: 'info', title: 'Honest serving', body: 'If you later unpublish a step’s page, that step becomes unavailable to the public (a clean 404) — the funnel never leaks draft content.' },
          ],
        },
      ],
    },
    {
      number: 3,
      title: 'Assemble the Funnel',
      description: 'Order the pages into a path.',
      goal: 'Create the funnel and bind each step to a page.',
      outcome: 'A draft funnel: Landing → Offer → Thanks.',
      steps: [
        {
          id: '3.1',
          title: 'Create the funnel',
          run: { chainId: 'walkthrough.funnels.list' },
          content: [
            { type: 'instructions', items: [
              { text: 'Open **Funnels** in the sidebar, pick your workspace, name it (e.g. **Summer Launch**), and hit **Create funnel**.' },
              { text: 'The URL slug is derived from the name (summer-launch) — it becomes the public path, and it locks while the funnel is published.' },
            ] },
          ],
        },
        {
          id: '3.2',
          title: 'Add and order the steps',
          content: [
            { type: 'instructions', items: [
              { text: 'In the funnel editor, **Add step** three times: a **Landing** step → your Landing page, a **Sales** step → Offer, a **Thank you** step → Thanks.' },
              { text: 'Use the up/down arrows to reorder; **Save steps** when the path reads top-to-bottom.' },
              { text: 'The **Edit page** link on any step deep-links straight into the Page Builder — content edits never leave the funnel context.' },
            ] },
            { type: 'checklist', items: [
              { label: 'Three steps, in order' },
              { label: 'Every step bound to a published page' },
              { label: 'Steps saved' },
            ] },
          ],
        },
      ],
    },
    {
      number: 4,
      title: 'Publish and Share',
      description: 'Make it live and hand out the entry URL.',
      goal: 'Publish the funnel and open the public entry.',
      outcome: 'A live funnel any visitor can walk.',
      steps: [
        {
          id: '4.1',
          title: 'Publish the funnel',
          run: { chainId: 'walkthrough.publishing.settings' },
          content: [
            { type: 'instructions', items: [
              { text: 'Hit **Publish** on the funnel. Publishing validates the path: at least one step, and every step’s page must still exist — a broken path fails loudly here, never silently in front of a visitor.' },
              { text: 'The editor now shows the **public entry URL** — open it: your Landing page serves, wrapped with the funnel’s step position.' },
            ] },
            { type: 'callout', variant: 'info', title: 'Visitor privacy', body: 'Funnel analytics only track visitors who carry a consented visitor key (the same consent gate as the analytics beacon). Anonymous visitors walk the funnel untracked — by design.' },
          ],
        },
        {
          id: '4.2',
          title: 'Optional: your own domain',
          content: [
            { type: 'prose', text: 'With the Custom domains feature, a funnel can serve on your own hostname (pages.your-brand.com): register the hostname, prove ownership with a DNS TXT record, and your operator attaches the TLS certificate at the load balancer. The domain is pinned to your workspace’s public content only — fail-closed.' },
          ],
        },
      ],
    },
    {
      number: 5,
      title: 'Route Your Visitors',
      description: 'The path is sequential by default — rules make it conditional.',
      goal: 'Understand sequential flow and add an outcome rule.',
      outcome: 'Declined offers skip straight to the thank-you page.',
      steps: [
        {
          id: '5.1',
          title: 'How routing works',
          content: [
            { type: 'instructions', items: [
              { text: 'With no rules, completing step N serves step N+1 — and past the last step the funnel reports **complete**.' },
              { text: 'A step can carry **routing rules**: the first rule whose conditions match decides the next step. Conditions today: the reported **outcome** (accepted / declined) and **UTM parameters** on the visitor’s link.' },
            ] },
          ],
        },
        {
          id: '5.2',
          title: 'Add a declined-skips-ahead rule',
          content: [
            { type: 'prose', text: 'Routing rules are authored through the API (or by the Funnel Architect agent) in this release — the visual rule editor is on the roadmap. To send a declined offer straight to the thank-you step, update the Sales step with:' },
            { type: 'code', language: 'json', code: '{\n  "steps": [\n    { "stepId": "landing", "kind": "landing", "pageId": "<landing-page-id>" },\n    { "stepId": "offer", "kind": "sales", "pageId": "<offer-page-id>",\n      "routing": [ { "when": { "outcome": "declined" }, "goto": "thanks" } ] },\n    { "stepId": "thanks", "kind": "thankyou", "pageId": "<thanks-page-id>" }\n  ]\n}' },
            { type: 'callout', variant: 'tip', title: 'Timers belong to journeys', body: 'Funnel rules decide per-visitor, per-click. Anything time-based — abandonment nudges, follow-up sequences — belongs to Campaign Journeys, which can trigger off the funnel’s own events.' },
          ],
        },
      ],
    },
    {
      number: 6,
      title: 'Add Commerce',
      description: 'Turn the offer into revenue.',
      goal: 'Create the product and sell it through the public storefront.',
      outcome: 'Orders carry your funnel’s fingerprint, so revenue shows up per step.',
      steps: [
        {
          id: '6.1',
          title: 'Create the product',
          run: { chainId: 'walkthrough.commerce.catalog' },
          content: [
            { type: 'instructions', items: [
              { text: 'In **E-Commerce**, create the product your Offer page sells (name, price, currency). Digital products need no inventory.' },
              { text: 'Point your Offer page’s buy button at the public storefront (/store/<your-workspace>) or embed a product grid section from the Page Builder.' },
            ] },
          ],
        },
        {
          id: '6.2',
          title: 'Attribution: the funnel stamp and affiliate refs',
          content: [
            { type: 'instructions', items: [
              { text: 'A checkout that carries the funnel stamp (funnelId + stepId) ties the order to your funnel — that’s how the analytics phase shows **revenue per step**.' },
              { text: 'Affiliate links: create an affiliate with a code in E-Commerce, share links carrying **ref=CODE** — a real code attributes the order and accrues commission at payment; junk codes are silently ignored.' },
            ] },
            { type: 'callout', variant: 'info', title: 'Order bumps', body: 'The checkout accepts bump add-ons priced into the SAME single charge, with honest line-item provenance. Bump offers on the checkout page come from your Recommendations placements.' },
          ],
        },
      ],
    },
    {
      number: 7,
      title: 'One-Click Upsells',
      description: 'The post-purchase moment is your highest-intent traffic.',
      goal: 'Understand the consent-first one-click chain.',
      outcome: 'You know exactly what to enable — and what stays a human decision.',
      steps: [
        {
          id: '7.1',
          title: 'How the chain works',
          content: [
            { type: 'instructions', items: [
              { text: 'At checkout, a buyer can **explicitly consent** (an unticked checkbox) to save their payment method for one-click offers.' },
              { text: 'After payment, your Thanks/upsell step can offer one more product — an accept charges the saved method **without re-entering card details**, creating a child order linked to the original.' },
              { text: 'A declined card routes to your downsell; a bank challenge (SCA) falls back to a normal confirm — the chain never silently drops a sale.' },
            ] },
          ],
        },
        {
          id: '7.2',
          title: 'The operator gate',
          content: [
            { type: 'callout', variant: 'warning', title: 'Money movement is opt-in', body: 'One-click charging ships DISABLED. Your operator enables it (OPENWOP_COMMERCE_OFFSESSION_ENABLED) only after the compliance review for your markets — until then the consent checkbox and chain endpoints exist but no off-session charge is ever made.' },
          ],
        },
      ],
    },
    {
      number: 8,
      title: 'Measure Every Step',
      description: 'The funnel is only as good as its weakest step.',
      goal: 'Read the per-step analytics honestly.',
      outcome: 'You can name your weakest step with numbers, not vibes.',
      steps: [
        {
          id: '8.1',
          title: 'The analytics table',
          content: [
            { type: 'instructions', items: [
              { text: 'Open your funnel and find **Analytics**: per step you get **Views**, **Completions**, **Conversion**, **Orders**, and **Revenue**.' },
              { text: 'Rollups rebuild on a schedule; **Rebuild now** forces a fresh recompute after a test session.' },
            ] },
            { type: 'feature-grid', items: [
              { label: 'Views', desc: 'Consented visitors who saw the step' },
              { label: 'Completions', desc: 'Visitors who advanced past it' },
              { label: 'Conversion', desc: 'Completions ÷ views — the number to fix' },
              { label: 'Revenue', desc: 'Paid orders stamped to the step (refunds subtract)' },
            ] },
          ],
        },
        {
          id: '8.2',
          title: 'Trust the numbers',
          content: [
            { type: 'callout', variant: 'info', title: 'Honest by construction', body: 'Analytics derive from the event spine and stamped orders on every rebuild — canceled orders drop out, refunds subtract, deleted funnels sweep their history. The table also states its event window, so very old traffic aging out is disclosed, never hidden.' },
          ],
        },
      ],
    },
    {
      number: 9,
      title: 'Experiment',
      description: 'Opinions argue; splits decide.',
      goal: 'Run a 50/50 challenger against your weakest step.',
      outcome: 'A running experiment with verdicts you can trust.',
      steps: [
        {
          id: '9.1',
          title: 'Start the split',
          content: [
            { type: 'instructions', items: [
              { text: 'Build a **challenger page** in the Page Builder (change ONE thing — the headline, the price framing) and publish it.' },
              { text: 'In the funnel’s **Step experiments** panel, pick the weak step, pick the challenger, and **Start 50/50 split**.' },
              { text: 'Consented visitors are assigned stickily — the same visitor always sees the same variant; anonymous visitors see the original.' },
            ] },
          ],
        },
        {
          id: '9.2',
          title: 'Read the verdict honestly',
          content: [
            { type: 'instructions', items: [
              { text: 'Results show per-variant visitors, completions, and conversion, plus a significance verdict (95%).' },
              { text: 'Below 30 visitors per variant the verdict honestly reads **needs more visitors** — never over-read a small sample.' },
              { text: '**Stop** the experiment when significance lands; if the challenger won, make its page the step’s page.' },
            ] },
            { type: 'callout', variant: 'tip', title: 'One variable at a time', body: 'A challenger that changes five things tells you nothing when it wins. Change one element per split; run the next split for the next element.' },
          ],
        },
      ],
    },
    {
      number: 10,
      title: 'Optimize with AI',
      description: 'The Funnel Architect reads your numbers and proposes the next move.',
      goal: 'Get a grounded optimization proposal.',
      outcome: 'A prioritized, evidence-based next experiment — proposed by AI, decided by you.',
      steps: [
        {
          id: '10.1',
          title: 'Ask the Funnel Architect',
          content: [
            { type: 'instructions', items: [
              { text: 'Open the chat and talk to the **Funnel Architect** agent: it can list your funnels, read per-step stats, draft new funnels, and propose step changes.' },
              { text: 'Or run the **Funnel Step Optimization Proposal** workflow chain against your funnel — it reads the definition + stats and returns the weakest step, concrete page changes to test, and the exact experiment to start.' },
            ] },
          ],
        },
        {
          id: '10.2',
          title: 'You stay in charge',
          content: [
            { type: 'callout', variant: 'info', title: 'Agents propose, humans dispose', body: 'Everything the AI authors stays a DRAFT: it cannot publish a funnel, start or stop an experiment, or touch pricing. The proposal chain is read-only by construction. Publishing to the public web is always a human clicking a button.' },
            { type: 'checklist', items: [
              { label: 'Funnel published and shared' },
              { label: 'Revenue attributed per step' },
              { label: 'First experiment running' },
              { label: 'First AI proposal reviewed' },
            ] },
          ],
        },
      ],
    },
  ],
};
