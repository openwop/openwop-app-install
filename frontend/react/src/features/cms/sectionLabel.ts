import type { Section } from './cmsClient.js';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A short human label for a section in the page workspace's list: its heading
 *  when it has one, else the first words of its text, caption or first item.
 *  Empty when the section has nothing readable yet (the caller shows the type). */
export function sectionLabel(section: Section): string {
  const d = (section.data ?? {}) as Record<string, unknown>;
  const direct = str(d.heading) || str(d.title) || str(d.caption) || str(d.label) || str(d.alt);
  if (direct) return clip(direct);
  const text = str(d.text) || str(d.subheading) || str(d.blurb);
  if (text) return clip(firstLine(text));
  const items = Array.isArray(d.items) ? d.items : Array.isArray(d.columns) ? d.columns : [];
  const first = items[0] as Record<string, unknown> | undefined;
  if (first) {
    const v = str(first.title) || str(first.question) || str(first.quote) || str(first.text);
    if (v) return clip(v);
  }
  return '';
}

function firstLine(text: string): string {
  // Drop the prose grammar's line markers (`### `, `- `, `1. `, `> `) and inline marks.
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/^(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)/, '').replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

function clip(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
