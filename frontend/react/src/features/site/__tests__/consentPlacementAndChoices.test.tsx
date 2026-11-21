/**
 * #6150 / #6155 (ADR 0860 D6) — where the visitor-consent control sits, how much
 * room the banner takes, and the analytics choice on a privacy page. Asked for by a
 * white-label adopter (CasaVoga).
 *
 * Guards:
 *  - clearance: stock pads `<body>` by the banner's height; `clearance="off"` leaves
 *    the body padding untouched (the document height does not change) while the
 *    scroll padding still tracks the banner (WCAG 2.2 SC 2.4.11); both are restored
 *    when the banner closes;
 *  - placement: in the grouped footer the control is an item of the bottom bar's
 *    utility links, else in the bar itself; a plain footer keeps the old container;
 *  - footer link: `footer="link"` makes the control a plain link to the built-in
 *    privacy page's choice section; with any other privacy page it stays the button;
 *  - the choice section states the current setting (on, off, not chosen), changes
 *    it in place through the consent lane, announces nothing false on a failed
 *    save, carries the separate unticked recording choice where offered, and
 *    renders nothing when the lane is unavailable and nothing is stored.
 *
 * Sabotage: applying the body padding unconditionally reds the clearance case;
 * appending the slot to `.app-footer` again reds both placement cases; dropping the
 * `/privacy` check reds the "other page" case; dropping `asking` from the section
 * reds the not-chosen case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { __resetVisitorConsentForTests, decisionFor, loadPosture, storedChoice } from '../visitorConsent.js';
import { VisitorConsentBanner } from '../VisitorConsentBanner.js';
import { VisitorConsentChoices } from '../VisitorConsentChoices.js';
import { consentClearance, consentFooter, PRIVACY_CHOICES_ANCHOR } from '../../../brand/consentOptions.js';
import { messages as en } from '../i18n/en.js';

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown };
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
function stubFetch(route: Route): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = route(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
}
const lane = (regime: 'opt-in' | 'opt-out' | null, choices: string[] = []): Route => (url, init) => {
  if (url.endsWith('/posture')) return regime ? { status: 200, body: { regime, choices } } : { status: 404, body: { error: 'not_found' } };
  if (init?.method === 'POST') {
    const sent = JSON.parse(String(init.body)) as { subjectToken?: string };
    return { status: 201, body: { ok: true, subjectToken: sent.subjectToken ?? 'tok-1' } };
  }
  return { status: 404 };
};
const posts = (): unknown[] => calls.filter((c) => c.init?.method === 'POST').map((c) => JSON.parse(String(c.init?.body)) as unknown);

const ORG = 'org-a';
beforeEach(() => { localStorage.clear(); calls.length = 0; __resetVisitorConsentForTests(); });
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.style.paddingBottom = ''; document.documentElement.style.scrollPaddingBottom = '';
});

/** A PublicShell footer: grouped (with or without utility links) or plain. */
function mountFooter(kind: 'grouped-utility' | 'grouped-bare' | 'plain'): { shell: HTMLElement; footer: HTMLElement } {
  const shell = document.createElement('div');
  shell.className = 'public-shell';
  const footer = document.createElement('footer');
  footer.className = kind === 'plain' ? 'app-footer' : 'app-footer app-footer--grouped';
  if (kind !== 'plain') {
    footer.innerHTML = kind === 'grouped-utility'
      ? '<div class="app-footer__top"></div><div class="app-footer__bottom"><p class="app-footer__copyright">©</p><nav><ul class="app-footer__utility"><li><a href="/privacy">Privacy</a></li></ul></nav></div>'
      : '<div class="app-footer__top"></div><div class="app-footer__bottom"><p class="app-footer__copyright">©</p></div>';
  }
  shell.appendChild(footer);
  document.body.appendChild(shell);
  return { shell, footer };
}

describe('the brand options parse closed', () => {
  it('only `off` and `link` change anything', () => {
    expect([consentClearance(undefined), consentClearance(''), consentClearance('no'), consentClearance(' OFF ')]).toEqual(['pad', 'pad', 'pad', 'off']);
    expect([consentFooter(undefined), consentFooter('panel'), consentFooter('links'), consentFooter('Link')]).toEqual(['panel', 'panel', 'panel', 'link']);
  });
});

