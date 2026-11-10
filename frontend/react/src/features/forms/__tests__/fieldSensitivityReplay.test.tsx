/**
 * ADR 0951 D2 — a form field authored with a `sensitivity` keeps its page out of
 * session recording: the public renderer stamps `data-owx-sensitivity` on the
 * control, and the recorder's `pageMayBeRecorded` refuses any page carrying it.
 *
 * Red when: the renderer stops stamping the attribute, renames it away from the
 * recorder's selector, or stamps it on an ordinary field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicFormRenderer } from '../render/PublicFormRenderer.js';
import { pageMayBeRecorded } from '../../site/replayCapture.js';

const schema = (fields: unknown[]) => ({ formId: 'form:s', title: 'Intake', fields, honeypotField: '_hp_ref', submitMessage: 'Thanks.' });
const serve = (body: unknown): void => {
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
    expect(screen.getByLabelText(/Condition/).getAttribute('data-owx-sensitivity')).toBe('health');
    expect(screen.getByLabelText(/Name/).hasAttribute('data-owx-sensitivity')).toBe(false);
    expect(pageMayBeRecorded(document)).toBe(false);
  });

  it('leaves a page of ordinary fields recordable', async () => {
    serve(schema([{ key: 'name', label: 'Name', type: 'text', required: false }]));
    render(<PublicFormRenderer formId="form:s" />);
    await screen.findByText('Intake');
    expect(pageMayBeRecorded(document)).toBe(true);
  });
});
