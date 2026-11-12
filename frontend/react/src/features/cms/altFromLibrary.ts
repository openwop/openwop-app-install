/**
 * ADR 1100 D2 — a picture placed in a CMS section takes the media library's alt
 * text when the section has none. Before this, the AI or hand-written
 * description saved on the asset (ADR 0363 P1) reached no page: the picker set
 * only the token, and every renderer reads the SECTION's `alt`.
 *
 * The rule is "fill an empty alt, never overwrite an author's":
 *  - only a token that appears NOWHERE in the previous data counts as newly
 *    placed, so reordering or inserting list items never fills an alt an author
 *    left empty on purpose (identity, not array index);
 *  - an alt the author wrote is left alone. The one alt that is replaced is a
 *    library description carried over from the picture that was swapped out: it
 *    describes the old picture, and a wrong alt is worse than an empty one;
 *  - a decorative or undescribed asset has no description, so it fills nothing
 *    (CMS has no decorative flag; the checker reports the empty alt).
 *
 * The caller runs it on the BASE layer only (an overlay must not get the
 * base-language description) and never on `fields` (the open protocol body).
 * Pure.
 */

import { CMS_A11Y_MAX_DEPTH, CMS_IMAGE_TOKEN_KEYS } from './cmsA11y.js';
import type { MediaAssetRef } from './cmsClient.js';

/** token → the library's description, or undefined when it has none. */
export type LibraryAlt = (token: string) => string | undefined;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The library's description of one asset, or undefined (none, or decorative). */
export function libraryAltOf(assets: readonly MediaAssetRef[], token: string): string | undefined {
  const a = assets.find((x) => x.serveToken === token);
  const alt = (a?.altText ?? '').trim();
  return a && alt && a.altTextSource !== 'decorative' ? alt : undefined;
}

function tokenOf(o: Record<string, unknown>): string | undefined {
  return CMS_IMAGE_TOKEN_KEYS.map((k) => o[k]).find((t): t is string => typeof t === 'string' && t !== '');
}

function tokensIn(value: unknown, out: Set<string>, depth: number): void {
  if (depth > CMS_A11Y_MAX_DEPTH + 1) return;
  if (Array.isArray(value)) { value.forEach((v) => tokensIn(v, out, depth + 1)); return; }
  if (!isRecord(value)) return;
  const t = tokenOf(value);
  if (t) out.add(t);
  Object.values(value).forEach((v) => tokensIn(v, out, depth + 1));
}

function fill(value: unknown, before: ReadonlySet<string>, carried: ReadonlySet<string>, libraryAlt: LibraryAlt, depth: number): unknown {
  if (depth > CMS_A11Y_MAX_DEPTH + 1) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => { const f = fill(v, before, carried, libraryAlt, depth + 1); if (f !== v) changed = true; return f; });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;
  let out: Record<string, unknown> = value;
  for (const [k, v] of Object.entries(value)) {
    const f = fill(v, before, carried, libraryAlt, depth + 1);
    if (f !== v) { if (out === value) out = { ...value }; out[k] = f; }
  }
  const token = tokenOf(value);
  if (!token || before.has(token)) return out;
  const alt = typeof value.alt === 'string' ? value.alt.trim() : '';
  if (alt && !carried.has(alt)) return out; // the author's own words
  const next = libraryAlt(token) ?? '';
  if (next === (typeof value.alt === 'string' ? value.alt : '')) return out;
  if (out === value) out = { ...value };
  out.alt = next;
  return out;
}

/** `next` with every newly placed picture's alt filled from the library (see the
 *  module rule). Returns `next` itself when nothing changed. */
export function fillAltFromLibrary(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  libraryAlt: LibraryAlt,
): Record<string, unknown> {
  const before = new Set<string>();
  tokensIn(prev, before, 0);
  // The library descriptions of the pictures already placed: an alt equal to one
  // of them on a NEW picture was carried over from a swap, not written.
  const carried = new Set<string>();
  for (const t of before) { const a = libraryAlt(t); if (a) carried.add(a); }
  return fill(next, before, carried, libraryAlt, 0) as Record<string, unknown>;
}

/** How many non-empty `alt`s `value` carries (to tell a fill from a clear). */
export function altCount(value: unknown, depth = 0): number {
  if (depth > CMS_A11Y_MAX_DEPTH + 1) return 0;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + altCount(v, depth + 1), 0);
  if (!isRecord(value)) return 0;
  const own = typeof value.alt === 'string' && value.alt.trim() ? 1 : 0;
  return Object.values(value).reduce<number>((n, v) => n + altCount(v, depth + 1), own);
}
