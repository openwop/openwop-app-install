/**
 * ADR 1080 — design-led site sections. The validators, prerender HTML and
 * markdown for four section types, plus two cleaners the existing hero and
 * richText cases call:
 *
 *   statusTable   a table whose rows end in a worded status chip       (D1)
 *   dateCalc      a decide-by / order-by calculator                    (D2)
 *   conversation  questions the reader picks, each with its answer     (D3)
 *   featureIndex  groups on one side, the chosen group's items beside  (D4)
 *   decisionTree  click-through trees: question, options, outcome      (D15)
 *   scheduleSim   milestones on a timeline; late decisions push it out (D16)
 *   marginCalc    cost and markup to price and margin (ADR 1105 D3)
 *   allowanceGap  allowance beside expected spend, line by line (ADR 1105 D4)
 *   partyViews    a switch between a project's parties (ADR 1105 D1)
 *   stageChart    counts by stage as columns, grouped (ADR 1105 D2)
 *   hero `queue`  a titled list of rows with a worded status           (D7)
 *   richText `card`  a card with a picture, words and two link actions (D8)
 *
 * The same posture as the stock types: closed fields, bounded plain text, links
 * through the caller's `safeLink`. `partial` (a locale overlay) keeps only the
 * fields present and skips the required-field checks.
 */
import { cleanContent, cleanOpaqueToken, optionalCleanContent } from '../../host/boundedStrings.js';
import { strictCurrencyExponent } from '../../host/currencyUnits.js';
import { isValidUploadDate } from '../../host/videoUploadDate.js';
import { computeGaps, computeMargin, type GapLine } from './worksheetMath.js';
import { OpenwopError } from '../../types.js';

export const DESIGN_SECTION_TYPES = ['statusTable', 'dateCalc', 'conversation', 'featureIndex', 'decisionTree', 'scheduleSim', 'films', 'marginCalc', 'allowanceGap', 'partyViews', 'stageChart'] as const;

/** ADR 0843 — a film's play-button length: `m:ss` (minutes may run to three
 *  digits). The prerender turns it into an ISO 8601 `PT#M#S`. Shared by `video`
 *  (cmsService) and `films` (ADR 1082). */
export const VIDEO_LENGTH_RE = /^\d{1,3}:[0-5]\d$/;
/** ADR 1082 — a film's frame shape, and the facet a `films` section may filter on. */
export const FILM_SHAPES = ['16:9', '9:16', '1:1'] as const;
export const FILM_FILTERS = ['useCase', 'shape'] as const;
/** ADR 1082 — the caller's https-only media-URL rule (cmsService `httpsMediaUrl`,
 *  the `video` rule), injected so there is one rule and no import cycle. */
export type MediaUrlRule = (v: unknown, field: string) => string | undefined;
export type DesignSectionType = (typeof DESIGN_SECTION_TYPES)[number];

export const DESIGN_MAX = {
  label: 120, cell: 120, point: 160, tablePoints: 6, status: 40, note: 400, question: 200, answer: 800, ref: 40, alt: 200, token: 256, body: 600,
  tableColumns: 6, tableRows: 24, exchanges: 8, refs: 6, numberCeiling: 520,
  indexGroups: 24, indexItems: 16, indexKey: 8, indexId: 24,
  queueRows: 6, cardActions: 2,
  trees: 16, treeNodes: 16, treeOptions: 6, treeText: 300, nodeId: 40,
  films: 24, useCase: 40, filmTitle: 160, filmDescription: 1000, // the `video` caps (MAX.title, MAX.videoDescription)
  // ADR 1112 D5: up to 1,500 decisions on 40 milestones, grouped by up to 20 phases,
  // categories and roles. The binding limit is bytes (`simSectionBytes`, D5 correction).
  milestones: 40, simDecisions: 1500, simGroups: 20, simSectionBytes: 850_000, simOptions: 4, weeks: 260, delayDays: 365,
  simDeps: 6, simPresets: 6, presetRules: 6, choiceText: 160, riskText: 400,
  money: 1_000_000_000, markup: 1000, targetMargin: 99, gapLines: 12, // ADR 1105
  parties: 4, partyNeeds: 6, partyRows: 8, needText: 240, stages: 14, chartGroups: 4, stageCount: 1_000_000, unit: 40,
} as const;

const SIM_KINDS = ['selection', 'approval', 'payment', 'response'] as const;

/**
 * ADR 1112 D6 (corrected by the P2 architect review and code review): the list-item fields
 * a locale overlay never changes, per section type, on top of the global ITEM_BASE_KEYS.
 * They are behaviour (ids, keys, references, numbers, flags), never prose, so
 * `restoreItemStates` copies them from the base whatever their JSON type. Per type, not
 * global: another section's `role` is prose (a quote's "CEO, Acme"). `all` applies to every
 * list's items; `lists` adds keys for the items of one named list. A decision's `decider`
 * is shown, so it stays translatable; a scenario rule's `decider` is mapped to it
 * (`alignSimOverlay`).
 */
export interface SectionBaseKeys { all: readonly string[]; lists?: Readonly<Record<string, readonly string[]>> }
export const SECTION_ITEM_BASE_KEYS: Partial<Record<string, SectionBaseKeys>> = {
  scheduleSim: {
    all: ['id', 'key', 'milestone', 'kind', 'phase', 'category', 'role', 'back', 'leadDays', 'leadUnknown', 'lockWeek', 'dependsOn', 'startWeek', 'weeks', 'floatDays', 'delayDays', 'minLeadDays'],
  },
};

/**
 * ADR 1112 D6 (corrected by the P2 code review and grading) — a `scheduleSim` translation
 * changes words only, and the generic restore is positional, so align it to the base first:
 *  - a list whose base items all carry an `id` or `key` (milestones, decisions, phases,
 *    categories, roles) is matched by it. An item the base lacks is dropped; one the
 *    translation lacks (added to the base since) is the base's own copy, so every locale
 *    has the same decisions and the same finish. Matched items take the base's behaviour
 *    keys. A translation written before ids were minted (none on its items) is matched by
 *    position when its length is the base's;
 *  - a list without ids (presets, rules, options) keeps its items when its length is the
 *    base's, else it is the base's own copy;
 *  - a scenario rule's `decider` is a match key against the decisions' shown `decider`,
 *    which a translation translates: each rule takes the translated name of a decision
 *    that had its base name, so scenarios work in every locale.
 * A translation written before a base edit still saves; `stampSourceDigests` aligns the
 * stored one the same way before comparing, so it still reads outdated.
 */
