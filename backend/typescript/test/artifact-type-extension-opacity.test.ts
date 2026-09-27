/**
 * RFC 0139 — an unrecognised extension MUST NOT change host behaviour.
 *
 * openwop-1 measured why a presence-check is insufficient: a stub host that
 * routes an unrecognised extension into a derived facet still passes legs 1, 2
 * and 5. Only the DIFFERENTIAL check catches it — install two manifests
 * identical except that one carries `^(x-|vendor\.)` properties the host does not
 * recognise, and require the observable registration projections to match after
 * recursive extension-stripping.
 *
 * The strength of the check is bounded by what the projection SURFACES. A thin
 * projection passes while proving less, so this asserts on derived values
 * (display name, export facets, resolved-schema keys) rather than on echoed
 * input.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getArtifactType, __resetArtifactTypes } from '../src/host/artifactTypes.js';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' } },
};

const ID = 'vendor.conformance.opacity-note';

/** Build a pack; `extensions` adds unrecognised `^(x-|vendor\.)` properties. */
function pack(extensions: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-opacity-'));
  const dir = join(root, 'p');
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'schemas', 'n.schema.json'), JSON.stringify(SCHEMA), 'utf8');
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: 'vendor.conformance.opacity', version: '1.0.0', kind: 'artifact-type',
    engines: { openwop: '>=1.1' },
    artifactTypes: [{
      artifactTypeId: ID, schemaRef: 'schemas/n.schema.json', schemaVersion: 1,
      displayName: 'Opacity Note', exportFormats: ['json'],
      ...extensions,
    }],
  }), 'utf8');
  return root;
}

/** The derived surface — what the host COMPUTED, not what it was handed. */
function project() {
  const t = getArtifactType(ID);
  return {
    displayName: t?.title ?? null,
    exportFormats: [...(t?.export ?? [])].sort(),
    registrationSource: t?.registrationSource ?? null,
    schemaKeys: Object.keys((t?.schema as { properties?: object } | undefined)?.properties ?? {}).sort(),
  };
}

function install(extensions: Record<string, unknown>) {
  __resetArtifactTypes();
  const root = pack(extensions);
  try {
    const out = loadArtifactTypePacks({ roots: [root] });
    return { registered: [...out.registered].sort(), errors: out.errors.length, projection: project() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('RFC 0139 — unrecognised extensions are opaque', () => {
  beforeEach(() => { __resetArtifactTypes(); });

  it('accepts BOTH manifests — an extension must not change acceptance', () => {
    expect(install({}).registered).toEqual([ID]);
    expect(install({ 'x-unknown-thing': { a: 1 } }).registered).toEqual([ID]);
  });

  it('the derived projection is IDENTICAL with and without extensions', () => {
    // The load-bearing assertion. If any unrecognised property reached a derived
    // value — display name, export facets, resolved-schema keys — these diverge.
    const withoutExt = install({});
    const withExt = install({
      'x-unknown-thing': { rendered: 'should never surface' },
      'vendor.someone.facet': { exportFormats: ['pdf'], displayName: 'HIJACKED' },
    });
    expect(withExt.projection).toEqual(withoutExt.projection);
  });

  it('an extension shaped like a REAL field does not override it', () => {
    // `vendor.someone.facet` above carries `displayName`/`exportFormats` keys
    // deliberately: a host that merged extension bodies would pick them up.
    const withExt = install({ 'vendor.someone.facet': { displayName: 'HIJACKED', exportFormats: ['pdf'] } });
    expect(withExt.projection.displayName, 'an extension overrode the canonical displayName').toBe('Opacity Note');
    expect(withExt.projection.exportFormats).toEqual(['json']);
  });

  it('rejection is symmetric — both fail for the same reason, or neither', () => {
    // A manifest broken the same way must fail identically with and without an
    // extension; an extension must not rescue OR doom a pack.
    const brokenPlain = install({ schemaRef: undefined as unknown as string });
    const brokenExt = install({ schemaRef: undefined as unknown as string, 'x-noise': 1 });
    expect(brokenExt.registered).toEqual(brokenPlain.registered);
    expect(brokenExt.errors > 0).toBe(brokenPlain.errors > 0);
  });
});
