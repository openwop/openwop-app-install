/**
 * ADR 0889 grade remediation (AE-2/AE-4, BE-1..3) — server refusals and run
 * errors map to localized copy by `details.reason` / `details.rule` / error
 * code; the server's English prose is only a last resort for an unknown 4xx.
 * Asserted in English AND French so a key that silently falls back to the
 * English source (or to the raw server message) is caught.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import i18n from '../../../i18n/index.js';
import { format, setFormatLocale } from '../../../i18n/format.js';
import { AgentEvalsRequestError } from '../agent/agentEvalsClient.js';
import { evalErrorMessage, isLockedConflict, isSuiteExists, ruleMessage, runErrorMessage } from '../agent/evalErrors.js';
import { messages as frEvals } from '../i18n/fr.js';

// fr is a lazy locale; merge its evals catalog directly so `tFr` reads real French.
i18n.addResourceBundle('fr', 'evals', frEvals, true, true);

const t = i18n.getFixedT('en', 'evals');
const tFr = i18n.getFixedT('fr', 'evals');
const err = (status: number, extra: { code?: string; field?: string; reason?: string; rule?: string; params?: Record<string, number | string | boolean | string[]> } = {}, message = 'English server prose') =>
  new AgentEvalsRequestError(message, status, extra.code, extra.field, { ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.rule ? { rule: extra.rule } : {}), ...(extra.params ? { params: extra.params } : {}) });

describe('evalErrorMessage', () => {
  beforeAll(async () => { await i18n.loadNamespaces(['evals', 'common']); });
  afterAll(() => setFormatLocale('en'));

  it('maps each refusal reason to its own sentence, never the server prose', () => {
    expect(evalErrorMessage(t, format, err(403, { code: 'forbidden', reason: 'not_entitled' }))).toBe('Agent evals aren’t included in this workspace’s plan.');
    expect(evalErrorMessage(t, format, err(503, { reason: 'feature_unavailable' }))).toMatch(/Try again in a moment/);
    // AE-4 — agent_mismatch is NOT "nothing captured", though both name field fromRunId.
    expect(evalErrorMessage(t, format, err(400, { field: 'fromRunId', reason: 'agent_mismatch' }))).toMatch(/Another agent made this run’s tool calls/);
    expect(evalErrorMessage(t, format, err(400, { field: 'fromRunId', reason: 'nothing_captured' }))).toMatch(/no recorded tool calls/);
    expect(evalErrorMessage(tFr, format, err(400, { reason: 'errored_call' }))).toMatch(/a échoué/);
  });

  it('formats a range rule with the locale’s numbers', () => {
    setFormatLocale('fr');
    expect(evalErrorMessage(tFr, format, err(400, { field: 'thresholds.passScore', rule: 'range', params: { min: 0, max: 0.5 } }))).toBe('Saisissez un nombre entre 0 et 0,5.');
    setFormatLocale('en');
  });

  it('explains a pattern miss on an id with that id’s own format help', () => {
    expect(ruleMessage(t, format, err(400, { field: 'suiteId', rule: 'pattern' }))).toMatch(/<name>\.evals\.<suite>/);
    expect(ruleMessage(t, format, err(400, { field: 'tasks[2].taskId', rule: 'pattern' }))).toBe('Lowercase letters, digits and hyphens.');
  });

  it('falls back: an unknown rule or a missing param → server prose; a transport failure → the common class', () => {
    expect(ruleMessage(t, format, err(400, { rule: 'range' }))).toBeNull();
    expect(evalErrorMessage(t, format, err(400, { field: 'x', rule: 'brand_new_rule' }, 'x: must be shiny'))).toBe('must be shiny');
    expect(evalErrorMessage(t, format, err(500))).toBe(i18n.getFixedT('en')('common:error_server'));
    expect(evalErrorMessage(t, format, new TypeError('Failed to fetch'))).not.toMatch(/Failed to fetch/);
  });

  it('tells a create collision from a locked version', () => {
    const exists = err(409, { code: 'suite_exists' });
    const existsByReason = err(409, { code: 'conflict', reason: 'suite_exists' });
    const locked = err(409, { code: 'conflict', reason: 'suite_locked' });
    expect(isSuiteExists(exists) && isSuiteExists(existsByReason)).toBe(true);
    expect(isSuiteExists(locked)).toBe(false);
    expect(isLockedConflict(locked) && !isLockedConflict(exists)).toBe(true);
    expect(evalErrorMessage(t, format, exists, { version: '1.0.0' })).toBe('Version 1.0.0 of this suite already exists. Save as a new version instead.');
  });
});

describe('evalErrorMessage — A2 contract reasons and rules', () => {
  it('reads each 409 by its reason: locked, conflict, pack-owned', () => {
    expect(isLockedConflict(err(409, { code: 'conflict', reason: 'suite_locked' }))).toBe(true);
    expect(isLockedConflict(err(409, { code: 'conflict', reason: 'suite_conflict' }))).toBe(false);
    expect(evalErrorMessage(t, format, err(409, { reason: 'suite_conflict' }))).toMatch(/Someone else changed this suite/);
    expect(evalErrorMessage(t, format, err(409, { reason: 'pack_suite_ref' }))).toMatch(/shipped with the agent’s pack/);
    expect(evalErrorMessage(t, format, err(409, { reason: 'suite_changed' }))).toMatch(/Run it again/);
    expect(evalErrorMessage(t, format, err(409, { reason: 'in_flight' }))).toMatch(/already starting/);
  });

  it('names the model class and the allowed ones, localized', () => {
    expect(evalErrorMessage(t, format, err(400, { field: 'agentId', reason: 'model_class_not_allowed', params: { modelClass: 'coding', allowedModels: ['reasoning', 'writing'] } })))
      .toBe('This suite doesn’t allow coding models. It allows: reasoning and writing.');
  });

  it('reads integer ranges, suite size in bytes, and the criteria cap', () => {
    expect(ruleMessage(t, format, err(400, { field: 'trials.count', rule: 'range', params: { min: 1, max: 10, integer: true } }))).toBe('Enter a whole number from 1 to 10.');
    expect(ruleMessage(t, format, err(400, { field: 'suite', rule: 'too_large', params: { max: 262144 } }))).toMatch(/^This suite is too large\. The limit is 256/);
    expect(ruleMessage(t, format, err(400, { field: 'tasks[0].expected.rubric[0].criterion', rule: 'too_large', params: { max: 2000 } }))).toBe('Too long. Use up to 2,000 characters.');
    expect(ruleMessage(t, format, err(400, { field: 'tasks[0].expected.rubric', rule: 'too_many', params: { max: 20 } }))).toBe('Too many. The limit is 20.');
  });
});

describe('runErrorMessage (BE-1)', () => {
  it('localizes known terminal codes and never shows an unknown code as prose', () => {
    expect(runErrorMessage(t, 'eval_cost_ceiling_exceeded')).toBe('It stopped when it reached the cost limit for one suite run.');
    expect(runErrorMessage(tFr, 'eval_cost_unpriced')).toMatch(/prix du modèle est inconnu/);
    expect(runErrorMessage(t, 'run_timeout')).toBe('It took longer than the time limit for one run.');
    expect(runErrorMessage(tFr, 'eval_mock_unscripted')).toMatch(/réponse simulée/);
    expect(runErrorMessage(t, 'something_new')).toBe('Open the run for details.');
    expect(runErrorMessage(t, undefined)).toBe('Open the run for details.');
  });
});
