/**
 * ADR 1064 — the CMS form card (P3 of the MyndHyve redesign brief).
 *
 * `PublicFormRenderer card`: each one-line field (text, email, number) is
 * wrapped so CSS can pair it with its neighbour on wide screens; every other
 * field, and the order, is unchanged. After a successful submit, the
 * confirmation leads with a decorative tick (aria-hidden; the Notice carries
 * the words). Without `card` nothing changes, so every other embed is
 * unaffected. The CMS `form` section with `layout: 'card'` renders the head
 * beside a card that holds the person block and the form.
 *
 * Red when: a short field loses its wrapper or a long one gains one, the order
 * changes, the tick is missing or announced, card markup leaks into the plain
 * renderer, or the section stops rendering its person block.
 *
 * Sabotage-witnessed (w92, /grade-tests): no wrapper, a wrapper in plain mode,
 * a number field left unwrapped, a wrapped checkbox, the card class or the
 * tick in plain mode (idle and done), an announced tick, a node before the
 * tick, an empty success Notice, and the section's card prop, layout gate,
 * person note or avatar alt dropped each turn a case here red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicFormRenderer } from '../render/PublicFormRenderer.js';
import { RenderSection } from '../../cms/SectionRenderer.js';
import type { Section } from '../../cms/cmsClient.js';
import type { PublicFormField } from '../render/deriveFields.js';

beforeEach(() => sessionStorage.setItem('owp-form-visit', 'v-form-card'));
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Every field type the renderer branches on: three one-line kinds (text,
// email, number) and three that are not (textarea, select, checkbox).
const FIELDS: PublicFormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'website', label: 'Website', type: 'text', required: false },
  { key: 'team', label: 'Team size', type: 'number', required: false },
  { key: 'about', label: 'What do you want to launch?', type: 'textarea', required: true },
  { key: 'when', label: 'When would you like to start?', type: 'select', required: false, options: ['This month', 'Later'] },
  { key: 'updates', label: 'Send me updates', type: 'checkbox', required: false },
];
const SCHEMA = { formId: 'form:dp', title: 'Tell us about your business', fields: FIELDS, honeypotField: '_hp_ref' };
const SUCCESS = 'Thanks — your submission was received.';
const fillAndSubmit = async (container: HTMLElement): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'Ana' } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ana@example.com' } });
  fireEvent.change(screen.getByLabelText(/launch/i), { target: { value: 'A booking app.' } });
  fireEvent.submit(container.querySelector('form')!);
  await screen.findByText(SUCCESS);
};
const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = (): void => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) =>
    (init?.method === 'POST' ? ok({ ok: true, submissionId: 'sub:1' }, 201) : ok(SCHEMA))));
};

describe('PublicFormRenderer card mode', () => {
  beforeEach(mockFetch);

  it('wraps only the one-line fields, keeping every field and its order', async () => {
    const { container } = render(<PublicFormRenderer formId="form:dp" card />);
    await screen.findByLabelText(/name/i);
    const form = container.querySelector('form.form-card')!;
    const labelOf = (el: Element): string => (el.id ? form.querySelector(`label[for="${el.id}"]`)?.textContent ?? '' : '').replace(/\s*\*$/, '').trim();
    const shorts = [...form.querySelectorAll(':scope > .form-card__short')];
    expect(shorts.map((w) => labelOf(w.querySelector('input')!))).toEqual(['Name', 'Email', 'Website', 'Team size']);
    const controls = [...form.querySelectorAll('input, textarea, select')]
      .filter((e) => !e.closest('.visually-hidden')).map(labelOf);
    expect(controls).toEqual(['Name', 'Email', 'Website', 'Team size', 'What do you want to launch?', 'When would you like to start?', 'Send me updates']);
    expect(form.querySelector('textarea')?.closest('.form-card__short')).toBeNull();
    expect(form.querySelector('select')?.closest('.form-card__short')).toBeNull();
    expect(form.querySelector('input[type="checkbox"]')?.closest('.form-card__short')).toBeNull();
  });

  it('leads the confirmation with a decorative tick', async () => {
    const { container } = render(<PublicFormRenderer formId="form:dp" card />);
    await fillAndSubmit(container);
    await waitFor(() => expect(container.querySelector('.form-card-done')).not.toBeNull());
    const done = container.querySelector('.form-card-done') as HTMLElement;
    const tick = container.querySelector('.form-card-done__tick')!;
    expect(tick.getAttribute('aria-hidden')).toBe('true');
    expect(done.firstElementChild).toBe(tick);
    // The Notice carries the words, inside the same confirmation.
    expect(within(done).getByText(SUCCESS)).toBeTruthy();
  });

  it('without card, the renderer is unchanged, idle and after submit', async () => {
    const { container } = render(<PublicFormRenderer formId="form:dp" />);
    await screen.findByLabelText(/name/i);
    expect(container.querySelector('.form-card, .form-card__short')).toBeNull();
    await fillAndSubmit(container);
    expect(container.querySelector('.form-card-done, .form-card-done__tick')).toBeNull();
  });
});

describe('CMS form section, layout card', () => {
  beforeEach(mockFetch);

  it('renders the head beside a card with the person block and the form', async () => {
    const section: Section = {
      sectionId: 'sec:mh-inquiry-form', type: 'form',
      data: {
        heading: 'Tell us about your business', lede: 'We read every one.', formId: 'form:dp', layout: 'card',
        person: { name: 'David', note: 'Read by a person, not a bot', imageToken: 'med_face', alt: 'David, the founder' },
      },
    };
    const { container } = render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
    await screen.findByLabelText(/name/i);
    const card = container.querySelector('.fp-formcard__inner > .fp-formcard__card')!;
    expect(card.querySelector('.fp-formcard__avatar')?.getAttribute('alt')).toBe('David, the founder');
    expect(card.querySelector('.fp-formcard__who')?.textContent).toBe('DavidRead by a person, not a bot');
    expect(card.querySelector('form.form-card')).not.toBeNull();
    expect(container.querySelector('.fp-formcard__inner > .fp-head')?.textContent).toContain('We read every one.');
  });
});
