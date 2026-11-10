/**
 * ADR 0951 P1 D2 — heat capture sends nothing before consent or on a site that
 * does not collect, sends only coordinates / author ids / depth / section time
 * (never text), and stops when the visitor withdraws.
 *
 * Sabotage (each reds the named case): skip the first consent read; read any
 * `heatmaps` value as on; add the page text or the input value to a click; send raw
 * pixels; drop the scroll event; post to another lane; skip the re-read at flush.
 *
 * Double guards, by design: after the config read `startHeatCapture` re-reads the
 * decision and every flush reads it again, so a refusal during that read sends nothing
 * even with the first re-read gone; `stop()` clears the queue and also blocks every
 * flush, so deleting the clear sends nothing either. Neither has a case of its own.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { __resetVisitorConsentForTests, loadPosture, recordChoice } from '../visitorConsent.js';
import { startHeatCapture } from '../heatCapture.js';
import { visitorApiBase } from '../visitorApi.js';

type HeatBody = { page?: string; sessionKey?: string; events?: Array<Record<string, unknown>> };
type Call = { url: string; body?: HeatBody };
const calls: Call[] = [];
let heatOn = true;
function stubFetch(regime: 'opt-in' | 'opt-out'): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as HeatBody } : {}) });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/posture')) return json({ regime });
    if (url.endsWith('/capture-config')) return json({ heatmaps: heatOn });
    if (url.includes('/public-consent/') && init?.method === 'POST') return json({ ok: true, subjectToken: 'tok-h' }, 201);
    return new Response(null, { status: 204 });
  }));
}
const heatPosts = () => calls.filter((c) => c.url.endsWith('/heat'));
const ORG = 'org-h';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.clear(); calls.length = 0; heatOn = true; __resetVisitorConsentForTests();
  document.body.innerHTML = '<main><section id="hero"><button id="cta-buy">Buy now for Jane Doe</button></section><input id="email" value="jane@example.com"></main>';
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(document.documentElement, 'scrollWidth');
  Reflect.deleteProperty(document.documentElement, 'scrollHeight');
});

describe('ADR 0951 P1 — heat capture', () => {
  it('before consent: no config read, no listener, nothing sent', async () => {
    stubFetch('opt-in');
    await loadPosture(ORG);
    const stop = await startHeatCapture({ orgId: ORG, visitorKey: 'vk-1', page: 'pricing' });
    document.getElementById('cta-buy')!.click();
    stop();
    expect(calls.some((c) => c.url.endsWith('/capture-config'))).toBe(false);
    expect(heatPosts()).toHaveLength(0);
  });

  it('heat maps off for the site: nothing is attached or sent', async () => {
    heatOn = false;
    stubFetch('opt-out');
    await loadPosture(ORG);
    const stop = await startHeatCapture({ orgId: ORG, visitorKey: 'vk-1', page: 'pricing' });
    document.getElementById('cta-buy')!.click();
    stop();
    expect(heatPosts()).toHaveLength(0);
  });

  it('allowed: sends element ids and fractions, the scroll reach on page end — never page text or input values', async () => {
    stubFetch('opt-out');
    await loadPosture(ORG);
    Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
    const stop = await startHeatCapture({ orgId: ORG, visitorKey: 'vk-1', page: 'pricing' });
    document.getElementById('cta-buy')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 250, clientY: 500 }));
    document.getElementById('email')!.click();
    vi.advanceTimersByTime(10_000);
    stop();
    const posts = heatPosts();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0]!.url).toBe(`${visitorApiBase()}/host/openwop-app/public-analytics/org-h/heat`);
    const events = posts.flatMap((p) => p.body?.events ?? []);
    expect(events).toContainEqual({ t: 'click', x: 0.25, y: 0.25, sel: 'cta-buy' });
    expect(events.some((e) => e.t === 'click' && e.sel === 'email')).toBe(true);
    const all = JSON.stringify(posts.map((p) => p.body));
    expect(all).toContain('"t":"scroll"');
    for (const leak of ['Jane', 'jane@example.com', 'Buy now']) expect(all).not.toContain(leak);
    expect(posts[0]!.body).toMatchObject({ page: 'pricing', sessionKey: 'vk-1' });
  });

  it('withdrawing analytics mid-visit drops the queue and stops capture', async () => {
    stubFetch('opt-out');
    await loadPosture(ORG);
    const stop = await startHeatCapture({ orgId: ORG, visitorKey: 'vk-1', page: 'pricing' });
    document.getElementById('cta-buy')!.click();
    await recordChoice(ORG, false);
    vi.advanceTimersByTime(10_000);
    document.getElementById('cta-buy')!.click();
    stop();
    expect(heatPosts()).toHaveLength(0);
  });
});
