/**
 * ADR 0905 P3 (D6, commerce sender) — the paid-order confirmation renders through the
 * host transactional registry as `commerce.order-confirmed`, in the four product
 * locales (goldens), with the order-status link LAST in the text.
 *
 * The end-to-end send (a paid order emails its contact through the transport) stays
 * pinned by `commerce-phase-d.test.ts`; this file pins the copy.
 *
 * Sabotage-witnessed: hard-coding English in `compose` reds three locale goldens.
 */
import { describe, expect, it } from 'vitest';
import { renderTransactional, TRANSACTIONAL_LOCALES } from '../src/host/transactionalEmail.js';
import { ORDER_CONFIRMED_KIND, registerCommerceTransactionalTemplates, type OrderConfirmedData } from '../src/features/commerce/transactionalTemplates.js';

registerCommerceTransactionalTemplates();

const data: OrderConfirmedData = { orderId: 'ord_1', total: 1234.5, currency: 'USD', statusUrl: 'https://app.example/shared/tok_1' };
const golden: Record<string, { subject: string; text: string }> = {
  en: { subject: 'Order ord_1 confirmed', text: 'Thanks for your order. Total: $1,234.50.\n\nTrack your order: https://app.example/shared/tok_1' },
  es: { subject: 'Pedido ord_1 confirmado', text: 'Gracias por tu pedido. Total: 1234,50 US$.\n\nSigue tu pedido: https://app.example/shared/tok_1' },
  fr: { subject: 'Commande ord_1 confirmée', text: 'Merci pour votre commande. Total : 1 234,50 $US.\n\nSuivez votre commande : https://app.example/shared/tok_1' },
  'pt-BR': { subject: 'Pedido ord_1 confirmado', text: 'Obrigado pelo seu pedido. Total: US$ 1.234,50.\n\nAcompanhe seu pedido: https://app.example/shared/tok_1' },
};

describe('commerce.order-confirmed — goldens in the four product locales', () => {
  for (const locale of TRANSACTIONAL_LOCALES) {
    it(locale, () => {
      const r = renderTransactional(ORDER_CONFIRMED_KIND, data, { locale });
      expect({ subject: r.subject, text: r.text }).toEqual(golden[locale]);
    });
  }
  it('without a status link the text ends at the total', () => {
    expect(renderTransactional(ORDER_CONFIRMED_KIND, { orderId: 'o', total: 6, currency: 'USD' }, { locale: 'en' }).text).toBe('Thanks for your order. Total: $6.00.');
  });
});
