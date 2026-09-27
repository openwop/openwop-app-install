/**
 * Canvas export helpers (ADR 0333 Phase 8) — type-agnostic core utilities.
 * The ONE-render-path rule holds by serializing a CLONE of the LIVE scene
 * SVG rather than re-rendering the doc through a second serializer: every
 * editor overlay (hit layers, selection, guides, grid, live ink) carries a
 * `cv-*` class, while the safe renderer's content elements are class-free —
 * stripping classed elements yields exactly the document's rendering.
 *
 * The export UI lives with the type that owns the scene element (drawings
 * today); a chassis export-menu seam is the recorded follow-up once a second
 * consumer (CAD) appears.
 */

/** Serialize a cleaned standalone copy of a live scene SVG: classed elements
 *  (editor chrome) removed, explicit pixel width/height set from the viewBox
 *  so standalone viewers size it, the editor class dropped from the root. */
export function svgElementToCleanString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[class]').forEach((el) => el.remove());
  // ADR 0333 grade pass UX-D1 — the classed root carries the theme text color;
  // stripping the class strands every `currentColor` default (ink, lines,
  // QuickShape fits) → black-on-transparent, invisible for a dark-theme
  // author. Resolve the LIVE computed color onto the clone so the export shows
  // what the editor showed. (Explicit colors are unaffected — they're inline.)
  try {
    const resolved = typeof getComputedStyle === 'function' ? getComputedStyle(svg).color : '';
    if (resolved) clone.style.color = resolved;
  } catch { /* jsdom / no layout — the inline colors still export correctly */ }
  clone.removeAttribute('class');
  clone.removeAttribute('role');
  clone.removeAttribute('aria-label');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = clone.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [];
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
    clone.setAttribute('width', String(vb[2]));
    clone.setAttribute('height', String(vb[3]));
  }
  return new XMLSerializer().serializeToString(clone);
}

/** Rasterize an SVG string to a PNG blob (Image + offscreen canvas — no new
 *  dependency; `scale` multiplies the viewBox size for crisp exports). Guarded
 *  for jsdom (no Image decode) — resolves null there and on any failure. */
export function svgStringToPngBlob(svgText: string, width: number, height: number, scale = 2): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          canvas.toBlob((b) => resolve(b), 'image/png');
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke — a synchronous revoke after click() races the download in
  // some browsers (Firefox). (ADR 0333 grade pass CODE-D19.)
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Copy a PNG blob to the clipboard (guarded — Safari/insecure contexts may
 *  lack ClipboardItem). Returns false when unsupported/failed. */
export async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  try {
    const G = globalThis as { ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem };
    if (!G.ClipboardItem || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new G.ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inline every host-asset `<image href="/host/openwop-app/assets/…">` in an
 * SVG string as a data: URI (ADR 0401 follow-through — the drawings `image`
 * kind). SVG-as-image rasterization (svgStringToPngBlob) forbids external
 * resource loads — even same-origin — so a PNG export would silently drop
 * placed images without this pass; an exported .svg FILE also becomes
 * self-contained. Host paths only (the validator already guarantees that);
 * a fetch failure leaves that href untouched (the export still succeeds,
 * minus that image).
 */
export async function inlineSvgImageHrefs(svgText: string): Promise<{ text: string; unresolved: number }> {
  const HREF_RE = /(<image\b[^>]*\bhref=")((?:\/v1)?\/host\/openwop-app\/assets\/[A-Za-z0-9_-]{1,512})(")/g;
  const hrefs = [...new Set([...svgText.matchAll(HREF_RE)].map((m) => m[2]).filter((h): h is string => !!h))];
  if (hrefs.length === 0) return { text: svgText, unresolved: 0 };
  const dataUris = new Map<string, string>();
  await Promise.all(hrefs.map(async (href) => {
    try {
      const res = await fetch(href);
      if (!res.ok) return;
      // arrayBuffer + btoa (not FileReader) — realm-independent, so the same
      // code path runs in the browser and under test.
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      dataUris.set(href, `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave this href as-is — export degrades, never fails */ }
  }));
  // DRAW-G3 — degrading is right; degrading SILENTLY is not. An href left as-is
  // renders as NOTHING in a rasterized PNG (SVG-as-image forbids resource loads
  // — the very reason this function exists) and leaves an .svg pointing at a
  // host path that resolves nowhere else. Report the count so the caller can say
  // the export is incomplete instead of handing over a file with a hole in it.
  const text = svgText.replace(HREF_RE, (whole, pre: string, href: string, post: string) => {
    const inlined = dataUris.get(href);
    return inlined ? `${pre}${inlined}${post}` : whole;
  });
  return { text, unresolved: hrefs.filter((h) => !dataUris.has(h)).length };
}
