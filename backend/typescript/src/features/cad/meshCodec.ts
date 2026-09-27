/**
 * CAD mesh codec (ADR 0388 P1) — the ONE export-grade geometry source.
 *
 * Pure, dependency-free, and DETERMINISTIC (the matrix row 9 invariant): no
 * wall-clock, no RNG, fixed tessellation segment counts, source triangle order
 * preserved on import, doc order preserved on export — so fork/replay of any
 * geometry op is byte-identical.
 *
 * This file is a deliberate FE↔BE TWIN (frontend/react/src/features/cad/
 * meshCodec.ts is byte-identical; packages cannot cross-import — the
 * contentA11y precedent, pinned harder here by a file-parity test that fails
 * on ANY divergence). Edit BOTH copies together.
 *
 * Canonical stored form (architect R2): little-endian BINARY STL — 80-byte
 * header, uint32 triangle count, 50 bytes/triangle (normal + 3 verts + attr 0).
 * Imports (STL ascii/binary, OBJ, GLTF/GLB) normalize to it; sha-256 over the
 * canonical bytes is the content address (computed by the caller — this module
 * stays hash-free so the twin has zero platform imports).
 *
 * Import honesty (architect R3): lossy-but-disclosed — geometry imports carry
 * an explicit `dropped[]` naming what was not representable (materials,
 * textures, animations…); anything that cannot yield faithful geometry
 * (Draco compression, EXTERNAL buffer URIs — also the SSRF posture: this
 * module NEVER fetches) is a typed `MeshCodecError`, never a lookalike.
 */

export class MeshCodecError extends Error {
  constructor(
    public readonly code:
      | 'unsupported_format'
      | 'malformed'
      | 'unrepresentable'
      | 'too_many_triangles'
      | 'empty_mesh',
    message: string,
  ) {
    super(message);
    this.name = 'MeshCodecError';
  }
}

/** Honest ceilings (architect R5 — named, enforced at parse time). */
export const MAX_MESH_TRIANGLES = 50_000;

export interface ParsedMesh {
  /** 9 floats per triangle: v0x v0y v0z v1x v1y v1z v2x v2y v2z. */
  positions: Float32Array;
  triangleCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Source features that could not be represented (disclosed, never silent). */
  dropped: string[];
  sourceFormat: 'stl' | 'obj' | 'gltf';
}

const CANONICAL_HEADER = 'openwop-cad canonical mesh v1';

// ── shared small math ────────────────────────────────────────────────────────

function triNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const ux = bx - ax; const uy = by - ay; const uz = bz - az;
  const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 1; }
  return [nx, ny, nz];
}

function bboxOf(positions: Float32Array): ParsedMesh['bbox'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i + a] ?? 0;
      if (v < (min[a] ?? Infinity)) min[a] = v;
      if (v > (max[a] ?? -Infinity)) max[a] = v;
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

function finishMesh(positions: Float32Array, dropped: string[], sourceFormat: ParsedMesh['sourceFormat']): ParsedMesh {
  const triangleCount = Math.floor(positions.length / 9);
  if (triangleCount === 0) throw new MeshCodecError('empty_mesh', 'The file contains no triangles.');
  if (triangleCount > MAX_MESH_TRIANGLES) {
    throw new MeshCodecError('too_many_triangles', `Mesh has ${triangleCount} triangles — the cap is ${MAX_MESH_TRIANGLES}.`);
  }
  return { positions, triangleCount, bbox: bboxOf(positions), dropped, sourceFormat };
}

// ── canonical binary STL (emit + parse) ──────────────────────────────────────

/** Emit the CANONICAL binary STL for a triangle soup (deterministic bytes:
 *  fixed header, source triangle order, computed normals, attr 0). */
