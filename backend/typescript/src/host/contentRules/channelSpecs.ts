/**
 * ADR 0946 D3 — the ONE channel spec table, inside the ADR 0933 content-rules
 * library. The data lives in `channelSpecs.json` (dated, versioned). Packs are
 * standalone and cannot import host code, so they read a GENERATED copy
 * (`scripts/gen-content-rules.mjs`, `--check` in CI and in
 * `test/adr0946-channel-specs.test.ts`). Edit the JSON, then regenerate.
 *
 * Every text field carries its source. `hardMax` comes only from the
 * platform's own published spec, and is the only limit that may block or
 * truncate copy. `recommended` is a display guideline (official or a labelled
 * third-party page) and only ever warns. `legacyMax` is the MyndHyve value the
 * row replaced; it is unsourced and enforces nothing in this app.
 */
import table from './channelSpecs.json';

export type ChannelSpecId = string;

export interface TextLimitSource {
  type: 'official' | 'third-party' | 'unsourced';
  url?: string;
  sites?: string;
  retrieved: string;
  note?: string;
}

export interface TextLimit {
  hardMax?: number;
  recommended?: number;
  min?: number;
  /** The unsourced MyndHyve value; kept for the vendor pack's output shape. */
  legacyMax: number;
  source: TextLimitSource;
}

export interface AdSpec {
  platform: string;
  placement: string;
  displayName: string;
  supportedTypes: string[];
  [facet: string]: unknown;
}

export interface ChannelSpecRow {
  channelSpecId: ChannelSpecId;
  kind: 'ad' | 'post' | 'email' | 'landing';
  platform?: string;
  aliases?: string[];
  text?: Record<string, TextLimit>;
  /** Ad rows only: the platform's media, CTA and safe-zone facets. */
  spec?: AdSpec;
  /** Fixed-size ad rows: the exact pixel sizes. */
  sizes?: Array<{ width: number; height: number }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SOURCE_TYPES = new Set(['official', 'third-party', 'unsourced']);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Read a row's `text` map, refusing a malformed table at boot. The rules a
 *  bad edit could break are checked here: a hard max needs an official URL,
 *  every field has a dated source, and an unsourced field carries no limit. */
function readText(v: unknown, where: string): Record<string, TextLimit> {
  if (!isObj(v)) throw new Error(`channelSpecs.json: ${where}.text must be an object`);
  const out: Record<string, TextLimit> = {};
  for (const [field, raw] of Object.entries(v)) {
    const at = `${where}.text.${field}`;
    if (!isObj(raw) || !isObj(raw.source) || !isObj(raw.legacy) || !posInt(raw.legacy.max)) throw new Error(`channelSpecs.json: ${at} is malformed`);
    const s = raw.source;
    if (typeof s.type !== 'string' || !SOURCE_TYPES.has(s.type) || typeof s.retrieved !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.retrieved)) {
      throw new Error(`channelSpecs.json: ${at}.source needs a type and a retrieval date`);
    }
    if (raw.hardMax !== undefined && (!posInt(raw.hardMax) || s.type !== 'official' || typeof s.url !== 'string')) {
      throw new Error(`channelSpecs.json: ${at}.hardMax must cite an official URL`);
    }
    if (s.type === 'unsourced' && (raw.hardMax !== undefined || raw.recommended !== undefined)) {
      throw new Error(`channelSpecs.json: ${at} is unsourced and so carries no limit`);
    }
    if (raw.recommended !== undefined && !posInt(raw.recommended)) throw new Error(`channelSpecs.json: ${at}.recommended must be a positive integer`);
    const source: TextLimitSource = {
      type: s.type as TextLimitSource['type'], retrieved: s.retrieved,
      ...(typeof s.url === 'string' ? { url: s.url } : {}),
      ...(typeof s.sites === 'string' ? { sites: s.sites } : {}),
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    };
    out[field] = {
      ...(raw.hardMax !== undefined ? { hardMax: raw.hardMax } : {}),
      ...(typeof raw.recommended === 'number' ? { recommended: raw.recommended } : {}),
      ...(typeof raw.legacy.min === 'number' ? { min: raw.legacy.min } : {}),
      legacyMax: raw.legacy.max,
      source,
    };
  }
  return out;
}

function readAdSpec(v: unknown, where: string): AdSpec {
  if (!isObj(v) || typeof v.platform !== 'string' || typeof v.placement !== 'string' || typeof v.displayName !== 'string' || !Array.isArray(v.supportedTypes)) {
    throw new Error(`channelSpecs.json: ${where}.spec is malformed`);
  }
  return { ...v, platform: v.platform, placement: v.placement, displayName: v.displayName, supportedTypes: v.supportedTypes.map(String) };
}

