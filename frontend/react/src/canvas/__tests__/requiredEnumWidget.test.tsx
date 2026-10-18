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
 *
 * w46 cuts (each covering case went red under the same sabotage): "an option with
 * no key still shows its code" (case 1's exact toEqual includes `conversion`;
 * w46g2-rew-fallback), "required and OPTIONAL enums now agree" (case 1 for the
 * widget, w46g2-rew-opt; PropertyForm.labels case 1 for the built-in enum,
 * w46g2-pfl-optkey), and "the field LABEL resolves through prop_<name>"
 * (propLabelKey "falls back to the derived key", w46g2-plk-derived).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PropertyField } from '../PropertyForm.js';
import { RequiredEnumWidget } from '../widgets.js';
import type { CanvasPropDef } from '../types.js';
import { campaignStudioDefinition } from '../../features/campaign-studio/definition.js';
import { messages as csEn } from '../../features/campaign-studio/i18n/en.js';
import { messages as csEs } from '../../features/campaign-studio/i18n/es.js';
import { messages as csFr } from '../../features/campaign-studio/i18n/fr.js';
import { messages as csPtBR } from '../../features/campaign-studio/i18n/pt-BR.js';

const STAGE: CanvasPropDef = {
  name: 'stage', type: 'enum-required', label: 'Stage',
  options: ['awareness', 'consideration', 'conversion'], required: true,
};

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

  it('with no translator at all, every option is its raw code', () => {
    view(STAGE, false);
    expect(optionTexts()).toEqual(['awareness', 'consideration', 'conversion']);
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
  it('every prop def has a prop_<name> key, and every enum option an opt_<name>_<value> key, in every locale', () => {
    const catalogs: Record<string, Readonly<Record<string, string>>> = { en: csEn, es: csEs, fr: csFr, 'pt-BR': csPtBR };
    const keys = new Set<string>();
    const defs = [
      ...(campaignStudioDefinition.elements ?? []).flatMap((coll) => coll.propDefs({})),
      ...(campaignStudioDefinition.docPropDefs ?? []),
    ];
    for (const p of defs) {
      keys.add(`prop_${p.name}`);
      // The panel reads opt_<name>_<value> for both enum branches (built-in
      // `enum` and the `enum-required` widget) — the 13 keys this file's header
      // says were authored and never reached a screen.
      if (p.type === 'enum' || p.type === 'enum-required') for (const o of p.options ?? []) keys.add(`opt_${p.name}_${o}`);
    }
    // Non-vacuity floor: the definition really has enums with options to check.
    expect([...keys].filter((k) => k.startsWith('opt_')).length).toBeGreaterThanOrEqual(13);
    const missing: string[] = [];
    for (const [locale, cat] of Object.entries(catalogs)) {
      for (const k of keys) if (!cat[k]) missing.push(`${locale}:${k}`);
    }
    // A half-translated panel reads as a bug rather than an untranslated
    // product — the mixed state is worse than either end.
    expect(missing).toEqual([]);
  });
});
