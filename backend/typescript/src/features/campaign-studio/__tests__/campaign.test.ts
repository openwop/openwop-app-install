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
  it('ADR 0360 — accepts optional board positions on funnel stages; rejects out-of-range', () => {
    const base = { name: 'X', channels: [{ name: 'c', type: 'email' }] };
    expect(validateArtifact('canvas.campaign', { ...base, funnel: [{ stage: 'awareness', x: 120, y: 240 }] }).valid).toBe(true);
    // Pre-ADR docs (no positions) stay valid — the additive guarantee.
    expect(validateArtifact('canvas.campaign', { ...base, funnel: [{ stage: 'awareness' }] }).valid).toBe(true);
    expect(validateArtifact('canvas.campaign', { ...base, funnel: [{ stage: 'awareness', x: -5 }] }).valid).toBe(false);
    expect(validateArtifact('canvas.campaign', { ...base, funnel: [{ stage: 'awareness', y: 4001 }] }).valid).toBe(false);
    expect(validateArtifact('canvas.campaign', { ...base, funnel: [{ stage: 'awareness', x: 'left' }] }).valid).toBe(false);
  });
  it('rejects an unknown funnel stage', () => {
    expect(validateArtifact('canvas.campaign', { name: 'X', channels: [{ name: 'c', type: 'email' }], funnel: [{ stage: 'mind-meld' }] }).valid).toBe(false);
  });
  it('rejects unknown top-level keys (closed schema)', () => {
    expect(validateArtifact('canvas.campaign', { ...valid, script: 'x' }).valid).toBe(false);
  });
});
