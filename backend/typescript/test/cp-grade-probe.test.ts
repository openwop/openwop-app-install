/**
 * GRADING PROBE — "Canvas Packs (Tier-1 FE-less canvas types)" (FEATURES.md ordinal
 * 229, ADR 0310 Phase D). Evidence only. GREEN + CI-safe. Drives the REAL untrusted
 * pack loader (`loadArtifactTypePacks`) with crafted temp packs to witness the
 * `x-openwop-app.canvas` extension's parser hardening — the trust boundary the code
 * scout flagged as UNTESTED (no test for the slug-regex rejection nor the
 * prototype-name screening of the canvas extension).
 *
 * CPP-1 (control): a clean canvas pack registers its canvas type.
 * CPP-2 (security — prototype-pollution screen): a canvas extension with a
 *     `__proto__` field name is REJECTED (error collected, canvas type NOT
 *     registered), while the ARTIFACT type still registers — a malformed extension
 *     is isolated, never un-registering the type.
 * CPP-3 (security — path-injection / id hardening): a canvasTypeId that is not a
 *     `canvas.<slug>` (uppercase/underscore) is REJECTED by CANVAS_TYPE_ID_RE — the
 *     id becomes a route path + FE URL, so a crafted id can't inject.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getPackCanvasType, __resetPackCanvasTypes } from '../src/host/canvasPackTypes.js';
import { __resetArtifactTypes, isRegisteredArtifactType } from '../src/host/artifactTypes.js';

function packRoot(dirName: string, manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'cpackprobe-'));
  const d = join(root, dirName);
  mkdirSync(d);
  writeFileSync(join(d, 'pack.json'), JSON.stringify(manifest));
  return root;
}

const cleanEditor = {
  collections: [
    { key: 'items', label: 'Items', max: 100, adders: [{ id: 'add', label: 'Add', defaults: { title: '' } }], fields: [{ name: 'title', type: 'text' }] },
  ],
};

function canvasTypeEntry(artifactTypeId: string, editor: unknown) {
  return {
    artifactTypeId,
    title: 'Probe',
    schema: { type: 'object', properties: {}, additionalProperties: true },
    'x-openwop-app.canvas': { editor },
  };
}

const manifest = (name: string, entry: unknown) => ({ name, version: '1.0.0', kind: 'artifact-type', artifactTypes: [entry] });

describe('ADR 0310 Phase D canvas-packs — untrusted pack-loader hardening (by execution)', () => {
  beforeEach(() => { __resetArtifactTypes(); __resetPackCanvasTypes(); });

  it('CPP-1 (control): a clean canvas pack registers its canvas type', () => {
    const root = packRoot('vendor.clean', manifest('vendor.clean', canvasTypeEntry('canvas.probe-ok', cleanEditor)));
    loadArtifactTypePacks({ roots: [root] });
    expect(getPackCanvasType('canvas.probe-ok')).toBeDefined();
  });

  it('CPP-2 (security): a prototype-pollution field name is REJECTED — extension isolated, artifact type still registers', () => {
    const evil = { collections: [{ key: 'items', label: 'Items', max: 100, adders: [{ id: 'add', label: 'Add', defaults: {} }], fields: [{ name: '__proto__', type: 'text' }] }] };
    const root = packRoot('vendor.proto', manifest('vendor.proto', canvasTypeEntry('canvas.probe-proto', evil)));
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.errors.some((e) => /x-openwop-app\.canvas rejected/.test(e.message))).toBe(true);
    expect(getPackCanvasType('canvas.probe-proto')).toBeUndefined();        // canvas type NOT registered
    expect(isRegisteredArtifactType('canvas.probe-proto')).toBe(true);      // but the artifact type IS (isolation)
  });

  it('CPP-3 (security): a non-`canvas.<slug>` id is REJECTED by the slug regex (route/URL injection guard)', () => {
    const root = packRoot('vendor.slug', manifest('vendor.slug', canvasTypeEntry('canvas.BAD_UPPER', cleanEditor)));
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.errors.some((e) => /x-openwop-app\.canvas rejected/.test(e.message))).toBe(true);
    expect(getPackCanvasType('canvas.BAD_UPPER')).toBeUndefined();
  });
});
