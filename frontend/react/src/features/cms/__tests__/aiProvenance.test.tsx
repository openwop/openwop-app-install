/**
 * ADR 0592 §3 (CMSLU-4) — the editor renders AI-draft provenance and the
 * HUMAN-edit path clears it: a machine-drafted overlay shows the §5.3
 * `chip--ai` provenance chip (+ the tab's accessible-name arm), applying a
 * translation stamps the overlay, and typing into a stamped overlay clears
 * the stamp in the very onChange payload that carries the edit.
 *
 * Sabotage-witnessed (/grade-tests w17): hiding the chip or the tab's AI arm
 * reds case 1; showing either for an unstamped overlay reds case 2; applying a
 * translation without `origin: 'ai'` reds case 3; keeping the stamp on a human
 * write reds case 4.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SectionsEditor } from '../SectionsEditor.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

const baseSection = (over: Partial<Section> = {}): Section => ({
  sectionId: 'sec:1',
  type: 'hero',
  data: { heading: 'Hi' },
  localizations: { es: { heading: 'Hola' } },
  ...over,
});

function renderEditor(sections: Section[], onChange: (s: Section[]) => void, onTranslate?: () => Promise<Record<string, unknown> | null>) {
  return render(
    <SectionsEditor
      sections={sections}
      assets={[]}
      baseLocale="en"
      locales={['en', 'es']}
      onChange={onChange}
      {...(onTranslate ? { onTranslate } : {})}
    />,
  );
}

describe('AI-draft provenance in the sections editor', () => {
  it('a stamped overlay renders the chip + the AI accessible-name arm on its tab', async () => {
    const s = baseSection({ aiDrafted: { es: '2026-08-20T00:00:00.000Z' } });
    renderEditor([s], () => undefined);
    // Switch to the es tab (stamped).
    fireEvent.click(screen.getByRole('tab', { name: /AI-drafted/i }));
    await waitFor(() => expect(screen.getByText('AI draft')).toBeTruthy());
  });

  it('an UNstamped overlay renders no AI chip (absence makes no claim)', async () => {
    renderEditor([baseSection()], () => undefined);
    fireEvent.click(screen.getByRole('tab', { name: /español.*translated/i }));
    expect(screen.queryByText('AI draft')).toBeNull();
    expect(screen.queryByRole('tab', { name: /AI-drafted/i })).toBeNull();
  });

  it('applying a translation stamps the overlay in the onChange payload', async () => {
    const changes: Section[][] = [];
    renderEditor([baseSection()], (s) => changes.push(s), async () => ({ heading: 'Hola nueva' }));
    fireEvent.click(screen.getByRole('tab', { name: /español/i }));
    fireEvent.click(screen.getByRole('button', { name: /translate from base/i }));
    await waitFor(() => expect(changes.length).toBe(1));
    const next = changes[0]?.[0];
    expect(next?.localizations?.es?.heading).toBe('Hola nueva');
    // The stamp is an ISO instant (its value is the wall clock, so assert its shape).
    expect(Number.isNaN(Date.parse(next?.aiDrafted?.es ?? ''))).toBe(false);
  });

  it('a human edit of a stamped overlay CLEARS the stamp in the same payload', async () => {
    const changes: Section[][] = [];
    const s = baseSection({ aiDrafted: { es: '2026-08-20T00:00:00.000Z' } });
    renderEditor([s], (next) => changes.push(next));
    fireEvent.click(screen.getByRole('tab', { name: /AI-drafted/i }));
    // Type into the overlay's heading field — the base field holds 'Hi', so the
    // only input showing 'Hola' is the es overlay.
    const inputs = screen.getAllByDisplayValue('Hola');
    fireEvent.change(inputs[0]!, { target: { value: 'Hola revisada' } });
    await waitFor(() => expect(changes.length).toBe(1));
    const next = changes[0]?.[0];
    expect(next?.localizations?.es?.heading).toBe('Hola revisada');
    expect(next?.aiDrafted).toBeUndefined();
  });
});
