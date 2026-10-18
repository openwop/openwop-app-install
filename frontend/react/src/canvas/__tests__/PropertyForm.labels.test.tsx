/**
 * ADR 0340 — the catalog-label key contract: PropertyField resolves
 * `prop_<name>` / `opt_<name>_<value>` through the TYPE-namespace translator
 * with the CODE LABEL as fallback (a missing key can never blank a control),
 * and stays byte-identical to the legacy render when no translator is given.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { PropertyField } from '../PropertyForm.js';
import type { CanvasPropDef } from '../types.js';

afterEach(cleanup);

const CATALOG: Record<string, string> = {
  prop_tone: 'Ton',
  opt_tone_muted: 'Atténué',
};
const tt = (key: string, opts: { defaultValue: string }): string => CATALOG[key] ?? opts.defaultValue;

// The code label differs from the prop NAME on purpose (w46g2-pfl-legacy-label):
// with label === name, a render of `p.name` instead of `p.label` was invisible.
const DEF: CanvasPropDef = { name: 'tone', type: 'enum', label: 'Tone colour', options: ['default', 'muted'] };

describe('ADR 0340 — PropertyField label keys', () => {
  it('resolves prop_/opt_ keys through the type translator, falling back to code labels', () => {
    render(<PropertyField def={DEF} value="muted" frames={[]} docState={{}} orgId="o" onChange={() => {}} onChangeText={() => {}} tt={tt} />);
    expect(screen.getByText('Ton')).toBeTruthy();                        // prop_tone hit
    expect(screen.getByRole('option', { name: 'Atténué' })).toBeTruthy(); // opt_tone_muted hit
    expect(screen.getByRole('option', { name: 'default' })).toBeTruthy(); // no key → raw value fallback
  });

  it('renders the legacy English labels when no translator is supplied', () => {
    render(<PropertyField def={DEF} value="muted" frames={[]} docState={{}} orgId="o" onChange={() => {}} onChangeText={() => {}} />);
    expect(screen.getByText('Tone colour')).toBeTruthy();
    expect(screen.queryByText('tone')).toBeNull();
    expect(screen.getByRole('option', { name: 'muted' })).toBeTruthy();
  });
});
