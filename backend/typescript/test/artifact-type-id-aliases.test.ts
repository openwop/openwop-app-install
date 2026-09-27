/**
 * PMC-4 — READ-SIDE artifact-type id aliases.
 *
 * This host's native ids (`canvas.checklist`, `doc.one-pager`, `brand.kit`)
 * predate the canonical `^(core|vendor|community|private)\.` namespace, so they
 * are not wire-conformant names. They cannot be renamed: `detectTypedArtifact`
 * (`runArtifactStore.ts:141`) reads `artifactTypeId` out of a NODE OUTPUT
 * ENVELOPE, so these ids live in the run-event log — immutable and replayed.
 * Rewriting them breaks `:fork` determinism, or leaves a replayed run emitting an
 * id the registry no longer knows, whereupon the artifact silently stops being
 * typed.
 *
 * So the alias resolves on READ only and is permanent, not transitional.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerArtifactType, getArtifactType, isRegisteredArtifactType,
  validateArtifact, resolveArtifactTypeId, __resetArtifactTypes,
} from '../src/host/artifactTypes.js';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title'], properties: { title: { type: 'string' } },
};

describe('PMC-4 — canonical ids resolve to the native registration', () => {
  beforeEach(() => {
    __resetArtifactTypes();
    registerArtifactType({
      artifactTypeId: 'canvas.checklist', title: 'Checklist',
      schema: SCHEMA, export: ['json'], registrationSource: 'pack',
    });
  });

  it('getArtifactType accepts the CANONICAL spelling', () => {
    const t = getArtifactType('community.openwop.canvas.checklist');
    expect(t, 'the conformant id did not resolve').toBeDefined();
    expect(t!.artifactTypeId, 'the alias rewrote the stored id — it must resolve, not mutate').toBe('canvas.checklist');
  });

  it('the NATIVE spelling still works — old events must keep resolving', () => {
    expect(isRegisteredArtifactType('canvas.checklist')).toBe(true);
  });

  it('isRegisteredArtifactType accepts both spellings', () => {
    expect(isRegisteredArtifactType('community.openwop.canvas.checklist')).toBe(true);
  });

  it('validateArtifact resolves too — otherwise a run passes the gate then validates against NOTHING', () => {
    // The dangerous asymmetry: if `isRegisteredArtifactType` aliased but
    // `validateArtifact` did not, a canonical id would report registered:true and
    // then fall into the unregistered escape hatch (registered:false, valid:true)
    // — silently untyped, with a green result.
    const ok = validateArtifact('community.openwop.canvas.checklist', { title: 'x' });
    expect(ok.registered, 'canonical id was treated as unregistered by the validator').toBe(true);
    expect(ok.valid).toBe(true);
    const bad = validateArtifact('community.openwop.canvas.checklist', { nope: 1 });
    expect(bad.valid, 'the resolved schema did not actually validate').toBe(false);
  });

  it('a DANGLING alias does not shadow a real miss', () => {
    // `core.openwop.doc.one-pager` is aliased, but nothing registered its target
    // in this test. It must report unregistered rather than resolving to nothing
    // and looking present.
    expect(isRegisteredArtifactType('core.openwop.doc.one-pager')).toBe(false);
    expect(resolveArtifactTypeId('core.openwop.doc.one-pager')).toBe('core.openwop.doc.one-pager');
  });

  it('an UNKNOWN id passes through unchanged', () => {
    expect(resolveArtifactTypeId('vendor.someone.else')).toBe('vendor.someone.else');
    expect(isRegisteredArtifactType('vendor.someone.else')).toBe(false);
  });
});
