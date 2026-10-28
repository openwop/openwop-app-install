/**
 * ADR 0951 D2 — is this behavior-capture batch from a bot, crawler, AI agent or
 * automation? Such traffic is excluded from heat aggregates (and later replay) and
 * counted separately.
 *
 * Deliberately NOT `publishing/prerenderService.isBotUserAgent`: that is an
 * allowlist of crawlers that should receive the SEO prerender (a positive list of
 * named unfurlers). Excluding traffic from measurement wants the opposite
 * posture — anything that looks automated is out, including headless browsers
 * and HTTP libraries that would never ask for a prerender. A missing user agent
 * counts as automated: every real browser sends one.
 */
const AUTOMATION_TOKENS = [
  'bot', 'crawl', 'spider', 'slurp', 'headless', 'puppeteer', 'playwright', 'phantomjs', 'selenium', 'webdriver',
  'lighthouse', 'pagespeed', 'chrome-lighthouse', 'gtmetrix', 'pingdom', 'uptime',
  'curl/', 'wget/', 'python-requests', 'python-urllib', 'aiohttp', 'httpx', 'go-http-client', 'java/', 'okhttp',
  'node-fetch', 'undici', 'axios/', 'libwww-perl',
  // AI agents and fetchers that do not say "bot"
  'chatgpt-user', 'claude-user', 'claude-web', 'anthropic-ai', 'perplexity-user', 'cohere-ai', 'facebookexternalhit',
  'meta-externalagent', 'google-extended', 'ccbot', 'diffbot',
];

export function isAutomatedTraffic(userAgent: string | undefined, clientSaysAutomation: boolean): boolean {
  if (clientSaysAutomation) return true; // the page's own `navigator.webdriver` report
  if (!userAgent || !userAgent.trim()) return true;
  const ua = userAgent.toLowerCase();
  return AUTOMATION_TOKENS.some((t) => ua.includes(t));
}