export function emitCanonicalStl(positions: Float32Array): Uint8Array {
  const triangleCount = Math.floor(positions.length / 9);
  const out = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(out.buffer);
  for (let i = 0; i < CANONICAL_HEADER.length && i < 80; i += 1) out[i] = CANONICAL_HEADER.charCodeAt(i);
  view.setUint32(80, triangleCount, true);
  let off = 84;
  for (let t = 0; t < triangleCount; t += 1) {
    const p = t * 9;
    const [nx, ny, nz] = triNormal(
      positions[p] ?? 0, positions[p + 1] ?? 0, positions[p + 2] ?? 0,
      positions[p + 3] ?? 0, positions[p + 4] ?? 0, positions[p + 5] ?? 0,
      positions[p + 6] ?? 0, positions[p + 7] ?? 0, positions[p + 8] ?? 0,
    );
    view.setFloat32(off, nx, true); view.setFloat32(off + 4, ny, true); view.setFloat32(off + 8, nz, true);
    off += 12;
    for (let v = 0; v < 9; v += 1) { view.setFloat32(off, positions[p + v] ?? 0, true); off += 4; }
    view.setUint16(off, 0, true); off += 2;
  }
  return out;
}

/** Parse binary OR ascii STL. */
export function parseStl(bytes: Uint8Array): ParsedMesh {
  if (bytes.length < 15) throw new MeshCodecError('malformed', 'File too small to be STL.');
  // ASCII iff it starts with "solid" AND contains "facet" in the first chunk
  // (binary files legally start with "solid" in the comment header).
  const headText = latin1(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const isAscii = /^\s*solid\b/.test(headText) && headText.includes('facet');
  if (isAscii) return parseAsciiStl(latin1(bytes));
  if (bytes.length < 84) throw new MeshCodecError('malformed', 'Binary STL truncated before the triangle count.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (bytes.length !== 84 + count * 50) {
    throw new MeshCodecError('malformed', `Binary STL length mismatch: ${bytes.length} bytes for ${count} triangles.`);
  }
  if (count > MAX_MESH_TRIANGLES) {
    throw new MeshCodecError('too_many_triangles', `Mesh has ${count} triangles — the cap is ${MAX_MESH_TRIANGLES}.`);
  }
  const positions = new Float32Array(count * 9);
  let off = 84;
  for (let t = 0; t < count; t += 1) {
    off += 12; // stored normal ignored — recomputed on emit (canonical)
    for (let v = 0; v < 9; v += 1) { positions[t * 9 + v] = view.getFloat32(off, true); off += 4; }
    off += 2;
  }
  // Grade-pass (CAD-C5): the ASCII/OBJ lanes gate on finiteness; the binary
  // lane must too — NaN/Infinity floats otherwise flow into BOM volume math
  // as silent garbage.
  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i])) {
      throw new MeshCodecError('malformed', 'Binary STL contains non-finite vertex values.');
    }
  }
  return finishMesh(positions, [], 'stl');
}

function parseAsciiStl(text: string): ParsedMesh {
  const verts: number[] = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const x = Number(m[1]); const y = Number(m[2]); const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new MeshCodecError('malformed', 'ASCII STL has a non-numeric vertex.');
    }
    verts.push(x, y, z);
  }
  if (verts.length % 9 !== 0) throw new MeshCodecError('malformed', 'ASCII STL vertex count is not a multiple of 3.');
  return finishMesh(new Float32Array(verts), [], 'stl');
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return s;
}

// ── OBJ ─────────────────────────────────────────────────────────────────────

/** Parse Wavefront OBJ (v + f; fan-triangulates n-gons; negative indices;
 *  v/vt/vn forms). Materials are DROPPED with disclosure. */
