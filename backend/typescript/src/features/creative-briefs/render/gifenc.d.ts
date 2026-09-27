/**
 * Ambient typing for `gifenc` (ships JS + a flow-typed source, no usable .d.ts)
 * — a pure-JS, deterministic GIF encoder (MIT). Only the surface the animated-ad
 * renderer uses (ADR 0399 OQ-2). No DOM, no native deps.
 */
declare module 'gifenc' {
  interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: number[][]; delay?: number; transparent?: boolean; dispose?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  // gifenc is a DUAL-PACKAGE hazard: `main` is CJS (what Node's loader uses at
  // runtime — named ESM imports CRASH the esbuild bundle at boot: "Named
  // export 'GIFEncoder' not found", deploy incident 2026-07-18 rev 00532),
  // while `module` is ESM (what vite/vitest resolve — named exports work,
  // `default` doesn't exist). The ONLY import shape correct in both loaders is
  // a namespace import with a runtime `default ?? namespace` pick — these
  // declarations type that shape.
  export function GIFEncoder(): GifEncoderInstance;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: string }): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
  interface GifencModule {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  }
  const defaultExport: GifencModule | undefined;
  export default defaultExport;
}