export function alignSimOverlay(base: unknown, overlay: Raw): Raw {
  const idOf = (x: unknown): string | undefined => {
    if (typeof x !== 'object' || x === null) return undefined;
    const r = x as Raw;
    return typeof r.id === 'string' ? `id:${r.id}` : typeof r.key === 'string' ? `key:${r.key}` : undefined;
  };
  const own = SECTION_ITEM_BASE_KEYS.scheduleSim;
  // A matched item takes the base item's behaviour keys here, because the positional
  // restore after this skips a list whose length differs from the base's.
  const withBase = (bx: Raw, ox: Raw, list: string): Raw => {
    const out = { ...ox };
    for (const k of [...(own?.all ?? []), ...(own?.lists?.[list] ?? [])]) {
      if (bx[k] !== undefined) out[k] = structuredClone(bx[k]); else delete out[k];
    }
    return out;
  };
  const align = (b: unknown, o: unknown, list = ''): unknown => {
    if (Array.isArray(o)) {
      if (!Array.isArray(b)) return undefined;
      const keyed = b.length > 0 && b.every((x) => idOf(x) !== undefined);
      if (keyed && o.some((x) => idOf(x) !== undefined)) {
        const mine = new Map(o.map((x) => [idOf(x), x] as const).filter(([k]) => k !== undefined));
        return b.map((bx) => {
          const ox = mine.get(idOf(bx));
          return ox === undefined ? structuredClone(bx) : withBase(bx as Raw, align(bx, ox) as Raw, list);
        });
      }
      if (b.length === o.length) return o.map((x, i) => (keyed ? withBase(b[i] as Raw, align(b[i], x) as Raw, list) : align(b[i], x)));
      return structuredClone(b);
    }
    if (typeof o === 'object' && o !== null && typeof b === 'object' && b !== null && !Array.isArray(b)) {
      const out: Raw = {};
      for (const [k, v] of Object.entries(o)) {
        if (!Array.isArray(v)) { out[k] = typeof v === 'object' && v !== null ? align((b as Raw)[k], v) ?? v : v; continue; }
        const next = align((b as Raw)[k], v, k);
        if (next !== undefined) out[k] = next;
      }
      return out;
    }
    return o;
  };
  const out = (align(base, overlay) as Raw | undefined) ?? {};
  // Scenario rules match the decisions' shown names: carry the translated name over.
  const b = (typeof base === 'object' && base !== null ? base : {}) as Raw;
  const baseDecisions = objects(b.decisions, DESIGN_MAX.simDecisions);
  const basePresets = objects(b.presets, DESIGN_MAX.simPresets);
  const byDecider = basePresets.some((p) => objects(p.rules, DESIGN_MAX.presetRules).some((r) => typeof r.decider === 'string'));
  if (byDecider && (Array.isArray(out.decisions) || Array.isArray(out.presets))) {
    const shown = new Map<string, string>();
    const mine = Array.isArray(out.decisions) ? out.decisions as Raw[] : baseDecisions;
    baseDecisions.forEach((bx, i) => {
      const from = typeof bx.decider === 'string' ? bx.decider : typeof bx.owner === 'string' ? bx.owner : undefined;
      const to = mine[i]?.decider ?? mine[i]?.owner;
      if (from && typeof to === 'string' && !shown.has(from)) shown.set(from, to);
    });
    const presets = (Array.isArray(out.presets) ? out.presets : structuredClone(basePresets)) as Raw[];
    presets.forEach((p, i) => {
      const baseRules = objects(basePresets[i]?.rules, DESIGN_MAX.presetRules);
      objects(p.rules, DESIGN_MAX.presetRules).forEach((r, j) => {
        const from = baseRules[j]?.decider;
        if (typeof from === 'string') r.decider = shown.get(from) ?? from; else delete r.decider;
      });
    });
    out.presets = presets;
  }
  return out;
}

/** ADR 1112 D5: the bytes of a `scheduleSim` and its translations together (see `simSectionBytes`). */
export function assertSimSectionBytes(data: unknown, localizations: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify({ data, localizations: localizations ?? {} }));
  if (bytes > DESIGN_MAX.simSectionBytes) {
    const locales = localizations && typeof localizations === 'object' ? Object.keys(localizations) : [];
    throw new OpenwopError('validation_error', `scheduleSim: this section and its ${locales.length} translation(s) come to ${Math.ceil(bytes / 1000)} kB; the limit is ${DESIGN_MAX.simSectionBytes / 1000} kB. Remove decisions, or a translation.`, 400, { reason: 'section_too_large', bytes, limit: DESIGN_MAX.simSectionBytes, locales });
  }
}

/** The status words' colors. Color always repeats the word, never replaces it. */
export const STATUS_TONES = ['ok', 'warn', 'bad', 'muted'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ADR 1105 D2 — a chart group's key (a stage refers to it). */
const CHART_KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

type Raw = Record<string, unknown>;
const objects = (v: unknown, cap: number): Raw[] =>
  (Array.isArray(v) ? v : []).slice(0, cap).filter((x): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x));
const pick = <T extends string>(set: readonly T[], v: unknown): T | undefined => set.find((s) => s === v);
const required = (type: string, what: string): OpenwopError =>
  new OpenwopError('validation_error', `${type}.${what} is required.`, 400, {});
const opt = (v: unknown, max: number, field: string): string | undefined => optionalCleanContent(v, max, field);
/** ADR 1105 — a finite number from 0 to `max`, else undefined. Never coerced from a string. */
const amount = (v: unknown, max: number): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);

/** ADR 1105 — a currency the host's ISO 4217 table knows; anything else is dropped. */
function currency(d: Raw): Raw {
  return typeof d.currency === 'string' && strictCurrencyExponent(d.currency) !== null ? { currency: d.currency } : {};
}

/** A row's worded status: the word is required for a tone to be kept. */
function cleanStatus(r: Raw): Raw {
  const status = opt(r.status, DESIGN_MAX.status, 'status');
  const tone = pick(STATUS_TONES, r.tone);
  return { ...(status ? { status } : {}), ...(status && tone ? { tone } : {}) };
}

export function isDesignSectionType(type: string): type is DesignSectionType {
  return (DESIGN_SECTION_TYPES as readonly string[]).includes(type);
}

/** The type-specific fields. The caller adds eyebrow, heading, lede and tone. */
/**
 * `stored` (ADR 1112 D8): the kernel's structure check of a row already saved, run on every
 * system write (publish, scheduled publish, unpublish, erasure). It keeps a stored section's
 * references as they are rather than refusing them, so a page saved before a rule existed can
 * still be published or erased. The author's own save is never `stored` and keeps every refusal.
 */
/** The first value that appears twice, so a refusal can name it. */
function firstRepeat(values: readonly string[]): string {
  const seen = new Set<string>();
  for (const v of values) { if (seen.has(v)) return v; seen.add(v); }
  return '';
}

