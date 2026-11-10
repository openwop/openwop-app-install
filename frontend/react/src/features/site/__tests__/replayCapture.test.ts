/**
 * ADR 0951 P2 — the session recorder sends GEOMETRY ONLY. jsdom has no layout,
 * so element rectangles are stubbed; the recorder's own serialization, masking,
 * quantization, page exclusion and stop rules run for real, and the chunk it
 * POSTs is gunzipped and checked against the P2.1 rules the server enforces.
 *
 * Consent is checked TWICE (at start and at every flush); case 5 witnesses each
 * guard alone. Sabotage-witnessed (/grade-tests wave 90), each red: a control's
 * value added to its placeholder, placeholders sized by the element, a box for an
 * element with words, no quantization, each never-record selector dropped
 * (password, card, one-time-code, opt-out, field sensitivity), a recorded:false
 * ignored, the flush sensitivity or consent re-check removed, the start consent
 * guard removed, the consent token dropped, the chunk URL prefix changed, an extra
 * body field (a page URL), the method changed, and pointer or time quantization off.
 */
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const consent = vi.hoisted(() => ({ allowed: true }));
vi.mock('../visitorConsent.js', () => ({
  replayAllowedFor: () => consent.allowed,
  consentTokenFor: () => 'v1.token',
}));
vi.mock('../visitorApi.js', () => ({ visitorApiBase: () => '/api' }));

import { REPLAY_FORMAT as F, pageMayBeRecorded, snapshotFrame, startReplayCapture, type ReplayEvent, type ReplayFrame } from '../replayCapture.js';

const SECRET = 'visitor.secret@example.com';
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
function page(extra = ''): void {
  document.body.innerHTML = `
    <main id="m"><h1 id="h">Private headline about ${SECRET}</h1>
    <form id="f"><input id="i" value="${SECRET}"><textarea id="t">${SECRET}</textarea></form>
    <img id="p" alt="${SECRET}" src="https://private.invalid/${SECRET}.png">
    <div id="e" contenteditable="true">${SECRET}</div>${extra}</main>`;
  const rects: Record<string, DOMRect> = {
    m: rect(0, 0, 1000, 2000), h: rect(13, 21, 403.5, 37), f: rect(13, 80, 500, 100), i: rect(20, 90, 200, 30),
    t: rect(20, 130, 300, 40), p: rect(600, 300, 120, 90), e: rect(20, 500, 600, 50),
  };
  for (const el of Array.from(document.querySelectorAll('*'))) {
    (el as HTMLElement).getBoundingClientRect = () => rects[el.id] ?? rect(0, 0, 0, 0);
  }
  Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, value: 1000 });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
}

/** The P2.1 frame rules, restated independently of the recorder. */
function assertFrame(frame: ReplayFrame): void {
  const q = F.geometryQuantum;
  expect(frame.nodes[0]).toMatchObject({ id: 1, parent: null, kind: 'box', x: 0, y: 0 });
  const root = frame.nodes[0]!;
  expect(root.width).toBeGreaterThanOrEqual(frame.viewport.width);
  expect(root.height).toBeGreaterThanOrEqual(frame.viewport.height);
  const seen = new Map<number, ReplayFrame['nodes'][number]>();
  for (const n of frame.nodes) {
    for (const v of [n.x, n.y, n.width, n.height]) expect(v % q).toBe(0);
    expect(n.width).toBeGreaterThanOrEqual(q);
    expect(n.x + n.width).toBeLessThanOrEqual(root.width);
    expect(n.y + n.height).toBeLessThanOrEqual(root.height);
    if (n.parent !== null) {
      const parent = seen.get(n.parent);
      expect(parent, `parent of ${n.id} precedes it`).toBeDefined();
      expect(parent!.kind).toBe('box');
    }
    if (n.kind === 'masked') expect([n.width, n.height]).toEqual([F.maskedWidth, F.maskedHeight]);
    seen.set(n.id, n);
  }
}

beforeEach(() => {
  consent.allowed = true;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

/** A fetch stub that records each POSTed body; answers `{recorded:true}`. */
function recordingFetch(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ recorded: true }), { status: 202 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies };
}

/**
 * Counts flushes that got PAST the consent and sensitivity guards: `flush` builds
 * its gzip stream synchronously right after them, so this count is settled the
 * moment the timer fires. The fetch that follows waits on a real async gzip, so a
 * "nothing was sent" check on `bodies` alone can run before a wrongly-sent chunk
 * lands (wave 90: the late-password case stayed green with the selector removed).
 */
