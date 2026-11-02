/**
 * MermaidDiagram — sandboxed Mermaid rendering for chat (ADR 0129 Phase 2).
 * SECURITY-CRITICAL: the diagram source is UNTRUSTED model output.
 *
 * Two independent defense layers (reviewed via /architect):
 *  1. mermaid runs with `securityLevel: 'strict'` — htmlLabels off, click/script
 *     directives stripped, labels sanitized — producing a sanitized static SVG.
 *  2. that SVG is displayed inside an iframe `srcdoc` with `sandbox=""` (EMPTY — NO
 *     allow-scripts, NO allow-same-origin → null origin, no script execution at all),
 *     a `default-src 'none'` CSP, and the `inert` attribute. ADR 1017 measured that a
 *     `sandbox=""` frame still navigates itself on a click or Tab+Enter over a link;
 *     `inert` takes clicks and focus away, so nothing that survives strict mode can
 *     run or phone home. The figcaption below is the text alternative, since `inert`
 *     also hides the frame from assistive tech.
 *
 * mermaid is lazy-imported (pinned to the `markdown` vite chunk, never the entry).
 * On a parse/render error (e.g. a partial diagram mid-stream) it DEGRADES to the
 * literal code block — never throws, never blanks the message.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeBlock } from './CodeBlock.js';

/** Locked-down CSP for the static-SVG sandbox: no scripts, no network, no fonts. */
export const SVG_CSP_FOR_TEST = "default-src 'none'; img-src data:; style-src 'unsafe-inline';";

/** Wrap a sanitized SVG in a minimal no-script document. Mirrors ADR 0128's
 *  buildArtifactSrcdoc but with `script-src` ABSENT (default-src 'none' denies it). */
export function buildMermaidSrcdoc(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SVG_CSP_FOR_TEST}"><style>html,body{margin:0;padding:0}svg{max-width:100%;height:auto;display:block}</style></head><body>${svg}</body></html>`;
}

/** ADR 1017 — the frame is `inert`, so it cannot scroll inside itself: it is sized to
 *  the whole diagram (up to this guard) and the PARENT figure scrolls instead. */
const MAX_FRAME_PX = 8000;

/** Best-effort intrinsic height from the rendered SVG (height attr or viewBox),
 *  capped — an iframe with sandbox="" can't self-size without a script. */
export function svgHeightPx(svg: string): number {
  const h = /<svg[^>]*\bheight="([0-9.]+)/.exec(svg);
  if (h?.[1]) return Math.min(Math.ceil(Number(h[1])) + 8, MAX_FRAME_PX);
  const vb = /viewBox="[0-9.]+ [0-9.]+ [0-9.]+ ([0-9.]+)"/.exec(svg);
  if (vb?.[1]) return Math.min(Math.ceil(Number(vb[1])) + 8, MAX_FRAME_PX);
  return 360;
}

let seq = 0; // unique render id per diagram (mermaid requires a DOM-safe id)

/** ART-3 dark-mode parity — resolve the active theme the same way the rest of the
 *  app does: an explicit `theme-dark`/`theme-light` class on <html> wins; with
 *  NEITHER present the user is on `system`, so fall back to the OS preference. */
export function isDarkTheme(): boolean {
  const cl = document.documentElement.classList;
  if (cl.contains('theme-dark')) return true;
  if (cl.contains('theme-light')) return false;
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function MermaidDiagramImpl({ source }: { source: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // ART-3 — bump on any theme change so the render effect below re-initializes
  // mermaid with the new theme and re-renders the diagram (no light island in dark).
  const [themeVersion, setThemeVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setThemeVersion((v) => v + 1);
    // Explicit toggle: the `theme-dark`/`theme-light` class on <html> changes.
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    // `system` mode: the OS color-scheme preference flips while no class is set.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', bump);
    return () => {
      observer.disconnect();
      mq?.removeEventListener('change', bump);
    };
  }, []);

  useEffect(() => {
    let live = true;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDarkTheme() ? 'dark' : 'default' });
        const id = `mmd-${(seq += 1)}`;
        const { svg: out } = await mermaid.render(id, source);
        if (live) setSvg(out);
      } catch (err) {
        // IART-4: surface the render failure (was silently swallowed). A partial diagram
        // mid-stream is expected, but chronic malformed mermaid is otherwise invisible.
        if (typeof console !== 'undefined') console.warn('[artifact] mermaid render failed', err instanceof Error ? err.message : err);
        if (live) setFailed(true); // partial/malformed → degrade to the code block
      }
    })();
    return () => { live = false; };
  }, [source, themeVersion]);

  // ADR 1017 — React 18 has no `inert` prop; set it before paint.
  const frameRef = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => { frameRef.current?.setAttribute('inert', ''); }, [svg, failed]);

  // Until it renders (or if it fails), show the raw fence — never blank, never throw.
  if (failed || svg === null) return <CodeBlock source={source} language="mermaid" />;

  return (
    // A scroll container must be reachable by keyboard (WCAG 2.1.1): a named, focusable region.
    <figure className="u-m-0 mermaid-diagram-scroll" role="region" aria-label={t('mermaidDiagram')} tabIndex={0}>
      <iframe
        ref={frameRef}
        className="mermaid-diagram-frame"
        sandbox=""
        srcDoc={buildMermaidSrcdoc(svg)}
        title={t('mermaidDiagram')}
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: `${svgHeightPx(svg)}px`, border: 'none' }}
      />
      {/* The sandboxed iframe is opaque to AT — expose the diagram source as a
          visually-hidden text alternative so screen-reader users can read it. */}
      <figcaption className="sr-only">{t('mermaidSourceLabel')}: {source}</figcaption>
    </figure>
  );
}

/** ADR 0129 Phase 4 (perf) — memoized on `source`: during streaming the parent
 *  re-renders on every token, but a settled diagram's source is stable, so this
 *  skips re-rendering (and re-painting) the sandbox iframe until the source changes. */
export const MermaidDiagram = memo(MermaidDiagramImpl);