export function buildDesignSectionData(type: DesignSectionType, d: Raw, partial: boolean, mediaUrl?: MediaUrlRule, stored = false): Raw {
  const has = (k: string): boolean => d[k] !== undefined;
  const text = (k: string, max: number): Raw => {
    const v = opt(d[k], max, k);
    return v ? { [k]: v } : {};
  };
  switch (type) {
    case 'films': {
      // ADR 1082 D1 — N films, each held to the `video` rules: https-only URLs
      // (the injected rule), plain text, `length` as m:ss, the upload-date rule.
      if (!mediaUrl) throw new Error('films: the caller must inject the media-URL rule');
      const raw = objects(d.films, DESIGN_MAX.films);
      const films = raw.map((f, i) => {
        const at = (k: string): string => `films[${i}].${k}`;
        const src = mediaUrl(f.src, at('src'));
        const poster = mediaUrl(f.poster, at('poster'));
        const captions = mediaUrl(f.captions, at('captions'));
        const title = opt(f.title, DESIGN_MAX.filmTitle, at('title'));
        const description = opt(f.description, DESIGN_MAX.filmDescription, at('description'));
        const lengthRaw = typeof f.length === 'string' ? f.length.trim() : '';
        const length = VIDEO_LENGTH_RE.test(lengthRaw) ? lengthRaw : undefined;
        const uploadRaw = typeof f.uploadDate === 'string' ? f.uploadDate.trim() : '';
        const uploadDate = isValidUploadDate(uploadRaw) ? uploadRaw : undefined;
        const useCase = opt(f.useCase, DESIGN_MAX.useCase, at('useCase'));
        const shape = pick(FILM_SHAPES, f.shape);
        if (!partial) {
          for (const [k, v] of [['src', src], ['poster', poster], ['title', title], ['description', description]] as const) {
            if (!v) throw new OpenwopError('validation_error', `films.${at(k)} is required.`, 400, { field: at(k) });
          }
          if (!length) throw new OpenwopError('validation_error', `films.${at('length')} is required as m:ss (e.g. 1:57).`, 400, { field: at('length') });
          if (uploadRaw && !uploadDate) throw new OpenwopError('validation_error', `films.${at('uploadDate')} must be YYYY-MM-DD or an ISO 8601 datetime with a timezone.`, 400, { field: at('uploadDate') });
          if (f.shape !== undefined && !shape) throw new OpenwopError('validation_error', `films.${at('shape')} must be one of ${FILM_SHAPES.join(', ')}.`, 400, { field: at('shape') });
        }
        return {
          ...(src ? { src } : {}), ...(poster ? { poster } : {}), ...(captions ? { captions } : {}),
          ...(title ? { title } : {}), ...(description ? { description } : {}),
          ...(length ? { length } : {}), ...(uploadDate ? { uploadDate } : {}),
          ...(useCase ? { useCase } : {}), ...(shape ? { shape } : {}),
        };
      });
      if (!partial && films.length === 0) throw required('films', 'films');
      const filter = pick(FILM_FILTERS, d.filter);
      if (!partial && d.filter !== undefined && !filter) {
        throw new OpenwopError('validation_error', `films.filter must be one of ${FILM_FILTERS.join(', ')}.`, 400, { field: 'filter' });
      }
      return { films, ...(filter ? { filter } : {}) };
    }
    case 'statusTable': {
      const columns = (Array.isArray(d.columns) ? d.columns : []).slice(0, DESIGN_MAX.tableColumns)
        .map((c) => cleanContent(c, DESIGN_MAX.label, 'columns')).filter((c) => c.length > 0);
      if (!partial && columns.length === 0) throw required('statusTable', 'columns');
      const rows = objects(d.rows, DESIGN_MAX.tableRows).map((r) => ({
        cells: (Array.isArray(r.cells) ? r.cells : []).slice(0, DESIGN_MAX.tableColumns)
          .map((c) => (typeof c === 'string' ? cleanContent(c, DESIGN_MAX.cell, 'cell') : '')),
        ...cleanStatus(r),
      })).filter((r) => r.cells.some((c) => c.length > 0));
      if (!partial && rows.length === 0) throw required('statusTable', 'rows');
      // #5765 — a short ruled list beside the table, under the head (with
      // `head: 'split'` the head and the list take the first column). Plain text.
      // Blanks are dropped before the cap, so an empty row never costs a point.
      const points = (Array.isArray(d.points) ? d.points : [])
        .map((p) => (typeof p === 'string' ? cleanContent(p, DESIGN_MAX.point, 'points') : '')).filter((p) => p.length > 0)
        .slice(0, DESIGN_MAX.tablePoints);
      return {
        ...text('label', DESIGN_MAX.label),
        ...(points.length > 0 || (partial && has('points')) ? { points } : {}),
        ...(!partial || has('columns') ? { columns } : {}),
        ...(!partial || has('rows') ? { rows } : {}),
      };
    }
    case 'dateCalc': {
      const number = (k: string): Raw => {
        const v = d[k];
        return typeof v === 'number' && Number.isFinite(v) ? { [k]: Math.min(Math.max(Math.floor(v), 0), DESIGN_MAX.numberCeiling) } : {};
      };
      const needDate = typeof d.needDate === 'string' && DATE_RE.test(d.needDate) ? { needDate: d.needDate } : {};
      return {
        ...text('needLabel', DESIGN_MAX.label), ...text('leadLabel', DESIGN_MAX.label), ...text('floatLabel', DESIGN_MAX.label), ...text('approveLabel', DESIGN_MAX.label),
        ...text('decideLabel', DESIGN_MAX.label), ...text('orderLabel', DESIGN_MAX.label), ...text('unknownText', DESIGN_MAX.note), ...text('note', DESIGN_MAX.note),
        ...needDate, ...number('leadWeeks'), ...number('floatDays'), ...number('approveDays'),
      };
    }
    // ADR 1105 D3/D5 — starting figures the reader edits. Numbers are data, not
    // copy, so a locale overlay never carries them (nor the currency).
    case 'marginCalc': {
      const figure = (k: string, max: number): Raw => {
        const v = partial ? undefined : amount(d[k], max);
        return v !== undefined ? { [k]: v } : {};
      };
      return {
        ...text('costLabel', DESIGN_MAX.label), ...text('markupLabel', DESIGN_MAX.label), ...text('targetLabel', DESIGN_MAX.label), ...text('note', DESIGN_MAX.note),
        ...figure('cost', DESIGN_MAX.money), ...figure('markup', DESIGN_MAX.markup), ...figure('target', DESIGN_MAX.targetMargin),
        ...(!partial ? currency(d) : {}),
      };
    }
    // ADR 1105 D4/D5 — a line's figures are item keys `restoreItemStates` copies
    // from the base (ITEM_BASE_KEYS), so an overlay's translated lines keep them.
    case 'allowanceGap': {
      const lines = objects(d.lines, DESIGN_MAX.gapLines).map((l) => {
        const name = opt(l.name, DESIGN_MAX.label, 'lines.name');
        const allowance = amount(l.allowance, DESIGN_MAX.money);
        const specified = amount(l.specified, DESIGN_MAX.money);
        return name ? { name, ...(allowance !== undefined ? { allowance } : {}), ...(specified !== undefined ? { specified } : {}) } : undefined;
      }).filter((l): l is NonNullable<typeof l> => l !== undefined);
      if (!partial && lines.length === 0) throw required('allowanceGap', 'lines');
      return {
        ...text('label', DESIGN_MAX.label), ...text('allowanceLabel', DESIGN_MAX.label), ...text('specifiedLabel', DESIGN_MAX.label), ...text('note', DESIGN_MAX.note),
        ...(!partial ? currency(d) : {}),
        ...(!partial || has('lines') ? { lines } : {}),
      };
    }
    // ADR 1105 D1 — a project's parties: what each needs and what each sees. A
    // row's tone is kept only with its status word (ADR 1080 D1).
    case 'partyViews': {
      const parties = objects(d.parties, DESIGN_MAX.parties).map((p) => {
        const label = opt(p.label, DESIGN_MAX.label, 'parties.label');
        if (!label) return undefined;
        const needs = (Array.isArray(p.needs) ? p.needs : []).slice(0, DESIGN_MAX.partyNeeds)
          .map((n) => cleanContent(n, DESIGN_MAX.needText, 'parties.needs')).filter((n) => n.length > 0);
        const rows = objects(p.rows, DESIGN_MAX.partyRows).map((r) => {
          const title = opt(r.title, DESIGN_MAX.needText, 'parties.rows.title');
          const meta = opt(r.meta, DESIGN_MAX.needText, 'parties.rows.meta');
          return title ? { title, ...(meta ? { meta } : {}), ...cleanStatus(r) } : undefined;
        }).filter((r): r is NonNullable<typeof r> => r !== undefined);
        const sub = (k: string, max: number): Raw => { const v = opt(p[k], max, `parties.${k}`); return v ? { [k]: v } : {}; };
        return {
          label, ...sub('needsLabel', DESIGN_MAX.label), ...(needs.length > 0 ? { needs } : {}),
          ...sub('viewTitle', DESIGN_MAX.label), ...sub('viewLabel', DESIGN_MAX.label), ...(rows.length > 0 ? { rows } : {}), ...sub('note', DESIGN_MAX.note),
        };
      }).filter((p): p is NonNullable<typeof p> => p !== undefined);
      if (!partial && parties.length === 0) throw required('partyViews', 'parties');
      // `initial` is behaviour, not copy: the base's only (D5).
      const initial = !partial && typeof d.initial === 'number' && Number.isInteger(d.initial) && d.initial > 0 && d.initial < parties.length ? { initial: d.initial } : {};
      return { ...text('label', DESIGN_MAX.label), ...(!partial || has('parties') ? { parties } : {}), ...initial };
    }
    // ADR 1105 D2 — counts by stage. A stage naming a group the section lacks is
    // a 400, not a silent drop. `count` and `group` follow the base (D5).
    case 'stageChart': {
      const groups = objects(d.groups, DESIGN_MAX.chartGroups).map((g) => {
        const key = typeof g.key === 'string' && CHART_KEY_RE.test(g.key) ? g.key : undefined;
        const label = opt(g.label, DESIGN_MAX.label, 'groups.label');
        return key && label ? { key, label } : undefined;
      }).filter((g): g is { key: string; label: string } => g !== undefined);
      const keys = new Set(groups.map((g) => g.key));
      const stages = objects(d.stages, DESIGN_MAX.stages).map((x) => {
        const label = opt(x.label, DESIGN_MAX.label, 'stages.label');
        const count = typeof x.count === 'number' && Number.isInteger(x.count) && x.count >= 0 && x.count <= DESIGN_MAX.stageCount ? x.count : undefined;
        if (!label || count === undefined) return undefined;
        if (!partial && x.group !== undefined && !(typeof x.group === 'string' && keys.has(x.group))) {
          throw new OpenwopError('validation_error', `stageChart: stage "${label}" names a group the section does not have (${String(x.group)}).`, 400, { field: 'stages.group' });
        }
        // A partial (overlay) seldom repeats `groups`; its `group` was copied from
        // the base by `restoreItemStates`, so a well-formed key is kept as is.
        const group = typeof x.group === 'string' && (partial ? CHART_KEY_RE.test(x.group) : keys.has(x.group)) ? x.group : undefined;
        return { label, count, ...(group ? { group } : {}) };
      }).filter((x): x is NonNullable<typeof x> => x !== undefined);
      if (!partial && stages.length === 0) throw required('stageChart', 'stages');
      return {
        ...text('unit', DESIGN_MAX.unit), ...text('note', DESIGN_MAX.note),
        ...(!partial || has('groups') ? { groups } : {}), ...(!partial || has('stages') ? { stages } : {}),
      };
    }
    case 'conversation': {
      const exchanges = objects(d.exchanges, DESIGN_MAX.exchanges).map((x) => {
        const gate = opt(x.gate, DESIGN_MAX.question, 'gate');
        const refs = (Array.isArray(x.refs) ? x.refs : []).slice(0, DESIGN_MAX.refs)
          .map((r) => cleanContent(r, DESIGN_MAX.ref, 'refs')).filter((r) => r.length > 0);
        return {
          q: cleanContent(x.q, DESIGN_MAX.question, 'q'),
          a: cleanContent(x.a, DESIGN_MAX.answer, 'a'),
          ...(refs.length > 0 ? { refs } : {}),
          ...(gate ? { gate } : {}),
        };
      }).filter((x) => x.q.length > 0 && x.a.length > 0);
      if (!partial && exchanges.length === 0) throw required('conversation', 'exchanges');
      return { ...text('title', DESIGN_MAX.label), ...text('subtitle', DESIGN_MAX.label), ...(!partial || has('exchanges') ? { exchanges } : {}) };
    }
    case 'featureIndex': {
      const groups = objects(d.groups, DESIGN_MAX.indexGroups).map((g) => {
        const key = opt(g.key, DESIGN_MAX.indexKey, 'key');
        const lede = opt(g.lede, DESIGN_MAX.note, 'lede');
        const items = objects(g.items, DESIGN_MAX.indexItems).map((it) => {
          const id = opt(it.id, DESIGN_MAX.indexId, 'id');
          return { label: cleanContent(it.label, DESIGN_MAX.label, 'label'), ...(id ? { id } : {}) };
        }).filter((it) => it.label.length > 0);
        return { name: cleanContent(g.name, DESIGN_MAX.label, 'name'), ...(key ? { key } : {}), ...(lede ? { lede } : {}), items };
      }).filter((g) => g.name.length > 0 && g.items.length > 0);
      if (!partial && groups.length === 0) throw required('featureIndex', 'groups');
      const first = typeof d.initial === 'number' && Number.isInteger(d.initial) && d.initial >= 0 && d.initial < groups.length ? { initial: d.initial } : {};
      return { ...text('label', DESIGN_MAX.label), ...(!partial || has('groups') ? { groups } : {}), ...first };
    }
    case 'decisionTree': {
      const id = (v: unknown, f: string): string => {
        const x = opt(v, DESIGN_MAX.nodeId, f);
        return x && /^[A-Za-z0-9_-]+$/.test(x) ? x : '';
      };
      const trees = objects(d.trees, DESIGN_MAX.trees).map((tr) => {
        const nodes = objects(tr.nodes, DESIGN_MAX.treeNodes).map((n) => ({
          id: id(n.id, 'nodes.id'),
          text: cleanContent(n.text, DESIGN_MAX.treeText, 'nodes.text'),
          options: objects(n.options, DESIGN_MAX.treeOptions).map((o) => {
            const next = id(o.next, 'options.next');
            const outcome = opt(o.outcome, DESIGN_MAX.treeText, 'options.outcome');
            return { label: cleanContent(o.label, DESIGN_MAX.label, 'options.label'), ...(next ? { next } : {}), ...(outcome ? { outcome } : {}) };
          }).filter((o) => o.label.length > 0 && (o.next !== undefined || o.outcome !== undefined)),
        })).filter((n) => n.id && n.text && n.options.length > 0);
        // An option may only point at a node in its own tree; anything else is a 400, never a dead click.
        const ids = new Set(nodes.map((n) => n.id));
        for (const n of nodes) for (const o of n.options) {
          if (o.next !== undefined && !ids.has(o.next)) throw new OpenwopError('validation_error', `decisionTree: option "${o.label}" points at a node that does not exist (${o.next}).`, 400, {});
        }
        const evidence = opt(tr.evidence, DESIGN_MAX.treeText, 'evidence');
        return { title: cleanContent(tr.title, DESIGN_MAX.label, 'title'), ...(opt(tr.question, DESIGN_MAX.treeText, 'question') ? { question: opt(tr.question, DESIGN_MAX.treeText, 'question') } : {}), ...(evidence ? { evidence } : {}), nodes };
      }).filter((tr) => tr.title && tr.nodes.length > 0);
      if (!partial && trees.length === 0) throw required('decisionTree', 'trees');
      return { ...(!partial || has('trees') ? { trees } : {}) };
    }
    case 'scheduleSim': {
      // A referential rule an author's save must meet; a stored row is kept as it is (D8).
      const refuse = (message: string): void => {
        if (!stored) throw new OpenwopError('validation_error', message, 400, {});
      };
      // A start date must be a real day; an impossible one (2026-13-01) is dropped, so the
      // section counts in weeks, rather than refused: system rewrites of a stored page
      // (redaction, erasure) re-validate it and must not fail on an old value.
      const realDate = (t: Raw): Raw => {
        const v = typeof t.startDate === 'string' ? t.startDate : undefined;
        if (v === undefined) return t;
        const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
        return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v ? t : {};
      };
      const num = (v: unknown, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), max) : undefined);
      const milestones = objects(d.milestones, DESIGN_MAX.milestones).map((m, i) => {
        const id = opt(m.id, DESIGN_MAX.nodeId, 'milestones.id') ?? `m${i + 1}`;
        const rework = opt(m.rework, DESIGN_MAX.treeText, 'milestones.rework');
        const items = (Array.isArray(m.items) ? m.items : []).slice(0, 8).map((x) => cleanContent(x, DESIGN_MAX.label, 'milestones.items')).filter(Boolean);
        return {
          id, label: cleanContent(m.label, DESIGN_MAX.label, 'milestones.label'),
          startWeek: num(m.startWeek, DESIGN_MAX.weeks) ?? 0, weeks: Math.max(num(m.weeks, DESIGN_MAX.weeks) ?? 1, 1), floatDays: num(m.floatDays, DESIGN_MAX.delayDays) ?? 0,
          ...(rework ? { rework } : {}), ...(items.length > 0 ? { items } : {}),
        };
      }).filter((m) => m.label.length > 0);
      const ids = new Set(milestones.map((m) => m.id));
      // ADR 1112: the model keys every milestone and decision by id, so a repeated id would
      // silently merge two of them (one's lateness erased, one setting for both).
      if (ids.size < milestones.length) refuse(`scheduleSim: two milestones share an id (${firstRepeat(milestones.map((m) => m.id))}).`);
      // ADR 1112 D2: phases, categories and roles, each a key and a label. A decision names
      // them by key, so a key is closed-world like a milestone id. An overlay that leaves a
      // list out is not checked against it (it translates labels; the base holds the keys).
      const keyed = (name: 'phases' | 'categories' | 'roles'): { key: string; label: string }[] => {
        const rows = objects(d[name], DESIGN_MAX.simGroups).map((k) => ({ key: opt(k.key, DESIGN_MAX.nodeId, `${name}.key`) ?? '', label: cleanContent(k.label, DESIGN_MAX.label, `${name}.label`) }))
          .filter((k) => k.key && k.label);
        // `|` joins a phase and a category into one cell key in the renderer.
        if (rows.some((k) => k.key.includes('|'))) refuse(`scheduleSim: a key in ${name} contains "|".`);
        if (new Set(rows.map((k) => k.key)).size < rows.length) refuse(`scheduleSim: two ${name} share a key (${firstRepeat(rows.map((k) => k.key))}).`);
        return rows;
      };
      const phases = keyed('phases');
      const categories = keyed('categories');
      const roles = keyed('roles');
      const groupKeys = { phase: [phases], category: [categories], role: [roles] } as const;
      const groupRef = (field: keyof typeof groupKeys, v: unknown, where: string): string | undefined => {
        const key = opt(v, DESIGN_MAX.nodeId, `${where}.${field}`);
        const [rows] = groupKeys[field];
        if (key && !partial && !rows.some((k) => k.key === key)) refuse(`scheduleSim: ${where} names a ${field} that does not exist (${key}).`);
        return key;
      };
      const decisions = objects(d.decisions, DESIGN_MAX.simDecisions).map((x) => {
        const milestone = opt(x.milestone, DESIGN_MAX.nodeId, 'decisions.milestone') ?? '';
        // A translation's references come from the base (`alignSimOverlay` + the restore), so only the base is checked.
        if (milestone && !partial && !ids.has(milestone)) refuse(`scheduleSim: decision "${String(x.title)}" names a milestone that does not exist (${milestone}).`);
        const owner = opt(x.owner, DESIGN_MAX.status, 'decisions.owner');
        const note = opt(x.note, DESIGN_MAX.treeText, 'decisions.note');
        // The richer fields: a real element and who decides, how long the item takes
        // to arrive, whether its lock is the day it is needed on site (`back`, ADR 1112
        // D1), what it waits on, and what goes wrong if it is late. All optional.
        // `choices` belonged to the live mode ADR 1112 D3 removed; it is no longer kept.
        const id = opt(x.id, DESIGN_MAX.nodeId, 'decisions.id');
        const element = opt(x.element, DESIGN_MAX.label, 'decisions.element');
        const decider = opt(x.decider, DESIGN_MAX.status, 'decisions.decider');
        const risk = opt(x.risk, DESIGN_MAX.riskText, 'decisions.risk');
        const source = opt(x.source, DESIGN_MAX.status, 'decisions.source');
        const dependsOn = (Array.isArray(x.dependsOn) ? x.dependsOn : []).slice(0, DESIGN_MAX.simDeps)
          .map((c) => opt(c, DESIGN_MAX.nodeId, 'decisions.dependsOn')).filter((c): c is string => Boolean(c));
        const leadDays = num(x.leadDays, DESIGN_MAX.delayDays);
        const lockWeek = num(x.lockWeek, DESIGN_MAX.weeks);
        const where = `decision "${String(x.title)}"`;
        const phase = groupRef('phase', x.phase, where);
        const category = groupRef('category', x.category, where);
        const role = groupRef('role', x.role, where);
        return {
          title: cleanContent(x.title, DESIGN_MAX.label, 'decisions.title'), milestone,
          kind: pick(SIM_KINDS, x.kind) ?? 'selection', ...(owner ? { owner } : {}), ...(note ? { note } : {}),
          // Kept only when there are some: at 1,500 decisions an empty list on each is ~20 kB.
          ...((): Raw => {
            const options = objects(x.options, DESIGN_MAX.simOptions).map((o) => ({ label: cleanContent(o.label, DESIGN_MAX.status, 'options.label'), delayDays: num(o.delayDays, DESIGN_MAX.delayDays) ?? 0 })).filter((o) => o.label.length > 0);
            return options.length > 0 ? { options } : {};
          })(),
          ...(id ? { id } : {}), ...(element ? { element } : {}), ...(decider ? { decider } : {}), ...(risk ? { risk } : {}), ...(source ? { source } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}), ...(x.back === true ? { back: true } : {}),
          ...(leadDays !== undefined ? { leadDays } : {}), ...(x.leadUnknown === true ? { leadUnknown: true } : {}),
          ...(lockWeek !== undefined ? { lockWeek } : {}),
          ...(phase ? { phase } : {}), ...(category ? { category } : {}), ...(role ? { role } : {}),
        };
        // Options are optional (ADR 1112 D2): a grouped catalog sets lateness by role or cell.
      }).filter((x) => x.title && x.milestone);
      // A dependency must name a decision in this section; anything else is a 400, never a silent no-op.
      const decisionIds = new Set(decisions.map((x) => x.id).filter(Boolean));
      const named = decisions.filter((x) => x.id).length;
      if (decisionIds.size < named) refuse(`scheduleSim: two decisions share an id (${firstRepeat(decisions.map((x) => x.id).filter((id): id is string => Boolean(id)))}).`);
      // ADR 1112 D6 — every stored decision has an id, so a translation is matched to it by
      // id: one minted here (d1, d2, … skipping ids in use) is kept from then on. Not in an
      // overlay, whose ids come from the base.
      if (!partial) {
        let n = 0;
        for (const x of decisions) {
          if (x.id) continue;
          do n += 1; while (decisionIds.has(`d${n}`));
          x.id = `d${n}`;
          decisionIds.add(x.id);
        }
      }
      if (!partial) for (const x of decisions) for (const dep of x.dependsOn ?? []) {
        if (!decisionIds.has(dep)) refuse(`scheduleSim: decision "${x.title}" depends on a decision that does not exist (${dep}).`);
      }
      const presets = objects(d.presets, DESIGN_MAX.simPresets).map((pr) => {
        const label = opt(pr.label, DESIGN_MAX.status, 'presets.label');
        const description = opt(pr.description, DESIGN_MAX.choiceText, 'presets.description');
        const rules = objects(pr.rules, DESIGN_MAX.presetRules).map((r) => {
          const kind = pick(SIM_KINDS, r.kind);
          // An unknown kind drops the rule; it must never widen into "every decision".
          if (r.kind !== undefined && !kind) return undefined;
          const decider = opt(r.decider, DESIGN_MAX.status, 'presets.rules.decider');
          const minLeadDays = num(r.minLeadDays, DESIGN_MAX.delayDays);
          // A rule naming a role, phase or category the section lacks is dropped, like an unknown kind.
          const group: Raw = {};
          for (const field of ['role', 'phase', 'category'] as const) {
            if (r[field] === undefined) continue;
            const key = opt(r[field], DESIGN_MAX.nodeId, `presets.rules.${field}`);
            const [rows] = groupKeys[field];
            if (!key || (!partial && !rows.some((k) => k.key === key))) return undefined;
            group[field] = key;
          }
          return { delayDays: num(r.delayDays, DESIGN_MAX.delayDays) ?? 0, ...(kind ? { kind } : {}), ...(decider ? { decider } : {}), ...(minLeadDays !== undefined ? { minLeadDays } : {}), ...group };
        }).filter((r): r is NonNullable<typeof r> => r !== undefined);
        return label ? { label, ...(description ? { description } : {}), rules } : undefined;
      }).filter((pr): pr is NonNullable<typeof pr> => pr !== undefined);
      if (!partial && (milestones.length === 0 || decisions.length === 0)) throw required('scheduleSim', 'milestones and decisions');
      return {
        // The start date is behaviour, not copy: the base holds it (ADR 1112 P2).
        ...(partial ? {} : realDate(text('startDate', 10))), ...text('note', DESIGN_MAX.note), ...text('finishLabel', DESIGN_MAX.label),
        ...(phases.length > 0 ? { phases } : {}), ...(categories.length > 0 ? { categories } : {}), ...(roles.length > 0 ? { roles } : {}),
        ...(!partial || has('milestones') ? { milestones } : {}), ...(!partial || has('decisions') ? { decisions } : {}),
        ...(presets.length > 0 ? { presets } : {}),
        // #5779 B5 — keep the summary in view while settings change. Off by default;
        // anything but `true` is dropped. Behaviour, not copy: the base holds it, a
        // locale overlay never does. (`startMode` is no longer kept: ADR 1112 D3 left
        // one view, so there is no mode to open on.)
        ...(!partial && d.stickySummary === true ? { stickySummary: true } : {}),
        // UXG-1112-7 — the cost of delay's currency (ISO 4217, else dropped; the page reads USD).
        // Behaviour, not copy: the base holds it, as marginCalc's does.
        ...(!partial ? currency(d) : {}),
      };
    }
  }
}