export function parseObj(text: string): ParsedMesh {
  const v: number[] = [];
  const out: number[] = [];
  const dropped: string[] = [];
  let sawMaterial = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0];
    if (kw === 'v') {
      const x = Number(parts[1]); const y = Number(parts[2]); const z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new MeshCodecError('malformed', `OBJ has a non-numeric vertex: "${line.slice(0, 60)}"`);
      }
      v.push(x, y, z);
    } else if (kw === 'f') {
      const idx: number[] = [];
      for (let i = 1; i < parts.length; i += 1) {
        const tok = parts[i];
        if (tok === undefined) continue;
        const vi = Number(tok.split('/')[0]);
        if (!Number.isInteger(vi) || vi === 0) throw new MeshCodecError('malformed', `OBJ has a bad face index: "${tok}"`);
        const resolved = vi > 0 ? vi - 1 : v.length / 3 + vi;
        if (resolved < 0 || resolved >= v.length / 3) {
          throw new MeshCodecError('malformed', `OBJ face references vertex ${vi} out of range.`);
        }
        idx.push(resolved);
      }
      if (idx.length < 3) throw new MeshCodecError('malformed', 'OBJ face with fewer than 3 vertices.');
      for (let i = 1; i + 1 < idx.length; i += 1) {
        for (const which of [idx[0], idx[i], idx[i + 1]]) {
          const base = (which ?? 0) * 3;
          out.push(v[base] ?? 0, v[base + 1] ?? 0, v[base + 2] ?? 0);
        }
      }
    } else if (kw === 'mtllib' || kw === 'usemtl') {
      sawMaterial = true;
    }
    // vt/vn/g/o/s/l/p lines are structural/ignorable — geometry is fully captured.
  }
  if (sawMaterial) dropped.push('materials');
  return finishMesh(new Float32Array(out), dropped, 'obj');
}

// ── GLTF / GLB ──────────────────────────────────────────────────────────────

interface GltfJson {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  accessors?: Array<{
    bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; sparse?: unknown;
  }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number; material?: number; extensions?: Record<string, unknown> }> }>;
  nodes?: Array<{ mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; skin?: number }>;
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  materials?: unknown[];
  textures?: unknown[];
  images?: unknown[];
  animations?: unknown[];
  skins?: unknown[];
  extensionsRequired?: string[];
}

/** Parse .glb (binary container) or .gltf (JSON with EMBEDDED data: buffers
 *  only — an external buffer URI is a typed error, never fetched). Bakes the
 *  scene-node transform hierarchy; drops materials/textures/animations/skins
 *  with disclosure. */
