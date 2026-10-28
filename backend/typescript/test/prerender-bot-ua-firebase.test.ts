/**
 * #5227 — Firebase Hosting rewrites the `Googlebot` UA token to
 * `Google-Firebase` before forwarding to Cloud Run, so the bot branch must
 * recognise both spellings. Red when `google-firebase` leaves BOT_UA_TOKENS:
 * Google then receives the SPA shell on every Hosting-fronted deploy.
 */
import { describe, expect, it } from 'vitest';
import { isBotUserAgent } from '../src/features/publishing/prerenderService.js';

const DESKTOP = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SMARTPHONE = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const viaHosting = (ua: string) => ua.replace('Googlebot', 'Google-Firebase');

describe('bot UA detection behind Firebase Hosting (#5227)', () => {
  it('recognises Googlebot at the origin', () => {
    expect(isBotUserAgent(DESKTOP)).toBe(true);
    expect(isBotUserAgent(SMARTPHONE)).toBe(true);
  });

  it('recognises Googlebot as Hosting forwards it (Google-Firebase), desktop and smartphone', () => {
    expect(isBotUserAgent(viaHosting(DESKTOP))).toBe(true);
    expect(isBotUserAgent(viaHosting(SMARTPHONE))).toBe(true);
    expect(isBotUserAgent('Google-Firebase/2.1 (+http://www.google.com/bot.html)')).toBe(true);
  });

  it('still treats a browser as human', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe(false);
  });
});
