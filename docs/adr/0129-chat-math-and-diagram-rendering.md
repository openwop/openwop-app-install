# ADR 0129 — KaTeX math + Mermaid diagram rendering in chat

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): KaTeX math. `remark-math` + `rehype-katex` (trust:false, throwOnError:false → malformed/partial math degrades to literal, never throws) wired into the chat `ReactMarkdown` (`MessageRenderer.tsx`) + KaTeX CSS. `katex` pinned into the lazy `markdown` chunk via vite manualChunks, so the budget-checked ENTRY chunk is UNCHANGED (163.0 kB gzip). Phase 2 (sandboxed Mermaid) + Phase 4 (a11y/perf, lazy Mermaid) pending. **Date:** 2026-06-23
**Toggle:** none — *core-chat architecture* (see Scope note); no feature-package, no node/agent pack, no `ctx.<feature>` surface.
**Surface:** frontend only — the chat markdown renderer (`frontend/react/src/chat/MessageRenderer.tsx`) + the shared `ui/Markdown.tsx`. Pure client-side rendering; no backend, no route, no wire contract.
**Depends on / composes:** the chat markdown pipeline (`chat/MessageRenderer.tsx:179` `react-markdown` + `remark-gfm`), `ui/Markdown.tsx`, ADR 0102 (chat-history projection — the content being rendered), ADR 0073 (`ConversationView` — inherits the renderer in every embed). The `a`/`input` sanitization overrides already in `MessageRenderer.tsx:45` (`CHAT_MD_COMPONENTS`).
**RFC verdict:** **host-extension / pure-FE — NO new RFC.** Rendering LaTeX + Mermaid is a client-side display concern over content that already arrives as RFC 0005 conversation-turn text. No wire field, capability claim, or endpoint changes. Nothing leaves the browser.

> **Scope note.** This is a *core-chat architecture* ADR (the ADR 0102 shape), not a feature-package (ADR 0001). Chat lives in core (`frontend/react/src/chat/`), so there is **no toggle, no node/agent pack, no `ctx.<feature>` surface, no backend, and no wire** — **nearly all** evaluation-matrix rows are **N/A**. The live concerns are **security (KaTeX/Mermaid injection + sanitization)**, rendering correctness on streamed/partial content, and a11y.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (message rendering) + §11 (gap ranking — MEDIUM). Competitor implementations: Open WebUI `Messages/Markdown.svelte` (KaTeX + Mermaid); LibreChat artifacts (Mermaid via the artifacts surface); AnythingLLM (KaTeX). **Verified today:** the chat markdown pipeline is `react-markdown` + `remark-gfm` **only** — `frontend/react/package.json` has `react-markdown` + `remark-gfm` and **no** `remark-math` / `rehype-katex` / `katex` / `mermaid` dependency; `MessageRenderer.tsx:179` (`MarkdownText`) wires `remarkPlugins={[remarkGfm]}` with no math/diagram plugin. So LaTeX renders as literal `$…$` text and Mermaid renders as an unstyled ```` ```mermaid ```` code block.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a new chat renderer with math + diagrams." There is exactly one chat markdown renderer; the only correct move is to **extend it** (and the shared `ui/Markdown.tsx`) — a second renderer would fragment the chat surface (`no-parallel-architecture`).

| Concern | Existing owner (file:line) | How math/diagram rendering reuses it |
|---|---|---|
| Chat markdown rendering | `chat/MessageRenderer.tsx:176` `MarkdownText` → `ReactMarkdown remarkPlugins={[remarkGfm]}` (`:179`) | **Extend** the same `ReactMarkdown` instance with `remark-math` (parse `$…$`/`$$…$$`) + `rehype-katex` (render). One renderer, one place. No second pipeline. |
| The fence parser (code blocks) | `MessageRenderer.tsx:62` `FENCE_RE` → `CodeBlock` (`:205`) | A ```` ```mermaid ```` fence is intercepted **before** `CodeBlock` and rendered as a sandboxed diagram (fenced-mermaid is the established convention). The generic code path is untouched. |
| Shared markdown (non-chat) | `ui/Markdown.tsx` | If math is wanted app-wide, the same `remark-math`/`rehype-katex` wiring lands in the shared `ui/Markdown.tsx` so chat composes it rather than forking. (Decision: scope v1 to chat; lift to `ui/` only if a second surface needs it.) |
| Link/checkbox sanitization | `MessageRenderer.tsx:45` `CHAT_MD_COMPONENTS` (`a` → new-tab + `noopener`; `input` → disabled); `defaultUrlTransform` strips `javascript:` | The same sanitization posture extends to KaTeX/Mermaid output (KaTeX `trust:false`; Mermaid `securityLevel:'strict'` + sandboxed render). No new sanitizer invented; the existing XSS-conscious posture is preserved. |
| Streaming/partial content | `MessageRenderer.tsx:14` doc — "Partial / streaming markdown renders as plain text until the closing delimiter arrives" | Incomplete `$…` / unclosed ```` ```mermaid ```` must degrade to literal text until closed (no half-parsed KaTeX throw, no Mermaid render of a partial graph). |
| Theme tokens | `MessageRenderer.tsx:178` `chat-md`/`msgrender-md` (var(--ink)/var(--color-accent)/var(--mono)) | KaTeX + Mermaid theming is pinned to the same CSS tokens (dark-mode parity), satisfying the `check-css-tokens`/`check-tsx-color-literals` build gates. |

**Net new (small, FE-only):** add `remark-math` + `rehype-katex` (+ KaTeX CSS) to the chat `ReactMarkdown`; intercept the ```` ```mermaid ```` fence and render it through a **sandboxed** Mermaid component (`securityLevel:'strict'`, off the streamed path); token-theme both; degrade partial input to literal text.

