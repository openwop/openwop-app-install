/**
 * Microsoft four-square brand mark — rendered at its official fills and NEVER
 * re-colored (DESIGN.md §8: vendor brand SVG marks are exempt from the app's
 * currentColor icon convention). Lives under `brand/vendor/` so the
 * no-raw-color-literal gate (check-tsx-color-literals.mjs allowlist) sanctions
 * the literal hexes — they are Microsoft's trademark colors, not app tokens.
 */
export function MicrosoftMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022" />
      <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}
