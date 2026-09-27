# ADR 0256 — Authored Markdown email body (safe-subset render + preview)

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0242 §"Open items" authored-HTML-editor follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0242 (HTML email + open tracking — the escape-first render this extends), ADR 0218 (email templates + engagement), ADR 0227 (preference center) |

## Context

ADR 0242 renders the plain-text body to an HTML part with an **escape-first** XSS
gate (`renderHtmlBody`), and left the richer authoring surface as an open item:

> "Authored HTML editor (a rich-body UI + sanitization + preview) — a later UX PR."

Operators want formatting (bold, links, lists, headings) in campaign emails. The
security question is the whole ballgame: authoring **arbitrary HTML** means
sanitizing it with an allowlist — a classic, easy-to-get-wrong XSS surface.

## Decision

**Author in a safe Markdown SUBSET, not arbitrary HTML.** A template gains
`format: 'text' | 'markdown'` (absent ⇒ `text`, back-compat). Markdown templates
render their HTML part through a new `safeMarkdown` renderer that is **safe by
construction** — the same discipline as ADR 0242, extended with formatting:

- **Escape-first.** Every byte of the operator-authored + contact-interpolated
  body is HTML-escaped, THEN a fixed safe subset is re-introduced as a controlled
  tag set (`# ## ###`, `- ` lists, `**bold**`, `*italic*`, `` `code` ``, `[text](url)`
  + bare-URL autolinks, blank-line paragraphs). No raw HTML ever survives
  (`<script>` → `&lt;script&gt;`).
- **Scheme-allowlisted links.** A single-pass link/URL alternation emits an anchor
  ONLY for `http`/`https`/`mailto`; a `javascript:` / `data:` link matches neither
  branch and falls through to inert escaped text. Because escaping runs first, a
  `"`/`'` in a URL is already neutralized, so an href can never break its attribute.
- **Composes with tracking (ADR 0242/0227).** `instrumentBody` runs first (it
  rewrites in-body URLs — including the ones inside `[text](url)` — to tracked `/c`
  redirects and appends the unsubscribe/preferences lines); the renderer then
  autolinks those host-owned URLs. Same tracked-link + open-pixel behaviour as text
  mode.

**Preview is server-authoritative.** A `POST /email/orgs/:orgId/preview` route runs
the SAME renderer (no instrumentation/pixel) so the editor preview is what actually
sends. The SPA renders it in a **`sandbox=""` iframe** (no scripts, no same-origin)
— defence-in-depth over the server sanitization, and it isolates the email's own
styles from the app shell. No `dangerouslySetInnerHTML`.

## Alternatives weighed

- **Arbitrary HTML + an allowlist sanitizer** (server DOMPurify-equivalent).
  Rejected — a security-critical dependency + a large XSS bypass-test surface, for
  expressiveness most campaign emails don't need. The safe-Markdown subset delivers
  the real value (formatting) with a renderer that is safe *by construction*, no
  dependency, exhaustively unit-tested.
- **A WYSIWYG editor.** Rejected for this pass — a heavy dependency + bundle cost;
  a Markdown textarea + live preview is the honest-minimal authoring surface.
- **Client-side Markdown render for preview.** Rejected — two renderers (client +
  server) drift; the server route is the single authoritative renderer, so preview
  == sent.
- **`dangerouslySetInnerHTML` for the preview.** Rejected — a `sandbox=""` iframe is
  strictly safer (kills scripts even if the server ever regressed) and a truer
  preview (style isolation).

## Boundaries / wire

- **No wire change, no RFC.** Template `format` + the preview route are host-ext;
  the send path is internal. `EmailMessage.html` already exists (ADR 0242).
- **Replay/fork.** The renderer is a pure function of the (instrumented) body;
  nothing new is stamped on a run.
- **Security.** The renderer is the XSS gate; `email-safe-markdown.test.ts` is its
  bypass suite (raw tags escaped, `javascript:`/`data:` links dropped, attribute
  break-out neutralized, single-pass anchors).

## Implementation

| Change | File |
| --- | --- |
| `safeMarkdown.ts` — `renderMarkdownBody` (send) + `renderMarkdownPreview` (editor); escape-first, scheme-allowlisted, single-pass links | `backend/typescript/src/features/email/safeMarkdown.ts` |
| `EmailTemplate.format` + create/update threading; send-path branch (`format==='markdown' ? renderMarkdownBody : renderHtmlBody`) | `backend/typescript/src/features/email/emailService.ts` |
| `format` on template create/patch routes; `POST …/preview` route | `backend/typescript/src/features/email/routes.ts` |
| XSS gate suite + template round-trip + send-path branch tests | `backend/typescript/test/email-safe-markdown.test.ts`, `test/email-markdown-body.test.ts` |
| `format` client type + `previewMarkdown`; `EmailBodyPreview` (sandboxed iframe); editor format toggle + preview; i18n × 4 | `frontend/react/src/features/email/{emailClient.ts,EmailBodyPreview.tsx,EmailPage.tsx,i18n/*}` |

## Open items (deferred)

- **Table / image / blockquote subset** — additive to the renderer if a real need
  appears (each new tag is one controlled emission + one bypass test).
- **A per-template test-send / seed preview with sample contact vars** — the
  current preview renders the raw body (vars unresolved); resolving sample vars is a
  minor follow-up.
