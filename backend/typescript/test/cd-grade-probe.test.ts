/**
 * GRADING PROBE — "CAD" (FEATURES.md ordinal 228, ADR 0388). Evidence only.
 * GREEN + CI-safe. Exercises the closed-world CAD validator `validateCadDoc` (the
 * SSoT mirror of the `canvas.cad` artifact schema) + the untrusted-mesh decode
 * guard in `meshCodec` — the checks that make an untrusted (model- or user-authored)
 * CAD doc + an uploaded mesh safe.
 *
 * CDP-1 (closed-world reject): an unknown solid kind, an unknown solid field, a
 *     mesh-only field on a NON-mesh solid, and a mesh solid MISSING its `assetRef`
 *     are all rejected (closed enum + per-kind closed world + additionalProperties
 *     mirror). A mesh references a HOST asset by `assetRef` — never an external URL.
 * CDP-2 (SECURITY — mesh decompression-bomb guard): a binary STL that LIES about its
 *     triangle count (declares a billion triangles in a tiny file) is rejected — the
 *     declared count is bounded by the actual byte length, so a small file can never
 *     force a huge allocation (backed by the MAX_MESH_TRIANGLES cap).
 * CDP-3 (control): a well-formed CAD doc validates clean.
 */
import { describe, it, expect } from 'vitest';
import { validateCadDoc } from '../src/features/cad/validateCadDoc.js';
import { parseStl } from '../src/features/cad/meshCodec.js';

const model = (solids: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name: 'probe', units: 'mm', solids, ...extra });

/** A binary STL whose header claims `declaredCount` triangles but whose byte length
 *  does not match — the classic bomb (tiny file, huge declared count). */
function lyingBinaryStl(declaredCount: number): Uint8Array {
  const b = new Uint8Array(200); // >84 (has a triangle-count field) but != 84 + count*50
  new DataView(b.buffer).setUint32(80, declaredCount, true);
  return b;
}

describe('ADR 0388 CAD — closed-world + untrusted-mesh hardening (by execution)', () => {
  it('CDP-1: closed-world rejects unknown kind / unknown field / mesh-only-field-on-non-mesh / mesh-without-assetRef', () => {
    expect(validateCadDoc(model([{ kind: 'dodecahedron' }])).errors.length).toBeGreaterThan(0);
    expect(validateCadDoc(model([{ kind: 'box', bogusField: 1 }])).errors.length).toBeGreaterThan(0);
    expect(validateCadDoc(model([{ kind: 'box', assetRef: 'x' }])).errors.length).toBeGreaterThan(0); // mesh-only on a box
    expect(validateCadDoc(model([{ kind: 'mesh' }])).errors.length).toBeGreaterThan(0); // a mesh requires assetRef
  });

  it('CDP-2 (security): a binary STL lying about its triangle count is rejected — a tiny file cannot force a huge allocation', () => {
    expect(() => parseStl(lyingBinaryStl(1_000_000_000))).toThrow(/mismatch|malformed/i);
  });

  it('CDP-3 (control): a well-formed CAD doc validates clean', () => {
    expect(validateCadDoc(model([{ kind: 'box', width: 10, height: 10, depth: 10 }])).errors).toEqual([]);
  });
});
