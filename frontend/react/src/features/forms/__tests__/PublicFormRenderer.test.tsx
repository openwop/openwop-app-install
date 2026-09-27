/**
 * ADR 0331 §D1 — the ONE public fill renderer: renders the fetched schema as
 * labeled controls, keeps the honeypot visually hidden, blocks submit on
 * client validation (shared ADR 0197 engine), posts a valid submission with
 * the honeypot inside `values` (the server contract), shows the form's
 * `submitMessage` on success, and renders the unavailable slot on 404 (no
 * draft-existence leak).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PublicFormRenderer } from '../render/PublicFormRenderer.js';
import { FormEmbedProvider } from '../render/embedContext.js';

const SCHEMA = {
  formId: 'form:1',
  title: 'Contact us',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ],
  honeypotField: '_hp_ref',
  submitMessage: 'We will be in touch.',
};

function mockFetch(handlers: { get?: () => Response; post?: (body: unknown) => Response }): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return handlers.post!(JSON.parse(String(init.body)));
    return handlers.get!();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('PublicFormRenderer', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('renders labeled fields + a visually-hidden honeypot, and submits with the honeypot inside values', async () => {
    let posted: { values?: Record<string, unknown> } = {};
    mockFetch({
      get: () => ok(SCHEMA),
      post: (body) => { posted = body as { values?: Record<string, unknown> }; return ok({ ok: true, submissionId: 'sub:1' }, 201); },
    });
    const onSubmitted = vi.fn();
    const { container } = render(<PublicFormRenderer formId="form:1" onSubmitted={onSubmitted} />);
    await screen.findByText('Contact us');
    const hp = container.querySelector('.visually-hidden input');
    expect(hp).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await screen.findByText('We will be in touch.');
    expect(onSubmitted).toHaveBeenCalledWith('sub:1');
    expect(posted.values?.name).toBe('Ada');
    expect(posted.values?._hp_ref).toBe(''); // untouched honeypot rides along empty
  });

  it('blocks submit on client validation and marks the fields', async () => {
    const fetchFn = mockFetch({ get: () => ok(SCHEMA) });
    render(<PublicFormRenderer formId="form:1" />);
    await screen.findByText('Contact us');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    // Both fields are marked invalid. (Counted via aria-invalid, not via
    // role=alert: UX_UPGRADE-forms F-G3 adds a third alert — the error summary.)
    await screen.findAllByRole('alert');
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2); // name + email required
    expect(fetchFn).toHaveBeenCalledTimes(1); // the GET only — no POST fired
  });

  it('merges FormEmbedProvider context under the prop and fires both onSubmitted hooks (ADR 0339)', async () => {
    let posted: { context?: Record<string, string> } = {};
    mockFetch({
      get: () => ok(SCHEMA),
      post: (body) => { posted = body as { context?: Record<string, string> }; return ok({ ok: true, submissionId: 'sub:2' }, 201); },
    });
    const fromProvider = vi.fn();
    const fromProp = vi.fn();
    render(
      <FormEmbedProvider value={{ context: { funnelId: 'fun:1', stepId: 's0', shared: 'provider' }, onSubmitted: fromProvider }}>
        <PublicFormRenderer formId="form:1" context={{ shared: 'prop' }} onSubmitted={fromProp} />
      </FormEmbedProvider>,
    );
    await screen.findByText('Contact us');
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByText('We will be in touch.');
    expect(posted.context).toEqual({ funnelId: 'fun:1', stepId: 's0', shared: 'prop' }); // prop wins on conflict
    expect(fromProvider).toHaveBeenCalledWith('sub:2');
    expect(fromProp).toHaveBeenCalledWith('sub:2');
  });

  it('renders the unavailable slot on 404, never the form', async () => {
    mockFetch({ get: () => ok({ error: 'not_found' }, 404) });
    render(<PublicFormRenderer formId="form:x" renderUnavailable={() => <div>gone</div>} />);
    await screen.findByText('gone');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
