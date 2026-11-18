// ADR 1136 P2b — the person's own browser, driven one operation at a time.
//
// A visible Chrome window (Playwright's `chrome` channel: the Google Chrome
// already installed on this machine, so nothing is downloaded), with its own
// persistent profile per pairing, separate from the person's everyday browser.
// The host sends operations over the device socket; this file performs them and
// reports what happened. It speaks the ADR 1136 executor protocol:
//
//   snapshot | screenshot | scroll {dy} | navigate {url} | click {ref}
//   | type {ref, text} | press {ref, key}
//
// What it does on its own, whatever the host asks (ADR 1136 P2 condition 6):
//   - refuses `file:`, `chrome:`, `data:`, `javascript:` and every other non-web
//     navigation, credentialed URLs and private addresses (`browserRefusals.js`);
//   - blocks requests to private addresses from any page;
//   - cancels every download and never fills a file chooser (no step's approval
//     can name one yet, so none is allowed);
//   - reports `effects` (navigated, submitted) for every operation, so a page
//     script that turns a click or a key into a submit is visible to the host,
//     which then stops the session (P2 entry criterion 3).
//
// `playwright-core` is an OPTIONAL dependency. Without it the companion's
// terminal mode works as before and this module says browser mode is unavailable.

import { navigationRefusal, requestRefusal } from './browserRefusals.js';

/** The page is read as interactive elements plus visible text, capped. */
export const SNAPSHOT_TEXT_MAX = 60_000;
const MAX_ELEMENTS = 400;
/** How long after an operation the executor keeps watching for its effects. */
export const EFFECT_SETTLE_MS = 400;

/**
 * Load Playwright, or explain why browser mode is unavailable. Never throws.
 * @param {() => Promise<unknown>} [importer]
 */
export async function loadPlaywright(importer = () => import('playwright-core')) {
  try {
    const mod = /** @type {any} */ (await importer());
    const chromium = mod?.chromium ?? mod?.default?.chromium;
    if (!chromium) return { ok: false, reason: 'playwright-core did not provide chromium' };
    return { ok: true, chromium };
  } catch {
    return { ok: false, reason: 'browser mode is unavailable: the optional dependency playwright-core is not installed. Reinstall @openwop/agent-host with optional dependencies.' };
  }
}

// Runs IN THE PAGE. Tags each interactive element with a generation-prefixed ref
// and reports the fields ADR 1136's tier table reads. Self-contained: Playwright
// serialises it, so it may not close over anything.
function snapshotInPage(arg) {
  const { gen, maxElements, textMax } = arg;
  for (const el of document.querySelectorAll('[data-owp-ref]')) el.removeAttribute('data-owp-ref');
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'disclosure';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    return '';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.textContent?.trim()) return l.textContent.trim(); }
    const wrap = el.closest('label'); if (wrap?.textContent?.trim()) return wrap.textContent.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
    return (el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.textContent || '').trim();
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const candidates = document.querySelectorAll('a[href], button, input, select, textarea, summary, [role], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]');
  const elements = [];
  let n = 0;
  for (const el of candidates) {
    if (elements.length >= maxElements) break;
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    const role = (el.getAttribute('role') || implicitRole(el) || '').toLowerCase();
    if (!role) continue;
    const ref = `g${gen}-${++n}`;
    el.setAttribute('data-owp-ref', ref);
    const e = { ref, role, name: nameOf(el).replace(/\s+/g, ' ').slice(0, 200) };
    if (el.tagName === 'INPUT' && el.type) e.inputType = el.type.toLowerCase();
    const ac = el.getAttribute('autocomplete'); if (ac) e.autocomplete = ac;
    const isSubmit = (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit' && !!el.form)
      || (el.tagName === 'INPUT' && ['submit', 'image'].includes(el.type));
    if (isSubmit) e.submits = true;
    if (el.tagName === 'A' && el.href) e.href = el.href;
    elements.push(e);
  }
  const text = (document.body?.innerText || '').slice(0, textMax);
  return { url: location.href, title: document.title.slice(0, 1000), elements, text };
}

