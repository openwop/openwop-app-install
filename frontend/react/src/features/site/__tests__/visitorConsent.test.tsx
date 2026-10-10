/**
 * ADR 0860 D5/D6 — the visitor key exists only after consent, and the banner gives
 * Accept and Reject equal weight.
 *
 * Witnessed red before the change: `getVisitorKey()` minted and stored `owp:vk` on
 * every call, before any consent check, and no banner existed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  __resetVisitorConsentForTests, consentTokenFor, decisionFor, getVisitorKey, loadPosture, recordChoice, repairConsentTokenFrom,
} from '../visitorConsent.js';
import { VisitorConsentBanner } from '../VisitorConsentBanner.js';
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
const posture = (regime: 'opt-in' | 'opt-out' | null): Route => (url, init) => {
  if (url.endsWith('/posture')) return regime ? { status: 200, body: { regime } } : { status: 404, body: { error: 'not_found' } };
  if (init?.method === 'POST') {
    const sent = JSON.parse(String(init.body)) as { subjectToken?: string };
    return { status: 201, body: { ok: true, subjectToken: sent.subjectToken ?? 'tok-1' } };
  }
  return { status: 404 };
};

beforeEach(() => { localStorage.clear(); calls.length = 0; __resetVisitorConsentForTests(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ORG = 'org-a';

describe('the visitor key (D5)', () => {
  it('opt-in regime: nothing is written until Accept; Reject and withdrawal remove it', async () => {
    stubFetch(posture('opt-in'));
    localStorage.setItem('owp:vk', 'vk-legacy'); // a key minted before consent existed
    localStorage.setItem(`owp:vk:${ORG}`, 'vk-pre');
    expect(getVisitorKey(ORG), 'unknown before the posture loads').toBeNull();
    expect(localStorage.getItem('owp:vk'), 'the legacy origin-wide key is deleted').toBeNull();
    await loadPosture(ORG);
    expect(decisionFor(ORG)).toBe('denied');
    expect(getVisitorKey(ORG)).toBeNull();
    expect(localStorage.getItem(`owp:vk:${ORG}`), 'a pre-consent key is removed under opt-in').toBeNull();

    await recordChoice(ORG, true);
    const k = localStorage.getItem(`owp:vk:${ORG}`);
    expect(k).toMatch(/^vk-/);
    expect(getVisitorKey(ORG)).toBe(k);
    expect(consentTokenFor(ORG)).toBe('tok-1');

    await recordChoice(ORG, false); // withdrawal, through the same lane, with the same token
    expect(localStorage.getItem(`owp:vk:${ORG}`)).toBeNull();
    const last = calls.filter((c) => c.init?.method === 'POST').at(-1)!;
    expect(JSON.parse(String(last.init!.body))).toEqual({ categories: { analytics: false }, subjectToken: 'tok-1' });
  });

  it('opt-out regime: the key is written unless the visitor opted out; one org never touches another', async () => {
    stubFetch(posture('opt-out'));
    await loadPosture(ORG);
    await loadPosture('org-b');
    expect(getVisitorKey(ORG)).toMatch(/^vk-/);
    const b = getVisitorKey('org-b');
    await recordChoice(ORG, false);
    expect(getVisitorKey(ORG)).toBeNull();
    expect(localStorage.getItem('owp:vk:org-b'), "a refusal on one site keeps the other's key").toBe(b);
  });

  it('a posture failure writes nothing and sends nothing', async () => {
    stubFetch(posture(null));
    localStorage.setItem(`owp:vk:${ORG}`, 'vk-stale');
    await loadPosture(ORG);
    expect(decisionFor(ORG)).toBe('unknown');
    expect(getVisitorKey(ORG)).toBeNull();
  });

  it('a failed refusal still fails closed; a failed grant is not remembered', async () => {
    stubFetch((url) => (url.endsWith('/posture') ? { status: 200, body: { regime: 'opt-out' } } : { status: 503 }));
    await loadPosture(ORG);
    expect(getVisitorKey(ORG)).toMatch(/^vk-/);
    await expect(recordChoice(ORG, false)).rejects.toThrow();
    expect(decisionFor(ORG)).toBe('denied');
    expect(localStorage.getItem(`owp:vk:${ORG}`)).toBeNull();
    __resetVisitorConsentForTests(); localStorage.clear();
    stubFetch((url) => (url.endsWith('/posture') ? { status: 200, body: { regime: 'opt-in' } } : { status: 503 }));
    await loadPosture(ORG);
    await expect(recordChoice(ORG, true)).rejects.toThrow();
    expect(decisionFor(ORG)).toBe('denied');
  });
});

describe('token repair (grade-code M4)', () => {
  it('a beacon 400 naming consentToken re-records the SAME choice once, minting a fresh token', async () => {
    let n = 0;
    stubFetch((url, init) => {
      if (url.endsWith('/posture')) return { status: 200, body: { regime: 'opt-in' } };
      if (init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { subjectToken?: string };
        return sent.subjectToken === 'tok-1' && n > 0 ? { status: 400, body: { error: 'validation_error', details: { field: 'subjectToken' } } } : { status: 201, body: { subjectToken: `tok-${++n}` } };
      }
      return { status: 404 };
    });
    await recordChoice(ORG, true);
    expect(consentTokenFor(ORG)).toBe('tok-1');
    const refused = new Response(JSON.stringify({ error: 'validation_error', details: { field: 'consentToken' } }), { status: 400 });
    await repairConsentTokenFrom(ORG, refused);
    expect(consentTokenFor(ORG)).toBe('tok-2');
    expect(decisionFor(ORG)).toBe('allowed');
    const other = new Response(JSON.stringify({ error: 'validation_error', details: { field: 'consentToken' } }), { status: 400 });
    await repairConsentTokenFrom(ORG, other);
    expect(consentTokenFor(ORG), 'once per tab').toBe('tok-2');
  });
});

describe('the banner (D6)', () => {
  it('opt-in: a labelled region with Accept and Reject of the same style; Reject records and closes', async () => {
    stubFetch(posture('opt-in'));
    render(<VisitorConsentBanner orgId={ORG} />);
    const region = await screen.findByRole('region', { name: en.consentTitle });
    const accept = screen.getByRole('button', { name: en.consentAccept });
    const reject = screen.getByRole('button', { name: en.consentReject });
    expect(accept.className, 'equal prominence').toBe(reject.className);
    expect(region.contains(document.activeElement), 'the banner never steals focus on load').toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(screen.queryByRole('region', { name: en.consentTitle })).toBeNull());
    expect(decisionFor(ORG)).toBe('denied');
    expect(screen.getByRole('button', { name: en.consentFooterLink })).toBeTruthy();
  });

  it('opt-out: no banner; the footer control opens the choice, focus moves in, Esc returns it', async () => {
    stubFetch(posture('opt-out'));
    render(<VisitorConsentBanner orgId={ORG} />);
    const footer = await screen.findByRole('button', { name: en.consentFooterLink });
    expect(screen.queryByRole('region', { name: en.consentTitle })).toBeNull();
    act(() => { fireEvent.click(footer); });
    const region = await screen.findByRole('region', { name: en.consentTitle });
    expect(screen.getByText(en.consentStateOn)).toBeTruthy();
    await waitFor(() => expect(region.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: en.consentTitle })).toBeNull());
    expect(document.activeElement).toBe(footer);
  });

  it('a failed save keeps the region open with its error, and offers the other choice', async () => {
    stubFetch((url) => (url.endsWith('/posture') ? { status: 200, body: { regime: 'opt-in' } } : { status: 503 }));
    render(<VisitorConsentBanner orgId={ORG} />);
    fireEvent.click(await screen.findByRole('button', { name: en.consentReject }));
    expect(await screen.findByText(en.consentFailed)).toBeTruthy();
    expect(screen.getByRole('region', { name: en.consentTitle })).toBeTruthy();
    expect(decisionFor(ORG), 'the refusal is kept on this device').toBe('denied');
    expect(screen.getByText(en.consentStateOff)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.consentReject }), 'the change form offers only the other choice').toBeNull();
    expect(screen.getByRole('button', { name: en.consentAccept })).toBeTruthy();
  });

  it('withdrawal stays reachable when the posture read fails but a choice is stored', async () => {
    stubFetch((url, init) => (url.endsWith('/posture') ? { status: 503 } : init?.method === 'POST' ? { status: 201, body: { subjectToken: 'tok-9' } } : { status: 404 }));
    localStorage.setItem('owp:consent', JSON.stringify({ [ORG]: { token: 'tok-9', analytics: true, at: '2026-10-07T00:00:00Z' } }));
    render(<VisitorConsentBanner orgId={ORG} />);
    await act(async () => { await loadPosture(ORG); });
    fireEvent.click(screen.getByRole('button', { name: en.consentFooterLink }));
    fireEvent.click(await screen.findByRole('button', { name: en.consentReject }));
    await waitFor(() => expect(decisionFor(ORG)).toBe('denied'));
  });

  it("the footer control lives in PublicShell's footer, in a container the lazy chunk creates and removes", async () => {
    stubFetch(posture('opt-out'));
    const shell = document.createElement('div');
    shell.className = 'public-shell';
    const footer = document.createElement('footer');
    footer.className = 'app-footer';
    shell.appendChild(footer);
    document.body.appendChild(shell);
    try {
      const { unmount } = render(<VisitorConsentBanner orgId={ORG} />);
      const btn = await screen.findByRole('button', { name: en.consentFooterLink });
      expect(footer.contains(btn)).toBe(true);
      unmount();
      expect(footer.querySelector('.visitor-consent__slot')).toBeNull();
    } finally { shell.remove(); }
  });

  it('renders nothing when the lane is unavailable', async () => {
    stubFetch(posture(null));
    const { container } = render(<VisitorConsentBanner orgId={ORG} />);
    await act(async () => { await loadPosture(ORG); });
    expect(container.innerHTML).toBe('');
  });
});
