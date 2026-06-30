/**
 * Host artifact-type registry (ADR 0055 / RFC 0071/0075) — unit. The seeded
 * host-native types, ajv validation (registered must validate; unregistered is the
 * escape hatch), and listing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  seedHostArtifactTypes, validateArtifact, isRegisteredArtifactType, listArtifactTypes,
  registerArtifactType, __resetArtifactTypes,
} from '../src/host/artifactTypes.js';

describe('host artifact-type registry', () => {
  beforeAll(() => { __resetArtifactTypes(); seedHostArtifactTypes(); });

  it('seeds host-native doc.* types', () => {
    expect(isRegisteredArtifactType('doc.sow')).toBe(true);
    expect(isRegisteredArtifactType('doc.markdown')).toBe(true);
    const ids = listArtifactTypes().map((t) => t.artifactTypeId);
    expect(ids).toEqual(expect.arrayContaining(['doc.sow', 'doc.prd', 'doc.rfp', 'doc.epic-brief', 'doc.board-agenda']));
    expect(listArtifactTypes().every((t) => t.registrationSource === 'host')).toBe(true);
  });

  it('validates a registered payload, flags an invalid one, and escape-hatches unregistered', () => {
    expect(validateArtifact('doc.sow', { content: '# SOW', title: 'Acme' })).toMatchObject({ registered: true, valid: true });
    const bad = validateArtifact('doc.sow', { title: 'no content' });
    expect(bad).toMatchObject({ registered: true, valid: false });
    expect((bad.errors ?? []).length).toBeGreaterThan(0);
    // Unregistered id stays valid (RFC 0071 escape hatch).
    expect(validateArtifact('doc.unknown', { anything: true })).toMatchObject({ registered: false, valid: true });
  });

  it('registers a pack-sourced type through the same seam', () => {
    registerArtifactType({ artifactTypeId: 'vendor.x', title: 'X', schema: { type: 'object' }, export: [], registrationSource: 'pack' });
    expect(validateArtifact('vendor.x', {})).toMatchObject({ registered: true, registrationSource: 'pack', valid: true });
  });
});
