/**
 * ADR 1013 D2 + D8 — what the host refuses about a clarification's form and
 * answers. Breaks if a form that fails the schema, binds an input to no question
 * or has no question reaches an interrupt, or if an answer to a question the
 * interrupt never raised gets past resolve. The conformance fixtures witness the
 * same rules over HTTP; these name each branch.
 *
 * Red when (sabotage-witnessed, grade-tests w84 TST-FNC-1): the schema check, the
 * no-question check, either form version's input scan, the unknown-id or no-id
 * answer check, the clarification-kind guard or the answers-array guard is
 * removed, or a bound form is refused.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertAnswersNameRaisedQuestions, interruptFormDefect } from '../src/host/interruptFormRules.js';

const fixture = (name: string): { questions: unknown; form: Record<string, unknown> } =>
  (JSON.parse(readFileSync(new URL(`../../../conformance-fixtures/${name}.json`, import.meta.url), 'utf8')) as {
    nodes: Array<{ config: { questions: unknown; form: Record<string, unknown> } }>;
  }).nodes[0]!.config;

const v1 = (fieldId: string) => ({
  catalogVersion: '0.9.1',
  surface: { components: [
    { component: 'field.date', id: fieldId, label: 'Date' },
    { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
  ] },
});

describe('interruptFormDefect', () => {
  it('passes a data block with no form, whatever else it holds', () => {
    expect(interruptFormDefect({ question: 'Why?' })).toBeNull();
  });

  it('passes the v0.9 and 0.9.1 forms whose inputs are all questions', () => {
    expect(interruptFormDefect(fixture('conformance-interrupt-form'))).toBeNull();
    expect(interruptFormDefect({ questions: [{ id: 'date', question: 'When?' }], form: v1('date') })).toBeNull();
  });

  it('refuses a form that fails the schema, because it asks for a secret', () => {
    const refused = fixture('conformance-interrupt-form-refused');
    expect(interruptFormDefect(refused)).toMatch(/^data\.form fails interrupt-form\.schema\.json: /);
    // The fixture differs from the passing one ONLY in its TextField `variant:
    // "obscured"` (a secret input). Put the plain variant back and the same form
    // passes, so the secret is the reason. (The message itself names the first Ajv
    // error, `catalogVersion`, not the variant: grade-code row TST-FNC-GC1.)
    const raw = JSON.stringify(refused);
    expect(raw.split('"variant":"obscured"')).toHaveLength(2);
    expect(interruptFormDefect(JSON.parse(raw.replace('"variant":"obscured"', '"variant":"shortText"')))).toBeNull();
  });

  it('refuses an input that is no question, naming it, in both form versions', () => {
    expect(interruptFormDefect(fixture('conformance-interrupt-form-unbound'))).toBe('form input "q2" is not a questions[].id');
    expect(interruptFormDefect({ questions: [{ id: 'date', question: 'When?' }], form: v1('time') })).toBe('form input "time" is not a questions[].id');
  });

  it('refuses a form with no fallback question', () => {
    expect(interruptFormDefect({ form: v1('date') })).toMatch(/needs questions\[\]/);
  });
});

describe('assertAnswersNameRaisedQuestions', () => {
  const raised = { kind: 'clarification', data: { questions: [{ id: 'q1', question: 'Color?' }] } };

  it('admits raised ids and an empty answers list', () => {
    expect(() => assertAnswersNameRaisedQuestions(raised, { answers: [{ id: 'q1', answer: 'blue' }] })).not.toThrow();
    expect(() => assertAnswersNameRaisedQuestions(raised, { answers: [] })).not.toThrow();
  });

  it('refuses an unknown id with a 400 validation_error naming it', () => {
    expect(() => assertAnswersNameRaisedQuestions(raised, { answers: [{ id: 'q1', answer: 'a' }, { id: 'q9', answer: 'b' }] }))
      .toThrow(expect.objectContaining({ code: 'validation_error', httpStatus: 400, details: expect.objectContaining({ received: 'q9' }) }));
  });

  it('refuses an answer entry with no id', () => {
    expect(() => assertAnswersNameRaisedQuestions(raised, { answers: ['blue'] })).toThrow(/not a question/);
  });

  it('leaves every value the rule does not cover to the node', () => {
    expect(() => assertAnswersNameRaisedQuestions(raised, { answer: 'blue' })).not.toThrow();
    expect(() => assertAnswersNameRaisedQuestions(raised, { answers: { q9: 'keyed' } })).not.toThrow();
    expect(() => assertAnswersNameRaisedQuestions({ kind: 'clarification', data: { question: 'Old?' } }, { answers: [{ id: 'x', answer: 1 }] })).not.toThrow();
    expect(() => assertAnswersNameRaisedQuestions({ kind: 'approval', data: { questions: [] } }, { answers: [{ id: 'x', answer: 1 }] })).not.toThrow();
  });
});
