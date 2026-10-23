/**
 * ADR 0914 (Book AI P9) — MarkdownEditor `lang`: the content language reaches
 * the textarea and the rendered preview, and NOT the toolbar (UI language).
 * Red under: dropping the prop, tagging the whole editor, or tagging the empty
 * "nothing to preview" message (UI text), or tagging the preview when no `lang` is
 * given. Sabotage-witnessed: w55g1-ml-* (round 1), w55g1-ml-*-r2 (round 2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownEditor } from '../MarkdownEditor.js';

afterEach(() => cleanup());

const mount = (props: { value: string; lang?: string }) =>
  render(createElement(MarkdownEditor, { value: props.value, onChange: () => {}, ...(props.lang ? { lang: props.lang } : {}) }));

const openPreview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

describe('MarkdownEditor lang (ADR 0914)', () => {
  it('tags the textarea with the content language', () => {
    const { container } = mount({ value: 'Bonjour', lang: 'fr' });
    expect(container.querySelector('textarea')?.getAttribute('lang')).toBe('fr');
  });

  it('tags the rendered preview, but not the toolbar or the editor root', () => {
    const { container } = mount({ value: 'Bonjour *monde*', lang: 'fr' });
    openPreview();
    const tagged = container.querySelector('.mdeditor-preview [lang="fr"]');
    expect(tagged?.textContent).toContain('Bonjour');
    expect(container.firstElementChild?.getAttribute('lang')).toBeNull();
    for (const b of container.querySelectorAll('button')) expect(b.closest('[lang="fr"]')).toBeNull();
  });

  it('without lang nothing is tagged (unchanged DOM)', () => {
    const { container } = mount({ value: 'Hello' });
    // Write mode: the textarea is mounted, untagged. (Queries stay inside the editor; the test document's <html lang> is outside.)
    expect(container.querySelector('textarea')).toBeTruthy();
    expect(container.querySelector('[lang]')).toBeNull();
    // Preview mode: the rendered text is there, and still nothing is tagged.
    openPreview();
    expect(container.querySelector('.mdeditor-preview')?.textContent).toContain('Hello');
    expect(container.querySelector('[lang]')).toBeNull();
  });

  it('does not tag the empty "nothing to preview" message (UI text, not content)', () => {
    const { container } = mount({ value: '', lang: 'fr' });
    expect(container.querySelector('textarea')?.getAttribute('lang')).toBe('fr');
    openPreview();
    const empty = screen.getByText('Nothing to preview yet.');
    expect(empty.closest('.mdeditor-preview')).toBeTruthy();
    // No tagged ancestor inside the editor (`closest` would reach the test document's <html lang>).
    expect(empty.hasAttribute('lang')).toBe(false);
    expect(container.querySelector('[lang]')).toBeNull();
  });
});
