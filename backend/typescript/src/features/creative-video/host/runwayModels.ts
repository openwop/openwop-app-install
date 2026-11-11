/**
 * The ONE Runway model table (ADR 1051 D2) — the frontier text/image-to-video
 * models this host will submit, with each model's ratio set and duration rule.
 *
 * Source: Runway's published OpenAPI, embedded in https://docs.dev.runwayml.com/api/
 * (info.version 2024-11-06, read 2026-11-03). A trimmed parse is saved as
 * `test/fixtures/runway-openapi-2024-11-06.json`, and
 * `test/adr1051-runway-contract.test.ts` holds every entry here to it. This is a
 * curated SUBSET: the models a person can pick on the page and a workflow can
 * name. Anything else is refused before any spend.
 *
 * The page reads this table from `GET …/video-models`; the node pack's text does
 * not enumerate it, so there is one copy.
 */

/** The server the spec names (the `api.runwayml.com` default this replaced is not the API). */
export const RUNWAY_API_BASE = 'https://api.dev.runwayml.com';
/** The spec's `X-Runway-Version` const. */
export const RUNWAY_API_VERSION = '2024-11-06';

export type RunwayEndpoint = 't2v' | 'i2v';

export interface RunwayModel {
  id: string;
  label: string;
  /** The ratios this model takes on each endpoint it serves. */
  ratios: Partial<Record<RunwayEndpoint, readonly string[]>>;
  /** Seconds: an inclusive integer range or a fixed set. */
  duration: { min: number; max: number } | { oneOf: readonly number[] };
  defaultDurationSec: number;
}

const LANDSCAPE = '1280:720';
const PORTRAIT = '720:1280';
const VEO_RATIOS = ['1280:720', '720:1280', '1080:1920', '1920:1080'] as const;

export const RUNWAY_MODELS: readonly RunwayModel[] = [
  {
    id: 'gen4.5', label: 'Gen-4.5',
    ratios: { t2v: ['1280:720', '720:1280'], i2v: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'] },
    duration: { min: 2, max: 10 }, defaultDurationSec: 5,
  },
  {
    id: 'gen4_turbo', label: 'Gen-4 Turbo',
    ratios: { i2v: ['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672'] },
    duration: { min: 2, max: 10 }, defaultDurationSec: 5,
  },
  {
    id: 'veo3.1', label: 'Veo 3.1',
    ratios: { t2v: VEO_RATIOS, i2v: VEO_RATIOS },
    duration: { oneOf: [4, 6, 8] }, defaultDurationSec: 6,
  },
  {
    id: 'veo3.1_fast', label: 'Veo 3.1 Fast',
    ratios: { t2v: VEO_RATIOS, i2v: VEO_RATIOS },
    duration: { oneOf: [4, 6, 8] }, defaultDurationSec: 6,
  },
];

export const DEFAULT_RUNWAY_MODEL = 'gen4.5';

/** The table entry for `id` on `endpoint`, or null when the model does not serve it. */
export function runwayModel(id: string, endpoint: RunwayEndpoint): RunwayModel | null {
  const m = RUNWAY_MODELS.find((x) => x.id === id);
  return m && m.ratios[endpoint] ? m : null;
}

export function durationAllowed(m: RunwayModel, sec: number): boolean {
  if (!Number.isInteger(sec)) return false;
  return 'oneOf' in m.duration ? m.duration.oneOf.includes(sec) : sec >= m.duration.min && sec <= m.duration.max;
}

export interface ResolvedRunwayRequest { model: string; ratio: string; durationSec: number }

export type RunwayResolveResult =
  | { ok: true; value: ResolvedRunwayRequest }
  | { ok: false; field: 'model' | 'ratio' | 'durationSec'; message: string };

/**
 * Resolve a request to a concrete (model, ratio, duration) the spec accepts, or
 * say which field it cannot be. `portrait` picks the default ratio's orientation
 * (an image-to-video still taller than wide). Pure: the caller decides what a
 * refusal costs (it must be before any row, reservation or submit).
 */
export function resolveRunwayRequest(endpoint: RunwayEndpoint, input: { model?: string; ratio?: string; durationSec?: number; portrait?: boolean; defaultModel?: string }): RunwayResolveResult {
  const id = (input.model ?? '').trim() || (input.defaultModel ?? '').trim() || DEFAULT_RUNWAY_MODEL;
  const m = runwayModel(id, endpoint);
  if (!m) return { ok: false, field: 'model', message: `Model "${id}" is not available for ${endpoint === 't2v' ? 'text' : 'image'}-to-video on this host.` };
  const ratios = m.ratios[endpoint]!;
  const ratio = (input.ratio ?? '').trim() || (input.portrait ? PORTRAIT : LANDSCAPE);
  if (!ratios.includes(ratio)) return { ok: false, field: 'ratio', message: `${m.label} does not take the ratio ${ratio}. It takes ${ratios.join(', ')}.` };
  const durationSec = input.durationSec ?? m.defaultDurationSec;
  if (!durationAllowed(m, durationSec)) {
    const rule = 'oneOf' in m.duration ? m.duration.oneOf.join(', ') : `${m.duration.min}–${m.duration.max}`;
    return { ok: false, field: 'durationSec', message: `${m.label} takes a duration of ${rule} seconds.` };
  }
  return { ok: true, value: { model: m.id, ratio, durationSec } };
}

/** The table for the page (`GET …/video-models`), per endpoint. */
export function runwayModelsView(): { defaultModel: string; models: { id: string; label: string; endpoints: RunwayEndpoint[]; ratios: Partial<Record<RunwayEndpoint, readonly string[]>>; duration: RunwayModel['duration']; defaultDurationSec: number }[] } {
  return {
    defaultModel: DEFAULT_RUNWAY_MODEL,
    models: RUNWAY_MODELS.map((m) => ({ id: m.id, label: m.label, endpoints: (Object.keys(m.ratios) as RunwayEndpoint[]), ratios: m.ratios, duration: m.duration, defaultDurationSec: m.defaultDurationSec })),
  };
}
