/**
 * ADR 0388 (CAD) — the closed-world `validateCadDoc` mirror of the `canvas.cad`
 * schema, and the untrusted-mesh STL length-mismatch guard in `meshCodec`.
 * Tracker TST-CBM-2 (grade-tests w67; file kept under its historical name).
 *
 * CDP-1 closed world, one exact `{path, message}` per sub-claim:
 *   - an unknown solid kind is refused at `solids[0].kind`
 *     (red when `validateCadDoc` stops checking `KINDS`; this is the only test
 *     of that check on `validateCadDoc` — the agent tool's own render node
 *     refuses the kind first, and cad.test.ts checks the SCHEMA mirror);
 *   - an unknown field is refused (red when the trailing unknown-field error
 *     is dropped);
 *   - a mesh-only field on a box is refused with the mesh-only message (red
 *     when the `MESH_ONLY_FIELDS` branch is skipped);
 *   - a mesh without `assetRef` is refused (red when that check is removed).
 * CDP-2 (security): a binary STL that declares a billion triangles in 200
 *   bytes is refused as a length mismatch before any allocation (red when the
 *   `84 + count * 50` length check is skipped — the triangle cap then throws a
 *   different error). Also covered by meshCodec.test.ts "typed errors: …".
 * CDP-3 (control): a well-formed doc validates clean.
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
    expect(validateCadDoc(model([{ kind: 'dodecahedron' }])).errors).toEqual([
      { path: 'solids[0].kind', message: 'kind must be one of: box, cylinder, sphere, cone, mesh' },
    ]);
    expect(validateCadDoc(model([{ kind: 'box', bogusField: 1 }])).errors).toEqual([
      { path: 'solids[0].bogusField', message: "unknown solid field 'bogusField'" },
    ]);
    expect(validateCadDoc(model([{ kind: 'box', assetRef: 'x' }])).errors).toEqual([
      { path: 'solids[0].assetRef', message: "'assetRef' is only valid on a mesh solid" },
    ]);
    expect(validateCadDoc(model([{ kind: 'mesh' }])).errors).toEqual([
      { path: 'solids[0].assetRef', message: 'a mesh solid requires an assetRef' },
    ]);
  });

  it('CDP-2 (security): a binary STL lying about its triangle count is rejected — a tiny file cannot force a huge allocation', () => {
    expect(() => parseStl(lyingBinaryStl(1_000_000_000)))
      .toThrow('Binary STL length mismatch: 200 bytes for 1000000000 triangles.');
  });

  it('CDP-3 (control): a well-formed CAD doc validates clean', () => {
    expect(validateCadDoc(model([{ kind: 'box', width: 10, height: 10, depth: 10 }])).errors).toEqual([]);
  });
});
