/**
 * ADR 0889 grade remediation (AE-2/AE-4, BE-1..3) — ONE mapping from what the
 * eval routes and runs report to localized copy.
 *
 * The server sends machine-readable `details.reason` (why a refusal happened)
 * and `details.rule` + params (which validation rule failed); a terminal run
 * carries a stable `error.code`. Each maps to an `evals:` key. The server's
 * English prose is the LAST resort, shown only for a 4xx this table does not
 * know yet, and a transport failure gets the app-wide localized class.
 */
import type { TFunction } from 'i18next';
import type { Formatter } from '../../../i18n/format.js';
import { loadErrorMessage } from '../../../client/loadErrorMessage.js';
import { AgentEvalsRequestError, type RuleParams } from './agentEvalsClient.js';

/** Refusal reasons with their own sentence. */
const REASONS = new Set([
  // access (403/503)
  'feature_disabled', 'not_entitled', 'feature_unavailable',
  // promote a captured run (field `fromRunId`)
  'nothing_captured', 'agent_mismatch', 'missing_run', 'errored_call',
  // suite writes (409)
  'suite_exists', 'suite_locked', 'pack_suite_ref', 'suite_conflict',
  // run start (POST /runs {mode:"eval"})
  'baseline_not_completed', 'baseline_other_suite', 'baseline_not_found', 'target_agent_mismatch',
  'unsupported_configurable', 'suite_changed', 'in_flight',
]);

/** Validation rules with their own sentence, and the params each sentence needs. */
const RULES: Record<string, readonly string[]> = {
  required: [], type: [], range: ['min', 'max'], pattern: [], enum: ['values'],
  unknown_property: [], duplicate: [], too_large: ['max'], too_many: ['max'],
};

/** A `pattern` miss on an id is better explained by that id's own format help. */
const PATTERN_HELP: Array<[RegExp, string]> = [
  [/^suiteId$/, 'evals:aeSuiteIdHelp'],
  [/^version$/, 'evals:aeVersionHelp'],
  [/(^|\.)taskId$/, 'evals:aeTaskIdHelp'],
];

const isReq = (err: unknown): err is AgentEvalsRequestError => err instanceof AgentEvalsRequestError;

/** The server prose without its `field: ` prefix (the control already names the field). */
export function serverText(err: AgentEvalsRequestError): string {
  return err.field && err.message.startsWith(`${err.field}: `) ? err.message.slice(err.field.length + 2) : err.message;
}

/** 409 because the ref already exists (`PUT …?create=true`). */
export function isSuiteExists(err: unknown): boolean {
  return isReq(err) && err.status === 409 && (err.code === 'suite_exists' || err.reason === 'suite_exists');
}

/** 409 because a run already used this version (`suite_locked`; an older server sent no reason). */
export function isLockedConflict(err: unknown): boolean {
  return isReq(err) && err.status === 409 && (err.reason === 'suite_locked' || (!err.reason && err.code !== 'suite_exists'));
}

function fmtParam(f: Formatter, v: RuleParams[string]): string {
  if (typeof v === 'number') return f.number(v);
  if (Array.isArray(v)) return f.list(v.map(String));
  return String(v);
}

/** The localized sentence for a failed validation rule, or null when the rule (or a param it needs) is unknown. */
export function ruleMessage(t: TFunction, f: Formatter, err: AgentEvalsRequestError): string | null {
  const rule = err.rule;
  if (!rule) return null;
  if (rule === 'pattern' && err.field) {
    const help = PATTERN_HELP.find(([re]) => re.test(err.field!));
    if (help) return t(help[1]);
  }
  const needs = RULES[rule];
  if (!needs || needs.some((p) => err.params[p] === undefined)) return null;
  const params = Object.fromEntries(needs.map((p) => [p, fmtParam(f, err.params[p]!)]));
  // Two rules read differently by what they bound: a whole-number range, and a
  // size limit that is BYTES for the whole suite but characters for a field.
  if (rule === 'range' && err.params.integer === true) return t('evals:aeRule_range_integer', params);
  if (rule === 'too_large' && err.field === 'suite' && typeof err.params.max === 'number') return t('evals:aeRule_too_large_suite', { max: f.bytes(err.params.max) });
  return t(`evals:aeRule_${rule}`, params);
}

/**
 * The message for any failed eval request. `version` names the ref in the
 * `suite_exists` sentence.
 */
export function evalErrorMessage(t: TFunction, f: Formatter, err: unknown, ctx: { version?: string } = {}): string {
  if (!isReq(err)) return loadErrorMessage(t, err);
  if (isSuiteExists(err)) return t('evals:aeReason_suite_exists', { version: ctx.version ?? '' });
  if (err.reason === 'model_class_not_allowed') {
    const allowed = err.params.allowedModels;
    const cls = (c: string | number): string => t(`evals:aeModelClass_${String(c)}`, { defaultValue: String(c) });
    return t('evals:aeReason_model_class_not_allowed', {
      modelClass: typeof err.params.modelClass === 'string' ? cls(err.params.modelClass) : '—',
      allowed: Array.isArray(allowed) ? f.list(allowed.map(cls)) : '—',
    });
  }
  if (err.reason && REASONS.has(err.reason)) return t(`evals:aeReason_${err.reason}`);
  if (isLockedConflict(err)) return t('evals:aeLockedConflict');
  if (err.status === 400) {
    const byRule = ruleMessage(t, f, err);
    if (byRule) return byRule;
  }
  // A refusal the table does not know yet: the server's own words beat a
  // generic class, but only for a client error that carries any.
  if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429 && err.message) {
    return serverText(err);
  }
  return loadErrorMessage(t, err);
}

/** Terminal run error codes with their own sentence (BE-1). */
const RUN_CODES = new Set([
  'eval_cost_ceiling_exceeded', 'eval_cost_unpriced', 'eval_feature_disabled', 'eval_suite_unavailable', 'eval_run_failed', 'run_timeout', 'eval_mock_unscripted',
  'eval_recorded_fixtures_gone',
]);

/** The localized sentence for a terminal run error code. Unknown codes read as a generic failure. */
export function runErrorMessage(t: TFunction, code: string | undefined): string {
  return code && RUN_CODES.has(code) ? t(`evals:aeRunError_${code}`) : t('evals:aeRunError_generic');
}
