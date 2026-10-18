/**
 * ADR 0875 D2 — the one-click capability.
 *
 * `POST /public-store/:orgId/orders/:orderId/one-click` charges a saved card
 * off-session. It used to need nothing but a paid `orderId`, and order ids leak
 * (the success URL, the confirmation email subject, the UCP order read). The
 * public checkout now mints this token onto the Stripe success URL, so only the
 * browser that completed THAT checkout holds it.
 *
 * The signed message is domain-separated and length-prefixed (the
 * `consent/publicSubjectToken.ts` shape), so no `(tenant, org, order)` triple can
 * produce another's bytes. No state is stored: the token is a pure function of
 * fields the order already carries, so nothing needs migrating and a replay of
 * the checkout mints the same value.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../../middleware/cookieSession.js';

const DOMAIN = 'commerce-oneclick:v1:';
/** A post-purchase offer is shown right after the purchase; a day is generous. */
export const ONE_CLICK_WINDOW_MS = 24 * 60 * 60 * 1000;

function message(tenantId: string, orgId: string, orderId: string): string {
  return `${DOMAIN}${tenantId.length}:${tenantId}${orgId.length}:${orgId}${orderId.length}:${orderId}`;
}

export function mintOneClickToken(tenantId: string, orgId: string, orderId: string): string {
  return createHmac('sha256', readSessionSecret()).update(message(tenantId, orgId, orderId)).digest('base64url');
}

export function verifyOneClickToken(tenantId: string, orgId: string, orderId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false;
  const expected = Buffer.from(mintOneClickToken(tenantId, orgId, orderId));
  const got = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
