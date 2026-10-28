# ADR 0937 — A pack node's palette text can be localized (`x-localizations`)

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream candidate SRV-2 (`bookai/docs/upstream-proposals.md`,
`bookai/docs/assessments/LOCALIZATION-ASSESSMENT.md`). My user approved it on
2026-10-19 ("proceed with your recommendations": SRV-2 as an `x-` localized field).

A node-pack manifest gives each node one `label` and one `description`. The
builder palette shows both to authors (`GET /host/openwop-app/node-catalog` →
`builder/palette/catalogRegistry.ts`), so a Portuguese-speaking author sees Book
AI's nodes in English, however well the pack's own UI is translated. Book AI
grades this row D in its localization assessment, and it matters only because
this host does show manifest text to authors.

The spec already has the pattern for this. Localized content (`i18n.md`
§Localized content, RFC 0103 §C, RFC 0206) is base data plus a sparse
`localizations` map keyed by BCP-47 tag, resolved exact → script family →
language family → base. This host implements that chain once
(`host/i18n/resolveSection.ts`), for CMS sections and localized entity values.

## Decision

- **D1 — the field.** A manifest node entry may carry
  `x-localizations: { "<tag>": { label?, description? } }`.
  - `PackNode` already admits `x-` keys (the RFC 0138 hatch, as `x-ports` and
    `x-requiresFeatureSurfaces` use), so this is a host extension and makes no
    wire claim. It needs no RFC.
  - `readNodeLocalizations` keeps only well-formed tags (the `ll[-Ssss][-RR]`
    shape) and non-empty strings (label ≤ 120 characters, description ≤ 2000).
- **D2 — one resolution chain.** `GET /host/openwop-app/node-catalog` resolves
  each node's text for the reader's most-preferred `Accept-Language` tag, through
  `resolveLocalizedValues`. That is the same chain CMS sections use, and the
  overlay is shallow, as for sections.
  - To report the served locale without a second chain, `resolveSection` now
    delegates to an exported `matchedLocalizationTag`. Its behaviour is unchanged:
    the 107 localization, CMS, content and catalog test files pass.
- **D3 — one locale per response, named honestly.**
  - The overlay map is never served.
  - `Content-Language` is the tag that was actually used (`pt` for a `pt-PT`
    reader of a `pt` overlay), and only when every localized node used the same
    one. Otherwise, and when nothing was localized, it is omitted (`i18n.md`
    §Accept-Language, SHOULD).
  - `Vary: Accept-Language` is always set.
- **D4 — model-facing catalogs are unchanged.** The workflow-author catalog and
  the schema responder project nodes field by field, so they keep the pack's own
  text, and translations never enter a model prompt.

## Alternatives weighed

- **Widen the spec's `label`/`description` to localized strings.** Every manifest
  reader would then have to accept an object where a string was guaranteed. That
  is a breaking change and needs an RFC for something one host shows. The `x-`
  field is additive, and it can be promoted later by an RFC if other hosts want
  it.
- **Translate in the frontend from a key the pack declares.** Packs would then
  need to ship strings into the SPA's catalogs, which is the opposite of
  feature-owned text.
- **Serve every overlay and let the SPA pick.** That grows the response with
  locales nobody asked for, and puts the resolution chain in a second place.

## Trade-offs

- The palette loads the catalog once per session (`loadDynamicCatalog`), so after
  a mid-session language switch the new labels appear on the next load. A
  re-fetch on `languageChanged` is the follow-up below.
- The base locale of pack text is the host default (`OPENWOP_I18N_DEFAULT_LOCALE`,
  default `en`). A pack written in another language would need a declared base
  locale. No pack needs one yet.

## Implementation

| Part | Where |
| --- | --- |
| D1 | `backend/typescript/src/host/nodeCatalogBuilder.ts` (`readNodeLocalizations`, `CatalogNode.localizations`) |
| D2 | `src/host/i18n/resolveSection.ts` (`matchedLocalizationTag`); `nodeCatalogBuilder.ts` (`localizeCatalogNode`) |
| D3 | `src/routes/nodeCatalog.ts` |
| Tests | `backend/typescript/test/adr0937-pack-node-text-localizations.test.ts` |

The test is at route level, over a temp pack:

- `pt-BR` takes the exact overlay;
- `pt-PT` falls back to `pt`, with `Content-Language: pt`;
- no header, or `de-DE`, gets the base and no `Content-Language`;
- the overlay map is not served;
- the parser's edge cases;
- `zh-Hant-TW` takes a script overlay over `zh`.

Each was checked by sabotage:

| Sabotage | Result |
| --- | --- |
| The route skips localization | 2 red |
| The chain resolves exact tags only | 2 red |

## Checklist

- [x] D1–D4 with tests
- [ ] Book AI: add `x-localizations` to its node entries (pt-BR, and the en-XA pseudo-locale it grades with)
- [ ] Frontend: re-fetch the node catalog on a UI language change
