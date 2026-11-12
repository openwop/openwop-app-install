/**
 * ADR 1100 D2 — a picture placed in a CMS section takes the library's alt text
 * when its own is empty, and never overwrites an author's.
 *
 * Red when: the fill stops (case 1); an authored alt is overwritten (case 2); a
 * reorder fills an alt left empty on purpose, i.e. comparison by index (case 3);
 * a decorative or undescribed asset fills (case 4); nested list items are missed
 * (case 5); swapping a picture keeps the old picture's library description
 * (case 6).
 */
import { describe, it, expect } from 'vitest';
import { altCount, fillAltFromLibrary, libraryAltOf } from '../altFromLibrary.js';
import type { MediaAssetRef } from '../cmsClient.js';

const asset = (serveToken: string, over: Partial<MediaAssetRef> = {}): MediaAssetRef => ({ assetId: `a-${serveToken}`, name: `${serveToken}.png`, serveUrl: `/s/${serveToken}`, serveToken, ...over });
const assets = [
  asset('t1', { altText: 'A red bicycle against a brick wall', altTextSource: 'ai' }),
  asset('t2', { altText: 'Team photo', altTextSource: 'human' }),
  asset('t3', { altText: '', altTextSource: 'decorative' }),
  asset('t4'),
];
const lib = (token: string): string | undefined => libraryAltOf(assets, token);

describe('fillAltFromLibrary', () => {
  it('fills an empty alt when a picture is newly placed', () => {
    expect(fillAltFromLibrary({ token: '' }, { token: 't1', alt: '' }, lib)).toEqual({ token: 't1', alt: 'A red bicycle against a brick wall' });
    expect(fillAltFromLibrary({}, { imageToken: 't2' }, lib)).toEqual({ imageToken: 't2', alt: 'Team photo' });
  });

  it('never overwrites an alt the author wrote', () => {
    expect(fillAltFromLibrary({ token: 't2' }, { token: 't1', alt: 'Our new model' }, lib)).toEqual({ token: 't1', alt: 'Our new model' });
  });

  it('a reorder does not fill an alt left empty on purpose', () => {
    const prev = { columns: [{ imageToken: 't1', alt: 'Bike' }, { imageToken: 't2', alt: '' }] };
    const next = { columns: [prev.columns[1], prev.columns[0]] };
    expect(fillAltFromLibrary(prev, next, lib)).toBe(next);
  });

  it('a decorative or undescribed asset fills nothing', () => {
    const next = { token: 't3', alt: '' };
    expect(fillAltFromLibrary({}, next, lib)).toBe(next);
    const next2 = { token: 't4' };
    expect(fillAltFromLibrary({}, next2, lib)).toBe(next2);
  });

  it('fills a nested list item and leaves its siblings untouched', () => {
    const prev = { columns: [{ title: 'A', imageToken: 't2', alt: 'Team photo' }] };
    const next = { columns: [prev.columns[0], { title: 'B', imageToken: 't1', alt: '' }] };
    const out = fillAltFromLibrary(prev, next, lib) as { columns: Array<Record<string, unknown>> };
    expect(out.columns[0]).toBe(prev.columns[0]);
    expect(out.columns[1]).toEqual({ title: 'B', imageToken: 't1', alt: 'A red bicycle against a brick wall' });
  });

  it('swapping a picture replaces the old picture\'s library description, never an author\'s', () => {
    const prev = { token: 't1', alt: 'A red bicycle against a brick wall' };
    expect(fillAltFromLibrary(prev, { ...prev, token: 't2' }, lib)).toEqual({ token: 't2', alt: 'Team photo' });
    // The new picture has no description: the carried-over one is cleared, not kept.
    expect(fillAltFromLibrary(prev, { ...prev, token: 't4' }, lib)).toEqual({ token: 't4', alt: '' });
    // The author edited it: theirs stays.
    expect(fillAltFromLibrary({ token: 't1', alt: 'Our bike' }, { token: 't2', alt: 'Our bike' }, lib)).toEqual({ token: 't2', alt: 'Our bike' });
  });

  it('altCount counts non-empty alts at any depth (tells a fill from a removal)', () => {
    expect(altCount({ alt: 'a', columns: [{ alt: '' }, { alt: 'b' }, { alt: '  ' }] })).toBe(2);
    expect(altCount({})).toBe(0);
  });
});
