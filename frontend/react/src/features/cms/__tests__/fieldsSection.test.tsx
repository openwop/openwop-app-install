/**
 * ADR 0748 — the `fields` section (the RFC 0103 content API's open body) and the
 * content-locale grammar the language settings validate with.
 *
 * Pinned: the public render is a definition list of TEXT (markup in a value is
 * shown, never parsed; a field named `heading` is not promoted to a heading);
 * the editor keeps an invalid or clashing name on screen with its error but never
 * saves it; on a locale overlay the names are the base's and an empty value
 * inherits the base (it is not written); the frontend grammar is byte-identical
 * to the vendored schema pattern and repairs case and `_`.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';
import { CONTENT_LOCALE_RE, canonicalContentLocale } from '../contentLocale.js';
import { FIELD_NAME_RE, FIELDS_MAX_KEYS } from '../fieldsSection.js';

afterEach(cleanup);

describe('fields section — public render', () => {
  it('renders a definition list of text, never markup, never a heading', () => {
    const { container } = render(<MemoryRouter><RenderSection mode="public" section={{ sectionId: 's', type: 'fields', data: { heading: '<b>Hi</b>', seats: 3, empty: '' } }} /></MemoryRouter>);
    const dts = [...container.querySelectorAll('dt')].map((e) => e.textContent);
    expect(dts).toEqual(['heading', 'seats']); // the empty field is omitted
    expect(screen.getByText('<b>Hi</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('fields section — editor', () => {
  it('base layer: an invalid name shows its error and is not saved', () => {
    const onChange = vi.fn();
    render(<SectionFields assets={[]} onChange={onChange} section={{ sectionId: 's', type: 'fields', data: { title: 'A' } }} />);
    const name = screen.getByLabelText(/1/, { selector: 'input' });
    fireEvent.change(name, { target: { value: 'bad name' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).toHaveBeenLastCalledWith({});
    fireEvent.change(name, { target: { value: 'subtitle' } });
    expect(onChange).toHaveBeenLastCalledWith({ subtitle: 'A' });
  });

  it('overlay layer: base names are read-only and an empty value inherits the base', () => {
    const onChange = vi.fn();
    render(<SectionFields assets={[]} onChange={onChange} baseData={{ heading: 'Base', cta: 'Go' }} section={{ sectionId: 's', type: 'fields', data: { heading: 'Hola' } }} />);
    const names = screen.getAllByRole('textbox').filter((e) => e.tagName === 'INPUT');
    expect(names.map((e) => (e as HTMLInputElement).value)).toEqual(['heading', 'cta']);
    expect(names.every((e) => (e as HTMLInputElement).readOnly)).toBe(true);
    const values = screen.getAllByRole('textbox').filter((e) => e.tagName === 'TEXTAREA') as HTMLTextAreaElement[];
    expect(values[1]!.placeholder).toBe('Go');
    fireEvent.change(values[1]!, { target: { value: 'Ir' } });
    expect(onChange).toHaveBeenLastCalledWith({ heading: 'Hola', cta: 'Ir' });
    fireEvent.change(values[0]!, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ cta: 'Ir' });
  });
});

describe('fields section — editor focus + names (end grade-ux)', () => {
  it('each Remove is named by its row; Add focuses the new name; Remove returns focus to Add', () => {
    render(<SectionFields assets={[]} onChange={vi.fn()} section={{ sectionId: 's', type: 'fields', data: { a: '1', b: '2' } }} />);
    expect(screen.getByRole('button', { name: 'Remove field 2' })).toBeTruthy();
    const add = screen.getByRole('button', { name: /Add field/ });
    fireEvent.click(add);
    expect(document.activeElement).toBe(screen.getByLabelText('Field 3 name'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove field 1' }));
    expect(document.activeElement).toBe(add);
    // Stable row keys: the surviving row keeps its own value in place.
    expect((screen.getByLabelText('Field 1 name') as HTMLInputElement).value).toBe('b');
  });
});

describe('fields section — editor follows external layer changes', () => {
  it('re-seeds when the layer changes without a keystroke (Copy from base / Clear overlay)', () => {
    const base = { heading: 'Base', cta: 'Go' };
    const { rerender } = render(<SectionFields assets={[]} onChange={() => undefined} baseData={base} section={{ sectionId: 's', type: 'fields', data: {} }} />);
    const values = () => (screen.getAllByRole('textbox').filter((e) => e.tagName === 'TEXTAREA') as HTMLTextAreaElement[]).map((e) => e.value);
    expect(values()).toEqual(['', '']);
    rerender(<SectionFields assets={[]} onChange={() => undefined} baseData={base} section={{ sectionId: 's', type: 'fields', data: { ...base } }} />);
    expect(values()).toEqual(['Base', 'Go']);
  });
});

describe('fields section — editor rows (ADR 0755, WIT-CNT-12)', () => {
  it('removing a row keeps every other row\'s error bound to its own input', () => {
    render(<SectionFields assets={[]} onChange={() => undefined} section={{ sectionId: 's', type: 'fields', data: { a: '1', b: '2', c: '3' } }} />);
    const names = () => screen.getAllByRole('textbox').filter((e) => e.tagName === 'INPUT') as HTMLInputElement[];
    fireEvent.change(names()[2]!, { target: { value: 'bad name' } });
    const errIdBefore = names()[2]!.getAttribute('aria-describedby');
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    expect(names().map((e) => e.value)).toEqual(['b', 'bad name']);
    // the invalid row kept ITS error id — keyed by index it would inherit row 2's
    expect(names()[1]!.getAttribute('aria-describedby')).toBe(errIdBefore);
    expect(document.getElementById(errIdBefore!)).toBeTruthy();
  });

  it('stops offering "Add field" at the server cap', () => {
    const data = Object.fromEntries(Array.from({ length: FIELDS_MAX_KEYS }, (_, i) => [`f${i}`, 'v']));
    render(<SectionFields assets={[]} onChange={() => undefined} section={{ sectionId: 's', type: 'fields', data }} />);
    expect(screen.queryByRole('button', { name: /add field/i })).toBeNull();
  });

  it('mirrors the backend grammar and cap byte-for-byte', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', '..', '..', '..', '..', 'backend', 'typescript', 'src', 'features', 'cms', 'cmsService.ts'), 'utf8');
    expect(src).toContain(`export const FIELDS_KEY_RE = ${FIELD_NAME_RE.toString()};`);
    expect(src).toMatch(new RegExp(`fieldKeys: ${FIELDS_MAX_KEYS},`));
  });
});

describe('content-locale grammar (RFC 0206)', () => {
  it('is byte-identical to the vendored schema pattern', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', '..', '..', 'schemas', 'v2', 'localized-content-section.schema.json'), 'utf8')) as { properties: { localizations: { propertyNames: { pattern: string } } } };
    expect(CONTENT_LOCALE_RE.source).toBe(schema.properties.localizations.propertyNames.pattern);
  });
  it('accepts the extended tags and repairs case and underscores', () => {
    for (const tag of ['es', 'pt-BR', 'fil', 'zh-Hant', 'zh-Hant-TW', 'es-419']) expect(canonicalContentLocale(tag)).toBe(tag);
    expect(canonicalContentLocale('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalContentLocale('pt_br')).toBe('pt-BR');
    expect(canonicalContentLocale(' EN ')).toBe('en');
  });
  it('refuses what the grammar cannot hold', () => {
    for (const tag of ['de-CH-1996', 'zh-yue', 'x', 'not a tag', '']) expect(canonicalContentLocale(tag)).toBeNull();
  });
});

describe('section fields register (RFCW-UX-10)', () => {
  it('wraps the editor in .cms-section-fields, so prose textareas take the public page\'s sans', () => {
    const { container } = render(<SectionFields assets={[]} onChange={vi.fn()} section={{ sectionId: 's', type: 'fields', data: { a: '1' } }} />);
    expect(container.firstElementChild?.className).toBe('cms-section-fields');
    expect(container.querySelector('.cms-section-fields textarea')).toBeTruthy();
  });
});
