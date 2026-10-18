/**
 * ADR 0729 D1 — the form told the user a value was invalid and submitted it anyway.
 *
 * Three properties, deliberately apart:
 *   1. a valid payload reports NOT blocking (the gate must not over-fire — `deriveFields`
 *      is a subset validator, so a false block would be worse than the bounce it replaces);
 *   2. an invalid one reports blocking, and the offending control is marked `aria-invalid`
 *      so the page has a focus target;
 *   3. **JSON mode reports NOT blocking however bad the value is** — the escape hatch is
 *      the documented way to post what the form rejects, and a gate that closed it would
 *      be a regression dressed as a fix.
 *
 * The gate's reports are read as the FULL sequence it emitted: a VALID payload
 * must report `false` (a form that only ever reported `true` would otherwise
 * pass on the helper's default). aria-invalid is asserted on the To control
 * itself. What turns it red: JSON mode blocking; an invalid value not
 * blocking; `false` never reported; the field error dropped; schema defaults
 * not written through, overwriting a user's value, dropping undeclared keys,
 * or overwriting unparseable text.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { SchemaInputForm } from '../SchemaInputForm.js';
import type { SchemaObject } from '../inputSchemaForm.js';

const schema: SchemaObject = {
  type: 'object',
  properties: { to: { type: 'string', format: 'email', title: 'To' } },
  required: ['to'],
};

afterEach(cleanup);

function mount(raw: string): { seen: boolean[]; blocking: () => boolean | undefined } {
  const seen: boolean[] = [];
  render(
    <SchemaInputForm
      schema={schema}
      raw={raw}
      onRawChange={() => {}}
      onBlockingChange={(b) => seen.push(b)}
    />,
  );
  // No `?? false` default: "never reported" must not read as "not blocking".
  return { seen, blocking: () => seen[seen.length - 1] };
}

describe('ADR 0729 D1 — the submit gate', () => {
  it('a VALID payload does not block (a subset validator must never over-fire)', () => {
    const h = mount('{"to":"ops@example.com"}');
    expect(h.seen).toEqual([false]);
  });

  it('BORN RED: an invalid email blocks, and the control is marked aria-invalid for focus', () => {
    const h = mount('{"to":"nope"}');
    expect(h.blocking(), 'the form already renders the error — it must also refuse').toBe(true);
    expect(screen.getByLabelText(/To/).getAttribute('aria-invalid'), 'the page needs a focus target').toBe('true');
  });

  it('JSON mode does NOT block — the escape hatch stays an exit', () => {
    const h = mount('{"to":"nope"}');
    expect(h.blocking()).toBe(true);
    fireEvent.click(screen.getByText('inputsModeJson'));
    expect(h.blocking(), 'switching to Edit-as-JSON is leaving the typed form on purpose').toBe(false);
  });
});

describe('ADR 0772 (RRUX-2) — what the form shows is what it sends', () => {
  const withDefault: SchemaObject = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['fast', 'careful'], default: 'careful', title: 'Mode' },
      note: { type: 'string', title: 'Note' },
    },
    required: ['mode'],
  };

  it('a schema default the form displays is written into the raw payload submit posts', () => {
    const writes: string[] = [];
    render(<SchemaInputForm schema={withDefault} raw="{}" onRawChange={(r) => writes.push(r)} />);
    expect(writes.length, 'the default must reach the payload, not just the screen').toBeGreaterThan(0);
    expect(JSON.parse(writes[writes.length - 1]!)).toEqual({ mode: 'careful' });
  });

  it('a value the user already chose is never overwritten by the default', () => {
    const writes: string[] = [];
    render(<SchemaInputForm schema={withDefault} raw={JSON.stringify({ mode: 'fast' })} onRawChange={(r) => writes.push(r)} />);
    // Either no write at all, or a write that keeps the user's value.
    for (const w of writes) expect(JSON.parse(w)).toEqual({ mode: 'fast' });
  });

  it('keys the schema does not declare are KEPT — the JSON escape hatch may carry them', () => {
    const writes: string[] = [];
    render(<SchemaInputForm schema={withDefault} raw={JSON.stringify({ text: 'hello world' })} onRawChange={(r) => writes.push(r)} />);
    expect(JSON.parse(writes[writes.length - 1]!)).toEqual({ text: 'hello world', mode: 'careful' });
  });

  it('text that does not parse (typed before the schema loaded) is never overwritten', () => {
    const writes: string[] = [];
    render(<SchemaInputForm schema={withDefault} raw={'{"mode": "fa'} onRawChange={(r) => writes.push(r)} />);
    expect(writes).toEqual([]);
  });
});