export function parseGltf(bytes: Uint8Array): ParsedMesh {
  let json: GltfJson;
  let bin: Uint8Array | null = null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67 /* 'glTF' */) {
    // GLB container
    const total = view.getUint32(8, true);
    if (total > bytes.length) throw new MeshCodecError('malformed', 'GLB declares more bytes than provided.');
    let off = 12;
    let jsonText: string | null = null;
    while (off + 8 <= total) {
      const chunkLen = view.getUint32(off, true);
      const chunkType = view.getUint32(off + 4, true);
      const chunk = bytes.subarray(off + 8, off + 8 + chunkLen);
      if (chunkType === 0x4e4f534a /* JSON */) jsonText = utf8(chunk);
      else if (chunkType === 0x004e4942 /* BIN */) bin = chunk;
      off += 8 + chunkLen + (chunkLen % 4 === 0 ? 0 : 4 - (chunkLen % 4));
    }
    if (!jsonText) throw new MeshCodecError('malformed', 'GLB has no JSON chunk.');
    json = parseJson(jsonText);
  } else {
    json = parseJson(utf8(bytes));
  }

  if (json.extensionsRequired?.length) {
    throw new MeshCodecError('unrepresentable', `glTF requires extensions we cannot honor: ${json.extensionsRequired.join(', ')}.`);
  }

  // Resolve buffers: GLB BIN chunk or embedded data: URIs only (SSRF posture).
  const buffers: Uint8Array[] = [];
  for (const buf of json.buffers ?? []) {
    if (buf.uri === undefined) {
      if (!bin) throw new MeshCodecError('malformed', 'glTF buffer has no URI and no GLB BIN chunk.');
      buffers.push(bin);
    } else if (buf.uri.startsWith('data:')) {
      const comma = buf.uri.indexOf(',');
      buffers.push(fromBase64(buf.uri.slice(comma + 1)));
    } else {
      throw new MeshCodecError('unrepresentable', 'glTF references an EXTERNAL buffer URI — only self-contained files import (nothing is fetched).');
    }
  }

  const dropped: string[] = [];
  if (json.materials?.length) dropped.push('materials');
  if (json.textures?.length || json.images?.length) dropped.push('textures');
  if (json.animations?.length) dropped.push('animations');
  if (json.skins?.length) dropped.push('skins');

  const readAccessor = (index: number): { data: Float32Array | Uint32Array; type: string; componentType: number } => {
    const acc = json.accessors?.[index];
    if (!acc) throw new MeshCodecError('malformed', `glTF accessor ${index} missing.`);
    if (acc.sparse) throw new MeshCodecError('unrepresentable', 'glTF sparse accessors are not supported.');
    const bv = acc.bufferView !== undefined ? json.bufferViews?.[acc.bufferView] : undefined;
    if (!bv) throw new MeshCodecError('malformed', `glTF accessor ${index} has no bufferView.`);
    const buffer = buffers[bv.buffer];
    if (!buffer) throw new MeshCodecError('malformed', `glTF bufferView references missing buffer ${bv.buffer}.`);
    const comps = acc.type === 'VEC3' ? 3 : acc.type === 'SCALAR' ? 1 : -1;
    if (comps < 0) throw new MeshCodecError('unrepresentable', `glTF accessor type ${acc.type} unsupported here.`);
    // Grade-pass (CAD-C3): a negative/fractional count passes the byte-range
    // math below but blows up allocation — typed-reject it up front.
    if (!Number.isInteger(acc.count) || acc.count <= 0) {
      throw new MeshCodecError('malformed', `glTF accessor count ${String(acc.count)} is invalid.`);
    }
    const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 0;
    // Bounds check BEFORE reading — a malformed accessor (count × stride past
    // the buffer) must be a typed error, never a raw RangeError → 500.
    const compSize = acc.componentType === 5123 ? 2 : acc.componentType === 5121 ? 1 : 4;
    const compCount = acc.type === 'VEC3' ? 3 : 1;
    const step = stride || compCount * compSize;
    const end = acc.count > 0 ? start + (acc.count - 1) * step + compCount * compSize : start;
    if (start < 0 || end > buffer.byteLength) {
      throw new MeshCodecError('malformed', 'glTF accessor reads past its buffer.');
    }
    const dv = new DataView(buffer.buffer, buffer.byteOffset + start);
    if (acc.componentType === 5126) {
      const out = new Float32Array(acc.count * comps);
      const step = stride || comps * 4;
      for (let i = 0; i < acc.count; i += 1) {
        for (let c = 0; c < comps; c += 1) out[i * comps + c] = dv.getFloat32(i * step + c * 4, true);
      }
      return { data: out, type: acc.type, componentType: acc.componentType };
    }
    if (acc.componentType === 5121 || acc.componentType === 5123 || acc.componentType === 5125) {
      const size = acc.componentType === 5121 ? 1 : acc.componentType === 5123 ? 2 : 4;
      const step = stride || comps * size;
      const out = new Uint32Array(acc.count * comps);
      for (let i = 0; i < acc.count; i += 1) {
        for (let c = 0; c < comps; c += 1) {
          const o = i * step + c * size;
          out[i * comps + c] = size === 1 ? dv.getUint8(o) : size === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true);
        }
      }
      return { data: out, type: acc.type, componentType: acc.componentType };
    }
    throw new MeshCodecError('unrepresentable', `glTF componentType ${acc.componentType} unsupported.`);
  };

  // Bake the node hierarchy (TRS/matrix), depth-first in scene order — deterministic.
  const out: number[] = [];
  const emitMesh = (meshIndex: number, matrix: number[]): void => {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) return;
    for (const prim of mesh.primitives) {
      if (prim.extensions && Object.keys(prim.extensions).some((e) => e.includes('draco'))) {
        throw new MeshCodecError('unrepresentable', 'Draco-compressed glTF cannot be imported.');
      }
      const mode = prim.mode ?? 4;
      if (mode !== 4) throw new MeshCodecError('unrepresentable', `glTF primitive mode ${mode} (only TRIANGLES imports).`);
      const posIndex = prim.attributes.POSITION;
      if (posIndex === undefined) throw new MeshCodecError('malformed', 'glTF primitive has no POSITION attribute.');
      const pos = readAccessor(posIndex);
      if (pos.componentType !== 5126 || pos.type !== 'VEC3') {
        throw new MeshCodecError('unrepresentable', 'glTF POSITION must be float32 VEC3.');
      }
      const positions = pos.data as Float32Array;
      const pushVert = (vi: number): void => {
        const x = positions[vi * 3] ?? 0; const y = positions[vi * 3 + 1] ?? 0; const z = positions[vi * 3 + 2] ?? 0;
        out.push(
          matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
          matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
          matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
        );
      };
      if (prim.indices !== undefined) {
        const idx = readAccessor(prim.indices).data;
        if (idx.length % 3 !== 0) throw new MeshCodecError('malformed', 'glTF index count not a multiple of 3.');
        // Grade-pass (CAD-C14): out-of-range indices must be a typed error,
        // not silent (0,0,0) vertices.
        const posCount = positions.length / 3;
        for (let i = 0; i < idx.length; i += 1) {
          const vi = idx[i] ?? 0;
          if (vi >= posCount) throw new MeshCodecError('malformed', `glTF index ${vi} references a vertex out of range.`);
          pushVert(vi);
        }
      } else {
        const vertCount = positions.length / 3;
        if (vertCount % 3 !== 0) throw new MeshCodecError('malformed', 'glTF vertex count not a multiple of 3.');
        for (let i = 0; i < vertCount; i += 1) pushVert(i);
      }
      // Grade-pass (CAD-C4): enforce the cap DURING accumulation — a node
      // graph that fans one mesh out many times must not allocate hundreds of
      // MB before the post-parse check.
      if (out.length > MAX_MESH_TRIANGLES * 9) {
        throw new MeshCodecError('too_many_triangles', `Mesh exceeds the ${MAX_MESH_TRIANGLES}-triangle cap.`);
      }
    }
  };

  // Grade-pass (CAD-C4): a self-referencing node graph must not recurse to a
  // stack overflow, and a repeated-children fan-out must not multiply visits
  // unboundedly (the triangle cap in emitMesh bounds memory; this bounds CPU).
  const visiting = new Set<number>();
  let walkBudget = 10_000;
  const walk = (nodeIndex: number, parent: number[]): void => {
    if (visiting.has(nodeIndex)) throw new MeshCodecError('malformed', 'glTF node graph contains a cycle.');
    walkBudget -= 1;
    if (walkBudget < 0) throw new MeshCodecError('malformed', 'glTF node graph is too large.');
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    visiting.add(nodeIndex);
    const local = node.matrix ? node.matrix : trsMatrix(node.translation, node.rotation, node.scale);
    const matrix = mul4(parent, local);
    if (node.mesh !== undefined) emitMesh(node.mesh, matrix);
    for (const child of node.children ?? []) walk(child, matrix);
    visiting.delete(nodeIndex);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) {
    for (const n of scene.nodes) walk(n, IDENTITY4);
  } else if (json.meshes?.length) {
    for (let i = 0; i < json.meshes.length; i += 1) emitMesh(i, IDENTITY4);
  }
  return finishMesh(new Float32Array(out), dropped, 'gltf');
}

