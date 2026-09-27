/**
 * Commerce SHOWCASE data (ecommerce gap-analysis Phase A / A3) — one coherent
 * fictional storefront for the same "Solstice Roasters" brand the campaign
 * showcase uses (name-only coherence; zero coupling between the seeders).
 *
 * Everything here is deliberately small and legible: four products spanning all
 * three product types (physical with variants + inventory, one deliberately
 * UNDER its low-stock threshold so the alert surface has something to show,
 * a digital download, a service), one coupon, and three orders that exercise
 * the lifecycle (pending / paid / delivered→fulfilled).
 */

export const COMMERCE_SHOWCASE_ACTOR = 'demo:commerce-showcase';

export interface ShowcaseProduct {
  key: 'medium-roast' | 'espresso-blend' | 'brewing-guide' | 'barista-workshop';
  type: 'physical' | 'digital' | 'service';
  name: string;
  description: string;
  price: number;
  currency: string;
  inventory?: number;
  lowStockThreshold?: number;
  variants?: { name: string; sku: string; price?: number; inventory?: number }[];
}

export const SHOWCASE_PRODUCTS: readonly ShowcaseProduct[] = [
  {
    key: 'medium-roast',
    type: 'physical',
    name: 'Solstice Medium Roast — Whole Bean',
    description: 'Our flagship year-round roast: caramel sweetness, toasted hazelnut, and a clean citrus finish. Roasted to order every Monday.',
    price: 16,
    currency: 'USD',
    inventory: 120,
    lowStockThreshold: 20,
    variants: [
      { name: '12 oz bag', sku: 'SR-MR-12', price: 16, inventory: 90 },
      { name: '2 lb bag', sku: 'SR-MR-2LB', price: 38, inventory: 30 },
    ],
  },
  {
    key: 'espresso-blend',
    type: 'physical',
    name: 'Solstice Espresso Blend',
    description: 'A dense, chocolate-forward blend built for milk drinks. Small-batch — restocks sell out fast.',
    price: 21,
    currency: 'USD',
    // Deliberately BELOW the threshold so the low-stock surface has a live example.
    inventory: 6,
    lowStockThreshold: 10,
  },
  {
    key: 'brewing-guide',
    type: 'digital',
    name: 'The Solstice Brewing Guide (PDF)',
    description: 'A 48-page illustrated guide to pour-over, immersion, and espresso brewing — with our exact recipes and troubleshooting charts.',
    price: 9,
    currency: 'USD',
  },
  {
    key: 'barista-workshop',
    type: 'service',
    name: 'Barista Workshop (90 minutes)',
    description: 'Hands-on espresso fundamentals at our roastery bar: dialing in, milk texture, and latte art basics. Max 6 seats per session.',
    price: 75,
    currency: 'USD',
  },
];

export const SHOWCASE_COUPON = {
  code: 'SOLSTICE10',
  type: 'percentage' as const,
  value: 10,
};

/** Orders reference products by `key`; the seeder resolves ids after creation.
 *  `advanceTo` drives the service lifecycle (never raw writes): 'paid' calls
 *  markAsPaid (keyless demo intent — honest `paymentVerification:'none'` posture);
 *  'fulfilled' additionally walks fulfillment processing→shipped→delivered. */
export interface ShowcaseOrder {
  lines: { productKey: ShowcaseProduct['key']; quantity: number }[];
  couponCode?: string;
  advanceTo: 'pending' | 'paid' | 'fulfilled';
  demoPaymentIntentId?: string;
}

export const SHOWCASE_ORDERS: readonly ShowcaseOrder[] = [
  { lines: [{ productKey: 'medium-roast', quantity: 2 }], couponCode: 'SOLSTICE10', advanceTo: 'pending' },
  { lines: [{ productKey: 'brewing-guide', quantity: 1 }], advanceTo: 'paid', demoPaymentIntentId: 'demo:pi_showcase_guide' },
  { lines: [{ productKey: 'medium-roast', quantity: 1 }, { productKey: 'espresso-blend', quantity: 1 }], advanceTo: 'fulfilled', demoPaymentIntentId: 'demo:pi_showcase_beans' },
];
