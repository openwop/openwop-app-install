import { describe, it, expect } from 'vitest';
import { rotate, tessellate, shadeBrightness, centroid, type Drawable } from '../cad3d.js';

const faces = (ds: Drawable[]) => ds.filter((d) => d.kind === 'face');

describe('cad3d pure math (ADR 0310 Phase-C 3D viewer)', () => {
  it('rotate: identity at 0; 90° yaw maps +x → -z; 90° pitch maps +y → +z', () => {
    expect(rotate({ x: 1, y: 2, z: 3 }, 0, 0)).toEqual({ x: 1, y: 2, z: 3 });
    const yaw = rotate({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0);
    expect(yaw.x).toBeCloseTo(0, 6);
    expect(yaw.z).toBeCloseTo(-1, 6);
    const pitch = rotate({ x: 0, y: 1, z: 0 }, 0, Math.PI / 2);
    expect(pitch.y).toBeCloseTo(0, 6);
    expect(pitch.z).toBeCloseTo(1, 6);
  });

  it('cylinder + cone side faces have OUTWARD normals (guards the winding)', () => {
    const dotR = (n: { x: number; z: number }, rx: number, rz: number) => n.x * rx + n.z * rz;
    for (const kind of ['cylinder', 'cone'] as const) {
      const ds = tessellate({ kind, x: 0, y: 0, z: 0, radius: 5, length: 10 }, 8);
      const cx = 5, cz = 5; // axis at (x+r, z+r)
      for (const d of faces(ds).slice(0, 8)) { // the first `seg` faces are the sides
        if (d.kind !== 'face') continue;
        const vs = d.face.verts, k = vs.length;
        const c = { x: vs.reduce((a, v) => a + v.x, 0) / k, z: vs.reduce((a, v) => a + v.z, 0) / k };
        // The side normal must point AWAY from the central axis (outward).
        expect(dotR(d.face.normal, c.x - cx, c.z - cz)).toBeGreaterThan(0);
      }
    }
  });

  it('an unknown kind tessellates to nothing (degenerate)', () => {
    expect(tessellate({ kind: 'pyramid' })).toEqual([]);
    expect(tessellate({})).toEqual([]);
  });

  it('tessellate: box → 6 faces (4 verts each); cone → seg tris + 1 base; sphere → 1 disc', () => {
    const box = tessellate({ kind: 'box', x: 0, y: 0, z: 0, width: 10, height: 10, depth: 10 });
    expect(faces(box)).toHaveLength(6);
    expect(box.every((d) => d.kind === 'face' && d.face.verts.length === 4)).toBe(true);

    const cone = tessellate({ kind: 'cone', x: 0, y: 0, z: 0, radius: 5, length: 10 }, 12);
    expect(faces(cone)).toHaveLength(13); // 12 side triangles + 1 base cap

    const cyl = tessellate({ kind: 'cylinder', x: 0, y: 0, z: 0, radius: 5, length: 10 }, 12);
    expect(faces(cyl)).toHaveLength(14); // 12 sides + top + bottom

    const sphere = tessellate({ kind: 'sphere', x: 0, y: 0, z: 0, radius: 5 });
    expect(sphere).toHaveLength(1);
    expect(sphere[0]!.kind).toBe('sphere');
  });

  it('box faces have outward unit normals', () => {
    const box = tessellate({ kind: 'box', x: 0, y: 0, z: 0, width: 2, height: 2, depth: 2 });
    for (const d of box) {
      if (d.kind !== 'face') continue;
      const n = d.face.normal;
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    }
  });

  it('shadeBrightness: stays in range; aligned > grazing; a glossier surface has a brighter highlight at the peak', () => {
    const matte = { metallic: 0, roughness: 1 };
    // Range invariant across many orientations.
    for (const n of [{ x: 1, y: 0, z: 0.1 }, { x: 0, y: 1, z: 0.2 }, { x: -1, y: -1, z: 0.3 }]) {
      const b = shadeBrightness(n, matte);
      expect(b).toBeGreaterThanOrEqual(0.15);
      expect(b).toBeLessThanOrEqual(1.7);
    }
    // Diffuse ordering: a normal aligned with the light out-shines a grazing one (same material).
    const light = { x: 0.35, y: 0.7, z: 0.62 };
    expect(shadeBrightness(light, matte)).toBeGreaterThan(shadeBrightness({ x: 1, y: 0, z: 0.05 }, matte));
    // At the specular peak (the half-vector between light and the +z view), a glossy
    // (low-roughness) surface produces a brighter highlight than a fully-rough one.
    const ll = Math.hypot(0.35, 0.7, 0.62);
    const half = { x: 0.35 / ll, y: 0.7 / ll, z: 0.62 / ll + 1 };
    const hl = Math.hypot(half.x, half.y, half.z);
    const peak = { x: half.x / hl, y: half.y / hl, z: half.z / hl };
    expect(shadeBrightness(peak, { metallic: 0.9, roughness: 0.05 })).toBeGreaterThan(shadeBrightness(peak, matte));
  });

  it('centroid: box +z face centers at z = depth', () => {
    const box = tessellate({ kind: 'box', x: 0, y: 0, z: 0, width: 10, height: 10, depth: 10 });
    const front = (box[0] as Extract<Drawable, { kind: 'face' }>);
    expect(centroid({ kind: 'face', face: front.face }).z).toBeCloseTo(10, 6);
  });
});
