/**
 * Ambient typing for `temml` (ships no bundled .d.ts we rely on) — a pure-JS
 * LaTeX → MathML converter (MIT). `renderToString` returns a standalone
 * `<math xmlns=…>` element string; deterministic, no DOM, no network — the
 * properties the ADR 0400 EPUB-MathML dependency decision depends on.
 */
declare module 'temml' {
  interface TemmlOptions {
    displayMode?: boolean;
    /** Emit XML-safe output (self-closing tags) for XHTML/EPUB. */
    xml?: boolean;
    throwOnError?: boolean;
  }
  export function renderToString(tex: string, options?: TemmlOptions): string;
  const _default: { renderToString: typeof renderToString };
  export default _default;
}
