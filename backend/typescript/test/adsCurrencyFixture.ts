/**
 * ADR 0952 defect P9 — fixture answers for the ad-account CURRENCY reads every
 * live budget write now makes (Meta `act_<id>?fields=currency`, Google
 * `customer.currency_code`, TikTok `advertiser/info`, LinkedIn `adAccounts/<id>`).
 * A fixture server calls `answerCurrencyRead` first; it answers and returns true
 * for a currency read (recorded in `currencyReads`). Every request is recorded
 * in `platformRequests` before any early return; preview assertions include reads,
 * else false. `fixtureCurrency.value` sets the account currency (default USD).
 */
import type http from 'node:http';

export const fixtureCurrency: { value: string; fault?: 'http' | 'malformed' | 'business' } = { value: 'USD' };
export const currencyReads: string[] = [];
export const platformRequests: Array<{ url: string; raw: string }> = [];

export function answerCurrencyRead(url: string, raw: string, res: http.ServerResponse): boolean {
  platformRequests.push({ url, raw });
  const c = fixtureCurrency.value;
  let body: string | null = null;
  if (/fields=currency/.test(url)) body = JSON.stringify({ currency: c });
  else if (url.includes('/advertiser/info/')) body = JSON.stringify({ code: 0, message: 'OK', data: { list: [{ currency: c }] } });
  // The account itself only (`/rest/adAccounts/<id>`), never its sub-resources.
  else if (/\/rest\/adAccounts\/\d+(?:\?|$)/.test(url)) body = JSON.stringify({ currency: c });
  else if (url.includes('googleAds:search') && raw.includes('customer.currency_code') && !raw.includes('metrics.')) body = JSON.stringify({ results: [{ customer: { currencyCode: c } }] });
  if (body === null) return false;
  currencyReads.push(url);
  res.writeHead(fixtureCurrency.fault === 'http' ? 503 : 200, { 'content-type': 'application/json' });
  res.end(fixtureCurrency.fault === 'malformed' ? '{bad' : fixtureCurrency.fault === 'business'
    ? JSON.stringify({ ...JSON.parse(body), code: 1, error: { message: 'rejected' } }) : body);
  return true;
}
