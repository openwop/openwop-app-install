/**
 * ADR 0951 P2 — session recording for public pages, as GEOMETRY ONLY.
 *
 * Loaded with a dynamic `import()` only on an explicit, server-recorded "yes" to
 * the separate `analytics.replay` choice (`replayAllowedFor`). Nothing on the
 * page is serialized as content: the layout becomes boxes, and every text run,
 * form control, image, media element and frame becomes a fixed 64×16 placeholder
 * (`masked`), so no words, values, URLs or attributes can leave the browser. The
 * server accepts only this closed format and stores its own re-encoding.
 *
 * Never recorded: a page carrying a password, card, one-time-code or marked
 * sensitive field, or one marked `data-owx-replay="off"`. Checkout and account
 * pages are not public CMS pages, so this module never runs on them.
 *
 * Every flush re-reads the visitor's choice; a withdrawal drops the buffer and
 * stops. A server answer of `recorded:false` (not sampled, limit reached, replay
 * off) also stops for the rest of the visit.
 */
import { visitorApiBase } from './visitorApi.js';
import { consentTokenFor, replayAllowedFor } from './visitorConsent.js';

/** The P2.1 limits this module must stay inside (the server refuses anything else). */
export const REPLAY_FORMAT = Object.freeze({
  geometryQuantum: 8, timeQuantumMs: 10, coordinate: 65_536, viewport: 8192,
  maskedWidth: 64, maskedHeight: 16, nodesPerFrame: 2000, nodesPerChunk: 10_000,
  events: 2000, depth: 32, durationMs: 30 * 60 * 1000,
});
const F = REPLAY_FORMAT;
const FLUSH_MS = 10_000;
const POINTER_MS = 100;
const SCROLL_MS = 200;
const RESNAPSHOT_MS = 2_000;

export type ReplayNode = { id: number; parent: number | null; kind: 'box' | 'masked'; x: number; y: number; width: number; height: number };
export type ReplayFrame = { type: 'frame'; at: number; viewport: { width: number; height: number }; nodes: ReplayNode[] };
export type ReplayEvent = ReplayFrame
  | { type: 'pointer'; at: number; action: 'move' | 'down' | 'up'; x: number; y: number }
  | { type: 'scroll'; at: number; x: number; y: number };

/** Elements whose content is replaced whole: their subtree is never visited. */
const OPAQUE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'OBJECT', 'EMBED']);
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BR', 'WBR']);
/** A page carrying any of these is never recorded. */
export const NEVER_RECORD_SELECTOR = [
  '[data-owx-replay="off"]', 'input[type="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="one-time-code"]',
  '[data-owx-sensitivity]', 'iframe[src*="stripe"]', 'iframe[src*="paypal"]',
].join(', ');

const down = (n: number): number => Math.max(0, Math.floor(n / F.geometryQuantum) * F.geometryQuantum);
const up = (n: number): number => Math.max(F.geometryQuantum, Math.ceil(n / F.geometryQuantum) * F.geometryQuantum);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function pageMayBeRecorded(doc: Document = document): boolean {
  return doc.querySelector(NEVER_RECORD_SELECTOR) === null;
}

function viewportOf(win: Window): ReplayFrame['viewport'] {
  return { width: clamp(up(win.innerWidth), F.geometryQuantum, F.viewport), height: clamp(up(win.innerHeight), F.geometryQuantum, F.viewport) };
}

function hasOwnText(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 && (child.textContent ?? '').trim() !== '') return true;
  }
  return false;
}
const isOpaque = (el: Element): boolean =>
  OPAQUE.has(el.tagName.toUpperCase()) || (el as HTMLElement).isContentEditable === true || el.getAttribute('contenteditable') === 'true';

/**
 * One layout frame of the document. Pure over the DOM's geometry: it reads
 * rectangles and tag names only, never text, values or attributes' contents.
 */
export function snapshotFrame(at: number, win: Window = window): ReplayFrame {
  const doc = win.document;
  const viewport = viewportOf(win);
  const scrollX = win.scrollX || 0;
  const scrollY = win.scrollY || 0;
  const root = doc.documentElement;
  const docW = clamp(up(Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0, viewport.width)), viewport.width, F.coordinate);
  const docH = clamp(up(Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0, viewport.height)), viewport.height, F.coordinate);
  const nodes: ReplayNode[] = [{ id: 1, parent: null, kind: 'box', x: 0, y: 0, width: docW, height: docH }];
  let nextId = 2;
  const place = (rect: DOMRect, fixed?: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null => {
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const width = fixed ? fixed.width : Math.min(up(rect.width), docW);
    const height = fixed ? fixed.height : Math.min(up(rect.height), docH);
    if (width > docW || height > docH) return null;
    const x = clamp(down(rect.left + scrollX), 0, docW - width);
    const y = clamp(down(rect.top + scrollY), 0, docH - height);
    return { x, y, width, height };
  };
  const masked = { width: F.maskedWidth, height: F.maskedHeight };
  const visit = (el: Element, parent: number, depth: number): void => {
    if (nodes.length >= F.nodesPerFrame) return;
    const tag = el.tagName.toUpperCase();
    if (SKIPPED.has(tag)) return;
    const rect = el.getBoundingClientRect();
    if (isOpaque(el)) {
      // The whole control or media element becomes one fixed-size placeholder.
      const at0 = place(rect, masked);
      if (at0 && depth + 1 <= F.depth) nodes.push({ id: nextId++, parent, kind: 'masked', ...at0 });
      return;
    }
    let self = parent;
    if (hasOwnText(el)) {
      // An element that carries words gets NO box of its own: its rectangle
      // would reveal the text's length and line count. Only the fixed
      // placeholder marks where words were; its child elements still lay out.
      const words = place(rect, masked);
      if (words && depth + 1 <= F.depth) nodes.push({ id: nextId++, parent, kind: 'masked', ...words });
    } else {
      const box = place(rect);
      if (box && depth + 1 <= F.depth) {
        self = nextId++;
        nodes.push({ id: self, parent, kind: 'box', ...box });
      }
    }
    const childDepth = self === parent ? depth : depth + 1;
    if (childDepth >= F.depth) return;
    for (const child of Array.from(el.children)) visit(child, self, childDepth);
  };
  if (doc.body) for (const child of Array.from(doc.body.children)) visit(child, 1, 1);
  return { type: 'frame', at, viewport, nodes };
}