const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function trsMatrix(t?: number[], r?: number[], s?: number[]): number[] {
  const [tx, ty, tz] = [t?.[0] ?? 0, t?.[1] ?? 0, t?.[2] ?? 0];
  const [qx, qy, qz, qw] = [r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0, r?.[3] ?? 1];
  const [sx, sy, sz] = [s?.[0] ?? 1, s?.[1] ?? 1, s?.[2] ?? 1];
  const x2 = qx + qx; const y2 = qy + qy; const z2 = qz + qz;
  const xx = qx * x2; const xy = qx * y2; const xz = qx * z2;
  const yy = qy * y2; const yz = qy * z2; const zz = qz * z2;
  const wx = qw * x2; const wy = qw * y2; const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function parseJson(text: string): GltfJson {
  try {
    return JSON.parse(text) as GltfJson;
  } catch {
    throw new MeshCodecError('malformed', 'glTF JSON does not parse.');
  }
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function fromBase64(b64: string): Uint8Array {
  // atob is available in browsers AND Node >= 16 (globalThis.atob). A hostile
  // data: URI with invalid base64 must be a typed error (grade-pass CAD-C13).
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ''));
  } catch {
    throw new MeshCodecError('malformed', 'Invalid base64 in glTF data URI.');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── format sniffing (import entry) ──────────────────────────────────────────

export type MeshFormat = 'stl' | 'obj' | 'gltf';

/** Parse an import by declared format. */
export function parseMesh(bytes: Uint8Array, format: MeshFormat): ParsedMesh {
  if (format === 'stl') return parseStl(bytes);
  if (format === 'obj') return parseObj(utf8(bytes));
  if (format === 'gltf') return parseGltf(bytes);
  throw new MeshCodecError('unsupported_format', `Unknown mesh format: ${String(format)}`);
}

// ── parametric tessellation (export-grade; true triangles for ALL kinds) ────

export interface TessellatableSolid {
  kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'mesh';
  x?: number; y?: number; z?: number;
  width?: number; height?: number; depth?: number;
  radius?: number; length?: number;
  rotation?: number;
  scale?: number;
  assetRef?: string;
  label?: string;
  color?: string;
  materialId?: string;
  metallic?: number;
  roughness?: number;
}

export const TESSELLATION_SEGMENTS = 24;
export const SPHERE_RINGS = 12;

/** Triangles for one PARAMETRIC solid (box/cylinder/sphere/cone), centered at
 *  its x/y/z with the doc's single in-plane rotation applied about Z. `mesh`
 *  kinds are resolved by the caller (the codec never does I/O). Deterministic:
 *  fixed segment counts, fixed emission order. */
export function tessellateSolid(s: TessellatableSolid): Float32Array {
  // Model convention (matches the 2D editor, the FE orbit viewer, and the
  // agent prompt): position (x, y, z) is the solid's MIN CORNER (bottom-left-
  // front); width→X, height→Y (up), depth→Z (box depth defaults to width);
  // cylinder/cone sit inside the corner-anchored box with the axis along Y
  // (centre at x+r, z+r, bottom at y, top at y+length); sphere centre is
  // (x+r, y+r, z+r). `rotation` (degrees) is the 2D editor's in-plane rotation
  // — about the Z axis through the solid's own bbox centre.
  // Grade-pass correction (CAD-C1, 2026-07-17): the first release anchored at
  // the CENTRE with height/length along Z, so exported STL/GLB assemblies did
  // not match the rendered arrangement. Placement is now golden-tested.
  const px = s.x ?? 0; const py = s.y ?? 0; const pz = s.z ?? 0;
  const rot = ((s.rotation ?? 0) * Math.PI) / 180;
  const cosR = Math.cos(rot); const sinR = Math.sin(rot);
  const out: number[] = [];
  // Rotation centre (bbox centre in the X-Y plane), set per kind below.
  let rcx = 0; let rcy = 0;
  const push = (x: number, y: number, z: number): void => {
    if (rot === 0) { out.push(x, y, z); return; }
    const dx = x - rcx; const dy = y - rcy;
    out.push(rcx + dx * cosR - dy * sinR, rcy + dx * sinR + dy * cosR, z);
  };
  const quad = (
    a: [number, number, number], b: [number, number, number],
    c: [number, number, number], d: [number, number, number],
  ): void => {
    push(...a); push(...b); push(...c);
    push(...a); push(...c); push(...d);
  };

  if (s.kind === 'box') {
    const w = s.width ?? 40; const h = s.height ?? 30; const d = s.depth ?? s.width ?? 40;
    rcx = px + w / 2; rcy = py + h / 2;
    const x0 = px; const x1 = px + w; const y0 = py; const y1 = py + h; const z0 = pz; const z1 = pz + d;
    // 6 faces, outward winding (CCW seen from outside).
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // front (+z)
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // back (-z)
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // right (+x)
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // left (-x)
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // top (+y)
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom (-y)
  } else if (s.kind === 'cylinder' || s.kind === 'cone') {
    const r = s.radius ?? 15; const len = s.length ?? (s.kind === 'cone' ? 35 : 40);
    const cx = px + r; const cz = pz + r; const yBot = py; const yTop = py + len;
    rcx = cx; rcy = py + len / 2;
    for (let i = 0; i < TESSELLATION_SEGMENTS; i += 1) {
      const a0 = (i / TESSELLATION_SEGMENTS) * 2 * Math.PI;
      const a1 = ((i + 1) / TESSELLATION_SEGMENTS) * 2 * Math.PI;
      const x0 = cx + r * Math.cos(a0); const z0 = cz + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1); const z1 = cz + r * Math.sin(a1);
      if (s.kind === 'cone') {
        // side triangle to the apex (outward winding)
        push(x1, yBot, z1); push(x0, yBot, z0); push(cx, yTop, cz);
      } else {
        quad([x1, yBot, z1], [x0, yBot, z0], [x0, yTop, z0], [x1, yTop, z1]);
      }
      // bottom cap (fan, downward normal)
      push(cx, yBot, cz); push(x0, yBot, z0); push(x1, yBot, z1);
      // top cap for cylinder
      if (s.kind === 'cylinder') { push(cx, yTop, cz); push(x1, yTop, z1); push(x0, yTop, z0); }
    }
  } else if (s.kind === 'sphere') {
    const r = s.radius ?? 20;
    const cx = px + r; const cy = py + r; const cz = pz + r;
    rcx = cx; rcy = cy;
    for (let ring = 0; ring < SPHERE_RINGS; ring += 1) {
      const phi0 = (ring / SPHERE_RINGS) * Math.PI;
      const phi1 = ((ring + 1) / SPHERE_RINGS) * Math.PI;
      for (let seg = 0; seg < TESSELLATION_SEGMENTS; seg += 1) {
        const th0 = (seg / TESSELLATION_SEGMENTS) * 2 * Math.PI;
        const th1 = ((seg + 1) / TESSELLATION_SEGMENTS) * 2 * Math.PI;
        // Y is the polar axis (poles at y = cy ± r), matching the viewer.
        const p = (phi: number, th: number): [number, number, number] => [
          cx + r * Math.sin(phi) * Math.cos(th), cy + r * Math.cos(phi), cz + r * Math.sin(phi) * Math.sin(th),
        ];
        const a = p(phi0, th0); const b = p(phi0, th1); const c = p(phi1, th1); const d = p(phi1, th0);
        if (ring > 0) { push(...a); push(...c); push(...b); }
        if (ring < SPHERE_RINGS - 1) { push(...a); push(...d); push(...c); }
      }
    }
  }
  return new Float32Array(out);
}

