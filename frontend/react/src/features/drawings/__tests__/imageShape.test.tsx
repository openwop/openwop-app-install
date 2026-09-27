/**
 * ADR 0401 follow-through — the drawings `image` kind: the render-time
 * safe-href belt (host media-asset paths ONLY — an external href would beacon
 * every viewer), rect-family geometry math, and the export inlining pass that
 * keeps PNG/SVG exports from silently dropping placed images (SVG-as-image
 * rasterization forbids resource loads).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ShapeEl } from '../../../chat/artifacts/DrawingPreview.js';
import { shapeMovePatch, shapeBBox, shapeHandles, scaleShapePatch } from '../shapeGeometry.js';
import { inlineSvgImageHrefs } from '../../../canvas/exportUtils.js';

const HOST_SRC = '/host/openwop-app/assets/tok_abc-123';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ShapeEl image kind — safe-href belt', () => {
  const mount = (src: string | undefined) => render(
    <svg>
      <ShapeEl s={{ kind: 'image', x: 10, y: 20, width: 100, height: 80, ...(src !== undefined ? { src } : {}) }} />
    </svg>,
  );

  it('renders a host media-asset src as an <image> with geometry', () => {
    const { container } = mount(HOST_SRC);
    const img = container.querySelector('image');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('href')).toBe(HOST_SRC);
    expect(img?.getAttribute('x')).toBe('10');
    expect(img?.getAttribute('width')).toBe('100');
    expect(img?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
  });

  it('renders NOTHING for an external / malformed src (viewer-beacon guard)', () => {
    for (const src of ['https://evil.example/x.png', 'data:image/png;base64,AAAA', '/host/openwop-app/assets/tok?x=1', undefined]) {
      const { container } = mount(src);
      expect(container.querySelector('image'), String(src)).toBeNull();
    }
  });
});

describe('image kind — rect-family geometry', () => {
  const img = { kind: 'image' as const, x: 10, y: 20, width: 100, height: 80, src: HOST_SRC };
  it('moves, bboxes, handles, and scales like a rect', () => {
    expect(shapeMovePatch(img, 5, -3)).toEqual({ x: 15, y: 17 });
    expect(shapeBBox(img)).toEqual({ x: 10, y: 20, w: 100, h: 80 });
    expect(shapeHandles(img)).toEqual([{ id: 'se', x: 110, y: 100 }]);
    expect(scaleShapePatch(img, 2, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 200, height: 160 });
  });
});

describe('inlineSvgImageHrefs — export self-containment', () => {
  it('inlines host hrefs as data URIs and leaves failing ones untouched', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('tok_ok')) return new Response(Buffer.from('89504e47', 'hex'), { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response('gone', { status: 404 });
    });
    const svg = `<svg><image href="/host/openwop-app/assets/tok_ok" x="0"/><image href="/host/openwop-app/assets/tok_gone" x="1"/></svg>`;
    // DRAW-G3 — the return grew a count: degrading is right, degrading SILENTLY
    // is not (the untouched href renders as NOTHING once rasterized).
    const { text: out, unresolved } = await inlineSvgImageHrefs(svg);
    expect(out).toContain('href="data:image/png;base64,');
    expect(out).toContain('href="/host/openwop-app/assets/tok_gone"'); // degraded, not dropped
    expect(out).not.toContain('tok_ok'); // the resolved one is fully inlined
    expect(unresolved).toBe(1);
  });

  it('never fetches non-host hrefs (they cannot appear post-validator, belt anyway)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(String(url)); return new Response('x', { status: 200 }); });
    const svg = `<svg><image href="https://evil.example/x.png"/></svg>`;
    expect(await inlineSvgImageHrefs(svg)).toEqual({ text: svg, unresolved: 0 });
    expect(calls).toEqual([]);
  });
});
