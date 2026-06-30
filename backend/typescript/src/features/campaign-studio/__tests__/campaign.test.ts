/**
 * Campaign-studio canvas (ADR 0153 Phase 3) — the host-side contract: `canvas.campaign`
 * is a registered artifact type whose schema gates `artifact.created` (ADR 0055). A
 * well-formed campaign validates; malformed ones (no channels, bad channel type, unknown
 * keys) are rejected.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCampaignArtifactType } from '../artifactTypes.js';
import { validateArtifact, isRegisteredArtifactType } from '../../../host/artifactTypes.js';

const valid = {
  name: 'Spring launch',
  objective: 'Drive trial signups',
  channels: [
    { name: 'Email', type: 'email', tactic: 'nurture', budget: 0 },
    { name: 'LinkedIn', type: 'social', budget: 8000 },
  ],
  funnel: [{ stage: 'awareness', kpis: ['Reach'] }, { stage: 'conversion' }],
  assets: [{ channel: 'LinkedIn', format: 'Single image', headline: 'Ship faster', cta: 'Start free' }],
};

describe('canvas.campaign artifact type', () => {
  beforeAll(() => { registerCampaignArtifactType(); });

  it('registers canvas.campaign', () => {
    expect(isRegisteredArtifactType('canvas.campaign')).toBe(true);
  });
  it('accepts a well-formed campaign', () => {
    expect(validateArtifact('canvas.campaign', valid)).toMatchObject({ registered: true, valid: true });
  });
  it('rejects a campaign with no channels', () => {
    expect(validateArtifact('canvas.campaign', { name: 'X', channels: [] }).valid).toBe(false);
  });
  it('rejects an unknown channel type', () => {
    expect(validateArtifact('canvas.campaign', { name: 'X', channels: [{ name: 'c', type: 'telepathy' }] }).valid).toBe(false);
  });
  it('rejects an unknown funnel stage', () => {
    expect(validateArtifact('canvas.campaign', { name: 'X', channels: [{ name: 'c', type: 'email' }], funnel: [{ stage: 'mind-meld' }] }).valid).toBe(false);
  });
  it('rejects unknown top-level keys (closed schema)', () => {
    expect(validateArtifact('canvas.campaign', { ...valid, script: 'x' }).valid).toBe(false);
  });
});
