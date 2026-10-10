# ADR 0813 — CMS prose blocks, post-aware prerender, and the launch blog post

Status: Accepted (implemented)

Related: ADR 0009 (CMS content safety), ADR 0027 (system site), ADR 0384
(server-side section HTML, the golden fixture), ADR 0391 (blog posts),
ADR 0392 (`systemSiteDocs.ts`, the seed pattern this follows).

## Context

The first long-form post for the app.openwop.dev blog, "10x Your Company = Your
Team + AI Agents", did not fit the CMS in three places:

1. **`richText` had no block structure.** The safe markdown subset was
   paragraphs plus inline `**bold**` / `*italic*` / `` `code` `` / links. The
   post depends on bullet lists, numbered lists and `###` subheadings. A list
   rendered as one paragraph full of literal dashes.
2. **A post had no `<h1>` and no Article semantics for crawlers.** The SPA's
   `BlogPostPage` draws the title as post chrome, not as a section, so the
   prerender (built from sections only) emitted a body with no `<h1>`. Its
   JSON-LD typed a page as `Article` only when it had a `hero` section, so a
   post was a `WebPage` with no `datePublished`.
3. **There was no way to put a post on the deployment's own blog in code.** The
   system site (`host-site`) has no members and no Media library UI, and its
   pages and docs are seeded at boot.
4. **The CMS editor could not make a page a post or set its byline.** The API
   accepted `kind`, `category` and `authorId`, but the editor showed none of
   them, and it cannot know the caller's backend user id (an OIDC bind may
   rekey it), so it could not send a correct `authorId` anyway.

## Decision

1. **A prose block grammar for `richText`**, still with no raw-HTML path.
   Blocks are blank-line separated. A lone `### ` line is a subheading (`<h3>`).
   A block whose every line starts `- ` / `* ` is a bullet list, `1. ` / `1) `
   a numbered list, `> ` a quote. Anything else is a paragraph, exactly as
   before. The inline grammar inside a block is unchanged. The frontend parser
   is `features/cms/proseBlocks.ts`; the server mirror is `paragraphsHtml` in
   `publishing/sectionHtml.ts`. They cannot share code, so the same cases are
   pinned on both sides (`proseBlocks.test.tsx`,
   `adr0384-section-html.test.ts` "ADR 0813 sectionHtml — prose blocks").
2. **Posts are articles to crawlers.** The public page projection gains two
   additive, posts-only fields, `kind: 'post'` and `publishedAt`. The page
   prerender adds the title as `<header><h1>` when a post has no hero, and the
   JSON-LD types every post as `Article` with `datePublished`.
3. **The launch post is seeded as a draft** by `host/systemSiteBlog.ts`, the
   `systemSiteDocs.ts` sibling: a deterministic page id, a `SEED_VERSION`, and
   never-clobber. Unlike the docs, it is **never auto-published**: it carries
   `[TODO: …]` markers for the author's own stories and numbers, and an
   operator publishes it from the CMS. The seed refreshes only while the page is
   still system-authored and unpublished. Its two diagrams are PNG media rows
   on the system-site tenant (SVG stays blocked by the upload allowlist),
   referenced by serve token, and the second is the post's social card
   (`ogImageToken`).
4. **Post settings in the editor.** Below the tags, a non-translator editor can
   mark the page a blog post, set its category, and set the byline to
   themselves. The page create and patch routes accept `authorId: "me"` and
   resolve it to the caller's user id; `null` clears the byline. The editor
   sends these fields only when they changed.

## Consequences

- Existing content changes rendering only where a block's every line already
  started with `- `, `* `, `1. ` or `> `, or a block was a lone `### ` line.
  Those rendered as literal markdown before; they now render as the structure
  they spelled.
- The byline of a seeded post falls back to `createdBy` (`system`) until an
  operator presses "Set me as the author" in the editor before publishing.
- The diagram bytes live in `host/seed-data/blog/launchPostDiagrams.ts` as
  base64 (about 200 KB). Re-export and regenerate it rather than hand-editing.
