/**
 * The SHIPPED artifact-type packs still load correctly after the canonical
 * migration (PMC-4, partial).
 *
 * WHY THIS TEST EXISTS. The migration rewrote both packs from the host dialect
 * (`title`, `export`, inline `schema`) to the canonical vocabulary (`displayName`,
 * `exportFormats`, `schemaRef`). The failure mode is SILENT: if the loader did not
 * understand the canonical keys, the types would still register — with the title
 * collapsed to the artifactTypeId and the export facets emptied. A migration that
 * degrades data rather than failing is exactly what this program keeps finding, so
 * the guard asserts the VALUES survived, not merely that registration happened.
 *
 * `PMC-3` (#3010) taught the loader those aliases; this pins that the shipped packs
 * actually benefit from it.
 *
 * What breaks it (sabotage-witnessed, /grade-tests wave 61, 8fw3g1-atp-*): the
 * loader dropping `displayName` (each title is pinned to the pack's literal), the
 * `exportFormats` alias, the `schemaRef` resolution (a bad payload must be
 * REJECTED by the resolved schema and a good one accepted), or the
 * `x-openwop-app.canvas` extension (the editor hints must reach the pack canvas
 * registry, not merely co-exist with a registered type).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getArtifactType, validateArtifact, __resetArtifactTypes } from '../src/host/artifactTypes.js';
import { getPackCanvasType, __resetPackCanvasTypes } from '../src/host/canvasPackTypes.js';

const PACKS = resolve(process.cwd(), '..', '..', 'packs');

describe('shipped artifact-type packs survive the canonical migration', () => {
  beforeAll(() => {
    __resetArtifactTypes();
    __resetPackCanvasTypes();
    loadArtifactTypePacks({ roots: [PACKS] });
  });

  // The second column is each pack's `displayName`, copied by hand from the
  // pack.json files (the values the loader must carry through, not computed).
  it.each([
    ['canvas.checklist', 'Checklist'],
    ['doc.one-pager', 'One-Pager'],
    ['brand.kit', 'Brand Kit'],
  ])('%s registers with a real title, not the id', (id, title) => {
    const t = getArtifactType(id);
    expect(t, `${id} did not register at all`).toBeDefined();
    // The silent-degradation guard: a lost `displayName` falls back to the id.
    expect(t!.title, `${id} title collapsed to the artifactTypeId — displayName was dropped`).not.toBe(id);
    expect(t!.title).toBe(title);
  });

  it('export facets survive the export -> exportFormats rename', () => {
    // `canvas.checklist` shipped `export: ["json"]`; after migration that value
    // lives under `exportFormats`. An empty array here means the rename silently
    // dropped it.
    const t = getArtifactType('canvas.checklist');
    expect(t?.export, 'exportFormats was dropped during migration').toEqual(['json']);
  });

  it('the schemaRef split produces a schema that actually VALIDATES', () => {
    // Registering a type whose schema failed to resolve would still "load" — the
    // discriminator is whether the resolved schema rejects a bad payload.
    const t = getArtifactType('canvas.checklist');
    expect(t?.schema, 'schemaRef did not resolve to a schema object').toBeTypeOf('object');
    const good = validateArtifact('canvas.checklist', { title: 'Launch', items: [{ text: 'Ship it', done: false }] });
    expect(good).toMatchObject({ registered: true, registrationSource: 'pack', valid: true });
    const bad = validateArtifact('canvas.checklist', { items: 'not-an-array' });
    expect(bad.registered).toBe(true);
    expect(bad.valid, 'the resolved schema accepted a payload it must reject').toBe(false);
    expect(bad.errors).toContain('/items must be array');
  });

  it('the RFC 0138 vendor extension is retained through the migration', () => {
    // `x-openwop-app.canvas` (ADR 0310 Phase D) is what the canonical schema used
    // to forbid outright. It must still reach the canvas registration path.
    const t = getArtifactType('canvas.checklist');
    expect(t, 'the extension-carrying pack failed to register').toBeDefined();
    const canvas = getPackCanvasType('canvas.checklist');
    expect(canvas, 'the x-openwop-app.canvas extension never reached the pack canvas registry').toBeDefined();
    expect(canvas!.packName).toBe('community.openwop.canvas-checklist');
    expect(canvas!.editor?.docNameKey).toBe('title');
    expect(canvas!.editor?.collections.map((c) => c.key)).toEqual(['items']);
  });
});
