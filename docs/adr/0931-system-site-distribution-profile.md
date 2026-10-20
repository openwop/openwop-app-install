# ADR 0931 — System-site distribution profile: the public site's identity and its optional seeds are configurable

Status: implemented (in the PR that adds this file)

## Context

MyndHyve is a white-label distribution of this app (an overlay on the install
bundle, the same shape as Book AI). Its public site runs on the reserved
system-site org (ADR 0027). Two things on that site were hard-wired to
OpenWOP, and a distribution could not change them without forking host code
(MyndHyve port recommendation R5; port sweep `sweep-site-content.md` §0 item 5
and §2):

- **The self-description.** `host/systemSiteProfile.ts` (ADR 0824 D3/D5)
  returns `siteName: 'OpenWOP'`, Organization `sameAs` openwop.dev and GitHub,
  a SoftwareApplication `isBasedOn` openwop.dev, the hero-film VideoObject and
  an OpenWOP `/llms.txt` preamble. It is demo-gated, so a non-demo install gets
  no profile at all. A distribution can drop OpenWOP's identity by turning
  demo mode off, but it cannot state its own.
- **The seeds.** At boot the host seeds OpenWOP content onto the system site:
  the launch blog post draft (`systemSiteBlog.ts`, ADR 0813), the docs corpus
  (`systemSiteDocs.ts`, ADR 0392), the page titles and descriptions
  (`systemSiteSeo.ts`, ADR 0824 D2) and the published About / Roadmap /
  Changelog / Support / Claude Code pages (`marketingContentPages.ts`). Each
  seed already stops refreshing a page once a person edits it. But a
  distribution that will never want the OpenWOP post or docs still gets them
  written on a fresh install, and has to unpublish or delete them by hand.

The existing `OPENWOP_PUBLIC_SITE_NAME` override sets only og:site_name and
the JSON-LD names. It cannot set `sameAs`, the home structured data or the
llms.txt head.

## Decision

- **D1: `OPENWOP_SYSTEM_SITE_PROFILE`.** Inline JSON (a value starting with
  `{`) or a path to a JSON file:

  ```json
  {
    "siteName": "MyndHyve",
    "organizationSameAs": ["https://myndhyve.ai"],
    "homeJsonLd": [{ "@type": "SoftwareApplication", "name": "MyndHyve" }],
    "llms": { "title": "MyndHyve", "summary": "…", "body": "…" }
  }
  ```

  - Only `siteName` is required (≤ 120 characters). `organizationSameAs` must
    be http(s) URLs. Each `homeJsonLd` block must be an object with an
    `@type`; `@context` defaults to `https://schema.org`. `llms`, when present,
    needs a non-empty `title`, `summary` and `body`.
  - When set and valid, it is the system site's profile **in or out of demo
    mode**. It is the distribution describing itself, not a showcase claim, so
    the ADR 0196 demo gate does not apply. The OpenWOP VideoObject is not
    added; a distribution that has a film adds its own block.
  - `homeJsonLd` is emitted on the home page only. `llms` is the `/llms.txt`
    head; without it the generic head is used.
  - **Invalid means no profile, never OpenWOP's.** Bad JSON, an unreadable
    file or a failed check logs `system_site_profile_invalid` with the reason,
    and the site renders as a non-demo install does (org name, generic llms
    head). Falling back to the built-in profile would make a misconfigured
    distribution claim to be OpenWOP.
  - `OPENWOP_PUBLIC_SITE_NAME` still wins over `siteName`, as it already wins
    over the built-in profile (prerender precedence unchanged).
  - The value is parsed once per distinct string, and a file is read once.
- **D2: `OPENWOP_SYSTEM_SITE_SEEDS_DISABLED`.** A comma list of `blog`, `docs`,
  `seo` and `marketing` (case and spaces ignored). A named seed's ensure
  returns before it writes anything. Unknown names log
  `system_site_seeds_disabled_unknown` once.
  - **Disabling never deletes.** Pages or SEO records a seed wrote on an
    earlier boot stay as they are; the operator unpublishes them in the CMS.
    This keeps the never-clobber rule intact in both directions: a seed never
    overwrites a person's edit, and turning a seed off never removes content.
  - **The home page seed (`systemSite.ts`) cannot be turned off.** Its ensure
    also creates the system-site org that every CMS route on it needs, and a
    person's edit already freezes it (`updatedBy !== 'system'`). A
    distribution writes its home page as a CMS edit.
- **D3: unset is byte-identical.** With neither variable set, every code path
  is the one that ran before: `systemSiteProfile` and `systemSiteLlmsPreamble`
  reach the same demo-gated branch, and each seed runs.

## Alternatives

- **A `distributions/<name>.json` field.** Distribution files are build
  identity for the feature catalog (ADR 0414), read by the SPA build and the
  deploy scripts, not by the backend at runtime. Site identity there would
  need a new backend reader. An environment value works for every deploy
  shape, and a distribution's deploy config can still set it.
- **Separate variables per field** (`…_SITE_NAME`, `…_SAME_AS`, `…_LLMS_TITLE`,
  …). The home JSON-LD is structured, so it needs JSON anyway. One value keeps
  the profile in one place.
- **Fall back to the OpenWOP profile on a bad value.** Rejected; see D1.
- **Delete seeded pages when a seed is disabled.** Rejected. It would remove a
  page a person may since have edited, and a destructive side effect of an
  environment change is the wrong default.
- **Make the marketing-page and SEO seeds follow the profile automatically**
  (skip them whenever a profile is set). Rejected: a distribution may want
  the profile and still keep the seeded pages as a starting point. The two
  switches are independent.

## Consequences

- A distribution sets its identity and drops the OpenWOP content with two
  environment values and no host fork.
- With the `docs` seed off, `/llms.txt` returns 404 until the distribution
  publishes at least one docs page, because the llms.txt door lists docs
  (ADR 0392). This is the existing behaviour of an install with no docs.
- The `seo` seed off means the home page has no seeded `PageSeo`, so its head
  falls back to the page title and first hero subheading until the
  distribution writes one in the CMS SEO panel.

## Implementation

| Part | Where |
| --- | --- |
| Profile and seed parsing | `backend/typescript/src/host/systemSiteConfig.ts` |
| Profile and llms head | `backend/typescript/src/host/systemSiteProfile.ts` |
| Seed switches | `systemSiteBlog.ts`, `systemSiteDocs.ts`, `systemSiteSeo.ts`, `marketingContentPages.ts` (each `doEnsure`) |
| Operator docs | `DEPLOY.md` § bot prerender knobs |
| Tests | `backend/typescript/test/adr0931-system-site-distribution-profile.test.ts` (the existing `public-site-aeo.test.ts` pins the unset OpenWOP output) |

## Open questions

- None blocking. The SPA's own head (`applySeo`) reads the same `PageSeo`
  records and is unaffected. A per-locale llms head is not needed while the
  llms.txt listing is base-locale only.
