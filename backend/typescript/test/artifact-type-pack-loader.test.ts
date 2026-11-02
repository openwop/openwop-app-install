/**
 * Artifact-type pack loader (ADR 0055 Phase 3 / RFC 0075) — unit. Registers
 * kind:'artifact-type' packs through the host registry (registrationSource:'pack'),
 * isolating malformed entries.
 *
 * TST-BZD-19 (grade-tests w66). Red when: a pack type is registered under a source other
 * than 'pack'; a pack may override a host-native type; the `kind` filter is dropped (the
 * non-artifact pack DOES carry an `artifactTypes[]`, so only the kind check excludes it);
 * a malformed type stops being reported with its reason.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { isRegisteredArtifactType, getArtifactType, validateArtifact, seedHostArtifactTypes, __resetArtifactTypes } from '../src/host/artifactTypes.js';

function pack(dir: string, manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'atpacks-'));
  const d = join(root, dir);
  mkdirSync(d);
  writeFileSync(join(d, 'pack.json'), JSON.stringify(manifest));
  return root;
}

describe('artifact-type pack loader', () => {
  beforeEach(() => __resetArtifactTypes());

  it('registers a kind:artifact-type pack with registrationSource pack + working validation', () => {
    const root = pack('vendor.x.types', {
      name: 'vendor.x.types', version: '1.0.0', kind: 'artifact-type',
      artifactTypes: [{ artifactTypeId: 'doc.custom', title: 'Custom', schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } }, export: ['pdf'] }],
    });
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.registered).toContain('doc.custom');
    expect(isRegisteredArtifactType('doc.custom')).toBe(true);
    expect(getArtifactType('doc.custom')?.registrationSource).toBe('pack');
    expect(validateArtifact('doc.custom', { content: 'x' })).toMatchObject({ valid: true });
    expect(validateArtifact('doc.custom', {})).toMatchObject({ valid: false });
  });

  it('isolates a malformed type (missing schema) but registers the rest', () => {
    const root = pack('vendor.y.types', {
      name: 'vendor.y.types', kind: 'artifact-type',
      artifactTypes: [{ artifactTypeId: 'bad' }, { artifactTypeId: 'doc.ok', schema: { type: 'object' } }],
    });
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.registered).toContain('doc.ok');
    expect(out.errors.some((e) => e.pack === 'vendor.y.types' && /`schema` must be a JSON Schema object/.test(e.message)), JSON.stringify(out.errors)).toBe(true);
    expect(isRegisteredArtifactType('bad')).toBe(false);
  });

  it('ignores non-artifact-type packs', () => {
    // Carries an artifactTypes[] that WOULD register — only the kind check excludes it.
    const root = pack('some.nodes', {
      name: 'some.nodes', kind: 'node', nodes: [],
      artifactTypes: [{ artifactTypeId: 'doc.should-not', schema: { type: 'object' } }],
    });
    expect(loadArtifactTypePacks({ roots: [root] }).registered).toHaveLength(0);
    expect(isRegisteredArtifactType('doc.should-not')).toBe(false);
  });

  it('does NOT let a pack override a host-native type (preserves the native schema)', () => {
    seedHostArtifactTypes(); // registers doc.sow as registrationSource:'host'
    const root = pack('evil.types', {
      name: 'evil.types', kind: 'artifact-type',
      artifactTypes: [{ artifactTypeId: 'doc.sow', title: 'Weak', schema: { type: 'object' } }],
    });
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.registered).not.toContain('doc.sow');
    expect(out.errors.some((e) => e.message.includes('host-native'))).toBe(true);
    expect(getArtifactType('doc.sow')?.registrationSource).toBe('host');
  });
});
