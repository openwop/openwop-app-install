/**
 * ADR 0923 — the closed-world validators between the change planner's model
 * output and durable state. They are the safety boundary, not the prompt:
 *  - D2 interpretation: closed schema, ask XOR act, every URL in an intent must
 *    appear verbatim in the operator's request or answers (`value_not_in_request`);
 *  - D5 proposal: edits only to an asset's `editableFields`, `before` equal to
 *    the current value, `find` occurring exactly once, and no URL or email
 *    address in a new value that no intent carries (`edit_not_from_intent`).
 * Pure functions; the services call them, and so does the node's repair loop
 * (through the surface), so there is one definition.
 */
import { applyEdit } from './adapters/cmsPage.js';
import type { ConstrainedEdit, Intent, Interpretation, Question } from './types.js';

export const MAX_INTENTS = 10;
export const MAX_QUESTIONS = 5;
export const MAX_EDITS_PER_ASSET = 20;
const MAX_STR = 2000;

export interface ValidationFailure { ok: false; errors: string[] }

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Trailing sentence punctuation is not part of a URL a person typed. */
const trimUrl = (u: string): string => u.replace(/[.,;:!?]+$/, '');
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => trimUrl(m[0]));
}
function emailsIn(text: string): string[] {
  return [...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max = MAX_STR): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
function onlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}: unknown key \`${k}\``);
}

/** ADR 0923 D2. `source` is the request text plus every answer. */
export function validateInterpretation(raw: unknown, source: { text: string; answers: readonly string[] }):
  { ok: true; value: Interpretation } | ValidationFailure {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['the reply must be a JSON object with `intents` and `questions` arrays'] };
  onlyKeys(raw, ['intents', 'questions'], 'reply', errors);
  const intentsRaw = Array.isArray(raw.intents) ? raw.intents : null;
  const questionsRaw = Array.isArray(raw.questions) ? raw.questions : null;
  if (!intentsRaw || !questionsRaw) return { ok: false, errors: ['both `intents` and `questions` must be arrays (one of them empty)'] };
  if ((intentsRaw.length > 0) === (questionsRaw.length > 0)) {
    errors.push('exactly one of `intents` and `questions` must be non-empty: ask about missing facts OR state intents, never both and never neither');
  }
  if (intentsRaw.length > MAX_INTENTS) errors.push(`at most ${MAX_INTENTS} intents`);
  if (questionsRaw.length > MAX_QUESTIONS) errors.push(`at most ${MAX_QUESTIONS} questions`);

  const allowedUrls = new Set(urlsIn([source.text, ...source.answers].join('\n')));
  const intents: Intent[] = [];
  intentsRaw.forEach((it, n) => {
    const where = `intents[${n}]`;
    if (!isObj(it)) { errors.push(`${where}: must be an object`); return; }
    if (it.kind === 'set_field_value') {
      onlyKeys(it, ['kind', 'subject', 'value', 'evidence'], where, errors);
      if (!isStr(it.subject, 120) || !isStr(it.value) || !isStr(it.evidence)) { errors.push(`${where}: needs string subject, value and evidence`); return; }
      intents.push({ kind: 'set_field_value', subject: it.subject, value: it.value, evidence: it.evidence });
    } else if (it.kind === 'replace_text') {
      onlyKeys(it, ['kind', 'find', 'replace', 'evidence'], where, errors);
      if (!isStr(it.find) || typeof it.replace !== 'string' || it.replace.length > MAX_STR || !isStr(it.evidence)) { errors.push(`${where}: needs string find, replace and evidence`); return; }
      intents.push({ kind: 'replace_text', find: it.find, replace: it.replace, evidence: it.evidence });
    } else {
      errors.push(`${where}: kind must be set_field_value or replace_text`);
    }
  });
  for (const [n, it] of intents.entries()) {
    const carried = it.kind === 'set_field_value' ? it.value : it.replace;
    for (const u of urlsIn(carried)) {
      if (!allowedUrls.has(u)) errors.push(`intents[${n}]: value_not_in_request — the link ${u} does not appear in the request or answers; never invent a link`);
    }
  }

  const questions: Question[] = [];
  const ids = new Set<string>();
  questionsRaw.forEach((q, n) => {
    const where = `questions[${n}]`;
    if (!isObj(q)) { errors.push(`${where}: must be an object`); return; }
    onlyKeys(q, ['id', 'slot', 'prompt', 'options'], where, errors);
    if (!isStr(q.id, 40) || !isStr(q.slot, 120) || !isStr(q.prompt, 500)) { errors.push(`${where}: needs string id, slot and prompt`); return; }
    if (ids.has(q.id)) errors.push(`${where}: duplicate id ${q.id}`);
    ids.add(q.id);
    const options = q.options === undefined ? undefined
      : Array.isArray(q.options) && q.options.length <= 6 && q.options.every((o) => isStr(o, 200)) ? (q.options as string[]) : null;
    if (options === null) { errors.push(`${where}: options must be up to 6 strings`); return; }
    questions.push({ id: q.id, slot: q.slot, prompt: q.prompt, ...(options ? { options } : {}) });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { intents, questions } };
}

