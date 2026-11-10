/**
 * ADR 1060 — the illustrated hero visuals as crawler text (ADR 0593 §C9:
 * crawler = human). One reading order per visual, written once here and
 * rendered twice: as an HTML `<figure>` by `sectionHtml` and as markdown by
 * `sectionMarkdown`. Only the words count: states, accents, fills and the
 * drawing are presentation and add nothing.
 *
 * Each visual shows under the same rule as the SPA renderer (a receipt needs a
 * priced line, …), so a crawler never reads a picture a visitor cannot see.
 * Lists are capped at the spec's cap here too: an overlay replaces a visual
 * whole and is not re-validated at serve time.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const items = (v: unknown, cap: number): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, cap).map(obj) : []);
/** "a — b", either side optional. */
const pair = (a: string, b: string): string => [a, b].filter(Boolean).join(' — ');

export type ArtPart =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'list'; items: string[] };

/** A visual's words in reading order: an optional caption, then its parts. */
export interface ArtText { caption: string; parts: ArtPart[] }

const part = {
  text: (t: string): ArtPart[] => (t ? [{ kind: 'text', text: t }] : []),
  strong: (t: string): ArtPart[] => (t ? [{ kind: 'strong', text: t }] : []),
  list: (xs: string[]): ArtPart[] => (xs.filter(Boolean).length > 0 ? [{ kind: 'list', items: xs.filter(Boolean) }] : []),
};

/** P1 — the receipt: title, subtitle, each priced line, the total, the stamp. */
function receiptText(v: unknown): ArtText | null {
  const r = obj(v);
  const lines = items(r.lines, 8).filter((l) => str(l.label) && str(l.amount));
  if (lines.length === 0) return null;
  return {
    caption: str(r.label),
    parts: [
      ...part.strong(str(r.title)),
      ...part.text(str(r.subtitle)),
      ...part.list(lines.map((l) => pair(str(l.label), str(l.amount)))),
      ...part.strong(pair(str(r.totalLabel), str(r.totalAmount))),
      ...part.text(str(r.stamp)),
    ],
  };
}

/** P2 — the apps, in order: each app's name, address and heading, then its
 *  rows ("text — status"); the chip last. */
function appsText(v: unknown): ArtText | null {
  const a = obj(v);
  const apps = items(a.items, 3).filter((x) => str(x.name));
  if (apps.length === 0) return null;
  return {
    caption: str(a.label),
    parts: [
      ...apps.flatMap((x) => [
        ...part.strong(str(x.name)),
        ...part.text(pair(str(x.address), str(x.heading))),
        ...part.list(items(x.rows, 3).filter((r) => str(r.text)).map((r) => pair(str(r.text), str(r.status)))),
      ]),
      ...part.text(str(a.chip)),
    ],
  };
}

/** P3 — the two sides in order: each side's label and its items, the divider between. */
function versusText(v: unknown): ArtText | null {
  const x = obj(v);
  const side = (s: unknown): { label: string; items: string[] } => ({ label: str(obj(s).label), items: items(obj(s).items, 6).map((i) => str(i.label)).filter(Boolean) });
  const before = side(x.before);
  const after = side(x.after);
  if (before.items.length === 0 || after.items.length === 0) return null;
  return {
    caption: str(x.label),
    parts: [
      ...part.strong(before.label), ...part.list(before.items),
      ...part.text(str(x.divider)),
      ...part.strong(after.label), ...part.list(after.items),
    ],
  };
}

/** P4 — the source, then each output: "title — check — status". */
function fanoutText(v: unknown): ArtText | null {
  const f = obj(v);
  const outputs = items(f.outputs, 3).filter((o) => str(o.title));
  if (!str(f.source) || outputs.length === 0) return null;
  return {
    caption: str(f.label),
    parts: [
      ...part.strong(str(f.source)),
      ...part.list(outputs.map((o) => [str(o.title), str(o.check), str(o.status)].filter(Boolean).join(' — '))),
    ],
  };
}

