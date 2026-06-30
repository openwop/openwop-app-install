/**
 * Theme generator (ADR 0171 Phase A). Maps a small input set → the seed + on-color
 * tokens for light AND dark. Hybrid:
 *   - brand FIDELITY: `--clay` is set to the operator's accent EXACTLY; the accent
 *     ramp's alpha variants stay CSS relative-color (Phase 2a) — not regenerated.
 *   - guaranteed ACCESSIBILITY: the contrast-critical on-colors (`--clay-text`,
 *     `--clay-strong`, `--ink-3`) are SOLVED for WCAG-AA against their actual
 *     surface (a fixed CSS offset can't guarantee that for an arbitrary accent).
 *   - NO regression: the default seed-set returns the hand-tuned stock values
 *     byte-identically, so unedited installs never shift.
 *
 * MIRROR: the token names here are a subset of styles/global.css — see the ADR 0170
 * MIRROR CONTRACT on PublicBrandIdentity before adding a token.
 */
import { formatOklch, numStr, parseColorToOklch, parseColorToRgb, type Oklch } from './oklch.js';
import { solveOnColorLightness } from './contrast.js';

export type ContrastLevel = 'standard' | 'medium' | 'high';
export interface ThemeInputs {
  /** The brand accent seed (any CSS color). Defaults to the stock accent if omitted. */
  accentSeed?: string;
  neutralSeed?: string;
  secondarySeed?: string; // reserved (future); not emitted yet
  contrastLevel?: ContrastLevel;
  radius?: 'sm' | 'md' | 'lg';
  density?: 'compact' | 'comfortable'; // reserved (Phase D); not emitted yet
}
export interface GeneratedTheme { light: Record<string, string>; dark: Record<string, string>; warnings: string[] }

/** Stock = the current global.css values, byte-identical (the no-regression anchor). */
export const STOCK_ACCENT = 'oklch(58% 0.13 40)';
const STOCK_LIGHT: Record<string, string> = {
  '--clay': STOCK_ACCENT, '--paper': '#f4f1ea', '--paper-2': '#ece8de',
  '--rule': '#d9d4c5', '--rule-2': '#c4bfae', '--ink': '#1a1a17', '--ink-2': '#4a4842', '--ink-3': '#66624f',
};
const STOCK_DARK: Record<string, string> = {
  '--paper': '#1a1a17', '--paper-2': '#232220', '--rule': '#3a3833', '--rule-2': '#4a4842',
  '--ink': '#f4f1ea', '--ink-2': '#d9d4c5', '--ink-3': '#a8a39a',
};
const TARGET: Record<ContrastLevel, number> = { standard: 4.5, medium: 5.5, high: 7 };
const RADIUS_PX: Record<NonNullable<ThemeInputs['radius']>, string> = { sm: '6px', md: '10px', lg: '14px' };

/** Lightness targets for a generated neutral ramp (calibrated near the stock warm grays). */
const NEUTRAL_L = {
  light: { paper: 0.955, paper2: 0.925, rule: 0.855, rule2: 0.78, ink: 0.18, ink2: 0.34 },
  dark: { paper: 0.16, paper2: 0.205, rule: 0.3, rule2: 0.38, ink: 0.955, ink2: 0.87 },
};

const isStock = (i: ThemeInputs): boolean =>
  ((i.accentSeed ?? STOCK_ACCENT).replace(/\s+/g, '') === STOCK_ACCENT.replace(/\s+/g, '')) &&
  !i.neutralSeed && (i.contrastLevel ?? 'standard') === 'standard' && !i.radius;

function neutralRamp(seed: Oklch, dark: boolean): Record<string, string> {
  const L = dark ? NEUTRAL_L.dark : NEUTRAL_L.light;
  const c = Math.min(seed.C, 0.02), ic = Math.min(seed.C, 0.012); // low-chroma tint
  return {
    '--paper': formatOklch({ L: L.paper, C: c, H: seed.H }),
    '--paper-2': formatOklch({ L: L.paper2, C: c, H: seed.H }),
    '--rule': formatOklch({ L: L.rule, C: c, H: seed.H }),
    '--rule-2': formatOklch({ L: L.rule2, C: c, H: seed.H }),
    '--ink': formatOklch({ L: L.ink, C: ic, H: seed.H }),
    '--ink-2': formatOklch({ L: L.ink2, C: ic, H: seed.H }),
  };
}

