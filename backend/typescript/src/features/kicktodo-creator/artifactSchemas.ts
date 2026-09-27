/**
 * kicktodo.challenge-plan artifact type (ADR 0415 P2) — the cross-workflow
 * plan contract, registered with the ONE host artifact registry and
 * DRIFT-PINNED to the producer (`kicktodo-creator-plan.test.ts` validates a
 * real valid plan against it). AI generation composes this schema through the
 * structured-output seam; acceptance always passes `validatePlan` (the
 * deterministic gate) regardless of what the model returned.
 */

import { registerArtifactType } from '../../host/artifactTypes.js';

export const CHALLENGE_PLAN_TYPE = 'kicktodo.challenge-plan';

export function registerKicktodoCreatorArtifactTypes(): void {
  registerArtifactType({
    artifactTypeId: CHALLENGE_PLAN_TYPE,
    title: 'KickTodo challenge plan',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['title', 'promise', 'audience', 'durationDays', 'dailyMinutesBudget', 'outcomes', 'achievements', 'days'],
      properties: {
        title: { type: 'string', minLength: 1 },
        promise: { type: 'string' },
        audience: { type: 'string' },
        durationDays: { type: 'integer', minimum: 3, maximum: 60 },
        dailyMinutesBudget: { type: 'number', minimum: 5, maximum: 120 },
        // ADR 0443 R4 — optional depth facet (Discover filter); absent = unlabeled.
        depthLevel: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        outcomes: {
          type: 'array', minItems: 1,
          items: { type: 'object', additionalProperties: false, required: ['outcomeId', 'measurableOutcome', 'method'],
            properties: { outcomeId: { type: 'string' }, measurableOutcome: { type: 'string' }, method: { type: 'string' } } },
        },
        achievements: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['achievementId', 'observableEvidence', 'outcomeIds'],
            properties: { achievementId: { type: 'string' }, observableEvidence: { type: 'string' }, outcomeIds: { type: 'array', items: { type: 'string' } } } },
        },
        days: {
          type: 'array', minItems: 1,
          items: { type: 'object', additionalProperties: false,
            required: ['day', 'stableActivityId', 'title', 'actionInstruction', 'userFacingWhy', 'estimatedMinutes', 'achievementIds', 'evidencePolicy'],
            properties: {
              day: { type: 'integer', minimum: 1 },
              stableActivityId: { type: 'string' },
              title: { type: 'string' },
              actionInstruction: { type: 'string' },
              userFacingWhy: { type: 'string' },
              estimatedMinutes: { type: 'number', minimum: 1 },
              achievementIds: { type: 'array', items: { type: 'string' } },
              evidencePolicy: { type: 'string', enum: ['attestation', 'note', 'photo', 'measurement'] },
              isRecovery: { type: 'boolean' },
              // ADR 0458 §2.2 (correction) — dossier claim ids the day relies on.
              claimRefs: { type: 'array', items: { type: 'string' } },
            } },
        },
      },
    },
    export: ['json'],
    registrationSource: 'host',
  });
}
