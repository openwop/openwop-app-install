/** ADR 0961 / 0712: real source projection, not a second credential resolver.
 * Source-only authored cases; executor/managed dispatch qualification is separate
 * (campaign-dedicated-launch-byok.test.ts).
 *
 * Sabotage-witnessed (w93): dropping the declared credentialRefs; giving a
 * managed stage explicit inputs or a synthetic `ai`; dropping either half of
 * the stage-argument override check; dropping the source provider/ref
 * mismatch check; putting the ref into the refusal details; dropping the
 * frozen aiDefault metadata; skipping the no-frozen-choice refusal. */
import { expect, it } from 'vitest';
import { projectCampaignStageAi } from '../src/features/campaign-orchestration/launchAi.js';
import { getDefaultModel } from '../src/providers/catalog.js';
import { runAiDefaultFor, withRunAiDefault } from '../src/host/runAiDefault.js';
import { sanitizeDetails } from '../src/middleware/sanitize.js';
import { OpenwopError } from '../src/types.js';

it('projects an explicit configuration choice and declarations without unrelated run authority', () => {
  const model = getDefaultModel('google');
  const source = {
    configurable: { ai: { provider: 'google', model, credentialRef: 'google:selected' }, credentialRefs: ['anthropic:declared'], connections: ['broker-private'], tools: { trusted: true }, extra: 'not forwarded' },
    metadata: { aiDefault: { provider: 'anthropic', model: getDefaultModel('anthropic'), source: 'workspace' }, unrelated: 'not forwarded' },
  };
  const projected = projectCampaignStageAi(source, {});
  expect(projected.configurable).toEqual({ credentialRefs: ['google:selected', 'anthropic:declared'], ai: { provider: 'google', model, credentialRef: 'google:selected' } });
  expect(projected.metadata).toEqual({ aiDefault: { provider: 'google', model, source: 'run' } });
  expect(projected.inputs).toEqual({ provider: 'google', model });
  expect(source.configurable.extra).toBe('not forwarded');
});

it('metadata BYOK choice retains its declared key and model instead of reading a current binding', () => {
  const model = getDefaultModel('anthropic');
  const projected = projectCampaignStageAi({ configurable: { credentialRefs: ['anthropic:chosen'] }, metadata: { aiDefault: { provider: 'anthropic', model, source: 'workspace' } } }, {});
  expect(projected.configurable).toEqual({ credentialRefs: ['anthropic:chosen'], ai: { provider: 'anthropic', model } });
  expect(projected.metadata).toEqual({ aiDefault: { provider: 'anthropic', model, source: 'workspace' } });
  expect(projected.inputs).toEqual({ provider: 'anthropic', model });
});

it('managed choice keeps the frozen sentinel through the real default injector without synthetic explicit inputs', () => {
  const choice = { provider: 'openwop-free', model: getDefaultModel('openwop-free'), source: 'managed', credentialRef: 'managed:openwop-free' };
  const projected = projectCampaignStageAi({ metadata: { aiDefault: choice } }, { provider: choice.provider, model: choice.model });
  expect(projected.configurable).toEqual({});
  expect(projected.inputs).toEqual({});
  expect(projected.metadata).toEqual({ aiDefault: choice });
  const injected = withRunAiDefault({}, runAiDefaultFor(projected.configurable, projected.metadata));
  expect(injected).toEqual({ provider: choice.provider, model: choice.model, credentialRef: choice.credentialRef });
});

it.each([{}, { configurable: { credentialRefs: ['google:legacy'] } }, { metadata: { aiDefault: null } }])('legacy missing source decision refuses a NEW stage rather than selecting a new default: %j', source => {
  expect(() => projectCampaignStageAi(source, {})).toThrow(/no frozen AI choice/);
  // The typed refusal, not any throw whose text happens to match.
  let refusal: unknown;
  try { projectCampaignStageAi(source, {}); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(OpenwopError);
  expect(refusal).toMatchObject({ httpStatus: 422, details: { reason: 'campaign_ai_choice_missing' } });
});

it.each([{ provider: 'anthropic' }, { model: 'different-model' }])('stage arguments cannot override source choice: %j', args => {
  expect(() => projectCampaignStageAi({ configurable: { ai: { provider: 'google', model: getDefaultModel('google'), credentialRef: 'google:selected' } } }, args)).toThrow(/keep its source run/);
});

it.each([
  {
    kind: 'stage',
    source: { configurable: { ai: { provider: 'google', model: getDefaultModel('google'), credentialRef: 'google:selected' } } },
    args: { provider: 'anthropic' },
    reason: 'campaign_ai_stage_mismatch',
    httpStatus: 400,
  },
  {
    kind: 'source',
    source: { configurable: { ai: { credentialRef: 'google:selected' } }, metadata: { aiDefault: { provider: 'anthropic', model: getDefaultModel('anthropic'), source: 'workspace' } } },
    args: {},
    reason: 'campaign_ai_source_mismatch',
    httpStatus: 422,
  },
])('the $kind refusal keeps its AI recovery reason through error-envelope sanitization', async ({ source, args, reason, httpStatus }) => {
  const failure = await Promise.resolve().then(() => projectCampaignStageAi(source, args)).then(
    () => { throw new Error('Expected the source authority guard to refuse'); },
    (error: unknown) => {
      if (!(error instanceof OpenwopError)) throw error;
      return error;
    },
  );
  expect(failure.httpStatus).toBe(httpStatus);
  const envelope = sanitizeDetails(failure.toEnvelope());
  expect(envelope).toMatchObject({ error: 'validation_error', details: { reason } });
  expect(JSON.stringify(envelope)).not.toContain('google:selected');
});