export class PlaywrightBrowserExecutor {
  /**
   * @param {{
   *   chromium: any, profileDir: string, executorId: string,
   *   headless?: boolean, channel?: string, allowHosts?: readonly string[],
   *   log?: (m: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.executorId = opts.executorId;
    this.gen = 0;
    this.context = null;
    this.page = null;
    this.log = opts.log ?? (() => {});
    /** Set by the page listeners while an operation runs. */
    this.watch = null;
  }

  async start() {
    const { chromium, profileDir, headless = false, channel = 'chrome' } = this.opts;
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless, channel, acceptDownloads: false, viewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const allowHosts = this.opts.allowHosts ?? [];
    await this.context.route('**/*', (route) => {
      const req = route.request();
      const why = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()
        ? navigationRefusal(req.url(), { allowHosts })
        : requestRefusal(req.url(), { allowHosts });
      if (why) { this.log(`refused ${why}`); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    this.context.on('page', (p) => this.adopt(p));
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.adopt(this.page);
  }

  adopt(page) {
    page.on('framenavigated', (frame) => { if (this.watch && frame === page.mainFrame()) this.watch.navigated = true; });
    page.on('request', (req) => {
      if (!this.watch) return;
      // A form submission is a document request that carries a body, or one the
      // browser started from a form (Playwright reports POST for both).
      if (req.isNavigationRequest() && req.method() !== 'GET') this.watch.submitted = true;
    });
    page.on('download', (d) => { void d.cancel().catch(() => undefined); this.log('download blocked'); });
    page.on('filechooser', () => { this.log('file upload blocked'); });
    page.on('dialog', (d) => { void d.dismiss().catch(() => undefined); });
  }

  async stop() {
    try { await this.context?.close(); } catch { /* closed */ }
  }

  locator(ref) {
    if (typeof ref !== 'string' || !/^g\d+-\d+$/.test(ref) || !ref.startsWith(`g${this.gen}-`)) return null;
    return this.page.locator(`[data-owp-ref="${ref}"]`);
  }

  async snapshot(timeoutMs) {
    this.gen += 1;
    let timer;
    const snap = await Promise.race([
      this.page.evaluate(snapshotInPage, { gen: this.gen, maxElements: MAX_ELEMENTS, textMax: SNAPSHOT_TEXT_MAX }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, snapshot: snap };
  }

  /** Run `fn` while watching for navigations and submissions; return its effects. */
  async withEffects(fn) {
    this.watch = { navigated: false, submitted: false };
    try {
      await fn();
      await new Promise((r) => setTimeout(r, EFFECT_SETTLE_MS));
      return { ...this.watch };
    } finally {
      this.watch = null;
    }
  }

  /**
   * One operation. Never throws: every failure is a protocol error code.
   * @param {any} op
   * @param {{ timeoutMs: number }} opts
   */
  async perform(op, { timeoutMs }) {
    if (!this.page) return { ok: false, error: 'detached' };
    try {
      switch (op?.op) {
        case 'snapshot': return await this.snapshot(timeoutMs);
        case 'screenshot': return { ok: true };
        case 'scroll': {
          const effects = await this.withEffects(() => this.page.mouse.wheel(0, Number(op.dy) || 0));
          return { ok: true, effects };
        }
        case 'navigate': {
          if (navigationRefusal(String(op.url), { allowHosts: this.opts.allowHosts ?? [] })) return { ok: false, error: 'navigation_refused' };
          await this.page.goto(String(op.url), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (navigationRefusal(this.page.url(), { allowHosts: this.opts.allowHosts ?? [] })) return { ok: false, error: 'navigation_refused' };
          return await this.snapshot(timeoutMs);
        }
        case 'click':
        case 'type':
        case 'press': {
          const loc = this.locator(op.ref);
          if (!loc || (await loc.count()) !== 1) return { ok: false, error: 'stale_ref' };
          const effects = await this.withEffects(async () => {
            if (op.op === 'click') await loc.click({ timeout: timeoutMs });
            else if (op.op === 'type') await loc.fill(String(op.text ?? ''), { timeout: timeoutMs });
            else await loc.press(['Enter', 'Tab', 'Escape'].includes(op.key) ? op.key : 'Escape', { timeout: timeoutMs });
          });
          return { ok: true, effects };
        }
        default:
          return { ok: false, error: 'bad_result' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`${String(op?.op)} failed: ${msg.split('\n')[0].slice(0, 200)}`);
      if (/timeout/i.test(msg)) return { ok: false, error: 'timeout' };
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg)) return { ok: false, error: 'navigation_refused' };
      if (/Target .*closed|has been closed/i.test(msg)) return { ok: false, error: 'detached' };
      return { ok: false, error: 'timeout' };
    }
  }
}
