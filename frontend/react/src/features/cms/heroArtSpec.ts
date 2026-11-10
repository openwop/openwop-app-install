/**
 * ADR 1060 — the illustrated hero visuals' field specs, mirrored from the
 * validator (`backend/typescript/src/features/cms/heroArt.ts`, the authority;
 * `adr1060-hero-art.test.ts` deep-compares the two). The editor builds its
 * fields from this, and the renderer caps its lists with it. Data only, no
 * imports, so the backend test can load it.
 */
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

const CAPTION = 160;

export const HERO_ART_SPECS = {
  receipt: {
    label: text(CAPTION),
    title: text(40),
    subtitle: text(80),
    lines: list(8, { label: text(60), amount: text(40), state: { kind: 'enum', values: ['highlight'] } }),
    totalLabel: text(40),
    totalAmount: text(40),
    stamp: text(60),
  },
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
  versus: {
    label: text(CAPTION),
    divider: text(8),
    before: { kind: 'object', shape: { label: text(60), items: list(6, { label: text(30) }) } },
    after: { kind: 'object', shape: { label: text(60), items: list(6, { label: text(30) }) } },
  },
  fanout: {
    label: text(CAPTION),
    source: text(40),
    outputs: list(3, { title: text(40), check: text(40), status: text(40), state: { kind: 'enum', values: ['done', 'waiting'] } }),
  },
  phone: {
    label: text(CAPTION),
    time: text(12),
    day: text(40),
    notes: list(4, { title: text(40), time: text(20), text: text(160) }),
    reply: { kind: 'object', shape: { title: text(40), time: text(20), text: text(160), primary: text(20), secondary: text(20) } },
  },
  wall: {
    label: text(CAPTION),
    spaces: list(2, { title: text(40), members: { kind: 'count', max: 6 }, docs: list(4, { label: text(40) }) }),
  },
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
/** The illustrated visuals, in phase order (each also in `HERO_VISUALS`). */
export const HERO_ART_VISUALS = Object.keys(HERO_ART_SPECS) as HeroArtVisual[];

export function isHeroArtVisual(v: string): v is HeroArtVisual {
  return (HERO_ART_VISUALS as readonly string[]).includes(v);
}

/** The values of the enum at `path` (list items and objects walked through), [] if none. */
export function artEnum(visual: HeroArtVisual, ...path: string[]): readonly string[] {
  let shape: ArtShape = HERO_ART_SPECS[visual];
  let f: ArtField | undefined;
  for (const key of path) {
    f = shape[key];
    if (!f) return [];
    if (f.kind === 'list') shape = f.item;
    else if (f.kind === 'object') shape = f.shape;
  }
  return f && f.kind === 'enum' ? f.values : [];
}

/** A list field's cap, for the renderer (0 when the path is not a list). */
export function artCap(visual: HeroArtVisual, key: string): number {
  const f = (HERO_ART_SPECS[visual] as ArtShape)[key];
  return f && f.kind === 'list' ? f.cap : 0;
}