export const CHANNEL_SPECS_VERSION: string = table.version;
export const CHANNEL_SPECS_AS_OF: string = table.asOf;

const ROWS: readonly ChannelSpecRow[] = [
  ...table.ads.map((r, i): ChannelSpecRow => {
    const spec = readAdSpec(r.spec, `ads[${i}]`);
    return { channelSpecId: r.channelSpecId, kind: 'ad', platform: spec.platform, text: readText(r.text, `ads[${i}]`), spec };
  }),
  ...table.banners.map((r): ChannelSpecRow => ({
    channelSpecId: r.channelSpecId, kind: 'ad', platform: r.platform,
    sizes: r.sizes.map((z) => ({ width: z.width, height: z.height })),
  })),
  ...table.posts.map((r, i): ChannelSpecRow => ({
    channelSpecId: r.channelSpecId, kind: 'post', platform: r.platform,
    ...('aliases' in r && Array.isArray(r.aliases) ? { aliases: r.aliases.map(String) } : {}),
    text: readText(r.text, `posts[${i}]`),
  })),
  ...table.destinations.map((r): ChannelSpecRow => {
    if (r.kind !== 'email' && r.kind !== 'landing') throw new Error(`channelSpecs.json: destination ${r.channelSpecId} has kind ${r.kind}`);
    return { channelSpecId: r.channelSpecId, kind: r.kind };
  }),
];
const BY_ID = new Map(ROWS.map((r) => [r.channelSpecId, r]));
if (BY_ID.size !== ROWS.length) throw new Error('channelSpecs.json: duplicate channelSpecId');

export const CHANNEL_SPEC_IDS: readonly ChannelSpecId[] = ROWS.map((r) => r.channelSpecId);

export function channelSpec(id: ChannelSpecId): ChannelSpecRow | undefined {
  return BY_ID.get(id);
}

export function isChannelSpecId(id: string): boolean {
  return BY_ID.has(id);
}

/** Whether a `width × height` canvas satisfies a spec row: an exact size of
 *  a fixed-size row, or within 1% of one of an ad row's image or video
 *  aspect ratios. */
export function sizeSatisfies(id: ChannelSpecId, width: number, height: number): boolean {
  const row = BY_ID.get(id);
  if (!row) return false;
  if (row.sizes) return row.sizes.some((z) => z.width === width && z.height === height);
  const ratios: Array<{ width: number; height: number }> = [];
  for (const facet of ['imageSpec', 'videoSpec']) {
    const f = row.spec?.[facet];
    if (isObj(f) && Array.isArray(f.aspectRatios)) {
      for (const a of f.aspectRatios) if (isObj(a) && typeof a.width === 'number' && typeof a.height === 'number') ratios.push({ width: a.width, height: a.height });
    }
  }
  const want = width / height;
  return ratios.some((a) => Math.abs(a.width / a.height - want) / want <= 0.01);
}

type CopyFields = Partial<Record<'headline' | 'description', number>>;

function copyDefaults(pick: (l: TextLimit) => number | undefined): Record<string, CopyFields> {
  const out: Record<string, CopyFields> = {};
  for (const [platform, id] of Object.entries(table.copyDefaults)) {
    const text = BY_ID.get(id)?.text;
    if (!text) throw new Error(`channel spec ${id} has no text limits`);
    const caps: CopyFields = {};
    for (const field of ['headline', 'description'] as const) {
      const v = text[field] ? pick(text[field]) : undefined;
      if (v !== undefined) caps[field] = v;
    }
    if (Object.keys(caps).length > 0) out[platform] = caps;
  }
  return out;
}

/** Per-platform ad copy HARD caps (official only) from each platform's
 *  copy-default placement. A platform with no published maximum is absent. */
export function adCopyCaps(): Record<string, CopyFields> {
  return copyDefaults((l) => l.hardMax);
}

/** Per-platform recommended ad copy lengths (warn, never truncate). */
export function adCopyRecommendations(): Record<string, CopyFields> {
  return copyDefaults((l) => l.recommended);
}

function postCaps(pick: (l: TextLimit) => number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ROWS) {
    if (r.kind !== 'post' || !r.platform || !r.text?.content) continue;
    const v = pick(r.text.content);
    if (v === undefined) continue;
    out[r.platform] = v;
    for (const a of r.aliases ?? []) out[a] = v;
  }
  return out;
}

/** Social post body HARD caps by platform (and alias), official only. */
export function postBodyCaps(): Record<string, number> {
  return postCaps((l) => l.hardMax);
}

/** Social post body recommended lengths by platform (and alias). */
export function postBodyRecommendations(): Record<string, number> {
  return postCaps((l) => l.recommended);
}