function countGzips(): () => number {
  const Real = globalThis.CompressionStream;
  let n = 0;
  class Counting extends Real { constructor(format: CompressionFormat) { super(format); n += 1; } }
  vi.stubGlobal('CompressionStream', Counting);
  return () => n;
}

describe('ADR 0951 P2 — geometry-only recorder', () => {
  it('a frame carries boxes and fixed placeholders only: no text, value, URL or attribute', () => {
    page();
    const frame = snapshotFrame(0);
    expect(JSON.stringify(frame)).not.toMatch(/secret|private|headline|example/i);
    assertFrame(frame);
    // The heading box, its words as one placeholder, and each control/media/editable as a placeholder.
    const masked = frame.nodes.filter((n) => n.kind === 'masked');
    expect(masked).toHaveLength(5);
    // The heading's words are one fixed placeholder; no box carries the
    // heading's text-derived extent (403.5 × 37 → would be 408 × 40).
    expect(frame.nodes.find((n) => n.x === 8 && n.y === 16)).toMatchObject({ kind: 'masked', width: 64, height: 16 });
    expect(frame.nodes.some((n) => n.kind === 'box' && n.width === 408 && n.height === 40)).toBe(false);
  });

  it('never records a page with a password, card, one-time-code or opted-out marker', () => {
    for (const extra of ['<input type="password">', '<input autocomplete="cc-number">', '<input autocomplete="one-time-code">',
      '<div data-owx-replay="off"></div>', '<input data-owx-sensitivity="health">']) {
      page(extra);
      expect(pageMayBeRecorded(), extra).toBe(false);
    }
    page();
    expect(pageMayBeRecorded()).toBe(true);
  });

  it('sends a gzipped closed-format chunk, and stops for good on {recorded:false}', async () => {
    page();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const bodies: Array<{ index: number; content: string; consentToken: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ recorded: bodies.length < 2 }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const gzips = countGzips();
    const stop = await startReplayCapture({ orgId: 'org-1', visitorKey: 'vk-1' });
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 33, clientY: 47 }));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const sent = JSON.parse(gunzipSync(Buffer.from(bodies[0]!.content, 'base64')).toString()) as { version: number; events: ReplayEvent[] };
    expect(sent.version).toBe(1);
    expect(JSON.stringify(sent)).not.toMatch(/secret|private|headline|example/i);
    expect(sent.events[0]!.type).toBe('frame');
    assertFrame(sent.events[0] as ReplayFrame);
    expect(sent.events[1]).toMatchObject({ type: 'pointer', action: 'down', x: 32, y: 40 });
    for (const e of sent.events) expect(e.at % F.timeQuantumMs).toBe(0);
    expect(Object.keys(sent).sort()).toEqual(['events', 'version']);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/^\/api\/host\/openwop-app\/public-analytics\/org-1\/replay\/[0-9a-f-]{36}\/chunk$/);
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    // The closed request body: nothing beyond these four fields leaves the browser.
    expect(Object.keys(bodies[0]!).sort()).toEqual(['consentToken', 'content', 'index', 'sessionKey']);
    expect(bodies[0]).toMatchObject({ index: 0, consentToken: 'v1.token', sessionKey: 'vk-1' });
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gzips()).toBe(2);
    expect(bodies).toHaveLength(2);
    stop();
  });

  it('a sensitive field that appears after start stops recording before the next send', async () => {
    page();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { bodies } = recordingFetch();
    const gzips = countGzips();
    const stop = await startReplayCapture({ orgId: 'org-1' });
    try {
      // Positive control: the recorder is live and sends.
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 2, clientY: 2 }));
      document.body.insertAdjacentHTML('beforeend', '<input type="password">');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(gzips()).toBe(1);
      expect(bodies).toHaveLength(1);
    } finally { stop(); }
  });

  it('does not start without the explicit choice, and a withdrawal stops before the next send', async () => {
    page();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { bodies } = recordingFetch();
    const gzips = countGzips();
    // Part A — the START guard alone: no choice at start, then the choice arrives. A
    // recorder that had started anyway would now pass the flush re-check and send.
    consent.allowed = false;
    const stopA = await startReplayCapture({ orgId: 'org-1' });
    consent.allowed = true;
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(gzips()).toBe(0);
    expect(bodies).toHaveLength(0);
    stopA();
    // Part B — the FLUSH re-check: a live recorder (positive control: it sends) stops
    // before the next send once the choice is withdrawn.
    const stopB = await startReplayCapture({ orgId: 'org-1' });
    try {
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 1 }));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      consent.allowed = false;
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 2, clientY: 2 }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(gzips()).toBe(1);
      expect(bodies).toHaveLength(1);
    } finally { stopB(); }
  });
});
