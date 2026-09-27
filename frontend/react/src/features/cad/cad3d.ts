/**
 * ADR 0310 Phase-C follow-up — the hand-rolled, dependency-free 3D math for the
 * CAD orbit VIEWER (read-only). No Three.js: the app's no-new-dep discipline (the
 * sales-map self-implemented projection to avoid d3-geo) + 4 analytic primitives
 * make ~200 lines of pure, unit-testable math the right call. The viewer rotates
 * the solids in 3D (azimuth/elevation), axonometrically projects them, painter's-
 * sorts by depth, and shades each face by a Lambert + APPROXIMATE metallic/
 * roughness term (NOT true PBR — the schema fields are glTF-aligned data, the
 * shading is an honest approximation; a later real-PBR renderer consumes the same
 * fields). Editing stays on the 2D orthographic surface (a perspective/orbit camera
 * can't drive footprint dragging).
 */

export interface Vec3 { x: number; y: number; z: number }
export interface Material { metallic: number; roughness: number }

/** A solid's fields as read here — loosely typed (optional `unknown`) so BOTH the
 *  renderer's `Solid` interface and the editor's raw records satisfy it (the
 *  `SolidLike` precedent in CadPreview). */
export type CadSolidInput = {
  kind?: unknown; x?: unknown; y?: unknown; z?: unknown;
  width?: unknown; height?: unknown; depth?: unknown; radius?: unknown; length?: unknown;
  color?: unknown; metallic?: unknown; roughness?: unknown;
  // ADR 0388 P1 — mesh reference + pose extras.
  rotation?: unknown; scale?: unknown; assetRef?: unknown; label?: unknown;
};
export interface Face { verts: Vec3[]; normal: Vec3; color: string; material: Material }
export interface Sphere { center: Vec3; radius: number; color: string; material: Material }
export type Drawable = { kind: 'face'; face: Face } | { kind: 'sphere'; sphere: Sphere };

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const faceNormal = (vs: Vec3[]): Vec3 => norm(cross(sub(vs[1]!, vs[0]!), sub(vs[2]!, vs[0]!)));

/** Rotate a point by azimuth (around Y) then elevation (around X). Radians. */
/** The shared camera-orbit contract (CAD-R2-1): the ¾ home view every surface
 *  starts at, and the pitch clamp. EL_MAX is exactly π/2 so the Top/Bottom
 *  snap views are straight-down/straight-up (the old 1.5-rad clamp stopped
 *  0.07 rad short of vertical, which made an honest Top view unreachable). */
export const HOME_AZ = -0.6;
export const HOME_EL = -0.45;
export const EL_MAX = Math.PI / 2;

export function rotate(v: Vec3, az: number, el: number): Vec3 {
  const ca = Math.cos(az), sa = Math.sin(az);
  const x1 = v.x * ca + v.z * sa, z1 = -v.x * sa + v.z * ca; // yaw
  const ce = Math.cos(el), se = Math.sin(el);
  const y2 = v.y * ce - z1 * se, z2 = v.y * se + z1 * ce; // pitch
  return { x: x1, y: y2, z: z2 };
}

const materialOf = (s: CadSolidInput): Material => ({
  metallic: Math.max(0, Math.min(1, num(s.metallic))),
  roughness: Math.max(0, Math.min(1, num(s.roughness, 0.6))),
});
const colorOf = (s: CadSolidInput): string => (typeof s.color === 'string' && s.color ? s.color : 'var(--paper-2)');

/** A unit circle's N points (in the XZ plane) scaled to radius r about (cx,cz). */
function ring(cx: number, cz: number, r: number, y: number, seg: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; out.push({ x: cx + Math.cos(a) * r, y, z: cz + Math.sin(a) * r }); }
  return out;
}

/** Tessellate one solid into world-space drawables (model units). box/cylinder/
 *  cone → faces; sphere → a shaded disc. Field semantics match `cadFootprint`. */
