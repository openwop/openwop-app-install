# ADR 0914 — Content language in the Markdown editor and exports, and alt text for DOCX images

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposals P9, P10 and P3
(`bookai/docs/upstream-proposals.md`). A book can be written in a language
other than the UI language.

- **P9:** The host `MarkdownEditor` gave its textarea and preview no `lang`, so
  the browser spellchecked a French manuscript as the UI language, and screen
  readers pronounced it that way too.
- **P10:** The Markdown EPUB writer hard-coded `<dc:language>en</dc:language>`,
  and its XHTML roots had no `lang`. The DOCX writer set no run language. Book AI
  patched the EPUB after rendering, and its DOCX carried no language.
- **P3:** The DOCX writer built each embedded `ImageRun` with no alt text, so
  images had no description.

## Decision

- **D1 (P9):** `MarkdownEditorProps.lang?: string`. It is applied to the
  `<textarea>` and to a wrapper around the rendered preview, and to nothing
  else: the toolbar, footer and the empty-preview message stay in the UI
  language. With no `lang`, the DOM is unchanged (no wrapper).
- **D2 (P10):** an `ExportLanguageOptions` (`language`, `direction`) on
  `renderMarkdownToEpub` and `renderMarkdownToDocx`.
  - `language` is a BCP 47 tag. A malformed value is ignored, so the XML cannot
    break.
  - **EPUB:** the tag goes to `dc:language`, the `<package xml:lang>` and every
    XHTML root (`xml:lang` + `lang`). `direction: 'rtl'` adds `dir="rtl"` and
    the spine's `page-progression-direction="rtl"`.
  - **DOCX:** the default run language is written in the styles (`w:lang`,
    with `bidirectional` and `rightToLeft` for rtl).
  - With no option, both writers produce the same output as before: EPUB stays
    `en` with no root `lang`, and DOCX has no `w:lang`. Existing renders do not
    change bytes.
- **D3 (P3):** `ResolvedExportImage.altText?: {description?, title?, decorative?}`.
  - **DOCX:** each `ImageRun` gets `altText` (`wp:docPr descr`). The resolver's
    description wins; otherwise the Markdown alt text is used. `decorative:
    true` writes an empty description, which screen readers skip.
  - **EPUB:** the same rule applies to `<img alt>`.

## Alternatives

- **Wrap the whole editor in a `lang` element.** That would tag the UI chrome
  too, which is wrong for the toolbar's own labels.
- **Always write `lang="en"` on EPUB roots.** It is more accessible by default,
  but it changes every existing export's bytes. Left for a separate decision.

## Implementation

| Part | Where |
| --- | --- |
| D1 | `frontend/react/src/ui/MarkdownEditor.tsx`; test `src/ui/__tests__/MarkdownEditor.lang.test.tsx` |
| D2, D3 | `backend/typescript/src/features/documents/render.ts`; test `test/adr0914-export-language-and-alt.test.ts` |

The host's own documents export does not pass a language yet. A document has no
content-language field; adding one is a separate product decision. Book AI calls
the writers directly.

## Checklist

- [x] D1–D3 with tests
- [ ] Tell Book AI the PR number, so it can drop its EPUB patch and the DOCX limitation
