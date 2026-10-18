/**
 * ADR 0914 (Book AI P9) — MarkdownEditor `lang`: the content language reaches
 * the textarea and the rendered preview, and NOT the toolbar (UI language).
 * Red under: dropping the prop, tagging the whole editor, or tagging the empty
 * "nothing to preview" message (UI text).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MarkdownEditor } from '../MarkdownEditor.js';

afterEach(() => cleanup());

const mount = (props: { value: string; lang?: string }) =>
  render(createElement(MarkdownEditor, { value: props.value, onChange: () => {}, ...(props.lang ? { lang: props.lang } : {}) }));

describe('MarkdownEditor lang (ADR 0914)', () => {
  it('tags the textarea with the content language', () => {
    const { container } = mount({ value: 'Bonjour', lang: 'fr' });
    expect(container.querySelector('textarea')?.getAttribute('lang')).toBe('fr');
  });

  it('tags the rendered preview, but not the toolbar or the editor root', () => {
    const { container } = mount({ value: 'Bonjour *monde*', lang: 'fr' });
    const previewTab = [...container.querySelectorAll('button, [role="tab"]')].find((b) => /preview/i.test(b.textContent ?? ''));
    expect(previewTab, 'the Preview toggle exists').toBeTruthy();
    fireEvent.click(previewTab!);
    const tagged = container.querySelector('.mdeditor-preview [lang="fr"]');
    expect(tagged?.textContent).toContain('Bonjour');
    expect(container.firstElementChild?.getAttribute('lang')).toBeNull();
    for (const b of container.querySelectorAll('button')) expect(b.closest('[lang="fr"]')).toBeNull();
  });

  it('without lang nothing is tagged (unchanged DOM)', () => {
    const { container } = mount({ value: 'Hello' });
    expect(container.querySelector('[lang]')).toBeNull(); // inside the editor only (the test document's <html lang> is outside)
  });
});
