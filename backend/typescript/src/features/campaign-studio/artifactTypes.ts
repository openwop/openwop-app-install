/**
 * Campaign-studio canvas artifact type (ADR 0153 Phase 3). `canvas.campaign` is a
 * structured multi-channel marketing campaign — channels, a funnel, and content
 * assets — emitted by the Campaign Strategist agent or a run, rendered inline in the
 * chat artifact workbench. Constrained typed JSON, never code. Same host-pinned
 * artifact-type pattern as slides (ADR 0055); no new wire surface.
 */
import { registerArtifactType } from '../../host/artifactTypes.js';

export function campaignSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['name', 'channels'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      objective: { type: 'string', maxLength: 600 },
      audience: { type: 'string', maxLength: 600 },
      channels: {
        type: 'array', minItems: 1, maxItems: 40,
        items: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            type: { type: 'string', enum: ['email', 'social', 'search', 'display', 'content', 'sms', 'events', 'pr'] },
            tactic: { type: 'string', maxLength: 400 },
            budget: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      funnel: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object',
          required: ['stage'],
          properties: {
            stage: { type: 'string', enum: ['awareness', 'consideration', 'conversion', 'retention', 'advocacy'] },
            description: { type: 'string', maxLength: 600 },
            kpis: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
          },
          additionalProperties: false,
        },
      },
      assets: {
        type: 'array', maxItems: 60,
        items: {
          type: 'object',
          properties: {
            channel: { type: 'string', maxLength: 120 },
            format: { type: 'string', maxLength: 80 },
            headline: { type: 'string', maxLength: 240 },
            body: { type: 'string', maxLength: 2000 },
            cta: { type: 'string', maxLength: 120 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

let registered = false;

/** Register `canvas.campaign`. Idempotent; called at boot from the feature. */
export function registerCampaignArtifactType(): void {
  if (registered) return;
  registerArtifactType({
    artifactTypeId: 'canvas.campaign',
    title: 'Campaign Studio',
    schema: campaignSchema(),
    export: ['json', 'pdf'],
    registrationSource: 'host',
  });
  registered = true;
}
