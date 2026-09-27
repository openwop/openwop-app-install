/**
 * Tutorial: Open Your Storefront (ADR 0490) — commerce walkthrough from first
 * product to first refund. Authored English content.
 */
import type { TutorialData } from '../tutorialTypes.js';

export const openYourStorefront: TutorialData = {
  id: 'open-your-storefront',
  category: 'commerce',
  title: 'Open Your Storefront',
  description: 'Create products, share your public store, take a real order, apply promotions, and handle a refund — the commerce loop end to end.',
  hero: { title: 'Open Your Storefront', subtitle: 'From first product to first refund' },
  goal: 'Walk the whole commerce loop: catalog → public storefront → order → promotion → refund → the one-read revenue summary.',
  learningObjectives: [
    'Create products with prices, variants, and inventory',
    'Share the public storefront and take a guest order',
    'Stack a promotion on top of your prices',
    'Mark orders paid, fulfil them, and issue a refund',
    'Read the revenue summary',
  ],
  prerequisites: ['The E-Commerce feature enabled (Admin → Feature toggles)', 'Optional: a Stripe key for live card capture'],
  estimatedMinutes: 25,
  difficulty: 'beginner',
  surfaces: ['/commerce'],
  phases: [
    {
      number: 1,
      title: 'Build the Catalog',
      goal: 'Products with honest prices and stock.',
      outcome: 'A sellable catalog.',
      steps: [
        { id: '1.1', title: 'Create products', content: [
          { type: 'instructions', items: [
            { text: 'Open **E-Commerce** and create a product: type (physical / digital / service), name, price, currency.' },
            { text: 'Physical products carry **inventory** — orders reserve stock at creation and release it if payment never lands.' },
            { text: 'Variants (size, color) carry their own SKU and optional price.' },
          ] },
        ] },
      ],
    },
    {
      number: 2,
      title: 'Open the Public Store',
      goal: 'A shareable storefront.',
      outcome: 'Guests can browse and buy.',
      steps: [
        { id: '2.1', title: 'The storefront link', content: [
          { type: 'instructions', items: [
            { text: 'Your workspace’s public storefront lives at **/store/<workspace>** — share it, or link your funnel’s offer page straight to it.' },
            { text: 'Guest checkout creates the order and a CRM contact from the buyer’s email (deduped).' },
          ] },
          { type: 'callout', variant: 'info', title: 'Keyless is honest', body: 'Without a Stripe key the checkout runs in demo mode: the order exists, honestly unpaid. With a key, buyers get a real hosted card checkout and the webhook flips the order paid.' },
        ] },
      ],
    },
    {
      number: 3,
      title: 'Promote',
      goal: 'A rule-based discount on top of your prices.',
      outcome: 'A live promotion that applies itself at checkout.',
      steps: [
        { id: '3.1', title: 'Create a promotion', content: [
          { type: 'instructions', items: [
            { text: 'Open **Promotions** and create one — a cart threshold (“10% over $110”), a product discount, or a budget-capped loss-leader.' },
            { text: 'Promotions compute a discount **on top of** resolved prices at checkout and snapshot onto the order — refunds and reports stay explainable.' },
          ] },
        ] },
      ],
    },
    {
      number: 4,
      title: 'Orders, Fulfilment, Refunds',
      goal: 'Run the order lifecycle.',
      outcome: 'A paid, fulfilled, partially-refunded order — all auditable.',
      steps: [
        { id: '4.1', title: 'The order lifecycle', content: [
          { type: 'instructions', items: [
            { text: 'Orders move **pending → paid → fulfilled**; cancelling a pending order releases its stock.' },
            { text: 'With Stripe configured, refunds are REAL — full or partial; the order tracks the cumulative refunded amount.' },
          ] },
          { type: 'callout', variant: 'warning', title: 'Money verification', body: 'A payment only flips an order paid after the amount and currency verify against the order — a mismatched webhook is rejected loudly, never silently accepted.' },
        ] },
      ],
    },
    {
      number: 5,
      title: 'Read the Numbers',
      goal: 'One read for the whole picture.',
      outcome: 'You know your GMV, AOV, and top products.',
      steps: [
        { id: '5.1', title: 'The revenue summary', content: [
          { type: 'instructions', items: [
            { text: 'The commerce **reports summary** gives GMV, average order value, top products, coupon usage, and low-stock warnings in one read.' },
            { text: 'Selling through a funnel? Per-step revenue lands in the funnel’s own analytics too (the Build Your First Sales Funnel tutorial, phase 8).' },
          ] },
          { type: 'checklist', items: [
            { label: 'Product created' },
            { label: 'Storefront order placed' },
            { label: 'Promotion applied' },
            { label: 'Refund issued' },
          ] },
        ] },
      ],
    },
  ],
};