/** Apply a mesh solid's pose (uniform scale → Z rotation → translate) to a
 *  parsed mesh's triangles. Pure + deterministic. */
export function poseMesh(mesh: ParsedMesh, s: TessellatableSolid): Float32Array {
  const scale = s.scale ?? 1;
  const rot = ((s.rotation ?? 0) * Math.PI) / 180;
  const cosR = Math.cos(rot); const sinR = Math.sin(rot);
  const cx = s.x ?? 0; const cy = s.y ?? 0; const cz = s.z ?? 0;
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] ?? 0) * scale;
    const y = (mesh.positions[i + 1] ?? 0) * scale;
    const z = (mesh.positions[i + 2] ?? 0) * scale;
    out[i] = x * cosR - y * sinR + cx;
    out[i + 1] = x * sinR + y * cosR + cy;
    out[i + 2] = z + cz;
  }
  return out;
}

// ── GLB export ──────────────────────────────────────────────────────────────

const F32 = 4;

/** Emit a self-contained GLB: one node+mesh per solid (doc order, labeled),
 *  positions + computed flat normals, per-solid PBR-ish material from the
 *  approximate color/metallic/roughness the doc model carries. Deterministic. */
export function emitGlb(parts: Array<{ label: string; positions: Float32Array; color?: string; metallic?: number; roughness?: number }>): Uint8Array {
  interface Prim { posOffset: number; norOffset: number; count: number; min: number[]; max: number[] }
  const prims: Prim[] = [];
  let binSize = 0;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const count = Math.floor(part.positions.length / 3);
    const normals = new Float32Array(part.positions.length);
    for (let t = 0; t * 9 < part.positions.length; t += 1) {
      const p = t * 9;
      const [nx, ny, nz] = triNormal(
        part.positions[p] ?? 0, part.positions[p + 1] ?? 0, part.positions[p + 2] ?? 0,
        part.positions[p + 3] ?? 0, part.positions[p + 4] ?? 0, part.positions[p + 5] ?? 0,
        part.positions[p + 6] ?? 0, part.positions[p + 7] ?? 0, part.positions[p + 8] ?? 0,
      );
      for (let v = 0; v < 3; v += 1) { normals[p + v * 3] = nx; normals[p + v * 3 + 1] = ny; normals[p + v * 3 + 2] = nz; }
    }
    const bbox = bboxOf(part.positions);
    prims.push({ posOffset: binSize, norOffset: binSize + part.positions.length * F32, count, min: bbox.min, max: bbox.max });
    chunks.push(new Uint8Array(part.positions.buffer.slice(part.positions.byteOffset, part.positions.byteOffset + part.positions.byteLength)));
    chunks.push(new Uint8Array(normals.buffer));
    binSize += part.positions.length * F32 + normals.length * F32;
  }
  const bin = new Uint8Array(pad4(binSize));
  let off = 0;
  for (const c of chunks) { bin.set(c, off); off += c.byteLength; }

  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  const materials: unknown[] = [];
  parts.forEach((part, i) => {
    const prim = prims[i];
    if (!prim) return;
    bufferViews.push({ buffer: 0, byteOffset: prim.posOffset, byteLength: prim.count * 3 * F32 });
    bufferViews.push({ buffer: 0, byteOffset: prim.norOffset, byteLength: prim.count * 3 * F32 });
    accessors.push({ bufferView: i * 2, componentType: 5126, count: prim.count, type: 'VEC3', min: prim.min, max: prim.max });
    accessors.push({ bufferView: i * 2 + 1, componentType: 5126, count: prim.count, type: 'VEC3' });
    materials.push({
      name: part.label,
      pbrMetallicRoughness: {
        baseColorFactor: colorToLinearRgba(part.color),
        metallicFactor: clamp01(part.metallic ?? 0.1),
        roughnessFactor: clamp01(part.roughness ?? 0.7),
      },
    });
    meshes.push({ name: part.label, primitives: [{ attributes: { POSITION: i * 2, NORMAL: i * 2 + 1 }, material: i, mode: 4 }] });
    nodes.push({ name: part.label, mesh: i });
  });
  const gltf = {
    asset: { version: '2.0', generator: 'openwop-cad' },
    scene: 0,
    scenes: [{ nodes: parts.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = new Uint8Array(pad4(jsonBytes.length));
  jsonPadded.fill(0x20); // pad with spaces per spec
  jsonPadded.set(jsonBytes, 0);

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // magic
  view.setUint32(4, 2, true); // version
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  view.setUint32(binHeader, bin.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // BIN
  out.set(bin, binHeader + 8);
  return out;
}

function pad4(n: number): number {
  return n % 4 === 0 ? n : n + (4 - (n % 4));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Approximate CSS color → linear-RGBA baseColorFactor. Hex (#rgb/#rrggbb)
 *  parses exactly; anything else maps to a deterministic mid-gray (the doc's
 *  color model is display-approximate — honest, not pretended PBR). */
export function colorToLinearRgba(color?: string): [number, number, number, number] {
  const fallback: [number, number, number, number] = [0.5, 0.5, 0.55, 1];
  if (!color) return fallback;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m || m[1] === undefined) return fallback;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const srgb = [0, 1, 2].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255);
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return [round6(lin[0] ?? 0.5), round6(lin[1] ?? 0.5), round6(lin[2] ?? 0.5), 1];
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
