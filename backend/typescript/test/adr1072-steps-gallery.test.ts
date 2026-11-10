/**
 * ADR 1072 — server half of step cards and the lead gallery: presentation keys
 * held to their layouts.
 *
 *   - `cards: true` is kept on a `steps` section only;
 *   - `galleryLayout` is the closed set {lead}, kept on a `gallery` only;
 *   - a step's `highlight` survives (it was already kept on every layout).
 *
 * Sabotage witnesses (w96 probes): keeping `cards` on another layout or for a
 * non-boolean, dropping it, dropping a step's highlight, widening the gallery
 * set, keeping it off a gallery, or dropping it on one reds a case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const cols = (layout: string, extra: Record<string, unknown>, columns: Record<string, unknown>[] = [{ title: 'A', text: 'a', imageToken: 'tok-1', alt: 'A' }]) =>
  validateSection({ type: 'columns', data: { layout, columns, ...extra } }).data;

describe('step cards and the lead gallery (ADR 1072)', () => {
  it('keeps cards on steps only, and only when true', () => {
    expect(cols('steps', { cards: true }).cards).toBe(true);
    expect('cards' in cols('steps', { cards: 'yes' })).toBe(false);
    expect('cards' in cols('cards', { cards: true })).toBe(false);
    expect(cols('steps', { cards: true }, [{ title: 'A', text: 'a', highlight: true }]).columns).toEqual([expect.objectContaining({ highlight: true })]);
  });

  it('keeps the lead gallery on galleries only, and nothing outside its set', () => {
    expect(cols('gallery', { galleryLayout: 'lead' }).galleryLayout).toBe('lead');
    expect('galleryLayout' in cols('gallery', { galleryLayout: 'masonry' })).toBe(false);
    expect('galleryLayout' in cols('cards', { galleryLayout: 'lead' })).toBe(false);
  });
});
