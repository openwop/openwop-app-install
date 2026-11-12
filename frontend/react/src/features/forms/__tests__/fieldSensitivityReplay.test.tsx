/**
 * ADR 0951 D2 — a form field authored with a `sensitivity` keeps its page out of
 * session recording: the public renderer stamps `data-owx-sensitivity` on the
 * control, and the recorder's `pageMayBeRecorded` refuses any page carrying it.
 *
 * Red when: the renderer stops stamping the attribute, renames it away from the
 * recorder's selector, or stamps it on an ordinary field.
 *
 * Sabotage witnesses (w103; src/features/forms/render/PublicFormRenderer.tsx,
 * src/features/site/replayCapture.ts): dropping or renaming the
 * `data-owx-sensitivity` spread, or removing `[data-owx-sensitivity]` from
 * NEVER_RECORD_SELECTOR, reds the first case; stamping every field reds both;
 * inverting `pageMayBeRecorded` reds both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicFormRenderer } from '../render/PublicFormRenderer.js';
import type { PublicFormField } from '../render/deriveFields.js';
import { pageMayBeRecorded } from '../../site/replayCapture.js';

/** The public GET body the renderer reads (`RenderSchema` in PublicFormRenderer). */
const schema = (fields: PublicFormField[]): { formId: string; title: string; fields: PublicFormField[]; honeypotField: string; submitMessage: string } =>
  ({ formId: 'form:s', title: 'Intake', fields, honeypotField: '_hp_ref', submitMessage: 'Thanks.' });
const serve = (body: ReturnType<typeof schema>): void => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
};

describe('ADR 0951 D2 — forms sensitivity reaches the replay recorder', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

  it('stamps a sensitive control, and the page may not be recorded', async () => {
    serve(schema([
      { key: 'name', label: 'Name', type: 'text', required: false },
      { key: 'condition', label: 'Condition', type: 'textarea', required: false, sensitivity: 'health' },
    ]));
    render(<PublicFormRenderer formId="form:s" />);
    await screen.findByText('Intake');
    const condition = screen.getByLabelText(/Condition/);
    // On the CONTROL itself (the element the recorder would mask), not a wrapper.
    expect(condition.tagName).toBe('TEXTAREA');
    expect(condition.getAttribute('data-owx-sensitivity')).toBe('health');
    expect(screen.getByLabelText(/Name/).hasAttribute('data-owx-sensitivity')).toBe(false);
    expect(pageMayBeRecorded(document)).toBe(false);
  });

  it('leaves a page of ordinary fields recordable', async () => {
    serve(schema([{ key: 'name', label: 'Name', type: 'text', required: false }]));
    render(<PublicFormRenderer formId="form:s" />);
    await screen.findByText('Intake');
    expect(screen.getByLabelText(/Name/).hasAttribute('data-owx-sensitivity')).toBe(false);
    expect(pageMayBeRecorded(document)).toBe(true);
  });
});
