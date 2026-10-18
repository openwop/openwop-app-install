/**
 * ADR 0861 D6 — translation status in the sections editor: an OUTDATED overlay
 * (the base text it translates changed after it was written) is said in words on
 * its tab's accessible name and as a chip, and "Mark up to date" re-stamps it.
 * A current overlay makes no such claim, and absent status renders nothing.
 *
 * Sabotage-witnessed (w17): the outdated arm of the tab's aria-label; the chip;
 * `onConfirmSource(s.sectionId, active)` args; `disabled={confirming === …}`;
 * the confirm button's `=== 'outdated'` gate; the chip gate read as `!== 'current'`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SectionsEditor } from '../SectionsEditor.js';
import type { Section, TranslationStatus } from '../cmsClient.js';

afterEach(cleanup);

const section: Section = { sectionId: 'sec:1', type: 'hero', data: { heading: 'Hi again' }, localizations: { es: { heading: 'Hola' } } };

function renderEditor(status: Record<string, Record<string, TranslationStatus>> | undefined, onConfirmSource?: (sid: string, l: string) => Promise<boolean>) {
  return render(
    <SectionsEditor
      sections={[section]}
      assets={[]}
      baseLocale="en"
      locales={['en', 'es']}
      onChange={() => undefined}
      translationStatus={status}
      onConfirmSource={onConfirmSource}
    />,
  );
}

describe('translation status in the sections editor', () => {
  it('an outdated overlay: the tab says so, the chip shows, and Mark up to date confirms it', () => {
    const confirm = vi.fn(async () => true);
    renderEditor({ 'sec:1': { es: 'outdated' } }, confirm);
    fireEvent.click(screen.getByRole('tab', { name: /outdated/i }));
    expect(screen.getByText('Outdated')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /mark the .* translation of this section up to date/i }));
    expect(confirm).toHaveBeenCalledWith('sec:1', 'es');
    // CMSL2UX-3 — in flight: disabled + "Marking…", so a double click is one write.
    const pending = screen.getByRole('button', { name: /mark the .* translation/i });
    expect(pending.hasAttribute('disabled')).toBe(true);
    expect(pending.textContent).toBe('Marking…');
  });

  it('a current overlay makes no outdated claim and offers no confirm', () => {
    renderEditor({ 'sec:1': { es: 'current' } }, vi.fn(async () => true));
    fireEvent.click(screen.getByRole('tab', { name: /español/i }));
    expect(screen.queryByText('Outdated')).toBeNull();
    expect(screen.queryByText('Not confirmed')).toBeNull();
    expect(screen.queryByRole('button', { name: /up to date/i })).toBeNull();
  });

  it('an unknown overlay (a Copy from base, or legacy) says "Not confirmed" and offers Mark up to date', () => {
    const confirm = vi.fn(async () => true);
    renderEditor({ 'sec:1': { es: 'unknown' } }, confirm);
    fireEvent.click(screen.getByRole('tab', { name: /español/i }));
    expect(screen.getByText('Not confirmed')).toBeTruthy();
    expect(screen.queryByText('Outdated')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mark the .* translation of this section up to date/i }));
    expect(confirm).toHaveBeenCalledWith('sec:1', 'es');
  });

  it('no status (a read that failed, or no locales) renders nothing extra', () => {
    renderEditor(undefined);
    fireEvent.click(screen.getByRole('tab', { name: /español/i }));
    expect(screen.queryByText('Outdated')).toBeNull();
  });
});
