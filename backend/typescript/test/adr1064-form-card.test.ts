/**
 * ADR 1064 — the CMS `form` section's card layout, validator half.
 *
 * `layout: 'card'` is kept (any other value is dropped); `lede` is kept; the
 * `person` block (name, note, picture + alt) is kept only on a card and only
 * when it has a name or a note; a person picture without alt text is a 400.
 * The form reference itself is unchanged: the section never copies fields.
 *
 * Sabotage witnesses (grade-tests w92, 7 probes): keeping any layout or dropping
 * the card one, keeping a person on a non-card form, keeping a person with
 * neither name nor note, accepting a picture without alt, or dropping the lede
 * or the person's note reds a case. A string `person` is dropped by two guards
 * in `cleanFormPerson` (the object check and the no-name/no-note check), so
 * neither alone can red that leg.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { OpenwopError } from '../src/types.js';

const data = (d: Record<string, unknown>): Record<string, unknown> => validateSection({ type: 'form', data: { formId: 'form:dp', ...d } }).data;

describe('form card layout (ADR 1064)', () => {
  it('keeps the card layout, the lede and a labelled person', () => {
    expect(data({ layout: 'card', lede: 'We read every one.', person: { name: 'David', note: 'Read by a person, not a bot', imageToken: 'med_face', alt: 'David' } }))
      .toEqual({ formId: 'form:dp', lede: 'We read every one.', layout: 'card', person: { name: 'David', note: 'Read by a person, not a bot', imageToken: 'med_face', alt: 'David' } });
  });

  it('drops another layout, and a person off the card or with neither name nor note', () => {
    expect(data({ layout: 'grid' }).layout).toBeUndefined();
    expect(data({ person: { name: 'David' } }).person).toBeUndefined();
    expect(data({ layout: 'card', person: { imageToken: 'med_face', alt: 'x' } }).person).toBeUndefined();
    expect(data({ layout: 'card', person: 'David' }).person).toBeUndefined();
  });

  it('refuses a person picture without alt text', () => {
    const bad = (): unknown => data({ layout: 'card', person: { name: 'David', imageToken: 'med_face' } });
    expect(bad).toThrow(OpenwopError);
    expect(bad).toThrow(expect.objectContaining({ httpStatus: 400 }));
    expect(bad).toThrow(/^form\.person\.alt is required when form\.person\.imageToken is set\.$/);
  });
});
