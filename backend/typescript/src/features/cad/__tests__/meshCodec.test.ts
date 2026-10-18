/**
 * meshCodec (ADR 0388 P1) — round-trip fixtures (our exporter ↔ our importer),
 * typed-failure posture (malformed/oversized → MeshCodecError, never a
 * lookalike), determinism, and the FE↔BE twin byte-parity pin.
 *
 * Sabotage-witnessed (/grade-tests w34): the triangle cap (full-length body,
 * literal oracle), the ASCII/binary non-finite guards, the length check, OBJ fan
 * + negative-index resolution + material disclosure, glTF bounds / external-URI /
 * sparse / material-disclosure / TRS, tessellation closedness (independent
 * divergence volume), placement, and pose order. Parity passes vacuously only
 * without the frontend tree (CAD-G4); the cap has a second guard in finishMesh
 * with the same message (a recorded double guard). W34-CAD-3 (BLOCKED-ON-PRODUCT,
 * `it.fails`): the sphere tessellation is inward-wound.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  emitCanonicalStl,
  emitGlb,
  parseGltf,
  parseObj,
  parseStl,
  poseMesh,
  tessellateSolid,
  MeshCodecError,
} from '../meshCodec.js';

const here = dirname(fileURLToPath(import.meta.url));

const TRI = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 0, 10, 5]);

/** Signed volume by the divergence theorem (Σ a·(b×c) / 6) — an independent
 *  oracle: exact for a closed, outward-wound triangle soup; an open or
 *  inward-wound mesh reads wrong. Never computed by the code under test. */
function signedVolume(t: Float32Array): number {
  let v6 = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!, t[i + 6]!, t[i + 7]!, t[i + 8]!];
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v6 / 6;
}

describe('meshCodec — canonical STL', () => {
  it('binary round-trips byte-identically (emit → parse → emit)', () => {
    const bytes1 = emitCanonicalStl(TRI);
    const parsed = parseStl(bytes1);
    expect(parsed.triangleCount).toBe(2);
    expect([...parsed.positions]).toEqual([...TRI]);
    const bytes2 = emitCanonicalStl(parsed.positions);
    expect(Buffer.from(bytes2).equals(Buffer.from(bytes1))).toBe(true); // determinism
  });

  it('parses ASCII STL', () => {
    const ascii = `solid a
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 0
 endloop
endfacet
endsolid a`;
    const parsed = parseStl(new TextEncoder().encode(ascii));
    expect(parsed.triangleCount).toBe(1);
    expect(parsed.positions[3]).toBe(10);
  });

  it('typed errors: truncated binary, length mismatch, non-numeric ASCII vertex', () => {
    expect(() => parseStl(new Uint8Array(10))).toThrowError(MeshCodecError);
    const bad = emitCanonicalStl(TRI).slice(0, 100); // truncated
    expect(() => parseStl(bad)).toThrowError(/length mismatch/);
    // `1e999` matches the vertex grammar but is not finite — the fixture must
    // REACH the guard (a non-matching `vertex a b c` only ever hit empty_mesh).
    const badAscii = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 1e999 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x';
    expect(() => parseStl(new TextEncoder().encode(badAscii))).toThrowError(/ASCII STL has a non-numeric vertex/);
  });

  it('triangle cap is enforced with a typed error', () => {
    // A FULL, length-consistent body of 50,001 triangles — a header-only file
    // fails the length check first and never reaches the cap. The count is a
    // literal (the documented 50k ceiling), never read from the module under
    // test, so a raised cap cannot move the oracle with it.
    const n = 50_001;
    const body = new Uint8Array(84 + n * 50);
    new DataView(body.buffer).setUint32(80, n, true);
    expect(() => parseStl(body)).toThrowError(MeshCodecError);
    expect(() => parseStl(body)).toThrowError(/Mesh has 50001 triangles — the cap is 50000/);
  });
});

describe('meshCodec — OBJ', () => {
  it('parses v/f with quad fan-triangulation and negative indices', () => {
    const obj = `# quad
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
f 1 2 3 4
f -4 -3 -2
`;
    const parsed = parseObj(obj);
    expect(parsed.triangleCount).toBe(3); // quad → 2 + 1
    expect(parsed.dropped).toEqual([]);
    // fan (v1,v2,v3) + (v1,v3,v4), then -4 -3 -2 resolves to v1 v2 v3
    expect([...parsed.positions]).toEqual([
      0, 0, 0, 10, 0, 0, 10, 10, 0,
      0, 0, 0, 10, 10, 0, 0, 10, 0,
      0, 0, 0, 10, 0, 0, 10, 10, 0,
    ]);
  });

  it('discloses dropped materials; rejects bad indices', () => {
    const obj = `mtllib m.mtl
v 0 0 0
v 1 0 0
v 0 1 0
usemtl steel
f 1 2 3
`;
    expect(parseObj(obj).dropped).toContain('materials');
    expect(() => parseObj('v 0 0 0\nf 1 2 9')).toThrowError(/out of range/);
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nf 1 2')).toThrowError(/fewer than 3/);
  });
});

