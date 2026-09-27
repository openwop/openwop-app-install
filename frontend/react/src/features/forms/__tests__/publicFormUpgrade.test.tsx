/**
 * UX_UPGRADE-forms — the public fill upgrades (F-G1/F-G2/F-G3).
 *
 * These pin BEHAVIOUR, and specifically the TIMING rule, which is the whole
 * point of inline validation: a field is judged when you LEAVE it, never while
 * you are still typing into it for the first time — and once judged, it is
 * re-judged as you type so the error clears the moment it's fixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublicFormRenderer } from '../render/PublicFormRenderer.js';

// R2 F-G5 — the renderer persists a device-local draft; without clearing, one
// test's typed values RESUME into the next render of the same form.
//
// ADR 0584 (FORM-UX-3): that sentence used to end "(the feature working as
// designed, bleeding across tests)" — this file DOCUMENTED the shared-device
// bleed as a known behaviour it had to work around, which is as close to a
// written-down defect as it gets. The draft is now scoped to a per-VISIT key
// (`sessionStorage`, one tab) and expires, so the cross-visitor case is closed
// by construction; the clear stays because tests inside ONE file share a visit
// by design, and the resume tests below depend on that being deterministic.
afterEach(() => localStorage.clear());

const SCHEMA = {
  formId: 'form:1',
  title: 'Contact us',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, description: 'As it appears on your ID.' },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ],
  honeypotField: '_hp_ref',
};

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    (init?.method === 'POST' ? ok({ ok: true, submissionId: 'sub:1' }, 201) : ok(SCHEMA))));
}

const nameBox = () => screen.getByLabelText(/name/i);
const emailBox = () => screen.getByLabelText(/email/i);

describe('public form — help text (F-G1)', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  it('renders an authored description and WIRES it to the control for a screen reader', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    const input = await screen.findByLabelText(/name/i);
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    // The help text must be reachable through the association, not merely present.
    expect(document.getElementById(describedBy!.split(' ')[0]!)?.textContent).toBe('As it appears on your ID.');
    // A field with no description gets no dangling association.
    expect(emailBox().getAttribute('aria-describedby')).toBeNull();
  });
});

describe('public form — inline validation timing (F-G2)', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stays QUIET while you type into an untouched field', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    // Typing then clearing an email would be invalid — but it has not been left,
    // so shouting now would be scolding someone mid-word.
    fireEvent.change(emailBox(), { target: { value: 'not-an-email' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(emailBox().getAttribute('aria-invalid')).toBeNull();
  });

  it('judges the field on BLUR, then re-judges live so a fix clears immediately', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);

    fireEvent.change(emailBox(), { target: { value: 'not-an-email' } });
    fireEvent.blur(emailBox());
    await waitFor(() => expect(emailBox().getAttribute('aria-invalid')).toBe('true'));

    // Now that it's been judged, correcting it clears WITHOUT another blur.
    fireEvent.change(emailBox(), { target: { value: 'someone@example.test' } });
    await waitFor(() => expect(emailBox().getAttribute('aria-invalid')).toBeNull());
  });

  it('blurring an untouched-but-VALID field does not invent an error', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    fireEvent.change(nameBox(), { target: { value: 'Ada' } });
    fireEvent.blur(nameBox());
    await waitFor(() => expect(nameBox().getAttribute('aria-invalid')).toBeNull());
  });
});

describe('public form — error summary (F-G3)', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockFetch(); });
  afterEach(() => vi.unstubAllGlobals());

  it('lists every problem in FIELD order and jumps focus to its control', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));

    const summary = await screen.findByRole('alert', { name: /before submitting/i });
    const links = within(summary).getAllByRole('button');
    expect(links.map((a) => a.textContent)).toEqual(['Name', 'Email']);

    // Submit already moved focus to the FIRST invalid control (RUX-1); let that
    // settle before exercising the summary, or the two focus moves race.
    await waitFor(() => expect(document.activeElement).toBe(nameBox()));
    // Clicking an entry moves focus to that control (pointer users + tab-back).
    fireEvent.click(links[1]!);
    await waitFor(() => expect(document.activeElement).toBe(emailBox()));
  });

  it('shrinks as problems are fixed and disappears when the form is clean', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await screen.findByRole('alert', { name: /before submitting/i });

    fireEvent.change(nameBox(), { target: { value: 'Ada' } });
    await waitFor(() => {
      const s = screen.getByRole('alert', { name: /before submitting/i });
      expect(within(s).getAllByRole('button').map((a) => a.textContent)).toEqual(['Email']);
    });

    fireEvent.change(emailBox(), { target: { value: 'ada@example.test' } });
    await waitFor(() => expect(screen.queryByRole('alert', { name: /before submitting/i })).toBeNull());
  });

  it('never shows a summary before the visitor has done anything', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    expect(screen.queryByRole('alert', { name: /before submitting/i })).toBeNull();
  });
});

describe('public form — number fields submit (F1, round-2 BLOCKER)', () => {
  const NUM_SCHEMA = {
    formId: 'form:n',
    title: 'RSVP',
    fields: [
      { key: 'guests', label: 'How many guests?', type: 'number', required: true },
    ],
    honeypotField: '_hp_ref',
  };
  let posted: unknown = null;
  beforeEach(() => {
    posted = null;
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return ok({ ok: true, submissionId: 'sub:n' }, 201); }
      return ok(NUM_SCHEMA);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a typed number passes blur judgement and the form SUBMITS the string wire value', async () => {
    // #2966 shipped the number type with backend + catalog tests only; the
    // renderer stored a string the engine then judged as not-a-number, so a
    // filled number field ALWAYS errored and the form could never be sent.
    render(<PublicFormRenderer formId="form:n" />);
    const box = await screen.findByLabelText(/guests/i);
    fireEvent.change(box, { target: { value: '2' } });
    fireEvent.blur(box);
    await waitFor(() => expect(box.getAttribute('aria-invalid')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    // The wire value stays the string the server demands (it coerces itself).
    expect((posted as { values: Record<string, unknown> }).values.guests).toBe('2');
  });

  it('a non-numeric answer still fails honestly on blur (the coercion is judgement-only)', async () => {
    render(<PublicFormRenderer formId="form:n" />);
    const box = await screen.findByLabelText(/guests/i);
    fireEvent.change(box, { target: { value: 'two' } });
    fireEvent.blur(box);
    await waitFor(() => expect(box.getAttribute('aria-invalid')).toBe('true'));
  });
});

describe('public form — failure honesty (R2 F2/F3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubLoad = (responses: Array<Response | Error>) => {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    }));
  };

  it('a 404 keeps the uniform "unavailable" posture (the positive case)', async () => {
    stubLoad([ok({ error: 'not_found' }, 404)]);
    const { container } = render(<PublicFormRenderer formId="form:1" renderUnavailable={() => <p>gone</p>} />);
    await screen.findByText('gone');
    expect(container.querySelector('form')).toBeNull();
  });

  it('a 500 renders the load-failed state with a WORKING retry — never "the link is out of date", never nothing', async () => {
    stubLoad([ok({ boom: 1 }, 500), ok(SCHEMA)]);
    render(<PublicFormRenderer formId="form:1" />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/couldn’t be loaded/i)).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: /retry/i }));
    await screen.findByLabelText(/name/i); // recovered into the real form
  });

  it('submit failures say what retrying can fix: 429 = capacity, 400 = rejected — answers preserved', async () => {
    let post = 0;
    const postCodes = [429, 400];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { const c = postCodes[Math.min(post, 1)]; post += 1; return ok({ error: 'x' }, c); }
      return ok(SCHEMA);
    }));
    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    fireEvent.change(name, { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.co' } });

    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    // FORM-429-1 (ADR 0584 §Correction) — this matched /no longer accepting/i,
    // i.e. the copy that asserted the FORM was full. A 429 has two causes (the
    // 50k lead ceiling and a full quarantine budget), and the second is reached
    // by a false-positive respondent, who was then told something untrue about
    // the form. The sentence is true of both now, and still names neither — a
    // 429 that identified the quarantine would be the spam oracle.
    await screen.findByText(/isn’t accepting submissions right now/i);
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Ada'); // answers preserved

    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await screen.findByText(/couldn’t be accepted/i);
  });

  it('a NETWORK failure on submit keeps the generic try-again copy (the transient leg)', async () => {
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { throw new TypeError('Failed to fetch'); }
      if (first) { first = false; return ok(SCHEMA); }
      return ok(SCHEMA);
    }));
    render(<PublicFormRenderer formId="form:1" />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await screen.findByText(/please try again/i);
    expect(screen.queryByText(/no longer accepting/i)).toBeNull();
  });

  it('an over-long answer is named AT THE FIELD before submit (the 5k server mirror)', async () => {
    mockFetch();
    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    fireEvent.change(name, { target: { value: 'x'.repeat(5001) } });
    fireEvent.blur(name);
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(name, { target: { value: 'x'.repeat(4999) } });
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBeNull());
  });
});

describe('public form — consent + attribution (R2 F4/F5)', () => {
  const CONSENT_SCHEMA = {
    formId: 'form:c',
    title: 'Sign up',
    fields: [{ key: 'agree', label: 'I agree to the terms', type: 'checkbox', required: true }],
    honeypotField: '_hp_ref',
  };
  let posted: Record<string, unknown> | null = null;
  beforeEach(() => {
    posted = null;
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return ok({ ok: true, submissionId: 'sub:c' }, 201); }
      return ok(CONSENT_SCHEMA);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('check-then-uncheck no longer satisfies a required checkbox (consent must be TRUE)', async () => {
    render(<PublicFormRenderer formId="form:c" />);
    const box = await screen.findByLabelText(/i agree/i);
    fireEvent.click(box); // checked
    fireEvent.click(box); // unchecked again — recorded false
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await waitFor(() => expect(box.getAttribute('aria-invalid')).toBe('true'));
    expect(posted).toBeNull(); // never sent

    fireEvent.click(box); // checked for real
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect((posted!.values as Record<string, unknown>).agree).toBe(true);
  });

  it('the submit body carries referrer + utm page metadata (the dark attribution lane, lit)', async () => {
    // jsdom: document.referrer is '' by default — stub it; utm rides the URL.
    Object.defineProperty(document, 'referrer', { value: 'https://social.example/post/1', configurable: true });
    window.history.pushState({}, '', '/f/form:c?utm_source=news&utm_campaign=aug&other=x');
    try {
      render(<PublicFormRenderer formId="form:c" />);
      const box = await screen.findByLabelText(/i agree/i);
      fireEvent.click(box);
      fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
      await waitFor(() => expect(posted).not.toBeNull());
      expect(posted!.referrer).toBe('https://social.example/post/1');
      expect(posted!.utm).toEqual({ utm_source: 'news', utm_campaign: 'aug' });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('public form — resume + submit-another (R2 F-G5/F7/F8)', () => {
  let posts: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    posts = [];
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return ok({ ok: true, submissionId: `sub:${posts.length}` }, 201); }
      return ok(SCHEMA);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('typed answers survive a reload (device-local), announce the restore, and Start over clears', async () => {
    const first = render(<PublicFormRenderer formId="form:1" />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    first.unmount();

    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    expect((name as HTMLInputElement).value).toBe('Ada');
    const notice = screen.getByText(/only in this browser/i);
    expect(notice).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('');
  });

  it('success clears the draft and "submit another" mints a FRESH idempotency key', async () => {
    render(<PublicFormRenderer formId="form:1" />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    const another = await screen.findByRole('button', { name: /another response/i });
    expect(localStorage.getItem('owp-form-draft:form:1')).toBeNull(); // draft cleared

    fireEvent.click(another);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'g@h.co' } });
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await screen.findByRole('button', { name: /another response/i });
    expect(posts).toHaveLength(2);
    // Reusing the key would dedupe the second submission into the first.
    expect(posts[0]!.clientKey).not.toBe(posts[1]!.clientKey);
  });

  /**
   * ADR 0584 (FORM-UX-1) — THIS TEST USED TO PIN THE DEFECT.
   *
   * It was named "a honeypot-shaped 200 WITHOUT a submissionId still advances
   * the embedding surface (F8)" and asserted `onSubmitted` was called with `''`.
   * That is the tests-that-pin-defects shape: it encoded, as desired behaviour,
   * a respondent being shown "Thanks — your submission was received" and a
   * funnel step advancing over a submission that was never stored.
   *
   * The R2 F8 reasoning it came from was sound about the wrong thing: gating the
   * callbacks on the id left a funnel showing "Thanks" while never advancing,
   * "an observable inconsistency that leaked more than advancing does". True —
   * but the cure for "thanks without an advance" is not "advance without a
   * submission", it is to stop saying thanks. THE INVARIANT: a submission id is
   * the only proof the server stored anything, so nothing downstream of "we
   * received this" may happen without one.
   *
   * The server no longer emits an id-less 2xx at all (a tripped abuse control
   * quarantines the row and returns a real id), so this is defence in depth —
   * which is exactly why it must be pinned: a client that trusts an id-less 2xx
   * re-opens the whole defect the moment any surface produces one.
   */
  it('FORM-UX-1: a 2xx WITHOUT a submissionId is a FAILURE — no thank-you, no advance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      (init?.method === 'POST' ? ok({ ok: true }, 200) : ok(SCHEMA))));
    const onSubmitted = vi.fn();
    render(<PublicFormRenderer formId="form:1" onSubmitted={onSubmitted} />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));

    // The respondent is TOLD it did not go through…
    expect(await screen.findByText(/couldn’t|could not|rejected|went wrong/i)).toBeTruthy();
    // …the success view never rendered…
    expect(screen.queryByRole('button', { name: /another response/i })).toBeNull();
    // …and the embedding surface (a funnel step) did NOT advance.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('FORM-UX-1: a real submissionId still advances the embedding surface', async () => {
    // The other half, so the assertion above cannot pass by never advancing.
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      (init?.method === 'POST' ? ok({ ok: true, submissionId: 'sub:real' }, 201) : ok(SCHEMA))));
    const onSubmitted = vi.fn();
    render(<PublicFormRenderer formId="form:1" onSubmitted={onSubmitted} />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: /submit|send/i }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('sub:real'));
  });

  /**
   * ADR 0584 (FORM-UX-3) — the shared-device bleed, pinned in both directions.
   *
   * The draft key was the FORM id alone, with no TTL and no visitor scoping, so
   * the next person on a public terminal / lent tablet / kiosk was shown a
   * stranger's name, email and free text under copy asserting they were theirs.
   * The bleed was even DOCUMENTED at the top of this file, as the reason it has
   * to clear `localStorage` between tests.
   */
  it('FORM-UX-3: a legacy UNSCOPED draft is purged, never restored to the next visitor', async () => {
    // Exactly what a device that already carries a previous visitor's answers
    // looks like: the pre-ADR-0584 key shape, holding their PII.
    localStorage.setItem('owp-form-draft:form:1', JSON.stringify({ name: 'Ada Lovelace', email: 'ada@private.test' }));
    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    expect((name as HTMLInputElement).value, 'a stranger’s answers must NOT be restored').toBe('');
    expect(screen.queryByText(/only in this browser/i), 'and no "we restored your answers" claim').toBeNull();
    // …and it is GONE from the device, not merely ignored on this render.
    expect(localStorage.getItem('owp-form-draft:form:1')).toBeNull();
  });

  it('FORM-UX-3: a draft older than the TTL is dropped', async () => {
    // Same visit, but stale: a kiosk tab nobody closed is the case visit-scoping
    // alone does not cover, which is why the TTL is not redundant with it.
    const visit = sessionStorage.getItem('owp-form-visit');
    expect(visit, 'the renderer must have minted a visit key by now').toBeTruthy();
    localStorage.setItem(
      `owp-form-draft:form:1:${visit}`,
      JSON.stringify({ savedAt: Date.now() - (31 * 60 * 1000), values: { name: 'Stale Person' } }),
    );
    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    expect((name as HTMLInputElement).value).toBe('');
  });

  it('FORM-UX-3: a fresh draft from THIS visit still resumes (the feature is not just switched off)', async () => {
    const first = render(<PublicFormRenderer formId="form:1" />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    first.unmount();

    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    expect((name as HTMLInputElement).value, 'save-and-resume must still work within one visit').toBe('Ada');
    expect(screen.getByText(/only in this browser/i)).toBeTruthy();
  });

  /**
   * FORM-DRAFT-1 (ADR 0584 §Correction) — THE REGRESSION THE FORM-UX-3 FIX
   * INTRODUCED, in both directions.
   *
   * `pruneStaleDrafts` spared only the EXACT current key, so mounting form B
   * deleted form A's draft from the SAME LIVE VISIT. A funnel with a form on
   * step 1 and a different form on step 2 lost step 1's answers the moment step
   * 2 mounted — and the in-page Back then showed an empty form that had resumed
   * correctly BEFORE the fix. Same on a CMS page rendering two forms, and on
   * either one re-mounting through the FORM-UX-9 Retry.
   */
  it('FORM-DRAFT-1: mounting a SECOND form does not destroy the first form’s draft from this visit', async () => {
    const OTHER = { ...SCHEMA, formId: 'form:2', title: 'Step two' };
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return ok({ ok: true, submissionId: 'sub:1' }, 201);
      return ok(String(url).includes('form%3A2') || String(url).includes('form:2') ? OTHER : SCHEMA);
    }));

    // Step 1: the visitor part-fills form A.
    const stepOne = render(<PublicFormRenderer formId="form:1" />);
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ada' } });
    stepOne.unmount();

    // Step 2 mounts under a DIFFERENT formId — this is where the draft died.
    const stepTwo = render(<PublicFormRenderer formId="form:2" />);
    await screen.findByLabelText(/name/i);
    stepTwo.unmount();

    // Back to step 1: the answers must still be there.
    render(<PublicFormRenderer formId="form:1" />);
    const name = await screen.findByLabelText(/name/i);
    expect((name as HTMLInputElement).value, 'a sibling form’s mount must not wipe this visit’s draft').toBe('Ada');
    expect(screen.getByText(/only in this browser/i)).toBeTruthy();
  });

  it('FORM-DRAFT-1: a draft from ANOTHER visit is still purged, and the TTL still applies per key', async () => {
    // The half the fix must not weaken: sparing the whole visit must not spare
    // every form's draft on the device. Both of these are other people's.
    localStorage.setItem('owp-form-draft:form:1:v-someone-else', JSON.stringify({ savedAt: Date.now(), values: { name: 'Stranger' } }));
    localStorage.setItem('owp-form-draft:form:9:v-someone-else', JSON.stringify({ savedAt: Date.now(), values: { name: 'Stranger' } }));
    // …and this one is THIS visit's, but past the TTL.
    const visit = sessionStorage.getItem('owp-form-visit');
    expect(visit).toBeTruthy();
    localStorage.setItem(`owp-form-draft:form:7:${visit}`, JSON.stringify({ savedAt: Date.now() - (31 * 60 * 1000), values: { name: 'Stale' } }));

    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByLabelText(/name/i);
    expect(localStorage.getItem('owp-form-draft:form:1:v-someone-else')).toBeNull();
    expect(localStorage.getItem('owp-form-draft:form:9:v-someone-else')).toBeNull();
    expect(localStorage.getItem(`owp-form-draft:form:7:${visit}`), 'the TTL now applies to EVERY key of this visit, not just the current form’s').toBeNull();
  });
});

