# Front-page story — CMS content

`front-page-story.sections.json` is the home page as typed CMS sections (the
`Section` model in `frontend/react/src/features/cms/cmsClient.ts`), base
locale `en` with `es`, `fr` and `pt-BR` overlays. It is the **publishable twin
of the system-site seed**: `DEFAULT_SECTIONS` in
`backend/typescript/src/host/systemSite.ts` is the same content, and
`backend/typescript/test/front-page-story-sections.test.ts` fails if the two
differ, or if either loses a field to CMS validation, or if either contains a
gated claim phrase. The SPA fallback (`buildDefaultSections` in
`features/site/FrontPage.tsx`, copy in `features/site/i18n/*.ts`) tells the same
story, and `scripts/check-default-page-drift.mjs` pins its hero to the seed's.

The story runs: thesis + the run ledger → why the run matters → the BPMN/SMTP
history lesson → five guarantees of an open run → the paper's two-host result
and one honest caveat → what you can do in the app today → closing CTA.

## Do you need to publish it at all?

Usually not. The seed refreshes the live home page on deploy (`SEED_VERSION` 7)
**only while that page has never been human-edited**, i.e. while its
`updatedBy` is still `system`. A human edit freezes the page and the seed never
touches it again.

- **Unedited install:** deploy the code. The new story goes live on boot. Don't
  publish this file.
- **Human-edited install:** the seed will not refresh it, so publish this file
  (below).

Whether app.openwop.dev's page is human-edited is **unknown without operator
access**. Its live copy matches the previous seed (version 6) word for word,
which is consistent with never having been edited, but that isn't proof. To
check, read the page and look at `updatedBy`:

```bash
curl -s -H "Authorization: Bearer $SUPERADMIN_TOKEN" \
  https://app.openwop.dev/v1/host/openwop-app/cms/orgs/host-site/pages/by-slug/home |
  jq '.page.updatedBy'     # "system" ⇒ unedited: the deploy refreshes it
```

## Before you publish

**Deploy the code first.** The page uses the hero visual `run` and the columns
layout `rows`. An older backend quietly rewrites them: `visual` is dropped, so
the page falls back to the workflow schematic, and `layout` becomes `cards`.
An older frontend can't draw either one.

## Publish (superadmin, host-site org)

In the UI, go to Admin → Content → CMS, choose the **Front page** scope, open
`home`, and swap the sections. Or use the API. The system site has no org to
review within, so a superadmin's PATCH edits the published page in place.
Publishing this way also counts as a human edit, so the seed stops refreshing
the page from then on:

```bash
BASE=https://app.openwop.dev/v1/host/openwop-app/cms/orgs/host-site
AUTH="Authorization: Bearer $SUPERADMIN_TOKEN"

# 1. Find the page and its current version (and keep this response as a backup)
curl -s -H "$AUTH" "$BASE/pages/by-slug/home" > home-before.json
PAGE_ID=$(jq -r '.page.pageId' home-before.json)
VERSION=$(jq -r '.page.version' home-before.json)

# 2. Replace the sections, pinned to that version
jq --argjson v "$VERSION" '{sections: .sections, expectedVersion: $v}' \
  docs/site/front-page-story.sections.json |
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  --data @- "$BASE/pages/$PAGE_ID"
```

Then open `/` and check it in each language: switch the public language picker, or
send `Accept-Language: es` / `fr` / `pt-BR`.
The `fr` overlay only serves if `fr` is in the site's content-language
settings. If it isn't, French visitors get the English base.

**Rollback:** `GET $BASE/pages/$PAGE_ID/versions`, then
`POST $BASE/pages/$PAGE_ID/restore/<versionId>`. You can also PATCH the saved
`home-before.json` sections back.

## Demo-only links

This file links to `https://openwop.dev` (hero secondary CTA) and to the
OpenWOP paper. That is correct for app.openwop.dev. **Do not publish it
unchanged on a white-label install** (ADR 0196 Gate A). There, remove
`ctaLabel2`/`ctaUrl2` from the hero and its overlays, and remove the last
paragraph of the `sec:story-proof` text. The SPA fallback already does this
through `useDemoMode()`. The seed does **not** demo-gate these links, and
neither did the previous seed. An install that seeds the system site gets them
on an unedited home page, and that is not a change this branch introduces.
