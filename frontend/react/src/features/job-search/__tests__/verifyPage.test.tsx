/**
 * ADR 0544 P3 — the PUBLIC verification page.
 *
 * The reader is a stranger with no account, so the properties worth pinning are
 * about what the page says and what it sends:
 *
 *  1. it never sends the visitor's credentials — a "public" read that carried a
 *     session cookie would let the backend correlate WHO checked WHICH applicant;
 *  2. an unreachable server is NOT reported as an invalid link (the SR-2 defect:
 *     a network blip once told a quote recipient the offer was revoked);
 *  3. unknown and revoked stay ONE state, because the backend refuses them
 *     identically and a page that guessed would put the oracle back;
 *  4. the page states its own limits — an attestation surface that showed only
 *     its strongest claims reads as an endorsement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { matchVerifyToken } from '../verifyRoute.js';
import { resolveAttestation } from '../attestationVerifyClient.js';
import { AttestationVerifyPage } from '../AttestationVerifyPage.js';

const VIEW = {
  // No campaignId: the projection drops it (a free-text correlator with no
  // reader). Day-precision issuedAt, matching the backend.
  issuedAt: '2026-03-01',
  claims: [
    { type: 'authorised-by-person', facts: { authorisedByNamedPerson: true, maxSubmits: 40 }, sourceDigest: 'a'.repeat(32) },
    { type: 'applications-in-window', facts: { count: 12, windowStart: '2026-02-01T00:00:00.000Z', windowEnd: '2026-02-28T00:00:00.000Z' }, sourceDigest: 'b'.repeat(32) },
  ],
};

// REAL `Response` objects, not hand-made shapes. A literal `{ ok: false, status:
// 404 }` encodes my belief about how `ok` relates to `status`; if that belief
// were wrong the test would agree with the bug. The platform derives it.
const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number): Response =>
  new Response(JSON.stringify({ error: 'not_found' }), { status: code, headers: { 'content-type': 'application/json' } });
const unparseable = (): Response => new Response('<html>a proxy error page</html>', { status: 200 });

/** A typed fetch double, so reading back its call args needs no cast. */
const fetchSpy = (impl: (url: string, init?: RequestInit) => Promise<Response>) => vi.fn(impl);

describe('the /verify/:token matcher', () => {
  it('matches a token path and decodes it', () => {
    expect(matchVerifyToken('/verify/owatt_abc123')).toBe('owatt_abc123');
    expect(matchVerifyToken('/verify/owatt_abc123/')).toBe('owatt_abc123');
  });

  it('is a SIBLING path — nothing under an authed namespace matches', () => {
    // The `public-forms` ≠ `forms` rule, mirrored on the client so both route
    // tables can be read for "what can a stranger reach" in one pass.
    expect(matchVerifyToken('/job-search/verify/owatt_abc')).toBeNull();
    expect(matchVerifyToken('/job-search/public/attestations/owatt_abc')).toBeNull();
  });

  it('a malformed percent escape is a NON-match, never a URIError', () => {
    expect(() => matchVerifyToken('/verify/%E0%A4%A')).not.toThrow();
    expect(matchVerifyToken('/verify/%E0%A4%A')).toBeNull();
  });

  it('refuses an oversized token before a request is ever made', () => {
    expect(matchVerifyToken(`/verify/${'x'.repeat(201)}`)).toBeNull();
    expect(matchVerifyToken(`/verify/${'x'.repeat(200)}`)).toBeTruthy();
  });

  it('does not match the bare prefix', () => {
    expect(matchVerifyToken('/verify')).toBeNull();
    expect(matchVerifyToken('/verify/')).toBeNull();
  });
});

describe('the verification client', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends NO credentials — the token is the only one this request carries', async () => {
    // `fetchOpts` would add `credentials: 'include'` in cookie mode (production),
    // shipping a signed-in visitor's session along with an anonymous read.
    const spy = fetchSpy(async () => okResponse(VIEW));
    vi.stubGlobal('fetch', spy);
    await resolveAttestation('owatt_abc');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain('/public-attestations/owatt_abc');
    expect(init, 'a bare fetch, so no credentials can ride along').toBeUndefined();
  });

  it('distinguishes an unreachable server from a token that does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect((await resolveAttestation('owatt_abc')).kind).toBe('unavailable');

    vi.stubGlobal('fetch', vi.fn(async () => status(404)));
    expect((await resolveAttestation('owatt_abc')).kind).toBe('not-found');
  });

  it('treats a 5xx and an unparseable 200 as unavailable, not as a bad link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => status(503)));
    expect((await resolveAttestation('owatt_abc')).kind).toBe('unavailable');

    // A 200 carrying an HTML proxy error page — the realistic shape of this.
    vi.stubGlobal('fetch', vi.fn(async () => unparseable()));
    expect((await resolveAttestation('owatt_abc')).kind).toBe('unavailable');
  });
});

describe('the verification page', () => {
  beforeEach(() => { document.head.innerHTML = ''; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders each proven fact as a sentence, and states what it does NOT attest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(VIEW)));
    render(<AttestationVerifyPage token="owatt_abc" />);

    expect(await screen.findByText(/named person authorised/i)).toBeTruthy();
    expect(screen.getByText(/40 automatic applications/i)).toBeTruthy();
    expect(screen.getByText(/12 applications sent/i)).toBeTruthy();
    // The limits are the point: without them the page reads as an endorsement.
    expect(screen.getByText(/no match score/i), 'the page must state its own limits').toBeTruthy();
  });

  it('is noindex — a capability-token URL must never reach a search index', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(VIEW)));
    render(<AttestationVerifyPage token="owatt_abc" />);
    await screen.findByText(/named person authorised/i);
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,nofollow');
  });

  it('does NOT say the link is invalid when the server is unreachable', async () => {
    // The SR-2 defect, on a surface where it would be a statement about a person.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    render(<AttestationVerifyPage token="owatt_abc" />);
    expect(await screen.findByText(/problem on our side/i)).toBeTruthy();
    expect(screen.queryByText(/not valid/i), 'a dropped connection is not a verdict on the link').toBeNull();
  });

  it('offers a retry that actually re-requests', async () => {
    const spy = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', spy);
    render(<AttestationVerifyPage token="owatt_abc" />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows ONE state for a token that does not resolve, and does not guess why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => status(404)));
    render(<AttestationVerifyPage token="owatt_abc" />);
    expect(await screen.findByText(/nothing to show/i)).toBeTruthy();
    // Naming a cause would rebuild the existence oracle P2 removed: "revoked"
    // tells an employer an attestation once existed and was withdrawn.
    for (const guess of [/revoked/i, /expired/i, /withdrawn by/i, /no longer/i]) {
      expect(screen.queryByText(guess), `the page must not assert ${guess}`).toBeNull();
    }
  });

  it('omits a claim type this build does not know rather than rendering a fact bag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      ...VIEW,
      claims: [...VIEW.claims, { type: 'future-claim-kind', facts: { somethingNew: 7 }, sourceDigest: 'c'.repeat(32) }],
    })));
    render(<AttestationVerifyPage token="owatt_abc" />);
    await screen.findByText(/named person authorised/i);
    expect(screen.queryByText(/somethingNew|future-claim-kind/), 'an unlabelled fact still reads as a claim').toBeNull();
    expect(screen.getAllByRole('listitem').filter((li) => li.className.includes('surface-card'))).toHaveLength(2);
  });
});