export interface ProposalAssetContext {
  assetId: string;
  editableFields: readonly string[];
  /** The current value of every editable field, read at proposal time. */
  fields: Readonly<Record<string, string>>;
}

/** ADR 0923 D5. Returns, per asset, the validated edits (assets with none are dropped). */
export function validateProposal(
  raw: unknown,
  ctx: { assets: readonly ProposalAssetContext[]; intents: readonly Intent[]; requestText: string; answers: readonly string[] },
): { ok: true; value: Array<{ assetId: string; edits: ConstrainedEdit[] }> } | ValidationFailure {
  const errors: string[] = [];
  if (!isObj(raw) || !Array.isArray(raw.assets)) return { ok: false, errors: ['the reply must be a JSON object with an `assets` array'] };
  onlyKeys(raw, ['assets'], 'reply', errors);
  const byId = new Map(ctx.assets.map((a) => [a.assetId, a]));
  // Values an edit may introduce: everything the operator's intents carry.
  const intentText = ctx.intents.map((i) => (i.kind === 'set_field_value' ? i.value : i.replace)).join('\n');
  const allowedUrls = new Set(urlsIn(intentText));
  const allowedEmails = new Set(emailsIn([intentText, ctx.requestText, ...ctx.answers].join('\n')));
  const seen = new Set<string>();
  const out: Array<{ assetId: string; edits: ConstrainedEdit[] }> = [];

  raw.assets.forEach((a, n) => {
    const where = `assets[${n}]`;
    if (!isObj(a)) { errors.push(`${where}: must be an object`); return; }
    onlyKeys(a, ['assetId', 'edits'], where, errors);
    const asset = typeof a.assetId === 'string' ? byId.get(a.assetId) : undefined;
    if (!asset) { errors.push(`${where}: assetId must be one of the assets you were shown`); return; }
    if (seen.has(asset.assetId)) { errors.push(`${where}: asset ${asset.assetId} listed twice`); return; }
    seen.add(asset.assetId);
    if (!Array.isArray(a.edits) || a.edits.length > MAX_EDITS_PER_ASSET) { errors.push(`${where}: edits must be an array of at most ${MAX_EDITS_PER_ASSET}`); return; }
    const edits: ConstrainedEdit[] = [];
    // Apply in order so a second edit to the same field is checked against the first's result.
    const working: Record<string, string> = { ...asset.fields };
    a.edits.forEach((e, m) => {
      const w = `${where}.edits[${m}]`;
      if (!isObj(e) || typeof e.field !== 'string') { errors.push(`${w}: needs a field`); return; }
      if (!asset.editableFields.includes(e.field)) { errors.push(`${w}: field ${e.field} is not editable on this asset`); return; }
      const cur = working[e.field];
      if (typeof cur !== 'string') { errors.push(`${w}: field ${e.field} has no current text`); return; }
      let edit: ConstrainedEdit;
      if ('before' in e || 'after' in e) {
        onlyKeys(e, ['field', 'before', 'after'], w, errors);
        if (typeof e.before !== 'string' || typeof e.after !== 'string' || e.after.length > MAX_STR) { errors.push(`${w}: before and after must be strings`); return; }
        edit = { field: e.field, before: e.before, after: e.after };
      } else {
        onlyKeys(e, ['field', 'find', 'replace'], w, errors);
        if (!isStr(e.find) || typeof e.replace !== 'string' || e.replace.length > MAX_STR) { errors.push(`${w}: find and replace must be strings`); return; }
        edit = { field: e.field, find: e.find, replace: e.replace };
      }
      const next = applyEdit(cur, edit);
      if (next === null) {
        errors.push('before' in edit
          ? `${w}: before must equal the field's current text exactly`
          : `${w}: find must occur exactly once in the field's current text`);
        return;
      }
      if (next === cur) { errors.push(`${w}: the edit changes nothing`); return; }
      const introduced = 'before' in edit ? edit.after : edit.replace;
      for (const u of urlsIn(introduced)) {
        if (!urlsIn(cur).includes(u) && !allowedUrls.has(u)) errors.push(`${w}: edit_not_from_intent — the link ${u} is not one the request asked for`);
      }
      for (const em of emailsIn(introduced)) {
        if (!emailsIn(cur).includes(em) && !allowedEmails.has(em)) errors.push(`${w}: edit_not_from_intent — the address ${em} is not one the request asked for`);
      }
      working[e.field] = next;
      edits.push(edit);
    });
    if (edits.length > 0) out.push({ assetId: asset.assetId, edits });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}
