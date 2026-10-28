/**
 * Commerce's transactional email kinds (ADR 0905 D6), registered on the host
 * registry (`host/transactionalEmail.ts`) at commerce boot. Copy is product copy in
 * the four product locales; data reaches the message only through the filler.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const ORDER_CONFIRMED_KIND = 'commerce.order-confirmed';

export interface OrderConfirmedData {
  orderId: string;
  /** Major units, as stored on the order. */
  total: number;
  currency: string;
  /** The order-status share link, when one could be minted. */
  statusUrl?: string;
}

export const orderConfirmedTemplate: TransactionalTemplate<OrderConfirmedData> = {
  kind: ORDER_CONFIRMED_KIND,
  catalog: {
    en: { subject: 'Order {{orderId}} confirmed', body: 'Thanks for your order. Total: {{total}}.', track: 'Track your order: {{url}}' },
    es: { subject: 'Pedido {{orderId}} confirmado', body: 'Gracias por tu pedido. Total: {{total}}.', track: 'Sigue tu pedido: {{url}}' },
    fr: { subject: 'Commande {{orderId}} confirmée', body: 'Merci pour votre commande. Total : {{total}}.', track: 'Suivez votre commande : {{url}}' },
    'pt-BR': { subject: 'Pedido {{orderId}} confirmado', body: 'Obrigado pelo seu pedido. Total: {{total}}.', track: 'Acompanhe seu pedido: {{url}}' },
  },
  compose(f, d) {
    const body = f.text('body', { total: f.money(d.total, d.currency) });
    // The link stays LAST in the text (a reader — and a test — can take everything
    // after it as the token).
    return {
      subject: f.subject('subject', { orderId: d.orderId }),
      text: d.statusUrl ? `${body}\n\n${f.text('track', { url: d.statusUrl })}` : body,
    };
  },
};

export function registerCommerceTransactionalTemplates(): void {
  registerTransactionalTemplate(orderConfirmedTemplate);
}
