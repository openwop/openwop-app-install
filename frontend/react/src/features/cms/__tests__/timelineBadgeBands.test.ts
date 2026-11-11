/**
 * Timeline badges (`markers: 'badge'`, ADR 1073 D3) stay legible in dark bands.
 *
 * The base badge is a light chip, `color-mix(clay 12%, var(--paper))`, under a
 * `--clay-strong` number. In an inverse band, `--paper` is the dark panel, so
 * the chip went dark under a dark number. On live myndhyve.ai (about page,
 * `sec:mh-about-built`, build 2d29c235, found 2026-11-10) that measured about
 * 1.5:1. The live (highlighted) badge did the same in green.
 *
 * What this pins:
 *   1. Inverse, accent, and both live variants each have their own rule, with
 *      exactly the declared colours, built from tokens.
 *   2. Those declarations, resolved for the stock tokens and for a cobalt brand
 *      on a navy panel (the MyndHyve shape), clear WCAG AA 4.5:1 against every
 *      backdrop the badge can sit on in that band.
 *
 * Red when (sabotage-witnessed): any of the three rules is removed (the base
 * rule then applies, and its resolved pair fails), or a dark-band badge's
 * number goes back to `--clay-strong` or `--color-success-text`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const CSS = readFileSync(join(__dirname, '../../../styles/global.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of the rule whose selector list contains `selector` exactly. */
function decls(selector: string): Record<string, string> {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? '').split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    return Object.fromEntries([...(m[2] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map((d) => [d[1], (d[2] ?? '').trim()]));
  }
  return {};
}

type Lch = [number, number, number];
type Rgb = [number, number, number];

const oklchToRgb = ([l, c, h]: Lch): Rgb => {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  }) as Rgb;
};
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
const lum = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** A translucent tint over an opaque backdrop (browser compositing, in sRGB). */
const over = (top: Rgb, alpha: number, back: Rgb): Rgb => top.map((v, i) => alpha * v + (1 - alpha) * (back[i] ?? 0)) as Rgb;

interface Brand {
  name: string;
  clay: Lch;
  success: Lch;
  /** The band ink (`--tone-inverse-ink`, which the bands assign to `--ink`). */
  ink: Rgb;
  /** Every opaque backdrop an inverse-band badge can sit on: the band and its panels, light and dark. */
  inverseBacks: Rgb[];
}

const stockClay: Lch = [0.58, 0.13, 40];
const cobaltClay: Lch = [0.52, 0.2, 264];
const BRANDS: Brand[] = [
  {
    name: 'stock tokens',
    clay: stockClay,
    success: [0.62, 0.13, 145],
    ink: oklchToRgb([0.96, 0.01, 40]),
    // tone-inverse-bg / -panel (light), and the dark-theme band (paper 58% black) / panel (paper-2).
    inverseBacks: [oklchToRgb([0.25, 0.06, 40]), oklchToRgb([0.31, 0.07, 40]), hex('#232220'), over(hex('#1a1a17'), 0.58, [0, 0, 0])],
  },
  {
    name: 'cobalt brand on navy (MyndHyve shape)',
    clay: cobaltClay,
    success: [0.62, 0.13, 145],
    ink: hex('#ffffff'),
    inverseBacks: [hex('#0e1621'), hex('#18222e')],
  },
];

/** Resolve one declared value for a brand. Only the forms these rules use; anything else fails loudly. */
function resolve(value: string, b: Brand): { rgb: Rgb; alpha: number } {
  const clayText: Lch = [0.84, 0.08, b.clay[2]]; // the bands' --clay-text: oklch(from var(--clay) 84% 0.08 h)
  const base: Record<string, Rgb> = {
    '--clay': oklchToRgb(b.clay),
    '--clay-text': oklchToRgb(clayText),
    '--ink': b.ink,
    '--color-success': oklchToRgb(b.success),
    '--clay-strong': oklchToRgb([b.clay[0] - 0.12, b.clay[1] + 0.02, b.clay[2]]),
    '--color-success-text': oklchToRgb([0.46, 0.13, 150]),
  };
  const v = /^var\((--[\w-]+)\)$/.exec(value);
  const vRgb = v?.[1] ? base[v[1]] : undefined;
  if (vRgb) return { rgb: vRgb, alpha: 1 };
  const mix = /^color-mix\(in oklab, var\((--[\w-]+)\) (\d+)%, transparent\)$/.exec(value);
  const mixRgb = mix?.[1] ? base[mix[1]] : undefined;
  if (mixRgb) return { rgb: mixRgb, alpha: Number(mix?.[2]) / 100 };
  const rel = /^oklch\(from var\(--color-success\) (\d+)% ([\d.]+) h\)$/.exec(value);
  if (rel) return { rgb: oklchToRgb([Number(rel[1]) / 100, Number(rel[2]), b.success[2]]), alpha: 1 };
  throw new Error(`timelineBadgeBands: cannot resolve "${value}"; extend the resolver or use a token`);
}

const CASES = [
  { band: 'inverse', selector: '.fp-tone--inverse .fp-timeline__badge' },
  { band: 'inverse', selector: '.fp-tone--inverse .fp-timeline__item--live .fp-timeline__badge' },
  { band: 'accent', selector: '.fp-tone--accent .fp-timeline__badge' },
  { band: 'accent', selector: '.fp-tone--accent .fp-timeline__item--live .fp-timeline__badge' },
] as const;

describe('timeline badges in dark bands', () => {
  it('each band and the live badge have their own rule, with the declared colours', () => {
    expect(decls(CASES[0].selector)).toEqual({ background: 'color-mix(in oklab, var(--clay) 24%, transparent)', color: 'var(--clay-text)' });
    expect(decls(CASES[2].selector)).toEqual({ background: 'color-mix(in oklab, var(--ink) 14%, transparent)', color: 'var(--ink)' });
    const live = { background: 'color-mix(in oklab, var(--color-success) 24%, transparent)', color: 'oklch(from var(--color-success) 86% 0.09 h)' };
    expect(decls(CASES[1].selector)).toEqual(live);
    expect(decls(CASES[3].selector)).toEqual(live);
  });

  for (const b of BRANDS) {
    it(`clear 4.5:1 on every backdrop (${b.name})`, () => {
      const failures: string[] = [];
      for (const { band, selector } of CASES) {
        const d = decls(selector);
        // A missing rule falls back to the base badge, which is what failed live.
        const fallback = selector.includes('--live') ? decls('.fp-timeline__item--live .fp-timeline__badge') : decls('.fp-timeline__badge');
        const bg = d.background ?? fallback.background ?? '';
        const fg = d.color ?? fallback.color ?? '';
        const backs = band === 'inverse' ? b.inverseBacks : [oklchToRgb([b.clay[0] - 0.12, b.clay[1] + 0.02, b.clay[2]])];
        for (const back of backs) {
          // The base chip mixes into --paper, which a dark band sets to its own panel: model it as the backdrop.
          const chipSpec = bg.replace(/, var\(--paper\)\)$/, ', transparent)');
          const chip = resolve(chipSpec, b);
          const ground = over(chip.rgb, chip.alpha, back);
          const text = resolve(fg, b).rgb;
          const r = ratio(text, ground);
          if (r < 4.5) failures.push(`${selector} on ${back.map((x) => Math.round(x * 255)).join(',')}: ${r.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