/** ADR 1080 D7 — the hero's `queue` picture: a titled list beside the copy. */
export function cleanHeroQueue(raw: unknown): Raw | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const q = raw as Raw;
  const title = opt(q.title, DESIGN_MAX.label, 'queue.title');
  const rows = objects(q.rows, DESIGN_MAX.queueRows).map((r) => {
    const id = opt(r.id, DESIGN_MAX.indexId, 'queue.id');
    const meta = opt(r.meta, DESIGN_MAX.label, 'queue.meta');
    return { title: cleanContent(r.title, DESIGN_MAX.label, 'queue.title'), ...(id ? { id } : {}), ...(meta ? { meta } : {}), ...cleanStatus(r) };
  }).filter((r) => r.title.length > 0);
  if (!title || rows.length === 0) return undefined;
  const label = opt(q.label, DESIGN_MAX.status, 'queue.label');
  const note = opt(q.note, DESIGN_MAX.note, 'queue.note');
  return { title, rows, ...(label ? { label } : {}), ...(note ? { note } : {}) };
}

/** ADR 1080 D8 — the richText `card` picture. Its links go through the caller's guard. */
export function cleanRichTextCard(raw: unknown, safeLink: (v: unknown, max: number) => string): Raw | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const c = raw as Raw;
  const title = opt(c.title, DESIGN_MAX.label, 'card.title');
  if (!title) return undefined;
  const imageToken = cleanOpaqueToken(c.imageToken, DESIGN_MAX.token);
  const alt = opt(c.alt, DESIGN_MAX.alt, 'card.alt');
  if (imageToken && !alt) throw new OpenwopError('validation_error', 'richText.card.alt is required when the card has an imageToken.', 400, {});
  const actions = objects(c.actions, DESIGN_MAX.cardActions).map((a) => {
    const label = opt(a.label, DESIGN_MAX.status, 'card.actions.label');
    return label ? { label, url: safeLink(a.url, 2048), ...(a.primary === true ? { primary: true } : {}) } : undefined;
  }).filter((a): a is { label: string; url: string; primary?: boolean } => a !== undefined);
  const eyebrow = opt(c.eyebrow, DESIGN_MAX.status, 'card.eyebrow');
  const body = opt(c.body, DESIGN_MAX.body, 'card.body');
  const note = opt(c.note, DESIGN_MAX.note, 'card.note');
  return {
    title,
    ...(imageToken ? { imageToken, alt } : {}),
    ...(eyebrow ? { eyebrow } : {}), ...(body ? { body } : {}), ...(note ? { note } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/**
 * ADR 1112 D5: what crawlers and the markdown export get from a `scheduleSim`, which can
 * hold 1,500 decisions: each milestone with its planned start (ISO, from `startDate`) and
 * its rework, a count of decisions per phase when the section is grouped, and the
 * decisions themselves only for a small section (80 or fewer).
 */
function simProjection(d: Raw): { milestones: { label: string; start: string; rework: string }[]; phases: { label: string; n: number }[]; rows: Raw[] } {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(str(d.startDate)) ? Date.parse(`${str(d.startDate)}T00:00:00Z`) : Number.NaN;
  const start = Number.isFinite(parsed) ? parsed : null; // a stored impossible date never breaks the page
  const decisions = objects(d.decisions, DESIGN_MAX.simDecisions);
  const milestones = objects(d.milestones, DESIGN_MAX.milestones).map((m) => ({
    label: str(m.label), rework: str(m.rework),
    start: start === null ? '' : new Date(start + (typeof m.startWeek === 'number' ? m.startWeek : 0) * 7 * 86_400_000).toISOString().slice(0, 10),
  }));
  const phases = objects(d.phases, DESIGN_MAX.simGroups).map((p) => ({ label: str(p.label), n: decisions.filter((x) => x.phase === p.key).length })).filter((p) => p.label && p.n > 0);
  const rows = decisions.length <= 80 ? decisions.filter((x) => str(x.element) || str(x.risk)) : [];
  return { milestones, phases, rows };
}

/** The crawler and no-JS view: every authored row, group and answer, as static HTML. */
export function designSectionHtml(type: string, d: Raw, head: string, escapeHtml: (s: string) => string): string | null {
  if (!isDesignSectionType(type)) return null;
  const e = escapeHtml;
  switch (type) {
    case 'films':
      // ADR 1082 — each film as a figure crawlers read; its VideoObject rides jsonLdBlocks.
      return `<section>\n${head}<ul>${objects(d.films, DESIGN_MAX.films).map((f) =>
        `<li><figure>${/^https:\/\//i.test(str(f.poster)) ? `<img src="${e(str(f.poster))}" alt="${e(str(f.title))}">` : ''}<figcaption><strong>${e(str(f.title))}</strong>${str(f.length) ? ` (${e(str(f.length))})` : ''}${str(f.description) ? `. ${e(str(f.description))}` : ''}${/^https:\/\//i.test(str(f.src)) ? ` <a href="${e(str(f.src))}">${e(str(f.title))}</a>` : ''}</figcaption></figure></li>`).join('')}</ul>\n</section>`;
    case 'statusTable': {
      const rows = objects(d.rows, DESIGN_MAX.tableRows);
      const hasStatus = rows.some((r) => str(r.status));
      const headRow = [...strings(d.columns), ...(hasStatus ? ['Status'] : [])].map((c) => `<th>${e(c)}</th>`).join('');
      const body = rows.map((r) => `<tr>${[...strings(r.cells), ...(hasStatus ? [str(r.status)] : [])].map((c) => `<td>${e(c)}</td>`).join('')}</tr>`).join('\n');
      const points = strings(d.points).map((x) => `<li>${e(x)}</li>`).join('');
      return `<section>\n${head}${points ? `<ul>${points}</ul>\n` : ''}<table><thead><tr>${headRow}</tr></thead><tbody>\n${body}\n</tbody></table>\n</section>`;
    }
    case 'dateCalc':
      return `<section>\n${head}${str(d.note) ? `<p>${e(str(d.note))}</p>\n` : ''}</section>`;
    // ADR 1105 D6 — the worked answer for the authored figures, not an empty form.
    case 'marginCalc':
      return `<section>\n${head}<dl>${marginFacts(d).map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>${str(d.note) ? `\n<p>${e(str(d.note))}</p>` : ''}\n</section>`;
    case 'allowanceGap': {
      const { rows, total } = gapFacts(d);
      return `<section>\n${head}<table><thead><tr>${rows[0]!.map((c) => `<th>${e(c)}</th>`).join('')}</tr></thead><tbody>\n${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join('')}</tr>`).join('\n')}\n</tbody></table>\n<p>${e(total)}</p>${str(d.note) ? `\n<p>${e(str(d.note))}</p>` : ''}\n</section>`;
    }
    // ADR 1105 D9 — every party, so a crawler reads all of them.
    case 'partyViews':
      return `<section>\n${head}${objects(d.parties, DESIGN_MAX.parties).map((p) => {
        const rows = objects(p.rows, DESIGN_MAX.partyRows);
        return `<h3>${e(str(p.label))}</h3>${strings(p.needs).length > 0 ? `\n${str(p.needsLabel) ? `<p>${e(str(p.needsLabel))}</p>\n` : ''}<ul>${strings(p.needs).map((n) => `<li>${e(n)}</li>`).join('')}</ul>` : ''}${rows.length > 0
          ? `\n${str(p.viewTitle) ? `<p>${e(str(p.viewTitle))}</p>\n` : ''}<ul>${rows.map((r) => `<li>${e(str(r.title))}${str(r.status) ? ` (${e(str(r.status))})` : ''}${str(r.meta) ? `: ${e(str(r.meta))}` : ''}</li>`).join('')}</ul>` : ''}${str(p.note) ? `\n<p>${e(str(p.note))}</p>` : ''}`;
      }).join('\n')}\n</section>`;
    case 'stageChart': {
      const unit = str(d.unit);
      return `<section>\n${head}<ol>${objects(d.stages, DESIGN_MAX.stages).map((x) => `<li>${e(str(x.label))}: ${e(countText(x.count, unit))}</li>`).join('')}</ol>${chartTotals(d).length > 0
        ? `\n<ul>${chartTotals(d).map((g) => `<li>${e(g.label)}: ${e(countText(g.total, unit))}</li>`).join('')}</ul>` : ''}${str(d.note) ? `\n<p>${e(str(d.note))}</p>` : ''}\n</section>`;
    }
    case 'conversation':
      return `<section>\n${head}${objects(d.exchanges, DESIGN_MAX.exchanges).map((x) =>
        `<h3>${e(str(x.q))}</h3>\n<p>${e(str(x.a))}</p>${str(x.gate) ? `\n<p>${e(str(x.gate))}</p>` : ''}`).join('\n')}\n</section>`;
    case 'decisionTree':
      return `<section>\n${head}${objects(d.trees, DESIGN_MAX.trees).map((tr) =>
        `<h3>${e(str(tr.title))}</h3>\n${str(tr.question) ? `<p>${e(str(tr.question))}</p>\n` : ''}<ol>${objects(tr.nodes, DESIGN_MAX.treeNodes).map((n) =>
          `<li>${e(str(n.text))}<ul>${objects(n.options, DESIGN_MAX.treeOptions).map((o) => `<li>${e(str(o.label))}${str(o.outcome) ? `: ${e(str(o.outcome))}` : ''}</li>`).join('')}</ul></li>`).join('')}</ol>`).join('\n')}\n</section>`;
    case 'scheduleSim': {
      const sim = simProjection(d);
      return `<section>\n${head}<ol>${sim.milestones.map((m) =>
        `<li>${m.start ? `<time datetime="${m.start}">${m.start}</time> ` : ''}${e(m.label)}${m.rework ? ` (if late: ${e(m.rework)})` : ''}</li>`).join('')}</ol>${sim.phases.length > 0
        ? `\n<ul>${sim.phases.map((p) => `<li>${e(p.label)}: ${p.n} decisions</li>`).join('')}</ul>` : ''}${sim.rows.length > 0
        ? `\n<ul>${sim.rows.map((x) => `<li>${e(str(x.element) || str(x.title))}: ${e(str(x.title))}${str(x.risk) ? `. ${e(str(x.risk))}` : ''}</li>`).join('')}</ul>` : ''}${str(d.note) ? `\n<p>${e(str(d.note))}</p>` : ''}\n</section>`;
    }
    case 'featureIndex':
      return `<section>\n${head}${objects(d.groups, DESIGN_MAX.indexGroups).map((g) =>
        `<h3>${e(str(g.name))}</h3>\n${str(g.lede) ? `<p>${e(str(g.lede))}</p>\n` : ''}<ul>${objects(g.items, DESIGN_MAX.indexItems).map((it) => `<li>${e(str(it.label))}</li>`).join('')}</ul>`).join('\n')}\n</section>`;
  }
}

/** ADR 1105 D6 — the prerender's figures, in English like the other prerender
 *  words (the crawler view has no locale). A missing figure reads "No figure". */
const NO_FIGURE = 'No figure';
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function money(v: number | undefined, cur: string): string {
  if (v === undefined) return NO_FIGURE;
  return cur ? new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
}
const pct = (v: number | undefined): string => (v === undefined ? NO_FIGURE : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(v)}%`);

/** ADR 1105 D2 — a count with its unit ("1,145 decisions"), for the prerender. */
function countText(v: unknown, unit: string): string {
  const n = new Intl.NumberFormat('en-US').format(typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return unit ? `${n} ${unit}` : n;
}

/** ADR 1105 D2 — each group with the sum of its stages, in group order; empty groups left out. */
export function chartTotals(d: Raw): { key: string; label: string; total: number }[] {
  const stages = objects(d.stages, DESIGN_MAX.stages);
  return objects(d.groups, DESIGN_MAX.chartGroups)
    .map((g) => ({ key: str(g.key), label: str(g.label), total: stages.filter((x) => x.group === g.key).reduce((sum, x) => sum + (num(x.count) ?? 0), 0) }))
    .filter((g) => g.label && g.total > 0);
}

function marginFacts(d: Raw): [string, string][] {
  const cur = str(d.currency);
  const r = computeMargin({ cost: num(d.cost), markup: num(d.markup), target: num(d.target) });
  return [
    [str(d.costLabel) || 'Cost', money(num(d.cost), cur)],
    [str(d.markupLabel) || 'Markup', pct(num(d.markup))],
    ['Client price', money(r.price, cur)],
    ['Gross margin', pct(r.margin)],
    ...(num(d.target) !== undefined ? [[str(d.targetLabel) || 'Target margin', pct(num(d.target))], ['Markup for the target', pct(r.markupForTarget)]] as [string, string][] : []),
  ];
}

function gapFacts(d: Raw): { rows: string[][]; total: string } {
  const cur = str(d.currency);
  const lines: GapLine[] = objects(d.lines, DESIGN_MAX.gapLines).map((l) => ({ name: str(l.name), ...(num(l.allowance) !== undefined ? { allowance: num(l.allowance) } : {}), ...(num(l.specified) !== undefined ? { specified: num(l.specified) } : {}) }));
  const g = computeGaps(lines);
  const rows = [
    [str(d.label) || 'Line', str(d.allowanceLabel) || 'Allowance', str(d.specifiedLabel) || 'Expected', 'Over by'],
    ...g.rows.map((r) => [r.name, money(r.allowance, cur), money(r.specified, cur), r.over === undefined ? NO_FIGURE : r.over > 0 ? money(r.over, cur) : 'Within']),
  ];
  return { rows, total: `Over the allowance: ${money(g.totalOver, cur)} on ${g.linesOver} of ${lines.length} lines${g.linesMissing > 0 ? ` (${g.linesMissing} without a figure)` : ''}. Lines under their allowance are not netted.` };
}

/** The markdown projection, also used by shared links. */
export function designSectionMarkdown(type: string, d: Raw, head: string): string | null {
  if (!isDesignSectionType(type)) return null;
  switch (type) {
    case 'films':
      return `${head}${objects(d.films, DESIGN_MAX.films).map((f) =>
        `- **${str(f.title)}**${str(f.length) ? ` (${str(f.length)})` : ''}${str(f.description) ? `: ${str(f.description)}` : ''}${/^https:\/\//i.test(str(f.src)) ? ` [Watch](${str(f.src)})` : ''}`).join('\n')}`;
    case 'statusTable': {
      const rows = objects(d.rows, DESIGN_MAX.tableRows);
      const hasStatus = rows.some((r) => str(r.status));
      const cols = [...strings(d.columns), ...(hasStatus ? ['Status'] : [])];
      const row = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
      const points = strings(d.points).map((x) => `- ${x}`).join('\n');
      return `${head}${points ? `${points}\n\n` : ''}${[row(cols), row(cols.map(() => '---')), ...rows.map((r) => row([...strings(r.cells), ...(hasStatus ? [str(r.status)] : [])]))].join('\n')}`;
    }
    case 'dateCalc':
      return `${head}${str(d.note)}`.trim();
    case 'marginCalc':
      return `${head}${marginFacts(d).map(([k, v]) => `- ${k}: ${v}`).join('\n')}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
    case 'allowanceGap': {
      const { rows, total } = gapFacts(d);
      const row = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
      return `${head}${[row(rows[0]!), row(rows[0]!.map(() => '---')), ...rows.slice(1).map(row)].join('\n')}\n\n${total}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
    }
    case 'partyViews':
      return `${head}${objects(d.parties, DESIGN_MAX.parties).map((p) =>
        `### ${str(p.label)}${strings(p.needs).length > 0 ? `\n\n${strings(p.needs).map((n) => `- ${n}`).join('\n')}` : ''}${objects(p.rows, DESIGN_MAX.partyRows).length > 0
          ? `\n\n${objects(p.rows, DESIGN_MAX.partyRows).map((r) => `- ${str(r.title)}${str(r.status) ? ` (${str(r.status)})` : ''}${str(r.meta) ? `: ${str(r.meta)}` : ''}`).join('\n')}` : ''}${str(p.note) ? `\n\n${str(p.note)}` : ''}`).join('\n\n')}`;
    case 'stageChart': {
      const unit = str(d.unit);
      return `${head}${objects(d.stages, DESIGN_MAX.stages).map((x, i) => `${i + 1}. ${str(x.label)}: ${countText(x.count, unit)}`).join('\n')}${chartTotals(d).length > 0
        ? `\n\n${chartTotals(d).map((g) => `- ${g.label}: ${countText(g.total, unit)}`).join('\n')}` : ''}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
    }
    case 'conversation':
      return `${head}${objects(d.exchanges, DESIGN_MAX.exchanges).map((x) =>
        `### ${str(x.q)}\n\n${str(x.a)}${str(x.gate) ? `\n\n${str(x.gate)}` : ''}`).join('\n\n')}`;
    case 'decisionTree':
      return `${head}${objects(d.trees, DESIGN_MAX.trees).map((tr) =>
        `### ${str(tr.title)}\n\n${objects(tr.nodes, DESIGN_MAX.treeNodes).map((n) =>
          `- ${str(n.text)}\n${objects(n.options, DESIGN_MAX.treeOptions).map((o) => `  - ${str(o.label)}${str(o.outcome) ? `: ${str(o.outcome)}` : ''}`).join('\n')}`).join('\n')}`).join('\n\n')}`;
    case 'scheduleSim': {
      const sim = simProjection(d);
      return `${head}${sim.milestones.map((m, i) => `${i + 1}. ${m.start ? `${m.start} ` : ''}${m.label}${m.rework ? ` (if late: ${m.rework})` : ''}`).join('\n')}${sim.phases.length > 0
        ? `\n\n${sim.phases.map((p) => `- ${p.label}: ${p.n} decisions`).join('\n')}` : ''}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
    }
    case 'featureIndex':
      return `${head}${objects(d.groups, DESIGN_MAX.indexGroups).map((g) =>
        `### ${str(g.name)}\n\n${str(g.lede) ? `${str(g.lede)}\n\n` : ''}${objects(g.items, DESIGN_MAX.indexItems).map((it) => `- ${str(it.label)}`).join('\n')}`).join('\n\n')}`;
  }
}

/** ADR 1080 D7 — the hero queue as real text for crawlers. Only when it is the visual shown. */
export function heroQueueHtml(raw: unknown, escapeHtml: (s: string) => string): string {
  const q = cleanHeroQueueForRender(raw);
  if (!q) return '';
  const rows = q.rows.map((r) => `<li>${[r.id, r.title, r.meta, r.status].filter(Boolean).map(escapeHtml).join(' · ')}</li>`).join('');
  return `<figure><figcaption>${escapeHtml(q.title)}</figcaption><ul>${rows}</ul>${q.note ? `<p>${escapeHtml(q.note)}</p>` : ''}</figure>`;
}

/** ADR 1080 D8 — the richText card as real text for crawlers. */
export function richTextCardHtml(raw: unknown, escapeHtml: (s: string) => string, imageUrl: (token: string) => string): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const c = raw as Raw;
  if (!str(c.title)) return '';
  const img = str(c.imageToken) ? `<img src="${escapeHtml(imageUrl(str(c.imageToken)))}" alt="${escapeHtml(str(c.alt))}">\n` : '';
  const lines = [str(c.eyebrow), str(c.body), str(c.note)].filter(Boolean).map((t) => `<p>${escapeHtml(t)}</p>`).join('\n');
  return `<article>\n${img}<h3>${escapeHtml(str(c.title))}</h3>\n${lines}\n</article>\n`;
}

function cleanHeroQueueForRender(raw: unknown): { title: string; note: string; rows: { id: string; title: string; meta: string; status: string }[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const q = raw as Raw;
  const rows = objects(q.rows, DESIGN_MAX.queueRows).map((r) => ({ id: str(r.id), title: str(r.title), meta: str(r.meta), status: str(r.status) })).filter((r) => r.title);
  return str(q.title) && rows.length > 0 ? { title: str(q.title), note: str(q.note), rows } : null;
}
