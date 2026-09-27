/**
 * PMC-5 — the install boundary rejects a structurally invalid manifest.
 *
 * `registryInstaller` verified SRI integrity + Ed25519 signature and nothing else,
 * so a correctly-signed pack with an invalid manifest installed cleanly. A
 * signature proves AUTHORSHIP, not SHAPE.
 */
import { describe, expect, it } from 'vitest';
import { assertCanonicalManifest, ENFORCED_KINDS } from '../src/packs/canonicalManifestGate.js';

const bytes = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

const VALID_FORM_CONTENT = {
  name: 'vendor.test.forms', version: '1.0.0', kind: 'form-content',
  engines: { openwop: '>=1.0.0' },
  templates: [{
    templateId: 'vendor.test.form.basic', version: '1.0.0',
    label: 'Basic', title: 'Basic form',
    fields: [{ id: 'name', label: 'Name', type: 'text' }],
  }],
};

describe('PMC-5 — canonical manifest gate at the install boundary', () => {
  it('accepts a conforming pack of an ENFORCED kind', () => {
    expect(() => assertCanonicalManifest(bytes(VALID_FORM_CONTENT))).not.toThrow();
  });

  it('REJECTS a structurally invalid pack of an ENFORCED kind', () => {
    // Drop `templates` — required by the canonical schema. Before this gate a
    // pack like this installed cleanly as long as it was correctly signed.
    const { templates, ...broken } = VALID_FORM_CONTENT;
    expect(() => assertCanonicalManifest(bytes(broken))).toThrow(/pack_manifest_invalid/);
  });

  it('lets UNENFORCED kinds through — the gate must not become a blanket refusal', () => {
    // artifact-type is deliberately NOT enforced: 0 of 4 shipped packs validate,
    // so gating it would reject packs this repo ships. If someone adds it to
    // ENFORCED_KINDS without migrating those packs, this test documents why it
    // was excluded — and `pack-manifest-canonical-validity.test.ts` goes red.
    expect(ENFORCED_KINDS['artifact-type']).toBeUndefined();
    expect(() => assertCanonicalManifest(bytes({ name: 'x.y', kind: 'artifact-type', artifactTypes: [] }))).not.toThrow();
    expect(() => assertCanonicalManifest(bytes({ name: 'x.y', kind: 'node' }))).not.toThrow();
  });

  it('unparseable pack.json is a typed failure, not a silent pass', () => {
    expect(() => assertCanonicalManifest(new TextEncoder().encode('{not json'))).toThrow(/pack_manifest_unparseable/);
  });

  it('a manifest with NO kind passes through untouched', () => {
    expect(() => assertCanonicalManifest(bytes({ name: 'x.y', version: '1.0.0' }))).not.toThrow();
  });
});