---

## Decision

Extend the **single** chat markdown renderer (`MessageRenderer.tsx`) to render **LaTeX math** (`remark-math` + `rehype-katex`) and **Mermaid diagrams** (sandboxed render of ```` ```mermaid ```` fences), pinned to openwop's theme tokens and held to the chat surface's existing XSS-conscious sanitization posture. No new renderer, no backend, no wire.

### SECURITY — the load-bearing decision (injection + sanitization)

Chat content is **LLM-influenced and therefore untrusted** (the same posture as the media-URL sanitization already at `MessageRenderer.tsx:288`). Both additions widen the rendering attack surface and **MUST be sandboxed**:

- **KaTeX:** render with **`trust: false`** + **`strict: true`** (or `throwOnError: false` so a malformed expression degrades to visible source, never an exception that blanks the bubble). `trust:false` disables `\href`/`\includegraphics`-style escapes — KaTeX's known injection vector. KaTeX emits a constrained HTML subset; `rehype-katex` runs **after** `react-markdown`'s own URL sanitization, and we do **not** enable `rehype-raw` (no arbitrary HTML passthrough). Net: math becomes display-only spans, no script/eval surface.
- **Mermaid:** **`securityLevel: 'strict'`** (Mermaid's HTML-label sanitization on; click-handlers/`%%{init}%%` script directives disabled). Render **off the React render path** (Mermaid mutates the DOM/SVG) into a contained element, and **sanitize the produced SVG** (strip `<script>`, `on*` handlers, `foreignObject` script) before insertion — Mermaid's own `dompurify` pass is the first line, our strip is defense-in-depth. The diagram source comes from an LLM, so a malicious graph definition must not reach a click-action or an embedded script. **Render only on settled (non-streaming) content** — never re-render a partial graph per token (DoS + half-parse). **This is the central `/architect`-or-`/security-review` item:** confirm the Mermaid sandbox (strict + SVG sanitization + no live re-render) closes the XSS surface before shipping.

### Rendering correctness on streamed/partial content

The renderer already keeps partial markdown as literal text until delimiters close (`MessageRenderer.tsx:14`). Both additions honor this:

- An unclosed `$…` / `$$…` stays literal until the closing delimiter arrives (no KaTeX throw mid-stream).
- An incomplete ```` ```mermaid ```` fence (no closing fence yet) renders as the existing `CodeBlock` (or literal) until closed, **then** flips to a rendered diagram on the settled turn — Mermaid never parses a partial graph.

### Data model — none

Pure rendering. No persisted entity, no backend, no route. The content is the existing RFC 0005 conversation-turn text (ADR 0102 projection) — unchanged.

### RBAC & isolation

N/A at the data layer (no new data, no new endpoint). The relevant control is **content sandboxing** (above) — the renderer treats all message content as untrusted regardless of author, exactly as the existing media-sanitization does.

### Replay / fork safety

N/A — pure client-side rendering over already-persisted turn text. Nothing is stamped on a run; the run event log is untouched. A `:fork` re-derives the same text and re-renders it identically (rendering is a deterministic function of the stored text). No run state, no replay surface.

---

## Evaluation matrix

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **N/A** — core-chat; extends `chat/MessageRenderer.tsx` (+ optionally `ui/Markdown.tsx`), no `features/<x>` package. |
| 2 | Toggle / admin UI / `bucketUnit` | **N/A** — core chat, always-on FE rendering. |
| 3 | Workflow node pack | **N/A** — no node pack; no backend. |
| 4 | Agent pack / persona | **N/A** — renders any agent's output identically. |
| 5 | AI-chat envelope / `ctx.<feature>` | **N/A** — renders existing RFC 0005 turn text; no new envelope. |
| 6 | RBAC | **N/A (data)** — no new data/endpoint. The control is content **sandboxing** (untrusted-content posture), covered under Security. |
| 7 | Replay / fork | **N/A** — pure FE rendering; nothing stamped on a run; deterministic re-render on `:fork`. |
| 8 | RFC gate | **pure-FE, NO new RFC** — client-side display of existing turn text; no wire field/capability/endpoint. |
| 9 | a11y | **Yes** — KaTeX emits MathML alongside HTML (screen-reader math); Mermaid SVG gets a `role="img"` + `aria-label` from the diagram title/source (never an unlabeled SVG); theme tokens keep dark-mode contrast. |
| 10 | Tests | KaTeX renders `$x^2$` / `$$…$$`; malformed math degrades to source (no throw); ```` ```mermaid ```` renders sandboxed SVG with no `<script>`/`on*`; partial math/diagram stays literal until closed; token-theme/dark-mode integrity (`check-css-tokens`). |

---

## Phased plan

1. **KaTeX math.** Add `remark-math` + `rehype-katex` (+ KaTeX CSS, token-themed) to the chat `ReactMarkdown` (`MessageRenderer.tsx:179`); `trust:false` + `throwOnError:false`; partial-math literal degrade. Tests + dark-mode token check.
2. **Mermaid diagrams (sandboxed).** Intercept the ```` ```mermaid ```` fence in the segment parser (`MessageRenderer.tsx:62`) before `CodeBlock`; render via a sandboxed Mermaid component (`securityLevel:'strict'`, SVG sanitization, settled-content-only, `role="img"`+`aria-label`). `/security-review` the sandbox. Tests for no-script SVG + partial-fence degrade.
3. **(Optional) Lift to `ui/Markdown.tsx`.** If a second app surface wants math/diagrams, move the wiring into the shared `ui/Markdown.tsx` so chat composes it — avoid a fork.
4. **A11y + perf.** MathML/aria-label verification; Mermaid render debounced to settled turns only (no per-token re-render); bundle-size review (KaTeX/Mermaid are heavy — lazy-load Mermaid).

## Alternatives weighed

1. **A bespoke math/diagram renderer beside `MessageRenderer`.** Rejected — two chat renderers fragment the surface and drift (`no-parallel-architecture`). Extend the one renderer.
2. **Render Mermaid live on every streamed token.** Rejected — half-parsed graphs throw/flicker and re-rendering per token is a DoS vector; render only on settled content.
3. **Enable `rehype-raw` to pass arbitrary HTML (incl. inline SVG).** Rejected outright — arbitrary HTML passthrough on untrusted LLM content is a direct XSS hole; KaTeX/Mermaid go through their constrained, sanitized emitters, never raw HTML.
4. **Server-side render of math/diagrams.** Rejected — adds a backend/wire surface for a pure display concern; client render keeps it FE-only (no RFC, no egress).

## Open questions

1. **OQ-1 — Mermaid bundle weight.** Mermaid is large; lazy-load it only when a ```` ```mermaid ```` fence is present (most turns have none). Propose: dynamic import on first diagram.
2. **OQ-2 — KaTeX delimiter ambiguity.** `$…$` collides with literal currency (`it cost $5 and $7`). `remark-math` requires balanced inline `$`; confirm the single-`$` heuristic doesn't false-positive on prose. Propose: enable `$$…$$` (display) + inline `$…$` with `remark-math`'s default guards; revisit if currency false-positives appear (Open WebUI hit this).
3. **OQ-3 — `ui/Markdown.tsx` scope.** Lift the wiring to the shared renderer now (app-wide math) or keep it chat-only (v1)? Propose: chat-only v1; lift on the second consumer.
4. **OQ-4 — Mermaid error UX.** A malformed diagram definition: show the raw code block (current behavior) + an inline parse-error note, never a blank/thrown bubble.

## RFC verdict (Step 5)

**Pure-FE host concern — NO new RFC.** Rendering LaTeX + Mermaid is client-side display of content that already arrives as RFC 0005 conversation-turn text. No wire field, capability claim, endpoint, or run-event change; nothing leaves the browser. (The security work is a sandboxing/sanitization concern, not a wire concern — handled under Security, reviewed by `/security-review`.)

> **Phase 2 (sandboxed Mermaid) implemented** (2026-06-24):** a ```` ```mermaid ```` fence in the ONE chat renderer (MessageRenderer `TextWithCodeBlocks`) now dispatches to a lazy `MermaidDiagram`. TWO defense layers: mermaid runs with `securityLevel:'strict'` (sanitizes at parse), and the resulting static SVG is displayed in an iframe `srcdoc` with `sandbox=""` (EMPTY — no allow-scripts, null origin) + a `default-src 'none'` no-egress CSP (neutralizes at render — strictly safer than the ADR 0128 artifact frame's allow-scripts, since a static SVG needs no script). NOT dangerouslySetInnerHTML. BUNDLE: mermaid (+d3/dagre/cytoscape) auto-splits into its own ~133 kB lazy chunk loaded ONLY when a diagram renders; the `markdown` chunk stays ~207 kB and the budgeted ENTRY chunk stays at 164.0 kB (the MermaidDiagram component is React.lazy). STREAMING: a parse error on partial/malformed source DEGRADES to the literal code block (CodeBlock, extracted to its own module to avoid an import cycle) — never throws, never blanks. /architect GO (security+bundle), /code-review + /ux-review clean (i18n'd title applied). 5 security tests (no-script CSP, sandbox="", height parse, degrade-on-error). Phase 4 (a11y/perf polish) pending.

> **Phase 4 (a11y/perf) implemented** (2026-06-24):** (a11y) `rehype-katex` now sets `output: 'htmlAndMathml'` EXPLICITLY — the MathML sibling is what screen readers announce; it was KaTeX's implicit default, now pinned so an a11y-critical setting can't silently change. (perf) `MermaidDiagram` is `React.memo`'d on `source` — during streaming the parent re-renders per token, but a settled diagram's source is stable, so the sandbox iframe no longer re-paints until the source changes. Lazy Mermaid was already done in Phase 2 (PR #813). /architect (inline — a11y config + memo on the Phase-2-reviewed renderers, no new surface), /code-review + /ux-review clean (explicit screen-reader MathML; 5/5 Mermaid tests green; entry 162.0 kB). ADR 0129 now complete (Phases 1, 2, 4).
