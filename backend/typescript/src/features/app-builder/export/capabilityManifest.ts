/**
 * Generator capability manifests + the source-map path convention (ADR 0343
 * Phase 1c — the PR-08/DA-10 contracts Phase 6 builds on).
 *
 * A manifest is a MACHINE-READABLE, honest statement of which document
 * semantics a target's generator actually implements — the anti-"silently
 * dropped behavior" contract. Phase 6 wires export preflight (block/warn by
 * severity) and behavior-parity fixtures on top; TODAY the manifests are kept
 * honest by `capabilityManifest.test.ts`, which pins each claim against the
 * real generator output. Claims here MUST follow implementation, never lead it
 * (the advertise-only-honored-behavior rule).
 */
import { type ExportTarget } from './generators.js';

/** The ADR 0343 closed action kinds a generator can implement. */
export type GeneratedActionKind = 'navigate' | 'set-state' | 'submit-form' | 'invoke-operation' | 'open-modal' | 'close-modal';

export interface GeneratorCapabilityManifest {
  target: ExportTarget;
  /** Every catalog component maps to real markup; unknown types become `warnings[]`, never errors. */
  componentCoverage: 'full-catalog';
  /** The legacy `navigateTo` prop generates real screen navigation. */
  navigateToProp: boolean;
  /** ADR 0343 `actions[]` kinds the generated code executes. Empty until Phase 6. */
  actionKinds: readonly GeneratedActionKind[];
  /** Design-time sample rows are unrolled + `{{field}}`-interpolated into markup. */
  sampleDataUnroll: boolean;
  /** ADR 0343 binding paths (`state.*`/`model.*`/`op.*`) the generated code resolves at runtime. Empty until Phase 6. */
  bindingPathRoots: readonly ('state' | 'model' | 'op' | 'source')[];
  /** Generated theme honors `themeColors.primary/secondary`. */
  themeColors: boolean;
  /** Responsive facets the target maps. */
  responsive: readonly ('hideOn' | 'columnsMobile')[];
  /** ADR 0343 facets the target scaffolds (models/operations/auth/env). None until Phase 6. */
  appContract: readonly ('models' | 'operations' | 'authProfile' | 'envRequirements')[];
}

/** The shared floor every generator implements (ADR 0305 C parity test). */
const BASELINE: Omit<GeneratorCapabilityManifest, 'target' | 'themeColors' | 'responsive'> = {
  componentCoverage: 'full-catalog',
  navigateToProp: true,
  actionKinds: [],
  sampleDataUnroll: true,
  bindingPathRoots: [],
  appContract: [],
};

/** Per-target truth, measured against real generator output by the honesty
 *  suite. ADR 0348 6a closed the recorded themeColors gap on every target and
 *  the responsive gap on react-styled; RN/Flutter responsive stays honestly
 *  absent (no CSS media queries — platform-idiomatic breakpoints are a
 *  recorded follow-up, not a fake claim). */
export const GENERATOR_CAPABILITIES: Readonly<Record<ExportTarget, GeneratorCapabilityManifest>> = {
  'html-css': { target: 'html-css', ...BASELINE, themeColors: true, responsive: ['hideOn', 'columnsMobile'] },
  'vue-tailwind': { target: 'vue-tailwind', ...BASELINE, themeColors: true, responsive: ['hideOn', 'columnsMobile'] },
  'nextjs': { target: 'nextjs', ...BASELINE, themeColors: true, responsive: ['hideOn', 'columnsMobile'] },
  'react-tailwind': { target: 'react-tailwind', ...BASELINE, themeColors: true, responsive: ['hideOn', 'columnsMobile'] },
  'react-styled': { target: 'react-styled', ...BASELINE, themeColors: true, responsive: ['hideOn', 'columnsMobile'] },
  'react-native': { target: 'react-native', ...BASELINE, themeColors: true, responsive: [] },
  'flutter': { target: 'flutter', ...BASELINE, themeColors: true, responsive: [] },
};

/**
 * Source-map path convention (DA-10): a stable address from generated output
 * back to the canvas field that produced it —
 *   `screens[<screenId>].components[<i0>].children[<i1>]…`
 * — i.e. EXACTLY the `path` grammar `validateAppDoc` reports errors against,
 * keyed by screen ID rather than index so reordering screens never remaps.
 * Phase 6 emits a `openwop.sourcemap.json` per export using these addresses;
 * defining the convention here lets validator errors, editor selection paths,
 * and generated-file provenance share one address space.
 */
export const SOURCE_MAP_FILENAME = 'openwop.sourcemap.json';
export function sourceAddress(screenId: string, componentPath: readonly number[]): string {
  return `screens[${screenId}].components${componentPath.map((i, n) => (n === 0 ? `[${i}]` : `.children[${i}]`)).join('')}`;
}
