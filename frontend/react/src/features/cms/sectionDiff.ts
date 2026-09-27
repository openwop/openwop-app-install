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
 *  index reports as `moved`. */
export function diffSections(from: Section[], to: Section[]): SectionDiffEntry[] {
  const out: SectionDiffEntry[] = [];
  const toById = new Map(to.map((s, i) => [s.sectionId, { s, i }]));
  from.forEach((a, aIndex) => {
    const hit = toById.get(a.sectionId);
    if (!hit) {
      out.push({ sectionId: a.sectionId, type: a.type, kind: 'removed', fields: [] });
      return;
    }
    const fields = diffOneSection(a, hit.s);
    if (fields.length > 0) out.push({ sectionId: a.sectionId, type: hit.s.type, kind: 'changed', fields });
    else if (hit.i !== aIndex) out.push({ sectionId: a.sectionId, type: hit.s.type, kind: 'moved', fields: [] });
  });
  const fromIds = new Set(from.map((s) => s.sectionId));
  for (const b of to) {
    if (!fromIds.has(b.sectionId)) out.push({ sectionId: b.sectionId, type: b.type, kind: 'added', fields: [] });
  }
  return out;
}
