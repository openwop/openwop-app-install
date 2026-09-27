/**
 * CS-G2 / CS-G3 (docs/steward/UX_UPGRADE-campaigns.md) — a REQUIRED enum localizes its
 * options the same way an optional one does.
 *
 * `PropertyForm`'s built-in `enum` branch resolves each option through
 * `opt_<name>_<value>`, and so does `QuickPropsCluster`. The custom
 * `enum-required` widget rendered the raw code — and could not do otherwise,
 * because `PropertyWidgetProps` never carried `tt` and the call site never
 * passed it. So on one panel an optional enum read "Notoriété" and a required
 * one read `awareness`, purely as an artefact of which widget drew it.
 *
 * campaign-studio had already authored all 13 `opt_*` keys in all four locales.
 * None of them had ever reached a screen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PropertyField } from '../PropertyForm.js';
import { RequiredEnumWidget } from '../widgets.js';
import type { CanvasPropDef } from '../types.js';

const STAGE: CanvasPropDef = {
  name: 'stage', type: 'enum-required', label: 'Stage',
  options: ['awareness', 'consideration', 'conversion'], required: true,
};
const OPTIONAL: CanvasPropDef = { name: 'stage', type: 'enum', label: 'Stage', options: ['awareness', 'consideration'] };

/** Stands in for a type namespace that HAS the keys (as campaign-studio does). */
const tt = (key: string, opts: { defaultValue: string }): string =>
  ({ opt_stage_awareness: 'Notoriété', opt_stage_consideration: 'Considération', prop_stage: 'Étape' }[key] ?? opts.defaultValue);

const view = (p: CanvasPropDef, withTt: boolean, onChange: (n: string, v: unknown) => void = () => {}) => render(
  <PropertyField
    def={p}
    value="awareness"
    frames={[]}
    docState={{}}
    orgId="org-1"
    widgets={{ 'enum-required': RequiredEnumWidget }}
    onChange={onChange}
    onChangeText={() => {}}
    {...(withTt ? { tt } : {})}
  />,
);

const optionTexts = (): string[] =>
  Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map((o) => o.textContent ?? '');

afterEach(cleanup);

describe('required-enum options are localized like optional ones', () => {
  it('renders the translated option labels for a REQUIRED enum', () => {
    view(STAGE, true);
    expect(optionTexts()).toEqual(['Notoriété', 'Considération', 'conversion']);
  });

  it('an option with no key still shows its code — never a blank row', () => {
    view(STAGE, true);
    // `conversion` has no key in this fixture. The fallback is the code, which is
    // what keeps a consumer that supplies NO keys (cad) unchanged.
    expect(optionTexts()).toContain('conversion');
  });

  it('with no translator at all, every option is its raw code', () => {
    view(STAGE, false);
    expect(optionTexts()).toEqual(['awareness', 'consideration', 'conversion']);
  });

  it('required and OPTIONAL enums now agree — the widget no longer decides', () => {
    view(OPTIONAL, true);
    const optional = optionTexts().filter((s) => s !== '—');
    cleanup();
    view(STAGE, true);
    const required = optionTexts();
    // The optional enum was always localized; the required one now matches it
    // for the values they share.
    expect(required.slice(0, optional.length)).toEqual(optional);
  });

  it('the field LABEL resolves through prop_<name> for both', () => {
    view(STAGE, true);
    expect(screen.getByText(/Étape/)).toBeTruthy();
  });

  it('reports the CODE, not the label — translation is presentation only', () => {
    const seen: unknown[] = [];
    view(STAGE, true, (_n, v) => seen.push(v));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    // Rendered French, selected by code.
    expect(select.value).toBe('awareness');
    fireEvent.change(select, { target: { value: 'consideration' } });
    // What travels to the document is the code — a localized label must never
    // become the stored value, or the same doc would mean different things in
    // different locales.
    expect(seen).toEqual(['consideration']);
  });
});

describe('campaign-studio supplies the keys the panel reads', () => {
  it('every prop def in the definition has a prop_<name> key in every locale', async () => {
    const [{ campaignStudioDefinition }, en, es, fr, ptBR] = await Promise.all([
      import('../../features/campaign-studio/definition.js'),
      import('../../features/campaign-studio/i18n/en.js'),
      import('../../features/campaign-studio/i18n/es.js'),
      import('../../features/campaign-studio/i18n/fr.js'),
      import('../../features/campaign-studio/i18n/pt-BR.js'),
    ]);
    const names = new Set<string>();
    for (const coll of campaignStudioDefinition.elements ?? []) {
      for (const p of coll.propDefs()) names.add(p.name);
    }
    for (const p of campaignStudioDefinition.docPropDefs ?? []) names.add(p.name);

    const catalogs: Record<string, Record<string, string>> = {
      en: en.messages as Record<string, string>,
      es: es.messages as Record<string, string>,
      fr: fr.messages as Record<string, string>,
      'pt-BR': ptBR.messages as Record<string, string>,
    };
    const missing: string[] = [];
    for (const [locale, cat] of Object.entries(catalogs)) {
      for (const n of names) if (!cat[`prop_${n}`]) missing.push(`${locale}:prop_${n}`);
    }
    // A half-translated panel reads as a bug rather than an untranslated
    // product — the mixed state is worse than either end.
    expect(missing).toEqual([]);
  });
});
