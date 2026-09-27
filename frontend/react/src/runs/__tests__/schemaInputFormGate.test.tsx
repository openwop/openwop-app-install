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
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { SchemaInputForm } from '../SchemaInputForm.js';

const schema = {
  type: 'object',
  properties: { to: { type: 'string', format: 'email', title: 'To' } },
  required: ['to'],
} as const;

afterEach(cleanup);

function mount(raw: string): { blocking: () => boolean } {
  const seen: boolean[] = [];
  render(
    <SchemaInputForm
      schema={schema as never}
      raw={raw}
      onRawChange={() => {}}
      onBlockingChange={(b) => seen.push(b)}
    />,
  );
  return { blocking: () => seen[seen.length - 1] ?? false };
}

describe('ADR 0729 D1 — the submit gate', () => {
  it('a VALID payload does not block (a subset validator must never over-fire)', () => {
    expect(mount('{"to":"ops@example.com"}').blocking()).toBe(false);
  });

  it('BORN RED: an invalid email blocks, and the control is marked aria-invalid for focus', () => {
    const h = mount('{"to":"nope"}');
    expect(h.blocking(), 'the form already renders the error — it must also refuse').toBe(true);
    expect(document.querySelector('[aria-invalid="true"]'), 'the page needs a focus target').not.toBeNull();
  });

  it('JSON mode does NOT block — the escape hatch stays an exit', () => {
    const h = mount('{"to":"nope"}');
    expect(h.blocking()).toBe(true);
    fireEvent.click(screen.getByText('inputsModeJson'));
    expect(h.blocking(), 'switching to Edit-as-JSON is leaving the typed form on purpose').toBe(false);
  });
});
