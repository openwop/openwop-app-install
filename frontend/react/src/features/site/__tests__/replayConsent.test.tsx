/**
 * ADR 0951 P0 D1 — the separate, unticked session-recording choice.
 *
 *  - offered only where the posture says so (no checkbox, and no `analytics.replay`
 *    key in any POST, on a site that does not record);
 *  - unticked by default: Accept alone records `analytics.replay: false`;
 *    ticking it records `true`; Reject refuses both;
 *  - asked in an opt-out regime too (recording is explicit opt-in everywhere);
 *  - `replayAllowedFor` needs an explicit stored yes AND a server token;
 *  - while changing, the recording button withdraws without touching analytics.
 *
 * Sabotage (each reds the named case): send a replay key where none is offered; tick
 * the box by default; let Reject keep a tick; ask only under opt-in; show opt-in copy
 * under opt-out; drop any of the three `replayAllowedFor` conditions; forget a stored
 * answer on an unrelated update; always name the category in a POST; forget a failed
 * withdrawal; flip analytics from the recording button.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { __resetVisitorConsentForTests, loadPosture, recordChoice, replayAllowedFor, replayOfferedFor } from '../visitorConsent.js';
import { VisitorConsentBanner } from '../VisitorConsentBanner.js';
import i18n from '../../../i18n/index.js';

const tx = (k: string): string => i18n.t(`site:${k}`);
type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown };
const posts: Array<Record<string, unknown>> = [];
function stubFetch(route: Route): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const r = route(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
}
const lane = (regime: 'opt-in' | 'opt-out', choices: string[]): Route => (url, init) => {
  if (url.endsWith('/posture')) return { status: 200, body: { regime, choices } };
  if (init?.method === 'POST') {
    const sent = JSON.parse(String(init.body)) as { subjectToken?: string };
    return { status: 201, body: { ok: true, subjectToken: sent.subjectToken ?? 'tok-1' } };
  }
  return { status: 404 };
};
const categoriesOf = (i: number) => (posts[i]?.categories ?? {}) as Record<string, unknown>;

beforeEach(() => { localStorage.clear(); posts.length = 0; __resetVisitorConsentForTests(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ORG = 'org-r';

describe('ADR 0951 — session-recording choice', () => {
  it('not offered: no checkbox, and no replay key is ever sent', async () => {
    stubFetch(lane('opt-in', []));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: tx('consentTitle') });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: tx('consentAccept') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: true });
  });

  it('offered: unticked by default — Accept alone records analytics.replay:false', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: tx('consentTitle') });
    const box = screen.getByRole('checkbox', { name: new RegExp(tx('consentReplayLabel').replace('.', '\\.')) }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: tx('consentAccept') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: true, 'analytics.replay': false });
    expect(replayAllowedFor(ORG)).toBe(false);
  });

  it('offered: ticking it and accepting records true; Reject refuses both', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: tx('consentTitle') });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: tx('consentAccept') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: true, 'analytics.replay': true });
    expect(replayAllowedFor(ORG)).toBe(true);

    cleanup(); localStorage.clear(); posts.length = 0; __resetVisitorConsentForTests();
    stubFetch(lane('opt-in', ['analytics.replay']));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: tx('consentTitle') });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: tx('consentReject') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: false, 'analytics.replay': false });
  });

  it('an opt-out site that offers recording still asks, with copy that does not claim nothing is counted', async () => {
    stubFetch(lane('opt-out', ['analytics.replay']));
    render(<VisitorConsentBanner orgId={ORG} />);
    await screen.findByRole('region', { name: tx('consentTitle') });
    expect(screen.getByText(new RegExp(tx('consentBodyOptOut').slice(0, 40)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(tx('consentBody').slice(0, 40)))).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: tx('consentAccept') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: true, 'analytics.replay': false });
    expect(replayAllowedFor(ORG)).toBe(false);
  });

  it('replayAllowedFor needs an explicit yes, a token, and an offering site', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    await loadPosture(ORG);
    expect(replayOfferedFor(ORG)).toBe(true);
    await recordChoice(ORG, true);
    expect(replayAllowedFor(ORG), 'analytics alone never implies recording').toBe(false);
    await recordChoice(ORG, true, { replay: true });
    expect(replayAllowedFor(ORG)).toBe(true);
    await recordChoice(ORG, true); // an unrelated update keeps the answer
    expect(replayAllowedFor(ORG)).toBe(true);
    expect(categoriesOf(2)).toEqual({ analytics: true });

    // The same stored yes, read fresh from the device, with one condition missing each time.
    const stored = async (choice: Record<string, unknown>, choices: string[]): Promise<void> => {
      __resetVisitorConsentForTests();
      localStorage.setItem('owp:consent', JSON.stringify({ [ORG]: { analytics: true, replay: true, at: '2026-10-25T00:00:00.000Z', ...choice } }));
      stubFetch(lane('opt-in', choices));
      await loadPosture(ORG);
    };
    await stored({ token: 'tok-1' }, ['analytics.replay']);
    expect(replayAllowedFor(ORG), 'positive control: all three hold').toBe(true);
    await stored({}, ['analytics.replay']);
    expect(replayOfferedFor(ORG)).toBe(true);
    expect(replayAllowedFor(ORG), 'a yes that never reached the server').toBe(false);
    await stored({ token: 'tok-1' }, []);
    expect(replayOfferedFor(ORG)).toBe(false);
    expect(replayAllowedFor(ORG), 'a site that no longer offers recording').toBe(false);
  });

  it('a failed withdrawal is still remembered on the device (fail closed)', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    await loadPosture(ORG);
    await recordChoice(ORG, true, { replay: true });
    stubFetch(() => ({ status: 500 }));
    await expect(recordChoice(ORG, true, { replay: false })).rejects.toThrow();
    expect(replayAllowedFor(ORG)).toBe(false);
  });

  it('changing: the recording button withdraws without touching analytics', async () => {
    stubFetch(lane('opt-in', ['analytics.replay']));
    await loadPosture(ORG);
    await recordChoice(ORG, true, { replay: true });
    posts.length = 0;
    render(<VisitorConsentBanner orgId={ORG} />);
    fireEvent.click(await screen.findByRole('button', { name: tx('consentFooterLink') }));
    await screen.findByRole('region', { name: tx('consentTitle') });
    expect(screen.getByText(tx('consentReplayStateOn'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tx('consentReplayTurnOff') }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(categoriesOf(0)).toEqual({ analytics: true, 'analytics.replay': false });
    expect(replayAllowedFor(ORG)).toBe(false);
  });
});
