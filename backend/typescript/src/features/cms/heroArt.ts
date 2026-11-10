/**
 * ADR 1060 — the illustrated hero visuals (`receipt`, `apps`, `versus`,
 * `fanout`, `phone`, `wall`, `tally`), validated from one declarative spec.
 *
 * Each visual is CLOSED content, like the ADR 1029 activity card and the ADR
 * 1038 flow: only the keys its spec names survive, every string is scrubbed
 * and capped (`cleanContent`), a styling enum outside its set is dropped (the
 * stock look), and a list longer than its cap is REFUSED with a typed 400
 * rather than cut (ADR 1038 D8's refusal for a seventh flow step). Inert text
 * only: no links, no media, no colour strings (an `accent` is a closed token
 * name the renderer maps to a theme token).
 *
 * A list item is kept even when every field is empty, so the editor's autosave
 * round trip never wipes a row being written (the ADR 1038 P8 lesson); the
 * renderers and crawlers show only complete items. A visual with nothing left
 * is omitted. An overlay replaces each visual whole (RFC 0103 §C) and is held
 * to the same spec (`sanitizeSectionOverlay` runs this in partial mode too).
 *
 * The spec is mirrored, byte for byte, by `frontend/react/src/features/cms/
 * heroArtSpec.ts` (the editor and renderer read it); `adr1060-hero-art.test.ts`
 * deep-compares the two.
 */
import { optionalCleanContent } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';

export type ArtField =
  | { readonly kind: 'text'; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'fraction' }
  | { readonly kind: 'count'; readonly max: number }
  | { readonly kind: 'object'; readonly shape: ArtShape }
  | { readonly kind: 'list'; readonly cap: number; readonly item: ArtShape };
export type ArtShape = { readonly [key: string]: ArtField };

const text = (max: number): ArtField => ({ kind: 'text', max });
const list = (cap: number, item: ArtShape): ArtField => ({ kind: 'list', cap, item });

/** Every visual's accessible caption: the figure's name, read before its parts. */
const CAPTION = 160;

/** ADR 1060 — the visuals' specs, in phase order. Keys are the hero `data` keys. */
export const HERO_ART_SPECS = {
  // P1 — a receipt printing out of a slot, with a stamp landing on it.
  receipt: {
    label: text(CAPTION),
    title: text(40),
    subtitle: text(80),
    lines: list(8, { label: text(60), amount: text(40), state: { kind: 'enum', values: ['highlight'] } }),
    totalLabel: text(40),
    totalAmount: text(40),
    stamp: text(60),
  },
  // P2 — the same app for several clients, cross-fading: name, address, accent bar.
  apps: {
    label: text(CAPTION),
    chip: text(40),
    items: list(3, {
      name: text(40),
      address: text(60),
      accent: { kind: 'enum', values: ['info', 'success', 'ai'] },
      heading: text(60),
      rows: list(3, { text: text(80), status: text(30), state: { kind: 'enum', values: ['done', 'waiting'] } }),
    }),
  },
  // P3 — a tangle of loose tools against one clean set of tiles, a "vs" between.
  versus: {
    label: text(CAPTION),
    divider: text(8),
    before: { kind: 'object', shape: { label: text(60), items: list(6, { label: text(30) }) } },
    after: { kind: 'object', shape: { label: text(60), items: list(6, { label: text(30) }) } },
  },
  // P4 — one source document fanning out into outputs, each checked; one waits for you.
  fanout: {
    label: text(CAPTION),
    source: text(40),
    outputs: list(3, { title: text(40), check: text(40), status: text(40), state: { kind: 'enum', values: ['done', 'waiting'] } }),
  },
  // P5 — a phone lock screen collecting notifications, then one waiting for your yes.
  phone: {
    label: text(CAPTION),
    time: text(12),
    day: text(40),
    notes: list(4, { title: text(40), time: text(20), text: text(160) }),
    reply: { kind: 'object', shape: { title: text(40), time: text(20), text: text(160), primary: text(20), secondary: text(20) } },
  },
  // P6 — two workspaces with a wall and a lock between; a document bounces off it.
  wall: {
    label: text(CAPTION),
    spaces: list(2, { title: text(40), members: { kind: 'count', max: 6 }, docs: list(4, { label: text(40) }) }),
  },
  // P7 — big numbers on cards, each with a bar that grows.
  tally: {
    label: text(CAPTION),
    items: list(4, { value: text(12), label: text(40), fill: { kind: 'fraction' }, state: { kind: 'enum', values: ['done', 'partial', 'none'] } }),
  },
  // ADR 1064 P3d — a recorded run's event log, one line at a time.
  log: {
    label: text(CAPTION),
    title: text(60),
    lines: list(10, { time: text(12), event: text(40), detail: text(60), state: { kind: 'enum', values: ['done', 'waiting'] } }),
  },
} as const satisfies Record<string, ArtShape>;

export type HeroArtVisual = keyof typeof HERO_ART_SPECS;
export const HERO_ART_VISUALS = Object.keys(HERO_ART_SPECS) as HeroArtVisual[];

/**
 * List-item keys whose value is presentation, never prose: like the ADR 1038 D8
 * `state`, they follow the base layer on every write (`restoreItemStates`), so a
 * model asked to translate values cannot turn `success` into `succès` or a fill of
 * 0.4 into "40 %".
 */
export const ITEM_BASE_KEYS = ['state', 'accent', 'members', 'fill'] as const;

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function cleanField(field: ArtField, v: unknown, path: string): unknown {
  switch (field.kind) {
    case 'text':
      return optionalCleanContent(v, field.max, path);
    case 'enum':
      return typeof v === 'string' && field.values.includes(v) ? v : undefined;
    case 'fraction':
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
    case 'count':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, field.max) : undefined;
    case 'object': {
      const o = cleanShape(field.shape, v, path);
      return Object.keys(o).length > 0 ? o : undefined;
    }
    case 'list': {
      if (!Array.isArray(v)) return undefined;
      if (v.length > field.cap) {
        throw new OpenwopError('validation_error', `${path}: at most ${field.cap} items; remove one before adding another.`, 400, { field: path, cap: field.cap });
      }
      return v.length > 0 ? v.map((item) => cleanShape(field.item, item, path)) : undefined;
    }
  }
}

/** One object against its shape: only the named keys, each cleaned; empty values omitted. */
function cleanShape(shape: ArtShape, v: unknown, path: string): Record<string, unknown> {
  const o = asObject(v) ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const cleaned = cleanField(field, o[key], `${path}.${key}`);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** Clean one visual's data, or undefined when nothing survives (the key is omitted). */
export function cleanHeroArt(visual: HeroArtVisual, v: unknown): Record<string, unknown> | undefined {
  if (!asObject(v)) return undefined;
  const out = cleanShape(HERO_ART_SPECS[visual], v, visual);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every illustrated visual's data on a hero, cleaned. Like plan/activity/hub/flow,
 *  a visual's data is kept while another visual shows, so switching back restores it. */
export function cleanAllHeroArt(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const visual of HERO_ART_VISUALS) {
    const cleaned = cleanHeroArt(visual, d[visual]);
    if (cleaned) out[visual] = cleaned;
  }
  return out;
}
