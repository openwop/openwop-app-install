/**
 * ADR 1100 D2 — the wiring: picking a library image in a CMS section's editor
 * fills the section's empty alt with the image's description, on the base layer
 * only.
 *
 * Red when: `SectionFields` stops wrapping `onChange` (case 1), or fills a locale
 * overlay with the base-language text (case 2).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { SectionFields } from '../SectionsEditor.js';
import type { MediaAssetRef, Section } from '../cmsClient.js';

const assets: MediaAssetRef[] = [
  { assetId: 'a1', name: 'bike.png', serveUrl: '/s/t1', serveToken: 't1', altText: 'A red bicycle against a brick wall', altTextSource: 'ai' },
];
const section: Section = { sectionId: 's1', type: 'image', data: { token: '', alt: '' } };

afterEach(cleanup);

/** The media-token picker: the select that offers the library's tokens. */
const tokenSelect = (c: HTMLElement): HTMLSelectElement => {
  const sel = [...c.querySelectorAll('select')].find((x) => x.querySelector('option[value="t1"]'));
  if (!sel) throw new Error('no media-token select rendered — the test would be vacuous');
  return sel;
};

describe('SectionFields — alt from the library', () => {
  it('picking an image fills the empty alt', () => {
    const onChange = vi.fn();
    const { container } = render(<SectionFields section={section} assets={assets} onChange={onChange} />);
    fireEvent.change(tokenSelect(container), { target: { value: 't1' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ token: 't1', alt: 'A red bicycle against a brick wall' }));
  });

  it('a locale overlay is not filled with the base-language description', () => {
    const onChange = vi.fn();
    const { container } = render(<SectionFields section={section} assets={assets} onChange={onChange} baseData={{ token: 't0', alt: 'Base' }} />);
    fireEvent.change(tokenSelect(container), { target: { value: 't1' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ token: 't1', alt: '' }));
  });

  // The Browse button awaits the picker, then calls the onChange it captured
  // BEFORE the pick, so the alt must come from the host's lookup at CALL time
  // (CmsPage keeps it current through a ref the pick updates). Red when the
  // wrapper resolves alts from the render-time `assets` instead: the freshly
  // uploaded asset is not in them and nothing fills. CmsPage's ref itself is
  // not covered here.
  it('a Browse pick of an asset the editor had not loaded still fills, through the host lookup', async () => {
    const onChange = vi.fn();
    const known = new Map<string, string>();
    let resolvePick: (t: string | null) => void = () => {};
    const onPickMedia = () => new Promise<string | null>((r) => { resolvePick = r; });
    const { getByRole } = render(<SectionFields section={section} assets={assets} onChange={onChange} onPickMedia={onPickMedia} libraryAlt={(tok) => known.get(tok)} />);
    fireEvent.click(getByRole('button', { name: /Browse/i }));
    known.set('t-new', 'A freshly uploaded chart'); // the host learns the asset during the pick
    await act(async () => { resolvePick('t-new'); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ token: 't-new', alt: 'A freshly uploaded chart' }));
  });

  it('a fill is shown on screen, not only announced', () => {
    const { container } = render(<SectionFields section={section} assets={assets} onChange={vi.fn()} />);
    fireEvent.change(tokenSelect(container), { target: { value: 't1' } });
    expect(container.querySelector('[data-alt-fill-note]')?.textContent).toMatch(/media library/);
  });
});
