/**
 * ADR 1141 D6 — the public viewer of a recipient-bound link.
 *
 * Before the code, the page shows only the firm's name and the masked address the
 * server sent, nothing from the shared resource; sending a code is an explicit
 * click (a page load emails nobody); a wrong code says so and keeps the field; the
 * right one re-reads the link and renders it; a locked link says who can unlock it.
 *
 * Red when: the page renders the generic "no longer available" card for a 401/423
 * (the client stops mapping `share_verification_*`), a code request fires on load,
 * or a verified code does not re-read the link; a link that locks mid-flow keeps
 * showing the code field; focus does not return to the field after a miss; or a
 * resend is announced with the first send's words.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SharedSharePage } from '../SharedSharePage.js';

const PROMPT = { orgDisplayName: 'Casa Studio', maskedEmail: 'a•••@client.test' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A routed fetch: GET the link, POST a code request, POST a verify. */
function stubShared(opts: { locked?: boolean; rightCode?: string; failResend?: boolean; lockOnWrong?: boolean } = {}) {
  let sends = 0;
  let verified = false;
  let locked = Boolean(opts.locked);
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^.*\/shared\//, '/shared/')}`);
    if (method === 'POST' && url.endsWith('/verification')) {
      sends += 1;
      if (opts.failResend && sends > 1) return json(429, { error: 'rate_limited', message: 'x', details: { retryAfterS: 120 } });
      return new Response('{}', { status: 202 });
    }
    if (method === 'POST' && url.endsWith('/verification/verify')) {
      const code = (JSON.parse(String(init?.body ?? '{}')) as { code?: string }).code;
      if (code === (opts.rightCode ?? '123456')) { verified = true; return new Response(null, { status: 204 }); }
      // The server answers the locking (fifth) miss exactly like any other miss.
      if (opts.lockOnWrong) locked = true;
      return json(400, { error: 'share_verification_failed', message: 'x' });
    }
    if (locked) return json(423, { error: 'share_verification_locked', message: 'x', details: PROMPT });
    if (!verified) return json(401, { error: 'share_verification_required', message: 'x', details: PROMPT });
    return json(200, { resourceType: 'cms_page', label: 'Ana portal', resource: { title: 'Your project portal', markdown: 'Budget: 42,000' } });
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ADR 1141 — a recipient-bound link asks for its code first', () => {
  it('shows only the firm and the masked address, and sends nothing until asked', async () => {
    const calls = stubShared();
    render(<SharedSharePage token="tok" />);
    expect(await screen.findByRole('heading', { name: /confirm it’s you/i })).toBeTruthy();
    expect(screen.getByText(/Casa Studio shared this link with a•••@client\.test/)).toBeTruthy();
    expect(screen.queryByText(/Your project portal|Budget|Ana portal/)).toBeNull();
    expect(screen.queryByText(/no longer available/i)).toBeNull();
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('a wrong code says so; the right one opens the link', async () => {
    const calls = stubShared();
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    const field = await screen.findByLabelText(/6-digit code/i);
    expect(screen.getByText(/We’ve sent a code to a•••@client\.test/)).toBeTruthy();
    fireEvent.change(field, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /open the link/i }));
    expect(await screen.findByText(/that code didn't work/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /open the link/i }));
    expect(await screen.findByRole('heading', { name: 'Your project portal' })).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET')).length).toBeGreaterThanOrEqual(2));
  });

  it('a locked link says who can unlock it, and offers no code field', async () => {
    stubShared({ locked: true });
    render(<SharedSharePage token="tok" />);
    expect(await screen.findByText(/this link is locked/i)).toBeTruthy();
    expect(screen.getByText(/Ask Casa Studio to unlock it/)).toBeTruthy();
    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
  });

  it('a refused resend keeps the code field and says how long to wait', async () => {
    stubShared({ failResend: true });
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    await screen.findByLabelText(/6-digit code/i);
    fireEvent.click(screen.getByRole('button', { name: /send a new code/i }));
    expect(await screen.findByText(/Try again in 2 min/i)).toBeTruthy();
    expect(screen.getByLabelText(/6-digit code/i)).toBeTruthy();
  });

  it('a miss that locks the link shows the locked card, not another "try again"', async () => {
    stubShared({ lockOnWrong: true });
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /open the link/i }));
    expect(await screen.findByText(/this link is locked/i)).toBeTruthy();
    expect(screen.queryByLabelText(/6-digit code/i)).toBeNull();
  });

  it('after a miss, focus is back on the code field with the code selected', async () => {
    stubShared();
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    const field = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(field, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /open the link/i }));
    await screen.findByText(/that code didn't work/i);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/6-digit code/i)));
  });

  it('a resend says a new code went out, in words a screen reader announces', async () => {
    stubShared();
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    await screen.findByText(/We’ve sent a code to a•••@client\.test/);
    fireEvent.click(screen.getByRole('button', { name: /send a new code/i }));
    expect(await screen.findByText(/We’ve sent a new code to a•••@client\.test/)).toBeTruthy();
  });

  it('one miss makes exactly one quiet re-read (no polling against the read budget)', async () => {
    const calls = stubShared();
    render(<SharedSharePage token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /email me a code/i }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), { target: { value: '000000' } });
    const getsBefore = calls.filter((c) => c.startsWith('GET')).length;
    fireEvent.click(screen.getByRole('button', { name: /open the link/i }));
    await screen.findByText(/that code didn't work/i);
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET')).length).toBe(getsBefore + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.startsWith('GET')).length).toBe(getsBefore + 1);
  });
});
