/**
 * ADR 1100 D2 — an image inserted from the library carries the library's alt
 * text. Before, every insert used the file name, and the checker passed it.
 *
 * Red when: the description is ignored (case 1), a decorative asset gets a name
 * (case 2), or the file-name fallback is lost (case 3).
 */
import { describe, it, expect } from 'vitest';
import { insertedImageAlt } from '../imageAlt.js';

describe('insertedImageAlt', () => {
  it('uses the library description', () => {
    expect(insertedImageAlt({ name: 'IMG_2041.jpg', altText: ' A red bicycle ', altTextSource: 'ai' })).toBe('A red bicycle');
  });
  it('is empty for an asset marked decorative', () => {
    expect(insertedImageAlt({ name: 'divider.png', altText: '', altTextSource: 'decorative' })).toBe('');
  });
  it('falls back to the file name when the asset has no description', () => {
    expect(insertedImageAlt({ name: 'IMG_2041.jpg' })).toBe('IMG_2041.jpg');
  });
});
