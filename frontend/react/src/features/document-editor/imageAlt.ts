/**
 * ADR 1100 D2 — the alt text a library image gets when it is inserted into a
 * document: the library's description when it has one, empty for an asset
 * marked decorative, else the file name (the behaviour before ADR 1100, kept so
 * existing inserts do not turn into new checker errors; OQ-2).
 */
import type { MediaAsset } from '../media/mediaClient.js';

export function insertedImageAlt(asset: Pick<MediaAsset, 'name' | 'altText' | 'altTextSource'>): string {
  if (asset.altTextSource === 'decorative') return '';
  return asset.altText?.trim() || asset.name;
}
