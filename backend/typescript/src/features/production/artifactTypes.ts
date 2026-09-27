/**
 * Production-plan artifact type (ADR 0172 / ADR 0055). Registers `production.plan`
 * through the host artifact-type registry so the `plan-generate` node can emit a
 * validated, renderable run-output artifact (ADR 0083) into the chat artifact
 * workbench — alongside the durable `ProductionPlan` lifecycle record. Constrained
 * typed JSON (the safe model-emits-typed-JSON pattern), never executable code; the
 * host registry does the authoritative AJV validation before `artifact.created`.
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import { registerArtifactType } from '../../host/artifactTypes.js';

/** JSON Schema (2020-12) for a `production.plan` artifact payload. */
function productionPlanSchema(): Record<string, unknown> {
  const budget = {
    type: 'object',
    required: ['min', 'max', 'currency'],
    properties: {
      min: { type: 'number', minimum: 0 },
      max: { type: 'number', minimum: 0 },
      currency: { type: 'string', maxLength: 8 },
      breakdown: {
        type: 'array',
        maxItems: 40,
        items: { type: 'object', required: ['item', 'cost'], properties: { item: { type: 'string', maxLength: 120 }, cost: { type: 'number', minimum: 0 } }, additionalProperties: false },
      },
    },
    additionalProperties: false,
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['strategySummary', 'recommendations'],
    properties: {
      strategySummary: { type: 'string', maxLength: 2000 },
      recommendations: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          required: ['assetType', 'executionRoute', 'rationale'],
          properties: {
            assetType: { type: 'string', maxLength: 120 },
            assetDescription: { type: 'string', maxLength: 2000 },
            executionRoute: { type: 'string', enum: ['internal', 'contractor', 'agency', 'hybrid'] },
            rationale: { type: 'string', maxLength: 2000 },
            budget,
            timelineEstimate: { type: 'string', maxLength: 120 },
          },
          additionalProperties: true,
        },
      },
      totalBudget: budget,
      timeline: {
        type: 'object',
        properties: {
          estimatedDeliveryDate: { type: 'string', maxLength: 40 },
          milestones: { type: 'array', maxItems: 40, items: { type: 'object', required: ['date', 'deliverable'], properties: { date: { type: 'string', maxLength: 40 }, deliverable: { type: 'string', maxLength: 200 } }, additionalProperties: false } },
        },
        additionalProperties: false,
      },
      capabilityAssessment: {
        type: 'object',
        properties: {
          strengths: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 120 } },
          gaps: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 120 } },
          overallRecommendation: { type: 'string', maxLength: 2000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: true,
  };
}

let registered = false;

/** Register `production.plan`. Idempotent; called at boot from the production feature. */
export function registerProductionArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'production.plan',
    title: 'Production Plan',
    schema: productionPlanSchema(),
    export: ['markdown', 'pdf'],
    registrationSource: 'host',
  });
  registered = true;
}

