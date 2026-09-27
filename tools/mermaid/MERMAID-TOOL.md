# Mermaid Diagram Renderer

Renders every ` ```mermaid ` block in a markdown file to a self-contained HTML
page you can open locally. Built for the `docs/research/deep-research-*.md` and
ADR diagrams, which are authored as mermaid source and are otherwise only
viewable on GitHub.

```
npm run diagrams -- docs/research/deep-research-cdp.md --open
```

## Why it exists

The research + ADR corpus carries architecture diagrams as mermaid fences.
Reading them as source is painful, and the alternatives all have a catch:
GitHub renders them but needs the file pushed, `@mermaid-js/mermaid-cli` pulls
a Puppeteer Chromium on first use, and CDN-based viewers need network access.

This tool reuses the **mermaid already installed as a frontend dependency**
(`frontend/react/node_modules/mermaid` — the same one `chat/MermaidDiagram.tsx`
renders with), copies that bundle next to the emitted HTML, and references it
relatively. The result works offline over `file://`: no install, no download,
no network, and the diagram engine is version-locked to what the app itself
ships.

## Usage

```
node tools/mermaid/render.mjs <input.md> [--out <dir>] [--open]

  --out <dir>   output directory (default: .mermaid-out/<input-basename>/)
  --open        open the rendered page in the default browser
```

Output is a directory containing `index.html` + `mermaid.min.js`. The default
location `.mermaid-out/` is gitignored.

Each diagram is labelled with its nearest preceding markdown heading and its
source line in the original file, with the mermaid source available under a
collapsed `source` disclosure — so a diagram you want to change is easy to
trace back to the line that produces it.

## Layout

| File | Role |
|---|---|
| `render.mjs` | CLI entry — argument parsing, file I/O, mermaid-bundle resolution, `--open` |
| `helpers.mjs` | Pure logic — fence extraction, HTML escaping, page generation |
| `__tests__/helpers.test.mjs` | Node built-in test runner, no dependencies |

The pure/impure split mirrors `tools/browser/` (`helpers.mjs` vs `server.mjs`)
so the parsing rules can be tested without writing files or launching a browser.

## Behaviour worth knowing

- **Nested fences are handled.** A ` ```mermaid ` line inside a wider ` ````  `
  fence — i.e. documentation *showing* mermaid source — is skipped, not parsed
  as a diagram.
- **Diagrams render at natural size** (`useMaxWidth: false`). Wide `flowchart LR`
  graphs and `timeline` diagrams scroll inside their card rather than being
  scaled down to unreadable type, which is what the mermaid default does to
  them.
- **The page is theme-aware** via `prefers-color-scheme`, matching the mermaid
  `dark`/`default` themes to the surrounding page.
- **Diagram source is escaped** before it reaches the page, so node labels
  cannot inject markup.

## Tests

```
node --test 'tools/mermaid/__tests__/*.test.mjs'
```

Quote the glob so Node expands it rather than the shell. The bare directory
form (`node --test tools/mermaid/`) does **not** work on Node 22 — it resolves
the path as a module and exits 1 having run nothing, which reads like one
failing test rather than a whole suite that never ran.

`tools/browser/` had the same wrong invocation in its test-file header, which
meant its 14 tests silently never ran for anyone who followed it; corrected
alongside this tool.

These tests are not part of `npm run ci` — the tool is developer-facing and
ships nothing into the backend or the SPA.
