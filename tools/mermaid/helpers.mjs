/**
 * Pure helpers used by render.mjs — extracted so the parsing and HTML
 * generation can be unit-tested without touching the filesystem.
 *
 * Keep these functions synchronous, side-effect-free, and free of any
 * dependency on `fs`, `path`, or process state so tests stay fast and
 * deterministic. File I/O and CLI plumbing stays in render.mjs.
 *
 * @module tools/mermaid/helpers
 */

/**
 * Extract every ```mermaid fenced block from a markdown document.
 *
 * Non-mermaid fences are skipped wholesale, so a ```mermaid line that appears
 * *inside* another code fence (e.g. documentation that shows mermaid source)
 * is correctly ignored rather than parsed as a diagram.
 *
 * @param {string} markdown Raw markdown source.
 * @returns {Array<{heading: string, line: number, code: string}>} Blocks in
 *   document order. `heading` is the nearest preceding ATX heading (used as a
 *   label), `line` is the 1-indexed line of the opening fence.
 */
export function extractMermaidBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let heading = '';

  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^\s*(`{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      const [, ticks, info] = fence;
      const closer = new RegExp(`^\\s*\`{${ticks.length},}\\s*$`);
      const start = i + 1;
      let end = start;
      while (end < lines.length && !closer.test(lines[end])) end += 1;
      if (info.trim().toLowerCase() === 'mermaid') {
        blocks.push({ heading, line: i + 1, code: lines.slice(start, end).join('\n') });
      }
      i = end;
      continue;
    }

    const atx = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (atx) heading = atx[1].trim();
  }

  return blocks;
}

/**
 * Escape a string for interpolation into HTML text or an attribute value.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the self-contained viewer page.
 *
 * The page references `./mermaid.min.js` relatively — render.mjs copies that
 * bundle next to the emitted HTML so the result works offline over `file://`
 * with no CDN, no bundler, and no network access.
 *
 * @param {object} options
 * @param {string} options.title Document title (usually the source filename).
 * @param {Array<{heading: string, line: number, code: string}>} options.blocks
 * @param {string} options.mermaidVersion Version string shown in the subtitle.
 * @returns {string} Complete HTML document.
 */
export function buildHtml({ title, blocks, mermaidVersion }) {
  const sections = blocks
    .map(
      (block, index) => `  <section>
    <h2>${escapeHtml(block.heading || `Diagram ${index + 1}`)}<span>line ${block.line}</span></h2>
    <div class="card"><pre class="mermaid">${escapeHtml(block.code)}</pre></div>
    <details><summary>source</summary><pre>${escapeHtml(block.code)}</pre></details>
  </section>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — diagrams</title>
<style>
  :root { color-scheme: light dark; --fg: #14181f; --muted: #5b6472; --bg: #ffffff; --card: #f7f8fa; --line: #e3e6eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8ecf2; --muted: #98a2b3; --bg: #14181f; --card: #1c222c; --line: #2a313d; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2.5rem 1.5rem 5rem; background: var(--bg); color: var(--fg);
         font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: .875rem; margin: 0 0 2.5rem; }
  section { margin: 0 0 3rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  h2 span { color: var(--muted); font-weight: 400; font-size: .8rem; margin-left: .5rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
          padding: 1.5rem; overflow-x: auto; }
  .card svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  details { margin-top: .75rem; }
  summary { cursor: pointer; color: var(--muted); font-size: .8125rem; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
        padding: 1rem; overflow-x: auto; font-size: .8125rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${blocks.length} mermaid diagram${blocks.length === 1 ? '' : 's'} · rendered locally from mermaid ${escapeHtml(mermaidVersion)}</p>
${sections}
</main>
<script src="./mermaid.min.js"></script>
<script>
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  // useMaxWidth:false keeps wide LR flowcharts and timelines at legible natural
  // size; the .card wrapper scrolls horizontally instead of shrinking the type.
  mermaid.initialize({
    startOnLoad: true,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: false, htmlLabels: true },
    timeline: { useMaxWidth: false },
  });
</script>
</body>
</html>
`;
}
