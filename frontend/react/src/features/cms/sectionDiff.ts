/**
 * Field-level, client-side diff between two section lists (ADR 0206 B1 — the
 * version-history compare). Pure + dependency-free: sections pair by
 * `sectionId`; fields compare across the union of base-`data` keys plus
 * per-locale overlay keys (rendered as `locale · field`). No backend diff
 * endpoint — the editor already holds both trees.
 */

import type { Section } from './cmsClient.js';

export interface FieldChange {
  /** `heading`, or `pt-BR · heading` for an overlay field. */
  key: string;
  from: string;
  to: string;
}

export interface SectionDiffEntry {
  sectionId: string;
  type: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  fields: FieldChange[];
  /** The `to` section this entry is paired with, when it differs from
   *  `sectionId` (sections paired by position, not id). */
  toSectionId?: string;
}

const show = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

function diffBags(prefix: string, from: Record<string, unknown> | undefined, to: Record<string, unknown> | undefined): FieldChange[] {
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  const out: FieldChange[] = [];
  for (const key of [...keys].sort()) {
    const a = show(from?.[key]);
    const b = show(to?.[key]);
    if (a !== b) out.push({ key: prefix ? `${prefix} · ${key}` : key, from: a, to: b });
  }
  return out;
}

function diffOneSection(from: Section, to: Section): FieldChange[] {
  const changes = diffBags('', from.data, to.data);
  const locales = new Set([...Object.keys(from.localizations ?? {}), ...Object.keys(to.localizations ?? {})]);
  for (const locale of [...locales].sort()) {
    changes.push(...diffBags(locale, from.localizations?.[locale], to.localizations?.[locale]));
  }
  return changes;
}

/** Diff `from` (e.g. a version snapshot) against `to` (e.g. the current editor
 *  content). Unchanged sections are omitted; a same-content section at a new
 *  index reports as `moved`.
 *
 *  Sections pair by id. With `pairByPosition`, those left over also pair in
 *  order when their types match: a snapshot the server validated separately
 *  (a seeded update, ADR 0817) carries freshly minted ids for the same
 *  sections, and pairing by id alone would report every section as removed
 *  and re-added. Off by default, because in ordinary history a different id
 *  really is a removed section and a new one. */
export function diffSections(from: Section[], to: Section[], opts: { pairByPosition?: boolean } = {}): SectionDiffEntry[] {
  const out: SectionDiffEntry[] = [];
  const toIndex = new Map(to.map((s, i) => [s.sectionId, i]));
  const fromIds = new Set(from.map((s) => s.sectionId));
  // Positional pairing of the leftovers: walk both in order, matching types.
  const unmatchedTo = to.map((s, i) => ({ s, i })).filter(({ s }) => !fromIds.has(s.sectionId));
  const paired = new Map<string, { s: Section; i: number }>();
  let cursor = 0;
  for (const a of opts.pairByPosition ? from : []) {
    if (toIndex.has(a.sectionId)) continue;
    const k = unmatchedTo.findIndex((c, idx) => idx >= cursor && c.s.type === a.type);
    if (k < 0) continue;
    paired.set(a.sectionId, unmatchedTo[k]!);
    cursor = k + 1;
  }
  const pairedTo = new Set([...paired.values()].map((c) => c.s.sectionId));
  from.forEach((a, aIndex) => {
    const i = toIndex.get(a.sectionId);
    const hit = i !== undefined ? { s: to[i]!, i } : paired.get(a.sectionId);
    if (!hit) {
      out.push({ sectionId: a.sectionId, type: a.type, kind: 'removed', fields: [] });
      return;
    }
    const extra = hit.s.sectionId !== a.sectionId ? { toSectionId: hit.s.sectionId } : {};
    const fields = diffOneSection(a, hit.s);
    if (fields.length > 0) out.push({ sectionId: a.sectionId, type: hit.s.type, kind: 'changed', fields, ...extra });
    else if (hit.i !== aIndex) out.push({ sectionId: a.sectionId, type: hit.s.type, kind: 'moved', fields: [], ...extra });
  });
  for (const b of to) {
    if (!fromIds.has(b.sectionId) && !pairedTo.has(b.sectionId)) out.push({ sectionId: b.sectionId, type: b.type, kind: 'added', fields: [] });
  }
  return out;
}