describe('the clearance under the banner (#6150)', () => {
  beforeEach(() => { vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(195); });

  it('stock: the body is padded by the banner height while it shows, and restored after', async () => {
    stubFetch(lane('opt-in'));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: en.consentTitle });
    expect(document.body.style.paddingBottom).toBe('195px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('195px');
    fireEvent.click(screen.getByRole('button', { name: en.consentReject }));
    await waitFor(() => expect(screen.queryByRole('region', { name: en.consentTitle })).toBeNull());
    expect(document.body.style.paddingBottom).toBe('');
  });

  it('off: the body keeps its padding (the page height does not change), the scroll padding still tracks', async () => {
    stubFetch(lane('opt-in'));
    document.body.style.paddingBottom = '7px'; // whatever the page had
    render(<VisitorConsentBanner orgId={ORG} clearance="off" />);
    await screen.findByRole('region', { name: en.consentTitle });
    expect(document.body.style.paddingBottom).toBe('7px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('195px');
    fireEvent.click(screen.getByRole('button', { name: en.consentReject }));
    await waitFor(() => expect(screen.queryByRole('region', { name: en.consentTitle })).toBeNull());
    expect(document.body.style.paddingBottom).toBe('7px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  });
});

describe('the footer control in the grouped footer (#6155)', () => {
  it('is an item of the bottom bar\'s utility links', async () => {
    stubFetch(lane('opt-out'));
    const { shell, footer } = mountFooter('grouped-utility');
    try {
      render(<VisitorConsentBanner orgId={ORG} />);
      const btn = await screen.findByRole('button', { name: en.consentFooterLink });
      const slot = btn.parentElement!;
      expect(slot.tagName).toBe('LI');
      expect(slot.parentElement).toBe(footer.querySelector('.app-footer__utility'));
      expect(slot.previousElementSibling?.textContent).toBe('Privacy');
    } finally { shell.remove(); }
  });

  it('sits in the bottom bar when the bar has no utility links', async () => {
    stubFetch(lane('opt-out'));
    const { shell, footer } = mountFooter('grouped-bare');
    try {
      render(<VisitorConsentBanner orgId={ORG} />);
      const btn = await screen.findByRole('button', { name: en.consentFooterLink });
      expect(btn.parentElement!.parentElement).toBe(footer.querySelector('.app-footer__bottom'));
    } finally { shell.remove(); }
  });

  it('a plain footer keeps the old container at the end of the footer', async () => {
    stubFetch(lane('opt-out'));
    const { shell, footer } = mountFooter('plain');
    try {
      render(<VisitorConsentBanner orgId={ORG} />);
      const btn = await screen.findByRole('button', { name: en.consentFooterLink });
      expect(btn.parentElement!.tagName).toBe('DIV');
      expect(btn.parentElement!.parentElement).toBe(footer);
    } finally { shell.remove(); }
  });
});

describe('the footer control as a link to the privacy page (#6155)', () => {
  it('links to the built-in page\'s choice section, and the first-visit banner still asks', async () => {
    stubFetch(lane('opt-in'));
    render(<VisitorConsentBanner orgId={ORG} footer="link" privacyHref="/privacy" />);
    expect(await screen.findByRole('region', { name: en.consentTitle })).toBeTruthy();
    const link = screen.getByRole('link', { name: en.consentFooterLink });
    expect(link.getAttribute('href')).toBe(`/privacy#${PRIVACY_CHOICES_ANCHOR}`);
    expect(screen.queryByRole('button', { name: en.consentFooterLink })).toBeNull();
  });

  it('stays the button when the privacy page is not the built-in one', async () => {
    stubFetch(lane('opt-out'));
    render(<VisitorConsentBanner orgId={ORG} footer="link" privacyHref="/p/privacy" />);
    expect(await screen.findByRole('button', { name: en.consentFooterLink })).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.consentFooterLink })).toBeNull();
  });
});

describe('the analytics choice on a privacy page (#6155)', () => {
  it('not chosen under opt-in: says so, offers Accept and Reject alike, and records in place', async () => {
    stubFetch(lane('opt-in'));
    render(<VisitorConsentChoices orgId={ORG} />);
    const section = await screen.findByRole('region', { name: en.consentChoicesTitle });
    expect(section.id).toBe(PRIVACY_CHOICES_ANCHOR);
    expect(screen.getByText(en.consentStateUnset)).toBeTruthy();
    const accept = screen.getByRole('button', { name: en.consentAccept });
    const reject = screen.getByRole('button', { name: en.consentReject });
    expect(accept.className, 'equal prominence').toBe(reject.className);
    fireEvent.click(accept);
    await waitFor(() => expect(screen.getByText(en.consentStateOn)).toBeTruthy());
    expect(decisionFor(ORG)).toBe('allowed');
    expect(posts()).toEqual([{ categories: { analytics: true } }]);
    // Changing again offers only the other setting.
    expect(screen.queryByRole('button', { name: en.consentAccept })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.consentReject }));
    await waitFor(() => expect(screen.getByText(en.consentStateOff)).toBeTruthy());
    expect(storedChoice(ORG)?.analytics).toBe(false);
  });

  it('opt-out with no choice: states that analytics is on and offers turning it off', async () => {
    stubFetch(lane('opt-out'));
    render(<VisitorConsentChoices orgId={ORG} />);
    expect(await screen.findByText(en.consentStateOn)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.consentReject })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.consentAccept })).toBeNull();
  });

  it('a failed save shows the error and keeps the stated setting honest', async () => {
    stubFetch((url) => (url.endsWith('/posture') ? { status: 200, body: { regime: 'opt-in' } } : { status: 503 }));
    render(<VisitorConsentChoices orgId={ORG} />);
    fireEvent.click(await screen.findByRole('button', { name: en.consentAccept }));
    expect(await screen.findByText(en.consentFailed)).toBeTruthy();
    expect(decisionFor(ORG), 'a failed grant is not remembered').not.toBe('allowed');
    expect(screen.getByText(en.consentStateUnset), 'the section still says nothing was chosen').toBeTruthy();
  });

  it('where recording is offered: its own unticked box while asking, its own button after', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    render(<VisitorConsentChoices orgId={ORG} />);
    const box = await screen.findByRole('checkbox', { name: en.consentReplayLabel });
    expect((box as HTMLInputElement).checked, 'never pre-ticked').toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: en.consentAccept }));
    await waitFor(() => expect(screen.getByText(en.consentReplayStateOn)).toBeTruthy());
    expect(posts()).toEqual([{ categories: { analytics: true, 'analytics.replay': true } }]);
    expect(screen.getByRole('button', { name: en.consentReplayTurnOff })).toBeTruthy();
  });

  it('renders nothing when the lane is unavailable and nothing is stored', async () => {
    stubFetch(lane(null));
    const { container } = render(<VisitorConsentChoices orgId={ORG} />);
    await act(async () => { await loadPosture(ORG); });
    expect(container.innerHTML).toBe('');
  });
});
