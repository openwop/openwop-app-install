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
 *   hero `queue`  a titled list of rows with a worded status           (D7)
 *   richText `card`  a card with a picture, words and two link actions (D8)
 *
 * The same posture as the stock types: closed fields, bounded plain text, links
 * through the caller's `safeLink`. `partial` (a locale overlay) keeps only the
 * fields present and skips the required-field checks.
 */
import { cleanContent, cleanOpaqueToken, optionalCleanContent } from '../../host/boundedStrings.js';
import { isValidUploadDate } from '../../host/videoUploadDate.js';
import { OpenwopError } from '../../types.js';

export const DESIGN_SECTION_TYPES = ['statusTable', 'dateCalc', 'conversation', 'featureIndex', 'decisionTree', 'scheduleSim', 'films'] as const;

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
  label: 120, cell: 120, status: 40, note: 400, question: 200, answer: 800, ref: 40, alt: 200, token: 256, body: 600,
  tableColumns: 6, tableRows: 24, exchanges: 8, refs: 6, numberCeiling: 520,
  indexGroups: 24, indexItems: 16, indexKey: 8, indexId: 24,
  queueRows: 6, cardActions: 2,
  trees: 16, treeNodes: 16, treeOptions: 6, treeText: 300, nodeId: 40,
  films: 24, useCase: 40, filmTitle: 160, filmDescription: 1000, // the `video` caps (MAX.title, MAX.videoDescription)
  milestones: 24, simDecisions: 80, simOptions: 4, weeks: 260, delayDays: 365,
  simChoices: 5, simDeps: 6, simPresets: 6, presetRules: 6, choiceText: 160, riskText: 400,
} as const;

const SIM_KINDS = ['selection', 'approval', 'payment', 'response'] as const;

/** The status words' colors. Color always repeats the word, never replaces it. */
export const STATUS_TONES = ['ok', 'warn', 'bad', 'muted'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const objects = (v: unknown, cap: number): Raw[] =>
  (Array.isArray(v) ? v : []).slice(0, cap).filter((x): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x));
const pick = <T extends string>(set: readonly T[], v: unknown): T | undefined => set.find((s) => s === v);
const required = (type: string, what: string): OpenwopError =>
  new OpenwopError('validation_error', `${type}.${what} is required.`, 400, {});
