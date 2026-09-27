/**
 * RFC 0071 `schemaRef` — the loader must install a STANDARDS-CONFORMANT
 * artifact-type pack, not only this repo's inline-`schema` variant.
 *
 * THE DEFECT THIS PINS. `artifactTypePackLoader` accepted an inline `schema`
 * only, and had ZERO references to `schemaRef`. Every pack this repo ships uses
 * the inline shape, so nothing internal ever noticed — while a third-party pack
 * written to the RFC was silently rejected: `artifactTypes[]` present, no type
 * registered, nothing surfaced to the installer.
 *
 * It stayed invisible because the conformance leg that catches it had never run
 * against this host — first the capability key was unreadable (openwop#889),
 * then the behavioral seam was unwired. Each fix moved the soft-skip one gate
 * later; only the third exposed the defect. The conformance suite is NOT in the
 * default `npm run ci` gate, so without this test the fix has no ratchet.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getArtifactType, validateArtifact, __resetArtifactTypes } from '../src/host/artifactTypes.js';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: { title: { type: 'string' }, body: { type: 'string' } },
};

/** Writes a pack whose type declares `schemaRef` (the RFC shape), not `schema`. */
function packWithSchemaRef(opts: { ref: string; writeSchemaAt?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-attype-test-'));
  const dir = join(root, 'p');
  mkdirSync(dir, { recursive: true });
  if (opts.writeSchemaAt) {
    const target = join(dir, opts.writeSchemaAt);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(SCHEMA), 'utf8');
  }
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: 'vendor.test.notes', version: '1.0.0', kind: 'artifact-type',
    artifactTypes: [{ artifactTypeId: 'vendor.test.note', schemaVersion: 1, schemaRef: opts.ref }],
  }), 'utf8');
  return root;
}

describe('RFC 0071 schemaRef — a conformant artifact-type pack installs', () => {
  beforeEach(() => { __resetArtifactTypes(); });

  it('resolves schemaRef relative to the pack dir and registers the type', () => {
    const root = packWithSchemaRef({ ref: 'schemas/note.schema.json', writeSchemaAt: 'schemas/note.schema.json' });
    try {
      const out = loadArtifactTypePacks({ roots: [root] });
      expect(out.registered, 'a schemaRef pack MUST register its type').toContain('vendor.test.note');
      // The resolved schema must be the one that VALIDATES — not merely stored.
      expect(validateArtifact('vendor.test.note', { title: 'a', body: 'b' }).valid).toBe(true);
      expect(validateArtifact('vendor.test.note', { title: 'a', extra: true }).valid).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a MISSING schemaRef target is a per-type error, not a silent skip', () => {
    // The original failure mode was silence: no type, no error. An installer
    // must be able to tell "rejected" from "installed nothing".
    const root = packWithSchemaRef({ ref: 'schemas/absent.schema.json' });
    try {
      const out = loadArtifactTypePacks({ roots: [root] });
      expect(getArtifactType('vendor.test.note')).toBeUndefined();
      expect(out.errors.some((e) => /schemaRef.*not found/.test(e.message)), 'a missing schemaRef MUST surface an error').toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a schemaRef escaping the pack dir is REFUSED, not read', () => {
    // A pack-supplied path is untrusted input; `..` must not read host files.
    const root = packWithSchemaRef({ ref: '../../../../etc/passwd' });
    try {
      const out = loadArtifactTypePacks({ roots: [root] });
      expect(getArtifactType('vendor.test.note')).toBeUndefined();
      expect(out.errors.some((e) => /escapes the pack directory/.test(e.message))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('inline `schema` still works — schemaRef is ADDITIVE, no shipped pack changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'owp-attype-inline-'));
    const dir = join(root, 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      name: 'vendor.test.inline', version: '1.0.0', kind: 'artifact-type',
      artifactTypes: [{ artifactTypeId: 'vendor.test.inline-note', schema: SCHEMA }],
    }), 'utf8');
    try {
      expect(loadArtifactTypePacks({ roots: [root] }).registered).toContain('vendor.test.inline-note');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('PMC-3 — canonical key vocabulary is accepted alongside the host dialect', () => {
  beforeEach(() => { __resetArtifactTypes(); });

  /** A pack written to `$defs/ArtifactType`: displayName + exportFormats + schemaRef. */
  function canonicalPack(): string {
    const root = mkdtempSync(join(tmpdir(), 'owp-attype-canon-'));
    const dir = join(root, 'p');
    mkdirSync(join(dir, 'schemas'), { recursive: true });
    writeFileSync(join(dir, 'schemas', 'n.schema.json'), JSON.stringify(SCHEMA), 'utf8');
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      name: 'vendor.test.canon', version: '1.0.0', kind: 'artifact-type',
      engines: { openwop: '>=1.1' },
      artifactTypes: [{
        artifactTypeId: 'vendor.test.canon-note',
        schemaRef: 'schemas/n.schema.json',
        displayName: 'Canonical Note',
        exportFormats: ['pdf', 'md'],
      }],
    }), 'utf8');
    return root;
  }

  it('reads displayName + exportFormats, not just title/export', () => {
    // The failure this prevents is SILENT: without the aliases the type still
    // registers, but its title collapses to the artifactTypeId and its export
    // facets become []. A migration would have "worked" while degrading data.
    const root = canonicalPack();
    try {
      expect(loadArtifactTypePacks({ roots: [root] }).registered).toContain('vendor.test.canon-note');
      const t = getArtifactType('vendor.test.canon-note');
      expect(t?.title, 'displayName must not collapse to the artifactTypeId').toBe('Canonical Note');
      expect(t?.export, 'exportFormats must not be dropped').toEqual(['pdf', 'md']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the host dialect still WINS when both are present — no shipped pack changes meaning', () => {
    const root = mkdtempSync(join(tmpdir(), 'owp-attype-both-'));
    const dir = join(root, 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      name: 'vendor.test.both', version: '1.0.0', kind: 'artifact-type',
      artifactTypes: [{
        artifactTypeId: 'vendor.test.both-note', schema: SCHEMA,
        title: 'Dialect', displayName: 'Canonical',
        export: ['docx'], exportFormats: ['pdf'],
      }],
    }), 'utf8');
    try {
      loadArtifactTypePacks({ roots: [root] });
      const t = getArtifactType('vendor.test.both-note');
      expect(t?.title).toBe('Dialect');
      expect(t?.export).toEqual(['docx']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
