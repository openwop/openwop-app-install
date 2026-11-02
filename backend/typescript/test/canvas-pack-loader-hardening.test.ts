/**
 * ADR 0310 Phase D (canvas packs) — the UNTRUSTED artifact-type pack loader's
 * `x-openwop-app.canvas` extension screen. Tracker TST-CQC-3 (w68; renamed from
 * the grading-pass leftover `cp-grade-probe.test.ts`).
 *
 * A pack is third-party data. Its canvas extension names object KEYS the editor
 * later writes (field names) and an id that becomes a route path and an FE URL,
 * so both are screened before anything is registered:
 *
 * CPP-1 (control): a clean canvas pack registers its canvas type — without it the
 *     two refusals below could pass on a loader that registers nothing.
 * CPP-2 (prototype pollution): a field named `__proto__` is REJECTED with its own
 *     message; the canvas type is NOT registered, the ARTIFACT type still is (a
 *     malformed extension is isolated). Red when the `UNSAFE_FIELD_NAMES` check in
 *     `packPropDef` is skipped.
 * CPP-3 (id injection): a non-`canvas.<slug>` id (uppercase/underscore) is REJECTED
 *     by `CANVAS_TYPE_ID_RE` with its own message. Red when that check is skipped.
 *
 * Each refusal asserts its EXACT message: the generic "x-openwop-app.canvas
 * rejected" prefix is shared by every extension refusal, so it cannot tell which
 * guard fired.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getPackCanvasType, __resetPackCanvasTypes } from '../src/host/canvasPackTypes.js';
import { __resetArtifactTypes, isRegisteredArtifactType } from '../src/host/artifactTypes.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function packRoot(dirName: string, manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'cpack-hardening-'));
  roots.push(root);
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
    expect(out.errors.map((e) => e.message)).toContain(
      'type `canvas.probe-proto`: x-openwop-app.canvas rejected — collections[0].fields[0]: field name `__proto__` is not allowed',
    );
    expect(getPackCanvasType('canvas.probe-proto')).toBeUndefined();        // canvas type NOT registered
    expect(isRegisteredArtifactType('canvas.probe-proto')).toBe(true);      // but the artifact type IS (isolation)
  });

  it('CPP-3 (security): a non-`canvas.<slug>` id is REJECTED by the slug regex (route/URL injection guard)', () => {
    const root = packRoot('vendor.slug', manifest('vendor.slug', canvasTypeEntry('canvas.BAD_UPPER', cleanEditor)));
    const out = loadArtifactTypePacks({ roots: [root] });
    expect(out.errors.map((e) => e.message)).toContain(
      'type `canvas.BAD_UPPER`: x-openwop-app.canvas rejected — the canvas extension needs a `canvas.<slug>` artifactTypeId (lowercase a-z, 0-9, dashes; max 64)',
    );
    expect(getPackCanvasType('canvas.BAD_UPPER')).toBeUndefined();
  });
});
