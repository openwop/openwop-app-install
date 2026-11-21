/**
 * ADR 1150 — the validator half of the split layout (D1), linked gallery tiles
 * (D2) and the video hero (D3). The renderer half is pinned by
 * `frontend/react/src/features/cms/__tests__/splitAndLinkedTiles.test.tsx`.
 *
 * Guards:
 * - `split` is an accepted column layout and keeps each row's link fields;
 * - a gallery tile keeps a relative, http(s) or mailto `href` and drops
 *   `javascript:` (any case), `data:`, `vbscript:` and protocol-relative ones;
 * - a `video` hero keeps a same-origin `videoSrc` / `posterSrc`, refuses every
 *   off-origin source, https included (400 naming the field), and keeps neither
 *   field for any other visual, so a stock hero is byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const v = (type: string, data: Record<string, unknown>) => validateSection({ type, data }, 'en', 't1');

describe('ADR 1150 D1 — the split layout', () => {
  it('is accepted, and each row keeps its link', () => {
    const s = v('columns', { layout: 'split', heading: 'H', columns: [{ title: 'Kitchen', text: 'Oak and brass', ctaLabel: 'See the kitchen', ctaUrl: '/p/kitchen' }] });
    expect(s.data.layout).toBe('split');
    expect((s.data.columns as Record<string, unknown>[])[0]).toMatchObject({ ctaLabel: 'See the kitchen', ctaUrl: '/p/kitchen' });
  });
});

describe('ADR 1150 D2 — gallery tiles that link', () => {
  it('keeps a relative, http(s) or mailto href, and refuses javascript:, data: and vbscript: at save', () => {
    const hrefs = ['/p/every-decision', 'https://example.test/work', 'mailto:studio@example.test', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '//evil.example.test/x', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '/\\evil.example'];
    const s = v('columns', { layout: 'gallery', heading: 'H', columns: hrefs.map((href, i) => ({ title: `T${i}`, href })) });
    const kept = (s.data.columns as Record<string, unknown>[]).map((c) => c.href ?? null);
    expect(kept).toEqual(['/p/every-decision', 'https://example.test/work', 'mailto:studio@example.test', null, null, null, null, null, null, null, null]);
  });
});

describe('ADR 1150 D3 — the video hero', () => {
  const base = { heading: 'Rooms that hold a life' };

  it('keeps a same-origin film and poster for the video visual', () => {
    const s = v('hero', { ...base, visual: 'video', videoSrc: '/media/reel.mp4', posterSrc: '/media/reel.jpg' });
    expect(s.data).toMatchObject({ visual: 'video', videoSrc: '/media/reel.mp4', posterSrc: '/media/reel.jpg' });
  });

  it('refuses any off-origin source, https included, naming the hero field', () => {
    for (const bad of ['https://cdn.example.test/loop.mp4', 'http://cdn.example.test/loop.mp4', '//cdn.example.test/loop.mp4', '/\\cdn.example.test/loop.mp4', 'data:video/mp4;base64,AAAA', 'javascript:alert(1)', 'java\tscript:alert(1)']) {
      expect(() => v('hero', { ...base, visual: 'video', videoSrc: bad }), bad).toThrow(/hero\.videoSrc must be a path on this site/);
    }
    expect(() => v('hero', { ...base, visual: 'video', videoSrc: '/media/reel.mp4', posterSrc: 'https://cdn.example.test/p.jpg' })).toThrow(/hero\.posterSrc/);
  });

  it('keeps neither field for any other visual (a stock hero is unchanged)', () => {
    const s = v('hero', { ...base, visual: 'image', videoSrc: '/media/reel.mp4', posterSrc: '/media/reel.jpg' });
    expect(s.data).not.toHaveProperty('videoSrc');
    expect(s.data).not.toHaveProperty('posterSrc');
  });
});
