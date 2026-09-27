/**
 * ADR 0256 — safe Markdown → HTML for AUTHORED email bodies.
 *
 * SAFE BY CONSTRUCTION, the same discipline as `renderHtmlBody` (ADR 0242):
 * ESCAPE FIRST (every byte of the operator-authored + contact-interpolated body
 * is HTML-escaped), THEN a fixed safe SUBSET of Markdown is re-introduced as a
 * controlled set of tags. No raw HTML ever survives (`<script>` → `&lt;script&gt;`),
 * link hrefs are scheme-allowlisted (http/https/mailto ONLY — a `javascript:` /
 * `data:` link falls through to inert escaped text), and the attribute context is
 * safe because `"`/`'` are escaped in step one, so an href can never break out.
 *
 * Supported subset: `# / ## / ###` headings, `- ` / `* ` unordered lists,
 * blank-line paragraphs (single newline → `<br>`), `**bold**`, `*italic*`,
 * `` `code` ``, `[text](url)` links, and bare-URL autolinks (the host-owned
 * tracked `/c` links + unsubscribe/preferences lines `instrumentBody` appends).
 */

const escapeHtml = (s: string): string =>
  s.replace(/\0/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ANCHOR_ATTRS = 'target="_blank" rel="noopener noreferrer"';

// ONE pass over already-escaped text. Alternation is left-to-right + non-overlapping,
// so `[text](url)` consumes its own url (never re-matched as a bare url), and only
// http(s)/mailto hrefs are ever emitted. A `[x](javascript:…)` matches NEITHER branch
// (the md branch requires http/mailto; the bare branch requires `http(s)://`) → it
// stays as the literal escaped text `[x](javascript:…)` — inert.
function linkify(escaped: string, emit: (anchorHtml: string) => string): string {
  const LINK_OR_URL = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|(https?:\/\/[^\s<>()"']+)/g;
  return escaped.replace(LINK_OR_URL, (_m, mdText: string | undefined, mdUrl: string | undefined, bareUrl: string | undefined) => {
    const html = mdUrl ? `<a href="${mdUrl}" ${ANCHOR_ATTRS}>${mdText}</a>` : `<a href="${bareUrl}" ${ANCHOR_ATTRS}>${bareUrl}</a>`;
    return emit(html);
  });
}

/** Inline formatting on already-escaped text. Links are pulled out to NUL-delimited
 *  placeholders FIRST, so emphasis/code can never rewrite an href or anchor internals
 *  — a URL containing `*` (e.g. `…/2*for*1`) would otherwise get an `<em>` spliced
 *  into its href (inert but a broken link). NUL is stripped by `escapeHtml`, so a
 *  placeholder can never collide with authored text; anchors are restored last. */
function inline(escaped: string): string {
  const anchors: string[] = [];
  let s = linkify(escaped, (html) => { anchors.push(html); return `\u0000A${anchors.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s.replace(/\u0000A(\d+)\u0000/g, (_m, i: string) => anchors[Number(i)] ?? '');
}

/** Render the safe-subset Markdown body (already escaped) to block HTML. */
function renderBlocks(raw: string): string {
  const escaped = escapeHtml(raw);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = (): void => { if (para.length) { out.push(`<p style="margin:0 0 12px">${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = (): void => { if (list.length) { out.push(`<ul style="margin:0 0 12px;padding-left:20px">${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = []; } };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const level = h[1]!.length;
      out.push(`<h${level} style="margin:0 0 8px">${inline(h[2]!)}</h${level}>`);
    } else if (li) {
      flushPara();
      list.push(li[1]!);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** The shared email document shell — ONE source of truth for the body styling so
 *  the editor preview renders IDENTICALLY to what sends (minus the tracked links +
 *  open pixel added at send time). */
function wrapDocument(bodyHtml: string, pixelHtml: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c;font-size:15px;line-height:1.5">
${bodyHtml}
${pixelHtml}
</body>
</html>`;
}

/**
 * Render an ALREADY-INSTRUMENTED markdown body (tracked `/c` links + the
 * unsubscribe/preferences lines) to the multipart HTML part, with the open pixel —
 * the markdown counterpart of `renderHtmlBody`, same document shell.
 */
export function renderMarkdownBody(instrumentedText: string, pixelUrl: string): string {
  // An empty pixelUrl means an UNTRACKED render (R2 test sends) — no img tag.
  const pixel = pixelUrl ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">` : '';
  return wrapDocument(renderBlocks(instrumentedText), pixel);
}

/** Preview render — the SAME styled document as the sent email (so the iframe
 *  preview is faithful: font, color, padding all match what sends), minus the
 *  instrumentation + open pixel. UX-1. */
export function renderMarkdownPreview(raw: string): string {
  return wrapDocument(renderBlocks(raw), '');
}
