# ADR 0965 — Content is never rewritten by the secret scrub

Status: implemented

## Context

`host/redactSecrets.ts` `scrubSecretShaped` replaces credential shapes (`sk-`,
`AKIA`, `ghp_`, `xox?-`) AND any `[A-Za-z0-9_-]{40,}` run with
`[REDACTED:secret-shaped]`. It exists to keep secrets out of logs, error text
and model context, where a false positive costs nothing.

Every helper in `host/boundedStrings.ts` (`cleanString`, `optionalCleanString`,
`cleanTagList`, `safeUrl`) runs it. Features used those helpers for text that is
PUBLISHED or SENT, so audience content was changed silently, with a 200:

- signed media URLs;
- long slugs (live: kicktodo.com's canonical URL has been stored as the marker
  since 2026-09-19, PR #4992);
- hashes;
- UTM values;
- base64 `data:` favicons;
- every 40+ character run in exported app source.

build-0907-ads found the same class in ADR 0953 P0 and refused there.
`projects` (`refuseSecretShaped`) and `team-intent-ledger` (`strictText`) had
already moved to "refuse, never rewrite", each with its own copy of the rule.

## Decision

There are two lanes, and one module (`host/boundedStrings.ts`) owns both.

1. **Log/label lane: `cleanString` and friends, unchanged.** It covers names,
   labels, ids, notes, prompt inputs (brand voice and positioning), kb ingest,
   comments, profiles and other internal text. The scrub's regex is untouched, so
   #4992's change to it does not conflict.
2. **Content lane: `cleanContent`, `optionalCleanContent`, `contentUrl`.**
   - These trim and cap but never rewrite.
   - A credential shape is a typed refusal: `findCredentialShape` covers `sk-`,
     `AKIA`, `ghp_`, `github_pat_`, `xox?-` and `AIza`. The refusal is
     `validation_error`, 400, `details: { field, reason: 'secret_shaped', kind }`.
     The message names the kind, never the token.
   - The generic 40+ character run is allowed. On content it is almost always a
     hash, a slug or a token inside a link, and refusing it would refuse
     legitimate copy.
   - `contentUrl` keeps `safeUrl`'s scheme screen.
3. **Strict internal lane: `refuseIfScrubbed`.** It refuses anything the log scrub
   would change. The projects charter and the team ledger now share it instead of
   keeping two copies.
4. **App-builder export:** the export is refused, naming the file, when generated
   source holds a credential shape. Source is no longer rewritten. This keeps the
   export-security invariant (a typed credential never lands in downloadable or
   pushed source) without corrupting URLs and integrity strings.

## Paths moved to the content lane

| Feature | Fields |
|---|---|
| cms | Section text fields (hero, rich text, cards, lists, columns, comparisons, faq, quotes, video, `fields` values, plan and chat pictures), CTA/button/card links (`safeLink`), video media URLs, page title |
| publishing | SEO `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `canonicalUrl` |
| funnels | UTM rule key and value (a scrubbed value never matched) |
| commerce | Product name, description, attributes, variant names |
| host/customFields | String values (served on the public storefront) |
| crm booking links | Title, description, location, video link |
| podcasts | Show title, author, description, category, subcategory, owner fields; episode description |
| creative-briefs | Render copy (headline, body, CTA) |
| campaign-brief | Angle claim, positioning lens, hook text (per-variant refusal in the hook bank), VoC quote, value prop, CTA strategy |
| brand | Identity copy (wordmark, product name, tagline, footer, copyright, instance/assistant names, document title), asset/fonts/home/repo URLs, including `data:` favicons |
| marketplace | Review body |
| app-builder | Export (refuse, never rewrite) |

## Alternatives weighed

- **Refuse the generic run on content too** (the projects precedent). Rejected:
  it refuses signed URLs, hashes and long slugs, which are legitimate published
  copy. The precedent's text is internal planning text, where that trade-off is
  different.
- **Allow everything on content.** Rejected: a pasted live key on a public page is
  the case the scrub was written for. Refusing it is honest; rewriting it is not.
- **Per-feature helpers.** Rejected: that is the drift this removes.

## Residue

- Silent truncation at `max` is the same class of problem (content changed without
  a word) and is not addressed here.
- Values that were already stored as the marker do not heal; they must be saved
  again.
- `notifications/notify.ts` uses a different scrubber (`sanitizeFreeText`) on sent
  notification text. Not in scope.
- `podcasts` `imageMediaRef` and the remaining id-shaped fields stay on the log
  lane. An opaque media ref over 40 characters would still be rewritten there;
  it needs `cleanOpaqueToken`, as a follow-up.

## Implementation record

Recovery review correction (2026-10-24): validate every booking content field
before reserving its public slug, so a refused save consumes no slug. Refusal
diagnostics also hide a credential-shaped field name or export path. The log
scrub retains main's readable-word-slug exemption. Added regression witnesses
for slug reuse after refusal and diagnostic labels; recovery validation pending.

| Phase | Commit / PR | Tests |
|---|---|---|
| 1 | branch `fix/content-secret-scrub` (PR filled on open) | `test/content-lane-secret-scrub.test.ts`: both lanes, plus one pair per migrated path (a long run is kept byte for byte; an `sk-` key is a 400 `secret_shaped` that does not echo the key). `test/crm-org-route.test.ts` flipped: a custom-field credential is refused, a hash is kept. |