/** P5 — the lock screen's time and day, each notification ("title · time — text"),
 *  then the reply: its title, text and the two choices. */
function phoneText(v: unknown): ArtText | null {
  const p = obj(v);
  const notes = items(p.notes, 4).filter((n) => str(n.text));
  const reply = obj(p.reply);
  if (notes.length === 0 && !str(reply.text)) return null;
  const head = (x: Record<string, unknown>): string => [str(x.title), str(x.time)].filter(Boolean).join(' · ');
  return {
    caption: str(p.label),
    parts: [
      ...part.text([str(p.time), str(p.day)].filter(Boolean).join(' · ')),
      ...part.list(notes.map((n) => pair(head(n), str(n.text)))),
      ...(str(reply.text) ? [
        ...part.strong(head(reply)),
        ...part.text(str(reply.text)),
        ...part.text([str(reply.primary), str(reply.secondary)].filter(Boolean).join(' · ')),
      ] : []),
    ],
  };
}

/** P6 — each workspace in order: its title, then its documents. */
function wallText(v: unknown): ArtText | null {
  const w = obj(v);
  const spaces = items(w.spaces, 2).filter((s) => str(s.title));
  if (spaces.length < 2) return null;
  return {
    caption: str(w.label),
    parts: spaces.flatMap((s) => [...part.strong(str(s.title)), ...part.list(items(s.docs, 4).map((d) => str(d.label)))]),
  };
}

/** P7 — each card's number and what it counts: "value — label". */
function tallyText(v: unknown): ArtText | null {
  const t = obj(v);
  const cards = items(t.items, 4).filter((c) => str(c.value) && str(c.label));
  if (cards.length === 0) return null;
  return { caption: str(t.label), parts: part.list(cards.map((c) => pair(str(c.value), str(c.label)))) };
}

/** ADR 1064 P3d — the run's title, then each line: "time — event — detail". */
function logText(v: unknown): ArtText | null {
  const l = obj(v);
  const lines = items(l.lines, 10).filter((x) => str(x.event));
  if (lines.length === 0) return null;
  return { caption: str(l.label), parts: [...part.strong(str(l.title)), ...part.list(lines.map((x) => pair(pair(str(x.time), str(x.event)), str(x.detail))))] };
}

const READERS: Record<string, (v: unknown) => ArtText | null> = {
  receipt: receiptText,
  apps: appsText,
  versus: versusText,
  fanout: fanoutText,
  phone: phoneText,
  wall: wallText,
  tally: tallyText,
  log: logText,
};

/** The words of the hero's visible illustrated visual, or null (another visual,
 *  or one with too little to show). */
export function heroArtText(d: Record<string, unknown>): ArtText | null {
  const visual = str(d.visual);
  const read = Object.hasOwn(READERS, visual) ? READERS[visual] : undefined;
  return read ? read(d[visual]) : null;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** As an HTML figure (escaped), '' when there is nothing to read. */
export function heroArtHtml(d: Record<string, unknown>): string {
  const t = heroArtText(d);
  if (!t) return '';
  const body = t.parts.map((p) => (p.kind === 'list'
    ? `<ul>${p.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : p.kind === 'strong' ? `<p><strong>${escapeHtml(p.text)}</strong></p>` : `<p>${escapeHtml(p.text)}</p>`));
  return `<figure>\n${t.caption ? `<figcaption>${escapeHtml(t.caption)}</figcaption>\n` : ''}${body.join('\n')}\n</figure>`;
}

/** As markdown, '' when there is nothing to read. */
export function heroArtMarkdown(d: Record<string, unknown>): string {
  const t = heroArtText(d);
  if (!t) return '';
  const body = t.parts.map((p) => (p.kind === 'list' ? p.items.map((i) => `- ${i}`).join('\n') : p.kind === 'strong' ? `**${p.text}**` : p.text));
  return [t.caption ? `*${t.caption}*` : '', ...body].filter(Boolean).join('\n\n');
}