const opt = (v: unknown, max: number, field: string): string | undefined => optionalCleanContent(v, max, field);

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
export function buildDesignSectionData(type: DesignSectionType, d: Raw, partial: boolean, mediaUrl?: MediaUrlRule): Raw {
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
      return {
        ...text('label', DESIGN_MAX.label),
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
      const decisions = objects(d.decisions, DESIGN_MAX.simDecisions).map((x) => {
        const milestone = opt(x.milestone, DESIGN_MAX.nodeId, 'decisions.milestone') ?? '';
        if (milestone && !ids.has(milestone)) throw new OpenwopError('validation_error', `scheduleSim: decision "${String(x.title)}" names a milestone that does not exist (${milestone}).`, 400, {});
        const owner = opt(x.owner, DESIGN_MAX.status, 'decisions.owner');
        const note = opt(x.note, DESIGN_MAX.treeText, 'decisions.note');
        // The richer fields drive the live mode: a real element and its options,
        // who decides, how long the item takes to arrive, what it waits on, and
        // what goes wrong if it is late. All optional; plain decisions still work.
        const id = opt(x.id, DESIGN_MAX.nodeId, 'decisions.id');
        const element = opt(x.element, DESIGN_MAX.label, 'decisions.element');
        const decider = opt(x.decider, DESIGN_MAX.status, 'decisions.decider');
        const risk = opt(x.risk, DESIGN_MAX.riskText, 'decisions.risk');
        const source = opt(x.source, DESIGN_MAX.status, 'decisions.source');
        const choices = (Array.isArray(x.choices) ? x.choices : []).slice(0, DESIGN_MAX.simChoices)
          .map((c) => cleanContent(c, DESIGN_MAX.choiceText, 'decisions.choices')).filter(Boolean);
        const dependsOn = (Array.isArray(x.dependsOn) ? x.dependsOn : []).slice(0, DESIGN_MAX.simDeps)
          .map((c) => opt(c, DESIGN_MAX.nodeId, 'decisions.dependsOn')).filter((c): c is string => Boolean(c));
        const leadDays = num(x.leadDays, DESIGN_MAX.delayDays);
        const lockWeek = num(x.lockWeek, DESIGN_MAX.weeks);
        return {
          title: cleanContent(x.title, DESIGN_MAX.label, 'decisions.title'), milestone,
          kind: pick(SIM_KINDS, x.kind) ?? 'selection', ...(owner ? { owner } : {}), ...(note ? { note } : {}),
          options: objects(x.options, DESIGN_MAX.simOptions).map((o) => ({ label: cleanContent(o.label, DESIGN_MAX.status, 'options.label'), delayDays: num(o.delayDays, DESIGN_MAX.delayDays) ?? 0 })).filter((o) => o.label.length > 0),
          ...(id ? { id } : {}), ...(element ? { element } : {}), ...(decider ? { decider } : {}), ...(risk ? { risk } : {}), ...(source ? { source } : {}),
          ...(choices.length > 0 ? { choices } : {}), ...(dependsOn.length > 0 ? { dependsOn } : {}),
          ...(leadDays !== undefined ? { leadDays } : {}), ...(x.leadUnknown === true ? { leadUnknown: true } : {}),
          ...(lockWeek !== undefined ? { lockWeek } : {}),
        };
      }).filter((x) => x.title && x.milestone && x.options.length > 0);
      // A dependency must name a decision in this section; anything else is a 400, never a silent no-op.
      const decisionIds = new Set(decisions.map((x) => x.id).filter(Boolean));
      for (const x of decisions) for (const dep of x.dependsOn ?? []) {
        if (!decisionIds.has(dep)) throw new OpenwopError('validation_error', `scheduleSim: decision "${x.title}" depends on a decision that does not exist (${dep}).`, 400, {});
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
          return { delayDays: num(r.delayDays, DESIGN_MAX.delayDays) ?? 0, ...(kind ? { kind } : {}), ...(decider ? { decider } : {}), ...(minLeadDays !== undefined ? { minLeadDays } : {}) };
        }).filter((r): r is NonNullable<typeof r> => r !== undefined);
        return label ? { label, ...(description ? { description } : {}), rules } : undefined;
      }).filter((pr): pr is NonNullable<typeof pr> => pr !== undefined);
      if (!partial && (milestones.length === 0 || decisions.length === 0)) throw required('scheduleSim', 'milestones and decisions');
      return {
        ...text('startDate', 10), ...text('note', DESIGN_MAX.note), ...text('finishLabel', DESIGN_MAX.label),
        ...(!partial || has('milestones') ? { milestones } : {}), ...(!partial || has('decisions') ? { decisions } : {}),
        ...(presets.length > 0 ? { presets } : {}),
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
      return `<section>\n${head}<table><thead><tr>${headRow}</tr></thead><tbody>\n${body}\n</tbody></table>\n</section>`;
    }
    case 'dateCalc':
      return `<section>\n${head}${str(d.note) ? `<p>${e(str(d.note))}</p>\n` : ''}</section>`;
    case 'conversation':
      return `<section>\n${head}${objects(d.exchanges, DESIGN_MAX.exchanges).map((x) =>
        `<h3>${e(str(x.q))}</h3>\n<p>${e(str(x.a))}</p>${str(x.gate) ? `\n<p>${e(str(x.gate))}</p>` : ''}`).join('\n')}\n</section>`;
    case 'decisionTree':
      return `<section>\n${head}${objects(d.trees, DESIGN_MAX.trees).map((tr) =>
        `<h3>${e(str(tr.title))}</h3>\n${str(tr.question) ? `<p>${e(str(tr.question))}</p>\n` : ''}<ol>${objects(tr.nodes, DESIGN_MAX.treeNodes).map((n) =>
          `<li>${e(str(n.text))}<ul>${objects(n.options, DESIGN_MAX.treeOptions).map((o) => `<li>${e(str(o.label))}${str(o.outcome) ? `: ${e(str(o.outcome))}` : ''}</li>`).join('')}</ul></li>`).join('')}</ol>`).join('\n')}\n</section>`;
    case 'scheduleSim':
      return `<section>\n${head}<ol>${objects(d.milestones, DESIGN_MAX.milestones).map((m) =>
        `<li>${e(str(m.label))}${str(m.rework) ? ` (if late: ${e(str(m.rework))})` : ''}</li>`).join('')}</ol>${objects(d.decisions, DESIGN_MAX.simDecisions).filter((x) => str(x.element) || str(x.risk)).length > 0
        ? `\n<ul>${objects(d.decisions, DESIGN_MAX.simDecisions).filter((x) => str(x.element) || str(x.risk)).map((x) => `<li>${e(str(x.element) || str(x.title))}: ${e(str(x.title))}${str(x.risk) ? `. ${e(str(x.risk))}` : ''}</li>`).join('')}</ul>` : ''}${str(d.note) ? `\n<p>${e(str(d.note))}</p>` : ''}\n</section>`;
    case 'featureIndex':
      return `<section>\n${head}${objects(d.groups, DESIGN_MAX.indexGroups).map((g) =>
        `<h3>${e(str(g.name))}</h3>\n${str(g.lede) ? `<p>${e(str(g.lede))}</p>\n` : ''}<ul>${objects(g.items, DESIGN_MAX.indexItems).map((it) => `<li>${e(str(it.label))}</li>`).join('')}</ul>`).join('\n')}\n</section>`;
  }
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
      return `${head}${[row(cols), row(cols.map(() => '---')), ...rows.map((r) => row([...strings(r.cells), ...(hasStatus ? [str(r.status)] : [])]))].join('\n')}`;
    }
    case 'dateCalc':
      return `${head}${str(d.note)}`.trim();
    case 'conversation':
      return `${head}${objects(d.exchanges, DESIGN_MAX.exchanges).map((x) =>
        `### ${str(x.q)}\n\n${str(x.a)}${str(x.gate) ? `\n\n${str(x.gate)}` : ''}`).join('\n\n')}`;
    case 'decisionTree':
      return `${head}${objects(d.trees, DESIGN_MAX.trees).map((tr) =>
        `### ${str(tr.title)}\n\n${objects(tr.nodes, DESIGN_MAX.treeNodes).map((n) =>
          `- ${str(n.text)}\n${objects(n.options, DESIGN_MAX.treeOptions).map((o) => `  - ${str(o.label)}${str(o.outcome) ? `: ${str(o.outcome)}` : ''}`).join('\n')}`).join('\n')}`).join('\n\n')}`;
    case 'scheduleSim':
      return `${head}${objects(d.milestones, DESIGN_MAX.milestones).map((m, i) => `${i + 1}. ${str(m.label)}${str(m.rework) ? ` (if late: ${str(m.rework)})` : ''}`).join('\n')}${str(d.note) ? `\n\n${str(d.note)}` : ''}`;
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
