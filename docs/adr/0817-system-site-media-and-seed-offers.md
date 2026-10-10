# ADR 0817 — the public site's Media library, and seed updates offered as versions

Status: Accepted (implemented)

> **RENUMBERED 2026-10-05 (0815 → 0817).** This ADR merged as 0815 in #4388, but 0815 had already been reserved (2026-10-04 22:02) and merged by the feature-loop row-12 orgs ADR (`0815-orgs-residual-subject-owner-tier-and-removal.md`, #4389). Two files claiming one number red `check-adr-refs` on main for every branch. Reserve with `node scripts/check-adr-refs.mjs --reserve <slug>` and push the reservation before using a number. Citations in this ADR's own files were updated; no decision text changed.

Related: ADR 0007 (Media library), ADR 0027 (system site), ADR 0206 B1/B4
(page versions, the media picker), ADR 0236 (page experiments), ADR 0593 §C3
(version `origin`), ADR 0813 (the launch post seed).

## Context

Finishing the ADR 0813 launch post exposed two gaps on the system site, the
reserved `host-site` org a super admin edits as "Front page (public site)":

1. **No Media library.** The CMS routes authorize that org through
   `requireCmsScope` (super admin, not membership), but the media routes used
   the plain `requireOrgScope`, so they answered 404 there. The CMS editor
   skipped the asset load for that scope and the picker could not upload. The
   only way to change one of the post's diagrams was a code change.
2. **Seed updates went silent after the first save.** The seed's never-clobber
   rule is right: a person's edit must not be overwritten. But a bumped
   `SEED_VERSION` on an edited post was dropped without a trace, so a
   corrected draft from code could never reach the author.

## Decision

1. **The media routes use `requireCmsScope`.** The system site gets a Media
   library under the same authority as its pages: a super admin reads and
   writes it, and every other caller gets the 404 the CMS routes give. Real
   orgs still go through `requireOrgScope`, unchanged. The CMS editor loads the
   system site's assets like any org's, so its picker lists and uploads
   images. The Media Library page offers "Front page (public site)" as a scope
   to a site admin (the same super-admin site-config probe the CMS uses).
2. **A seed update on an edited page is offered as a version.** When the seed
   would write but may not, it records the new content as a page version with
   `origin: 'seed'` (`offerSeedVersion`). The page is untouched. The editor's
   history labels the row "Seeded update"; Diff compares it with the draft and
   Restore adopts it into the draft (never published). The offer's sections
   go through `validateSections`, because Restore copies a snapshot verbatim.
   An identical offer is not recorded twice.
3. **An offer is not a capture.** `snapshotPage`'s distinct-content dedupe
   skips `'seed'` rows, and an experiment variant may not point at one
   (409 `seed_offer`), gate or no gate.

The launch post's seed (`systemSiteBlog.ts`) uses the offer path. The home
page and docs seeds keep their behavior; they can adopt `offerSeedVersion`
when they need it.

## Consequences

- An author who has edited the launch post gets every later code revision of
  it as a "Seeded update" in History, and chooses whether to take it.
- Restoring an offer replaces the draft's title and sections wholesale. To
  merge, compare with Diff first and copy what you want.
- Diagrams and other images on the public site can be uploaded and swapped in
  the editor. Images uploaded there are served by token like any org's.