/** Generate the theme token maps from the input set. */
export function generateTheme(inputs: ThemeInputs): GeneratedTheme {
  if (isStock(inputs)) return { light: { ...STOCK_LIGHT }, dark: { ...STOCK_DARK }, warnings: [] };

  const warnings: string[] = [];
  const accent = parseColorToOklch(inputs.accentSeed || STOCK_ACCENT) ?? parseColorToOklch(STOCK_ACCENT)!;
  const target = TARGET[inputs.contrastLevel ?? 'standard'];

  // Surfaces: generated neutral ramp (custom seed) or the stock grays.
  const neutralSeed = inputs.neutralSeed ? parseColorToOklch(inputs.neutralSeed) : null;
  const light: Record<string, string> = neutralSeed ? neutralRamp(neutralSeed, false) : { ...STOCK_LIGHT };
  const dark: Record<string, string> = neutralSeed ? neutralRamp(neutralSeed, true) : { ...STOCK_DARK };
  delete light['--clay']; delete dark['--clay']; // accent set below

  // Accent (exact) + AA-solved accent text/strong, per surface.
  const accentStr = formatOklch(accent);
  light['--clay'] = accentStr; dark['--clay'] = accentStr;

  const paperLight = parseColorToRgb(light['--paper'] ?? '') ?? [0.96, 0.94, 0.92];
  const paperDark = parseColorToRgb(dark['--paper'] ?? '') ?? [0.1, 0.1, 0.09];

  // accent-text: start from the stock derivation (darker + a touch more chroma), then solve.
  const seedText: Oklch = { L: accent.L - 0.12, C: accent.C + 0.02, H: accent.H };
  const tLight = solveOnColorLightness(seedText, paperLight, target);
  const tDark = solveOnColorLightness({ L: accent.L + 0.14, C: accent.C, H: accent.H }, paperDark, target);
  if (tLight.bumpExhausted) warnings.push(`accent text can't reach ${target}:1 on the light surface (best ${numStr(tLight.ratio, 1)}:1)`);
  if (tDark.bumpExhausted) warnings.push(`accent text can't reach ${target}:1 on the dark surface (best ${numStr(tDark.ratio, 1)}:1)`);
  light['--clay-text'] = formatOklch(tLight.color); light['--clay-strong'] = formatOklch(tLight.color);
  dark['--clay-text'] = formatOklch(tDark.color); dark['--clay-strong'] = formatOklch(tLight.color); // strong = solid fill, light derivation

  // --ink-3 (muted text, must be AA on the surface).
  const inkSeedL = parseColorToOklch(light['--ink'] ?? '') ?? { L: 0.18, C: 0, H: accent.H };
  const inkSeedD = parseColorToOklch(dark['--ink'] ?? '') ?? { L: 0.95, C: 0, H: accent.H };
  const i3Light = solveOnColorLightness({ L: 0.46, C: inkSeedL.C, H: inkSeedL.H }, paperLight, target);
  const i3Dark = solveOnColorLightness({ L: 0.66, C: inkSeedD.C, H: inkSeedD.H }, paperDark, target);
  if (i3Light.bumpExhausted) warnings.push(`muted text can't reach ${target}:1 on the light surface`);
  if (i3Dark.bumpExhausted) warnings.push(`muted text can't reach ${target}:1 on the dark surface`);
  light['--ink-3'] = formatOklch(i3Light.color); dark['--ink-3'] = formatOklch(i3Dark.color);

  if (inputs.radius) { light['--radius'] = RADIUS_PX[inputs.radius]; dark['--radius'] = RADIUS_PX[inputs.radius]; }

  return { light, dark, warnings };
}