export function tessellate(s: CadSolidInput, seg = 20): Drawable[] {
  const color = colorOf(s), material = materialOf(s);
  const x = num(s.x), y = num(s.y), z = num(s.z);
  const face = (verts: Vec3[]): Drawable => ({ kind: 'face', face: { verts, normal: faceNormal(verts), color, material } });
  switch (s.kind) {
    case 'box': {
      const w = num(s.width), h = num(s.height), d = num(s.depth) || w; // depth defaults to width for volume
      const x1 = x + w, y1 = y + h, z1 = z + d;
      const v = (px: number, py: number, pz: number): Vec3 => ({ x: px, y: py, z: pz });
      return [
        face([v(x, y, z1), v(x1, y, z1), v(x1, y1, z1), v(x, y1, z1)]),   // +z front
        face([v(x1, y, z), v(x, y, z), v(x, y1, z), v(x1, y1, z)]),       // -z back
        face([v(x1, y, z1), v(x1, y, z), v(x1, y1, z), v(x1, y1, z1)]),   // +x right
        face([v(x, y, z), v(x, y, z1), v(x, y1, z1), v(x, y1, z)]),       // -x left
        face([v(x, y1, z1), v(x1, y1, z1), v(x1, y1, z), v(x, y1, z)]),   // +y top
        face([v(x, y, z), v(x1, y, z), v(x1, y, z1), v(x, y, z1)]),       // -y bottom
      ];
    }
    case 'cylinder': {
      const r = num(s.radius), len = num(s.length), cx = x + r, cz = z + r;
      const bot = ring(cx, cz, r, y, seg), top = ring(cx, cz, r, y + len, seg);
      const faces: Drawable[] = [];
      // Wind sides + caps for OUTWARD normals (the box convention the cull relies on).
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; faces.push(face([bot[j]!, bot[i]!, top[i]!, top[j]!])); }
      faces.push(face([...top].reverse()), face(bot));
      return faces;
    }
    case 'cone': {
      const r = num(s.radius), len = num(s.length), cx = x + r, cz = z + r;
      const bot = ring(cx, cz, r, y, seg), apex: Vec3 = { x: cx, y: y + len, z: cz };
      const faces: Drawable[] = [];
      // Outward winding (sides + base), matching the box/cull convention.
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; faces.push(face([bot[j]!, bot[i]!, apex])); }
      faces.push(face(bot));
      return faces;
    }
    case 'sphere': {
      const r = num(s.radius);
      return [{ kind: 'sphere', sphere: { center: { x: x + r, y: y + r, z: z + r }, radius: r, color, material } }];
    }
    default: return [];
  }
}

/** Approximate metallic/roughness brightness multiplier for a rotated face normal
 *  (Lambert base + a Blinn-ish specular). Returns a `filter: brightness()` factor;
 *  >1 = a highlight. Deliberately NOT energy-conserving PBR — an honest approximation. */
const LIGHT = norm({ x: 0.35, y: 0.7, z: 0.62 });
const VIEW: Vec3 = { x: 0, y: 0, z: 1 };
const HALF = norm({ x: LIGHT.x + VIEW.x, y: LIGHT.y + VIEW.y, z: LIGHT.z + VIEW.z });
export function shadeBrightness(nRot: Vec3, m: Material): number {
  const facing = nRot.z < 0 ? { x: -nRot.x, y: -nRot.y, z: -nRot.z } : nRot; // two-sided
  const lambert = Math.max(0, dot(facing, LIGHT));
  const diffuse = (0.4 + 0.6 * lambert) * (1 - m.metallic * 0.35);
  const shininess = 4 + (1 - m.roughness) * 90;
  const spec = Math.pow(Math.max(0, dot(facing, HALF)), shininess) * (1 - m.roughness) * (0.3 + 0.7 * m.metallic);
  return Math.max(0.15, Math.min(1.7, diffuse + spec));
}

/** The centroid of a drawable (for painter's depth sort). */
export function centroid(d: Drawable): Vec3 {
  if (d.kind === 'sphere') return d.sphere.center;
  const vs = d.face.verts, n = vs.length;
  return { x: vs.reduce((a, v) => a + v.x, 0) / n, y: vs.reduce((a, v) => a + v.y, 0) / n, z: vs.reduce((a, v) => a + v.z, 0) / n };
}
