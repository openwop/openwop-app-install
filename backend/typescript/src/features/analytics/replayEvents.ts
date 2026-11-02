/** ADR 0951 P2.1: a closed, inert recording format owned by analytics.
 * This parser grants no consent, storage, playback or public-ingest authority.
 * Callers must persist only the returned representation, never the input bytes.
 */
import { gunzipSync } from 'node:zlib';

export const REPLAY_EVENT_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024,
  decodedBytes: 4 * 1024 * 1024,
  events: 2000,
  nodesPerFrame: 2000,
  nodesPerChunk: 10_000,
  depth: 32,
  durationMs: 30 * 60 * 1000,
  geometryQuantum: 8,
  timeQuantumMs: 10,
  coordinate: 65_536,
  viewport: 8192,
  maskedWidth: 64,
  maskedHeight: 16,
});

// Nodes use document coordinates; pointers use viewport coordinates. The first
// node is the document extent, so the player need not infer geometry from text.
type Rectangle = { x: number; y: number; width: number; height: number };
export type ReplayLayoutNode = Rectangle & { id: number; parent: number | null; kind: 'box' | 'masked' };
export type ReplayLayoutFrame = {
  type: 'frame'; at: number; viewport: { width: number; height: number }; nodes: ReplayLayoutNode[];
};
export type ReplayGeometryEvent = ReplayLayoutFrame
  | { type: 'pointer'; at: number; action: 'move' | 'down' | 'up'; x: number; y: number }
  | { type: 'scroll'; at: number; x: number; y: number };
export type ReplayEventChunk = { version: 1; events: ReplayGeometryEvent[] };

export class ReplayEventFormatError extends Error {
  constructor() { super('Replay events do not match the private geometry format.'); this.name = 'ReplayEventFormatError'; }
}
const refuse = (): never => { throw new ReplayEventFormatError(); };
const limits = REPLAY_EVENT_LIMITS;

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return refuse();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, quantum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < min || value > max || value % quantum !== 0) return refuse();
  return value;
}
function coordinate(value: unknown): number {
  return integer(value, 0, limits.coordinate, limits.geometryQuantum);
}
function extent(value: unknown, max: number = limits.coordinate): number {
  return integer(value, limits.geometryQuantum, max, limits.geometryQuantum);
}

function frame(value: Record<string, unknown>, at: number): ReplayLayoutFrame {
  const raw = record(value, ['type', 'at', 'viewport', 'nodes']);
  const viewport = record(raw.viewport, ['width', 'height']);
  const width = extent(viewport.width, limits.viewport);
  const height = extent(viewport.height, limits.viewport);
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > limits.nodesPerFrame) return refuse();
  const seen = new Map<number, { kind: ReplayLayoutNode['kind']; depth: number }>();
  const nodes: ReplayLayoutNode[] = [];
  for (const input of raw.nodes) {
    const node = record(input, ['id', 'parent', 'kind', 'x', 'y', 'width', 'height']);
    const id = integer(node.id, 1, 65_535);
    if (seen.has(id) || (node.kind !== 'box' && node.kind !== 'masked')) return refuse();
    const root = nodes.length === 0;
    const parent = root ? null : integer(node.parent, 1, 65_535);
    if (root && (node.parent !== null || id !== 1 || node.kind !== 'box')) return refuse();
    const ancestor = parent === null ? null : seen.get(parent);
    // Parents precede children, so cycles/forward references cannot enter the
    // player. Masked nodes are opaque leaves, including all their descendants.
    if (!root && (!ancestor || ancestor.kind === 'masked')) return refuse();
    const depth = root ? 1 : ancestor!.depth + 1;
    if (depth > limits.depth) return refuse();
    const rectangle = { x: coordinate(node.x), y: coordinate(node.y),
      width: extent(node.width), height: extent(node.height) };
    if (rectangle.x + rectangle.width > limits.coordinate || rectangle.y + rectangle.height > limits.coordinate) return refuse();
    if (root && (rectangle.x !== 0 || rectangle.y !== 0 || rectangle.width < width || rectangle.height < height)) return refuse();
    if (!root && (rectangle.x + rectangle.width > nodes[0].width || rectangle.y + rectangle.height > nodes[0].height)) return refuse();
    // A mask never carries a text-length-derived extent. Client capture must
    // replace the whole sensitive subtree before serialization, not here later.
    if (node.kind === 'masked' && (rectangle.width !== limits.maskedWidth || rectangle.height !== limits.maskedHeight)) return refuse();
    nodes.push({ id, parent, kind: node.kind, ...rectangle });
    seen.set(id, { kind: node.kind, depth });
  }
  return { type: 'frame', at, viewport: { width, height }, nodes };
}

/** Validate already-decoded UTF-8 bytes. The bound precedes decoding and JSON
 * parsing; traversal is flat and bounded independently of the input's nesting.
 * No arbitrary strings, attributes, text, page names, styles or URLs survive.
 */
export function parseReplayEventsJson(bytes: Uint8Array): ReplayEventChunk {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > limits.decodedBytes) return refuse();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return refuse(); }
  const chunk = record(value, ['version', 'events']);
  if (chunk.version !== 1 || !Array.isArray(chunk.events) || chunk.events.length === 0 || chunk.events.length > limits.events) return refuse();
  const events: ReplayGeometryEvent[] = [];
  let priorAt = -1;
  let totalNodes = 0;
  let viewport: ReplayLayoutFrame['viewport'] | undefined;
  let documentExtent: Rectangle | undefined;
  for (const input of chunk.events) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse();
    const raw = input as Record<string, unknown>;
    const at = integer(raw.at, 0, limits.durationMs, limits.timeQuantumMs);
    if (at < priorAt || (!viewport && raw.type !== 'frame')) return refuse();
    priorAt = at;
    if (raw.type === 'frame') {
      const parsed = frame(raw, at);
      totalNodes += parsed.nodes.length;
      if (totalNodes > limits.nodesPerChunk) return refuse();
      viewport = parsed.viewport;
      documentExtent = parsed.nodes[0];
      events.push(parsed);
    } else if (raw.type === 'pointer') {
      record(raw, ['type', 'at', 'action', 'x', 'y']);
      if (raw.action !== 'move' && raw.action !== 'down' && raw.action !== 'up') return refuse();
      const x = coordinate(raw.x); const y = coordinate(raw.y);
      if (!viewport || x > viewport.width || y > viewport.height) return refuse();
      events.push({ type: 'pointer', at, action: raw.action, x, y });
    } else if (raw.type === 'scroll') {
      record(raw, ['type', 'at', 'x', 'y']);
      const x = coordinate(raw.x); const y = coordinate(raw.y);
      if (!viewport || !documentExtent || x > documentExtent.width - viewport.width
        || y > documentExtent.height - viewport.height) return refuse();
      events.push({ type: 'scroll', at, x, y });
    } else return refuse();
  }
  return { version: 1, events };
}

/** Only gzip is supported by this decoding entry point. maxOutputLength caps
 * inflation inside zlib; a small compressed bomb cannot allocate an unbounded
 * decoded recording before validation. Per-session/admission budgets are separate.
 */
export function decodeReplayEventsGzip(bytes: Uint8Array): ReplayEventChunk {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > limits.compressedBytes) return refuse();
  let decoded: Buffer;
  try { decoded = gunzipSync(bytes, { maxOutputLength: limits.decodedBytes }); }
  catch { return refuse(); }
  return parseReplayEventsJson(decoded);
}