describe('meshCodec — GLTF/GLB', () => {
  it('our GLB export round-trips through our GLTF importer', () => {
    const glb = emitGlb([{ label: 'part', positions: TRI, color: '#ff0000', metallic: 0.2, roughness: 0.5 }]);
    const parsed = parseGltf(glb);
    expect(parsed.triangleCount).toBe(2);
    // materials are declared in our GLB → the importer discloses dropping them
    expect(parsed.dropped).toContain('materials');
    for (let i = 0; i < TRI.length; i += 1) {
      expect(parsed.positions[i]).toBeCloseTo(TRI[i] ?? 0, 4);
    }
  });

  it('GLB export is deterministic (same input → identical bytes)', () => {
    const a = emitGlb([{ label: 'p', positions: TRI }]);
    const b = emitGlb([{ label: 'p', positions: TRI }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('typed reject: an accessor reading past its buffer (never a raw RangeError)', () => {
    const bad = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      // count 100 × 12 bytes ≫ the 12-byte buffer — must be a typed 'malformed'.
      accessors: [{ bufferView: 0, componentType: 5126, count: 100, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
      buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.alloc(12).toString('base64')}`, byteLength: 12 }],
    });
    expect(() => parseGltf(new TextEncoder().encode(bad))).toThrowError(MeshCodecError);
    expect(() => parseGltf(new TextEncoder().encode(bad))).toThrowError(/past its buffer/);
  });

  it('typed rejects: external buffer URI (SSRF posture), required extensions, sparse', () => {
    const external = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'https://evil.example/mesh.bin', byteLength: 100 }],
    });
    expect(() => parseGltf(new TextEncoder().encode(external))).toThrowError(/EXTERNAL buffer URI/);
    const reqExt = JSON.stringify({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] });
    expect(() => parseGltf(new TextEncoder().encode(reqExt))).toThrowError(/extensions/);
    const sparse = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1 } }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.alloc(36).toString('base64')}`, byteLength: 36 }],
    });
    expect(() => parseGltf(new TextEncoder().encode(sparse))).toThrowError(/sparse accessors/);
  });

  it('bakes node TRS transforms', () => {
    const glb = emitGlb([{ label: 'p', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    // Re-parse, then wrap through a translation via a hand-built gltf JSON:
    const parsed = parseGltf(glb);
    const translated = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [5, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(new Uint8Array(parsed.positions.slice(0, 9).buffer)).toString('base64')}`, byteLength: 36 }],
    });
    const out = parseGltf(new TextEncoder().encode(translated));
    expect(out.positions[0]).toBeCloseTo(5, 5);
    expect(out.positions[3]).toBeCloseTo(6, 5);
  });
});

describe('meshCodec — parametric tessellation', () => {
  it('every parametric kind emits closed triangle geometry; deterministic', () => {
    // Closed + outward-wound ⇔ the divergence volume equals the solid's. Box:
    // 10³. Cylinder/cone: the inscribed 24-gon prism/pyramid, (n/2)·r²·sin(2π/n)·L
    // = 12·100·sin(π/12)·20 (÷3 for the cone). Sphere: inscribed, so strictly
    // under (4/3)π·10³ and above 90 % of it. All hand-derived.
    const expected: Record<string, (v: number) => void> = {
      box: (v) => expect(v).toBeCloseTo(1000, 3),
      cylinder: (v) => expect(v).toBeCloseTo(6211.657082, 2),
      cone: (v) => expect(v).toBeCloseTo(2070.552361, 2),
      // |V|: closedness only — the sphere's WINDING is pinned separately (W34-CAD-3).
      sphere: (v) => { expect(Math.abs(v)).toBeGreaterThan(0.9 * 4188.790205); expect(Math.abs(v)).toBeLessThan(4188.790205); },
    };
    for (const kind of ['box', 'cylinder', 'sphere', 'cone'] as const) {
      const tris = tessellateSolid({ kind, radius: 10, length: 20, width: 10, height: 10, depth: 10 });
      expect(tris.length % 9).toBe(0);
      expected[kind]!(signedVolume(tris));
      const again = tessellateSolid({ kind, radius: 10, length: 20, width: 10, height: 10, depth: 10 });
      expect([...again]).toEqual([...tris]);
    }
  });

  // W34-CAD-3 (BLOCKED-ON-PRODUCT): the sphere is closed but INWARD-wound —
  // its divergence volume is negative (measured −4070.55 for r=10), so every
  // exported STL/GLB sphere carries inverted normals (box/cylinder/cone are
  // outward, per the case above). Pinned until the ring winding is flipped.
  it.fails('W34-CAD-3: the sphere tessellation is outward-wound like every other kind', () => {
    const tris = tessellateSolid({ kind: 'sphere', radius: 10 });
    expect(signedVolume(tris)).toBeGreaterThan(0.9 * 4188.790205);
  });

  it('box tessellates to exactly 12 triangles with the declared dimensions', () => {
    const tris = tessellateSolid({ kind: 'box', width: 20, height: 10, depth: 30, x: 5, y: 5, z: 5 });
    expect(tris.length / 9).toBe(12); // dimensions: see the CAD-C1 placement golden below
  });

  it('GRADE CAD-C1: placement golden — exports match the viewer convention (min-corner, Y-up)', () => {
    // Box at min-corner (5,5,5), 20×10×30 → bbox [5..25]×[5..15]×[5..35].
    const box = tessellateSolid({ kind: 'box', width: 20, height: 10, depth: 30, x: 5, y: 5, z: 5 });
    const bbox = (tris: Float32Array): number[] => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < tris.length; i += 3) {
        minX = Math.min(minX, tris[i]!); maxX = Math.max(maxX, tris[i]!);
        minY = Math.min(minY, tris[i + 1]!); maxY = Math.max(maxY, tris[i + 1]!);
        minZ = Math.min(minZ, tris[i + 2]!); maxZ = Math.max(maxZ, tris[i + 2]!);
      }
      return [minX, maxX, minY, maxY, minZ, maxZ];
    };
    expect(bbox(box)).toEqual([5, 25, 5, 15, 5, 35]);
    // Cylinder: axis along Y — bottom at y, top at y+length; centred at (x+r, z+r).
    const cyl = tessellateSolid({ kind: 'cylinder', radius: 10, length: 40, x: 0, y: 0, z: 0 });
    const [cminX, cmaxX, cminY, cmaxY] = bbox(cyl);
    expect(cminY).toBeCloseTo(0, 5);
    expect(cmaxY).toBeCloseTo(40, 5);
    expect((cminX! + cmaxX!) / 2).toBeCloseTo(10, 3); // axis at x+r
    // Sphere: centre (x+r, y+r, z+r) — poles along Y.
    const sph = tessellateSolid({ kind: 'sphere', radius: 5, x: 0, y: 0, z: 0 });
    const [, , sminY, smaxY] = bbox(sph);
    expect(sminY).toBeCloseTo(0, 4);
    expect(smaxY).toBeCloseTo(10, 4);
    // 2D rotation spins about the solid's own centre (footprint-preserving).
    const rot = tessellateSolid({ kind: 'box', width: 20, height: 10, depth: 30, x: 5, y: 5, z: 5, rotation: 90 });
    const [rminX, rmaxX, rminY, rmaxY] = bbox(rot);
    expect((rminX! + rmaxX!) / 2).toBeCloseTo(15, 4); // same centre
    expect((rminY! + rmaxY!) / 2).toBeCloseTo(10, 4);
    expect(rmaxX! - rminX!).toBeCloseTo(10, 4); // width/height swapped by 90°
    expect(rmaxY! - rminY!).toBeCloseTo(20, 4);
  });

  it('GRADE CAD-C5: binary STL with non-finite floats is a typed reject', () => {
    const good = emitCanonicalStl(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const bad = new Uint8Array(good);
    const dv = new DataView(bad.buffer);
    dv.setFloat32(84 + 12, Number.NaN, true); // first vertex x
    expect(() => parseStl(bad)).toThrowError(/non-finite/);
  });

  it('poseMesh applies scale → rotation → translation', () => {
    const mesh = parseStl(emitCanonicalStl(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])));
    const posed = poseMesh(mesh, { kind: 'mesh', scale: 2, rotation: 90, x: 10, y: 0, z: 0 });
    // (1,0,0) → scale (2,0,0) → rot90 (0,2,0) → translate (10,2,0)
    expect(posed[3]).toBeCloseTo(10, 5);
    expect(posed[4]).toBeCloseTo(2, 5);
  });
});

describe('FE↔BE twin parity (architect R4 — pinned harder than behavior)', () => {
  it('backend and frontend meshCodec.ts are BYTE-IDENTICAL', () => {
    const backend = readFileSync(join(here, '..', 'meshCodec.ts'), 'utf8');
    const frontendPath = join(here, '..', '..', '..', '..', '..', '..', 'frontend', 'react', 'src', 'features', 'cad', 'meshCodec.ts');
    // GRADE-PASS CAD-G4: the deploy image / a backend-only checkout has no
    // frontend tree — the parity pin runs wherever the full checkout does (CI,
    // dev), and passes vacuously where the twin simply isn't present.
    if (!existsSync(frontendPath)) return;
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(backend);
  });
});
