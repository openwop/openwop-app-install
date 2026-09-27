/**
 * ADR 0470 P2 — the best-in-class visitor widget (`embed.js`).
 *
 * The widget is served to EVERY visitor of every embedding site, so (1) it MUST be
 * syntactically valid JS (a parse error breaks every widget) and (2) it must carry the
 * research-cited best-in-class UX markers: AI-disclosure + human-follow-up notice, a
 * `role="log"`/`aria-live="polite"` transcript, `aria-expanded` on the launcher, a
 * reduced-motion-safe typing indicator, Escape-to-close, ≥44px touch targets, and an
 * honest error message (never silence).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
let embed: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const r = await fetch(`${BASE}/v1/host/openwop-app/public/widget/embed.js`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('javascript');
  embed = await r.text();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0470 P2 — embed.js served widget', () => {
  it('is syntactically valid JavaScript (a parse error would break every widget)', () => {
    // new Function COMPILES (parses) the body without EXECUTING it — a pure syntax gate.
    expect(() => new Function(embed)).not.toThrow();
  });

  it('discloses it is AI + that a human may follow up (privacy notice-at-collection)', () => {
    expect(embed).toContain('AI assistant');
    expect(embed).toMatch(/team member may follow up/i);
  });

  it('has an accessible transcript live region (WCAG 2.2 SC 4.1.3)', () => {
    expect(embed).toContain("'role','log'");
    expect(embed).toContain("'aria-live','polite'");
  });

  it('exposes launcher state + dialog semantics + keyboard close', () => {
    expect(embed).toContain("'aria-expanded'");
    expect(embed).toContain("'role','dialog'");
    expect(embed).toContain("e.key==='Escape'"); // APG dialog: Escape closes
    expect(embed).toContain('btn.focus()'); // focus returns to the launcher on close
  });

  it('meets ≥44px touch targets on the launcher, input, and send', () => {
    expect((embed.match(/min-height:44px/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(embed).toContain('min-width:44px'); // the send button
  });

  it('shows a reduced-motion-safe typing indicator (no animation) and an HONEST error', () => {
    expect(embed).toContain('Assistant is typing'); // static text, no CSS animation
    expect(embed).toMatch(/Sorry, something went wrong/i); // never silence / never a bare glyph
  });

  it('renders message text via textContent only (XSS-safe on the host page)', () => {
    expect(embed).toContain('d.textContent=text');
    expect(embed).not.toContain('innerHTML');
  });

  it('P3 — carries a hidden honeypot decoy that a human never sees + sends it in the POST', () => {
    expect(embed).toContain("hp.setAttribute('aria-hidden','true')"); // hidden from AT
    expect(embed).toContain('hp.tabIndex=-1'); // not keyboard-reachable
    expect(embed).toContain('position:absolute;left:-9999px'); // off-screen
    expect(embed).toContain('hp:hp.value'); // sent to the server to check
  });

  it('OQ5 — fetches public config and renders the privacy link with a DEFENSIVE scheme re-check', () => {
    expect(embed).toContain("/widget/config?token="); // pulls businessName + privacyUrl
    // Defense in depth: the client re-validates http(s) before ever setting an href
    // (the server already rejected other schemes; this guards a compromised/edge config).
    expect(embed).toContain('/^https?:\\/\\//i.test');
    expect(embed).toContain("a.rel='noopener noreferrer'"); // safe external link
    expect(embed).toContain("a.textContent='Privacy'");
  });
});
