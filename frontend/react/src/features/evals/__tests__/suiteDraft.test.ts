/**
 * ADR 0889 P6 — the editor's form model must not drop a field the JSON view
 * carries (the validator-allowlist trap): form → suite → form is lossless for
 * call args, fixtures, thresholds and allowedModels the form does not expose.
 */
import { describe, it, expect } from 'vitest';
import { bumpPatch, defaultSuiteId, draftFromSuite, emptyDraft, nextFreeVersion, readValue, suiteFromDraft } from '../agent/suiteDraft.js';
import type { AgentEvalSuite } from '../agent/agentEvalsClient.js';

const suite: AgentEvalSuite = {
  suiteId: 'support.evals.refunds',
  version: '1.2.3',
  targetAgentId: 'vendor.openwop-app.support',
  modes: ['golden', 'rubric', 'regression'],
  allowedModels: ['general'],
  thresholds: { passScore: 0.8, maxCostUsd: 2, maxP95LatencyMs: 9000 },
  trials: { count: 5, k: 3, passRule: 'all' },
  tasks: [
    {
      taskId: 'lookup',
      input: { orderId: 'A1' },
      expected: {
        kind: 'golden',
        match: { strategy: 'json-match', value: { refunded: true } },
        // M15 — `includeDelegates` is accepted by the server (suiteStore validateTrajectory) and must survive the form.
        trajectory: { match: 'in-order', calls: [{ tool: 'crm.lookup', args: { id: 'A1' }, argsMatch: 'subset' }, { tool: 'refund.issue' }], forbidden: ['email.send'], includeDelegates: true },
      },
      fixtures: { toolResponses: [{ tool: 'crm.lookup', response: { ok: true } }], onMiss: 'fail' },
    },
    { taskId: 'tone', input: 'Be kind', expected: { kind: 'rubric', rubric: [{ criterion: 'Polite', weight: 0.5 }] } },
    // EVAL-7 — string values that LOOK like JSON stay strings; a real number stays a number.
    { taskId: 'scalars', input: '42', expected: { kind: 'golden', match: { strategy: 'exact', value: 'true' } } },
    { taskId: 'numeric', input: 7, expected: { kind: 'golden', match: { strategy: 'json-match', value: 42 } } },
  ],
};

describe('suiteDraft (ADR 0889 P6)', () => {
  it('round-trips every field through the form model', () => {
    expect(suiteFromDraft(draftFromSuite(suite))).toEqual(suite);
  });

  it('keeps call args by position only while the tool id is unchanged', () => {
    const d = draftFromSuite(suite);
    d.tasks[0]!.calls = 'crm.lookup\nrefund.preview';
    const out = suiteFromDraft(d).tasks[0]!.expected.trajectory!.calls;
    expect(out).toEqual([{ tool: 'crm.lookup', args: { id: 'A1' }, argsMatch: 'subset' }, { tool: 'refund.preview' }]);
  });

  it('reads structured JSON when it parses and plain text otherwise; a bare scalar stays text (EVAL-7)', () => {
    expect(readValue('{"a":1}')).toEqual({ a: 1 });
    expect(readValue('"quoted"')).toBe('quoted');
    expect(readValue('42')).toBe('42');
    expect(readValue('true')).toBe('true');
    expect(readValue('30 days')).toBe('30 days');
    expect(readValue('{not json')).toBe('{not json');
    // A value that arrived as a number/boolean is read back as one.
    expect(readValue('42', 'json')).toBe(42);
    // A value that arrived as a string is sent verbatim, even when it looks like JSON.
    expect(readValue('{"a":1}', 'text')).toBe('{"a":1}');
  });

  it('round-trips under a comma-decimal locale, and reads what a fr user types (AE-1)', () => {
    const d = draftFromSuite(suite, 'fr');
    expect(d.passScore).toBe('0,8');
    expect(d.tasks[1]!.rubric[0]!.weight).toBe('0,5');
    expect(suiteFromDraft(d, 'fr')).toEqual(suite);
    d.passScore = '0,65';
    expect(suiteFromDraft(d, 'fr').thresholds?.passScore).toBe(0.65);
    // A pasted `.` decimal is accepted too; garbage is NaN (the server's typed 400), never a silent drop.
    d.passScore = '0.65';
    expect(suiteFromDraft(d, 'fr').thresholds?.passScore).toBe(0.65);
    d.passScore = 'abc';
    expect(suiteFromDraft(d, 'fr').thresholds?.passScore).toBeNaN();
    expect(emptyDraft('a', new Set(), 'pt-BR').passScore).toBe('0,7');
  });

  it('proposes a suite id and version no listed ref uses (EVUX-1)', () => {
    expect(defaultSuiteId('Support')).toBe('support.evals.default');
    const taken = new Set(['support.evals.default@1.0.0', 'support.evals.default-2@1.0.0']);
    expect(defaultSuiteId('Support', taken)).toBe('support.evals.default-3');
    expect(nextFreeVersion('s.evals.x', '1.0.0', new Set(['s.evals.x@1.0.1', 's.evals.x@1.0.2']))).toBe('1.0.3');
  });

  it('bumps the patch version', () => {
    expect(bumpPatch('1.2.3')).toBe('1.2.4');
    expect(bumpPatch('banana')).toBe('1.0.1');
  });
});