async function gzipBase64(text: string): Promise<string | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return null;
  const source = new ReadableStream<BufferSource>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const stream = source.pipeThrough(new CS('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface ReplayCaptureOptions { orgId: string; visitorKey?: string }

/** Start recording. Resolves to a stop function (a no-op when recording may not run). */
export async function startReplayCapture(opts: ReplayCaptureOptions): Promise<() => void> {
  const noop = (): void => undefined;
  if (!replayAllowedFor(opts.orgId) || !pageMayBeRecorded() || !(globalThis as { CompressionStream?: unknown }).CompressionStream) return noop;
  const sessionId = crypto.randomUUID();
  const started = performance.now();
  let index = 0;
  let stopped = false;
  let lastFrame = 0;
  let lastPointer = 0;
  let lastScroll = 0;
  const now = (): number => Math.floor((performance.now() - started) / F.timeQuantumMs) * F.timeQuantumMs;
  let current = snapshotFrame(0);
  let buffer: ReplayEvent[] = [current];
  let nodesInChunk = current.nodes.length;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    buffer = [];
    clearInterval(timer);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onLayout);
    window.removeEventListener('pagehide', onHide);
  };

  const push = (event: ReplayEvent): void => {
    if (stopped) return;
    if (event.at > F.durationMs) { void flush(); stop(); return; }
    if (buffer.length >= F.events - 1) void flush();
    buffer.push(event);
  };
  const pointer = (action: 'move' | 'down' | 'up', e: PointerEvent): void => {
    push({ type: 'pointer', at: now(), action,
      x: clamp(down(e.clientX), 0, current.viewport.width), y: clamp(down(e.clientY), 0, current.viewport.height) });
  };
  const onMove = (e: PointerEvent): void => {
    const t = performance.now();
    if (t - lastPointer < POINTER_MS) return;
    lastPointer = t;
    pointer('move', e);
  };
  const onDown = (e: PointerEvent): void => pointer('down', e);
  const onUp = (e: PointerEvent): void => pointer('up', e);
  const onScroll = (): void => {
    const t = performance.now();
    if (t - lastScroll < SCROLL_MS) return;
    lastScroll = t;
    const root = current.nodes[0]!;
    push({ type: 'scroll', at: now(),
      x: clamp(down(window.scrollX), 0, root.width - current.viewport.width),
      y: clamp(down(window.scrollY), 0, root.height - current.viewport.height) });
  };
  const onLayout = (): void => {
    const t = performance.now();
    if (t - lastFrame < RESNAPSHOT_MS || stopped) return;
    lastFrame = t;
    const frame = snapshotFrame(now());
    if (nodesInChunk + frame.nodes.length > F.nodesPerChunk) void flush();
    current = frame;
    nodesInChunk += frame.nodes.length;
    push(frame);
  };

  const flush = async (keepalive = false): Promise<void> => {
    if (stopped) return;
    // Re-read the visitor's choice at every send: a withdrawal stops here.
    if (!replayAllowedFor(opts.orgId)) { stop(); return; }
    // A sensitive field that appeared after start (a login modal, an injected
    // payment frame) ends recording for the visit; this buffer is never sent.
    if (!pageMayBeRecorded()) { stop(); return; }
    const events = buffer;
    if (events.length <= 1 && index > 0) return; // only the leading frame: nothing new
    current = snapshotFrame(now());
    buffer = [current];
    nodesInChunk = current.nodes.length;
    let content: string | null;
    try { content = await gzipBase64(JSON.stringify({ version: 1, events })); }
    catch { stop(); return; }
    if (!content || stopped) return;
    const chunkIndex = index++;
    try {
      const r = await fetch(`${visitorApiBase()}/host/openwop-app/public-analytics/${encodeURIComponent(opts.orgId)}/replay/${sessionId}/chunk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive,
        body: JSON.stringify({ index: chunkIndex, content, consentToken: consentTokenFor(opts.orgId), ...(opts.visitorKey ? { sessionKey: opts.visitorKey } : {}) }),
      });
      if (!r.ok || ((await r.json().catch(() => ({}))) as { recorded?: unknown }).recorded !== true) stop();
    } catch { stop(); }
  };
  const onHide = (): void => { void flush(true); };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onLayout);
  window.addEventListener('pagehide', onHide);
  const timer = setInterval(() => { void flush(); }, FLUSH_MS);
  return stop;
}
