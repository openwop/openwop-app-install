/**
 * Publishing & SEO routes (ADR 0012). Two surfaces:
 *   - AUTHED  /v1/host/openwop-app/publishing/orgs/:orgId/pages/:pageId/seo
 *       (requireCmsScope — GET workspace:read, PUT workspace:write; this preserves
 *       normal org RBAC while admitting the superadmin-owned system site)
 *   - PUBLIC  /v1/host/openwop-app/public/:orgId/*  (NO auth — org→tenant from URL,
 *       published-only). The `/v1/host/openwop-app/public` prefix is on
 *       PUBLIC_PATH_PREFIXES (auth.ts).
 *
 * ADR 0027: Publishing is always-on — no toggle gate. The authed SEO routes keep
 * their org-scoped RBAC; the public surface is gated only by the CMS `published`
 * status (the per-tenant toggle is gone — Sharing covers private/draft access).
 *
 * @see docs/adr/0012-publishing-seo.md · docs/adr/0027-cms-front-page-and-always-on-content.md
 */

import { isProtocolClient, v2MountedRootPrefixes } from '../../middleware/protocolVersion.js';
import { readFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { throttleLog } from '../../observability/logSampler.js';
import { publicBaseUrl } from '../featureRoute.js';
import { requireCmsScope } from '../cms/cmsScope.js';
import {
  isBotUserAgent,
  prerenderBlogIndex,
  prerenderDisabled,
  prerenderPageCached,
  prerenderTtlSeconds,
} from './prerenderService.js';
import {
  blogFeedXml,
  feedRss,
  getSeo,
  listPublicBlog,
  listPublicNavPages,
  publicPageBySlug,
  putSeo,
  robotsTxt,
  sitemapXml,
  negotiatePublicLocale,
} from './publishingService.js';
import { pageMarkdown } from './sectionMarkdown.js';
import { sendError } from '../../middleware/errorEnvelope.js';

export function registerPublishingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // Rate-limited observability for the new crawler-facing HTML routes (SEO-3):
  // a bounded outcome key set + suppressed count, so the bot/human split, the
  // 404 rate, and the SPA-shell fallback rate stay visible without one line per
  // hit on a crawler-hammered path.
  const logDoc = (outcome: string): void => {
    const t = throttleLog(`publishing_doc_${outcome}`);
    if (t.emit) log.info('publishing_doc_serve', { outcome, suppressed: t.suppressed });
  };

  // ── authed: per-page SEO metadata ──
  const SEO = '/v1/host/openwop-app/publishing/orgs/:orgId/pages/:pageId/seo';

  app.get(SEO, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      res.json({ seo: await getSeo(tenantId, orgId, req.params.pageId) });
    } catch (err) { next(err); }
  });

  app.put(SEO, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json({ seo: await putSeo(tenantId, orgId, req.params.pageId, user.userId, body) });
    } catch (err) { next(err); }
  });

  // ── public: the published site (NO auth; org→tenant; toggle-gated) ──
  const PUB = '/v1/host/openwop-app/public/:orgId';

  // ADR 0486 — the public-site NAV list (published pages, slug + title) so the
  // public shell menu can reach EVERY published page. Registered before
  // `/pages/:slug` (distinct exact path; the `:slug` route needs a segment).
  app.get(`${PUB}/pages`, async (req, res, next) => {
    try {
      const pages = await listPublicNavPages(req.params.orgId);
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.json({ pages });
    } catch (err) { next(err); }
  });

  // R2-D12 (UX_UPGRADE-docs) — the `.md` door: the whole published page as one
  // markdown document (the Vercel/Stripe append-`.md` convention; agents are
  // the majority docs consumer). Registered BEFORE `/pages/:slug` — `:slug`
  // matches dots, so the generic route would swallow `x.md` (the
  // feed.xml-before-/blog ordering lesson). Same negotiation as the JSON read;
  // an unrenderable section ⇒ 404, never a partial document.
  app.get(`${PUB}/pages/:slug.md`, async (req, res, next) => {
    try {
      const { page, locale } = await publicPageBySlug(req.params.orgId, req.params.slug, publicBaseUrl(req), req.headers['accept-language'], undefined);
      const md = pageMarkdown(page, publicBaseUrl(req));
      if (md === null) { sendError(res, 404, 'not_found', 'That page has no Markdown rendering.'); return; }
      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      // R2R-3 — authored text verbatim on a public boundary: declare + pin the
      // type (the ui-plugins nosniff precedent; markdown renders inert anyway).
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('text/markdown').send(md);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/pages/:slug`, async (req, res, next) => {
    try {
      // ADR 0236 (D1) — optional `?vk=` visitor key (the analytics beacon
      // sessionKey) opts this read into consent-gated experiment assignment.
      // Absent/oversized ⇒ exactly the plain published page.
      const vk = typeof req.query.vk === 'string' ? req.query.vk : undefined;
      const { page, locale } = await publicPageBySlug(req.params.orgId, req.params.slug, publicBaseUrl(req), req.headers['accept-language'], vk);
      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.json(page);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/sitemap.xml`, async (req, res, next) => {
    try {
      const xml = await sitemapXml(req.params.orgId, publicBaseUrl(req));
      res.type('application/xml').send(xml);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/robots.txt`, async (req, res, next) => {
    try {
      const txt = await robotsTxt(req.params.orgId, publicBaseUrl(req));
      res.type('text/plain').send(txt);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/feed.rss`, async (req, res, next) => {
    try {
      const rss = await feedRss(req.params.orgId, publicBaseUrl(req));
      res.type('application/rss+xml').send(rss);
    } catch (err) { next(err); }
  });

  // ── ADR 0391 (a) — the public blog surface (published posts only) ──
  const qstr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 120 ? v : undefined);

  // The blog-scoped, author-enriched RSS (registered BEFORE `/blog` so the exact
  // path wins). Content-type + cache posture match the generic `feed.rss` route.
  app.get(`${PUB}/blog/feed.xml`, async (req, res, next) => {
    try {
      const rss = await blogFeedXml(req.params.orgId, publicBaseUrl(req));
      res.type('application/rss+xml').send(rss);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/blog`, async (req, res, next) => {
    try {
      const filter = {
        ...(qstr(req.query.tag) ? { tag: qstr(req.query.tag)! } : {}),
        ...(qstr(req.query.category) ? { category: qstr(req.query.category)! } : {}),
        ...(qstr(req.query.author) ? { author: qstr(req.query.author)! } : {}),
      };
      // R2-BLOG-3 — forward the reader's locale preference so excerpts/reading
      // estimates localize like the page view does (the client has sent
      // Accept-Language since the A1 gap fix; the server dropped it here).
      // ADR 0668 D3 (CMSLWF-14) — this response varies by `Accept-Language` (the excerpt
      // and the reading estimate are localized per post), and declared neither `Vary` nor
      // `Content-Language` — alone among the siblings in this file. `Content-Language` is
      // the locale actually USED, never an echo of the request.
      const { posts, locale } = await listPublicBlog(req.params.orgId, filter, req.headers['accept-language'] ?? null);
      res.setHeader('Content-Language', locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.json({ posts });
    } catch (err) { next(err); }
  });

  // ── ADR 0384 — crawler prerender ──────────────────────────────────────────
  //
  // Two doors, one renderer:
  //   1. `${PUB}/prerender/:slug` — the CUSTOM-DOMAIN door (customDomain.ts
  //      rewrites `/` and `/p/:slug` on a bound host here). Serves prerendered
  //      semantic HTML to ALL clients: no SPA shell exists on customer
  //      hostnames, so bots AND humans get the semantic document (strictly
  //      better than the pre-0384 uniform 404). Kill-switched → 404 (reverts
  //      to the pre-0384 behavior).
  //   2. `/` + `/p/:slug` — the PLATFORM-ORIGIN door (reached only once the
  //      Firebase Hosting document-rewrite is flipped at deploy time; see
  //      DEPLOY.md). UA-branched: bots get the prerender; humans get the SPA
  //      shell (OPENWOP_SPA_SHELL_FILE) — with `Vary: User-Agent` so no cache
  //      can serve one audience's document to the other.

  app.get(`${PUB}/prerender/:slug`, async (req, res, next) => {
    try {
      if (prerenderDisabled()) {
        sendError(res, 404, 'not_found', 'Prerendering is disabled on this host.');
        return;
      }
      const out = await prerenderPageCached(
        req.params.orgId, req.params.slug, publicBaseUrl(req),
        req.headers['accept-language'], process.env.OPENWOP_PUBLIC_SITE_NAME,
      );
      if (out === null) {
        // Unrenderable (unknown future section type): honest-off. On a custom
        // domain there is no SPA to fall back to — uniform 404 over a broken page.
        logDoc('prerender_unrenderable_404');
        sendError(res, 404, 'not_found', 'That page cannot be prerendered.');
        return;
      }
      logDoc('prerender_served');
      res.setHeader('Content-Language', out.locale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.setHeader('Cache-Control', `public, max-age=${prerenderTtlSeconds()}`);
      res.type('html').send(out.html);
    } catch (err) { next(err); }
  });

  // The blog-INDEX prerender (ADR 0391 / custom-domain `/blog`): a semantic list
  // over `listPublicBlog` (title / date / byline / excerpt links). Same
  // cache/Vary/kill-switch posture as the page prerender. Registered before
  // `/blog/:slug`-style routes are irrelevant here (this is a distinct literal
  // `/blog/prerender` under the public prefix; the page prerender owns `:slug`).
  app.get(`${PUB}/blog/prerender`, async (req, res, next) => {
    try {
      if (prerenderDisabled()) {
        sendError(res, 404, 'not_found', 'Prerendering is disabled on this host.');
        return;
      }
      // PUB2-B2 — this response has always advertised `Vary: Accept-Language`
      // (below), while the renderer never received the header and stamped a
      // hardcoded `lang="en"`. The claim came first; now it is true.
      const html = await prerenderBlogIndex(
        req.params.orgId,
        publicBaseUrl(req),
        process.env.OPENWOP_PUBLIC_SITE_NAME,
        req.headers['accept-language'],
      );
      logDoc('blog_index_prerender');
      // ADR 0668 D3 — this route has advertised `Vary: Accept-Language` since PUB2-B2 and
      // never declared WHICH language it returned. `prerenderBlogIndex` stamps `<html lang>`
      // from the same negotiation, so the header and the document now agree.
      const blogLocale = await negotiatePublicLocale(req.params.orgId, req.headers['accept-language'] ?? null);
      if (blogLocale) res.setHeader('Content-Language', blogLocale);
      res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
      res.setHeader('Cache-Control', `public, max-age=${prerenderTtlSeconds()}`);
      res.type('html').send(html);
    } catch (err) { next(err); }
  });

  // Platform-origin document paths. The org is operator-configured (the same
  // org the SPA's VITE_PUBLIC_SITE_ORG_ID points at); `/` serves the published
  // `home` slug (ADR 0027).
  const documentHandler = (slugOf: (req: Request) => string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Bot vs human differ at the same URL — Vary is mandatory (a shared
        // cache must never serve the bot document to a human or vice versa).
        res.setHeader('Vary', 'User-Agent, Accept-Language, Accept-Encoding');
        const siteOrg = process.env.OPENWOP_PUBLIC_SITE_ORG_ID?.trim();
        const wantBot = !prerenderDisabled() && siteOrg && isBotUserAgent(req.headers['user-agent']);
        if (wantBot) {
          const out = await prerenderPageCached(siteOrg, slugOf(req), publicBaseUrl(req), req.headers['accept-language'], process.env.OPENWOP_PUBLIC_SITE_NAME);
          if (out !== null) {
            logDoc('bot_prerender');
            res.setHeader('Content-Language', out.locale);
            // no-store, NOT public: the Firebase Hosting CDN in front of this
            // route STRIPS Vary (observed: `vary: x-fh-requested-host,
            // accept-encoding`), so a public-cached response at this UA-branched
            // URL would be served across audiences — a bot document to humans
            // (or the shell to crawlers) for up to the TTL. The backend's own
            // prerender LRU (prerenderPageCached) absorbs the recompute cost;
            // the custom-domain door (no Firebase CDN, no UA branch) keeps its
            // public caching.
            res.setHeader('Cache-Control', 'no-store');
            res.type('html').send(out.html);
            return;
          }
          // fall through: unrenderable → serve the shell (the SPA can render it)
        }
        const shell = await spaShellHtml();
        if (shell !== null) {
          logDoc(wantBot ? 'bot_shell_fallback' : 'human_shell');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.type('html').send(shell);
          return;
        }
        // No shell configured: this route is only reachable once the hosting
        // rewrite is flipped, which DEPLOY.md gates on configuring the shell.
        logDoc('no_shell_404');
        sendError(res, 404, 'not_found', 'No SPA shell is configured on this host.');
      } catch (err) { next(err); }
    };

  app.get('/', documentHandler(() => 'home'));

  // ── ADR 0631 — the major-2 path space and the SPA share the origin's roots ──
  // Hosting routes every `spec/v2/path-manifest.json` root to this backend
  // (it cannot key on a request header). A request naming a major never
  // reaches here — the negotiator rewrote it onto `/v1` before any router. A
  // HEADERLESS request on one of these roots is therefore either a browser
  // navigating to an SPA page (`/agents/:id`, `/runs/:id` — the two roots the
  // SPA owns; the rest render the SPA's own 404) or a client that forgot the
  // header. The client keeps today's JSON 404 (a shell would be a lie to a
  // program); the browser gets the shell this feature already serves for `/`.
  // ONE shell owner (this file), ONE root list (the negotiator's derivation).
  // `no-store` because a CDN that served one branch to the other's client
  // would break both, and the Firebase CDN has been observed stripping Vary.
  const v2Roots = v2MountedRootPrefixes();
  app.get(v2Roots.flatMap((r) => [r, `${r}/*`]), async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ADR 0646 — ONE predicate decides whose request this is, shared with
      // the negotiator. It used to be restated here as two lines; two copies
      // of an authorization-adjacent decision drift, and the negotiator now
      // withholds the version header on exactly the branch this serves.
      if (isProtocolClient(req)) { next(); return; }
      const shell = await spaShellHtml();
      if (shell === null) { next(); return; }
      res.vary('Accept');
      res.setHeader('Cache-Control', 'no-store');
      logDoc('human_shell_v2_root');
      res.type('html').send(shell);
    } catch (err) { next(err); }
  });
  app.get('/p/:slug', documentHandler((req) => req.params.slug as string));
}

/** The SPA shell for human document requests on the platform origin (Phase 4).
 *  Two delivery modes (URL preferred — the Cloud Run image does NOT bundle
 *  `frontend/react/dist`, so a file path only works with a mounted volume):
 *    - OPENWOP_SPA_SHELL_URL — fetch the shell (Firebase Hosting's static
 *      `/index.html`; rewrites never apply to existing static files, so no
 *      loop) and cache it with a conditional TTL refresh
 *      (OPENWOP_SPA_SHELL_TTL_S, default 60 s). A refresh failure serves the
 *      last-good shell (stale beats broken).
 *
 *      **CORRECTION (2026-08-03).** This block used to claim the cache
 *      "SELF-HEALS the stale-asset-hash hazard". It heals only AFTERWARDS —
 *      during the TTL the hazard is live, and `/` is genuinely broken for
 *      anonymous visitors (Hosting prunes the old build's assets, so the
 *      cached shell points at a bundle that 404s into the SPA rewrite and
 *      comes back as `text/html`). Calling that self-healing hid a real
 *      outage; the TTL is now short and revalidation conditional so the
 *      window is ~60 s instead of ~5 min.
 *
 *      **CORRECTION (2026-08-08) — "the window is ~60 s" was ALSO false, and
 *      for a reason the TTL cannot express.** Measured in production: `/`
 *      served a pruned bundle for 16+ MINUTES, across repeated probes, and
 *      recovered only when new instances were forced. Cloud Logging for the
 *      window showed 10 `human_shell` lines and ZERO `spa_shell_fetch_failed`
 *      — the refresh had not failed, it had NEVER SETTLED.
 *
 *      Cause: the refresh was fire-and-forget, and Cloud Run runs this service
 *      with `cpu-throttling=true`, so after a response is flushed the instance
 *      gets ~no CPU and a detached continuation may never resume. The promise
 *      stayed pending, `shellRefreshing` was never cleared, and the old guard
 *      `(expired && !shellRefreshing)` then disabled EVERY later refresh for
 *      the life of that instance. One starved continuation = a permanently
 *      stale shell, with no error anywhere.
 *
 *      Fixed in two places, because either alone is insufficient:
 *        - the refresh is AWAITED (bounded by SHELL_REFRESH_AWAIT_MS) so the
 *          fetch finishes inside a request, the only place CPU is guaranteed;
 *        - an in-flight refresh older than SHELL_REFRESH_WEDGE_MS no longer
 *          blocks a new one, so a starved promise can never be permanent.
 *
 *      Why the tests missed it: Node in a test always has CPU, so the detached
 *      promise settled inside the 100 ms sleep the old cases used. They
 *      asserted a runtime the production host does not provide. The regression
 *      cases in `adr0384-shell-url.test.ts` now drive a NEVER-ANSWERING origin,
 *      which is the faithful shape.
 *
 *      NOT DONE, deliberately: validating the shell's referenced assets before
 *      caching. It does not fix this — the shell and its assets are consistent
 *      at fetch time and only go dangling when a LATER deploy prunes them — so
 *      it would add per-refresh cost and a new way to reject a good shell
 *      (against this module's "stale beats broken" posture) while leaving the
 *      actual window untouched. The window is closed by revalidating often,
 *      not by inspecting harder.
 *
 *      Note the client-side `vite:preloadError` reload in `frontend/react/src/
 *      main.tsx` does NOT cover this case and cannot: it ships inside the very
 *      entry bundle that fails to load, so it recovers stale LAZY chunks (a tab
 *      left open across a deploy) but never a dangling entry reference.
 *    - OPENWOP_SPA_SHELL_FILE — a readable file path; read once per process.
 *  Neither configured → null (the route 404s; the hosting rewrite must not be
 *  flipped without one — DEPLOY.md). */
const log = createLogger('publishing.prerender');

let shellCache: string | null | undefined;
let shellFetchedAt = 0;
let shellRefreshing: Promise<void> | null = null;
/** When the in-flight refresh STARTED — the wedge bound is measured from this. */
let shellRefreshStartedAt = 0;
/** The upstream ETag of the cached shell, for conditional revalidation. */
let shellEtag: string | null = null;

/** How long a cached shell may serve before it is revalidated.
 *
 *  DEFAULT 60s, lowered from 300s (2026-08-03) because this TTL **is** the
 *  public `/` outage window, not merely a freshness knob: Hosting PRUNES the
 *  previous build's hashed assets on deploy, so a shell cached from before a
 *  frontend deploy references a bundle that no longer exists. The request then
 *  falls through Hosting's SPA rewrite and returns `index.html` as
 *  `200 text/html`, the browser refuses it under strict MIME checking, and the
 *  SPA never boots for anonymous visitors on `/`. Verified live 2026-08-02.
 *
 *  Refreshes send `If-None-Match`. **MEASURED 2026-08-03: Firebase Hosting
 *  does NOT honour it for this file** — it answers a conditional GET with a
 *  full 200 + body (consistent with the `no-cache, no-store, must-revalidate`
 *  it serves the shell with). So on THIS host the validator buys nothing today
 *  and the window reduction comes from the shorter TTL alone; the header is
 *  kept because it is standards-correct, costs nothing, and pays off on a
 *  white-label host that does answer 304 (adopters pick their own — WHITE-LABEL.md).
 *  Do not re-justify a short TTL with "304s are cheap": at 60 s this is one
 *  ~7 KB GET per minute per instance, which is affordable on its own terms.
 *  The floor is deliberately not zero (that would make every `/` miss block on
 *  an upstream fetch). */
function shellTtlMs(): number {
  const raw = Number(process.env.OPENWOP_SPA_SHELL_TTL_S);
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 1000;
}

async function fetchShellFromUrl(url: string): Promise<void> {
  try {
    // Conditional when we already hold a shell: Hosting answers 304 with no
    // body for the common "nothing changed" case, so refreshing often is cheap.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      ...(shellEtag && shellCache ? { headers: { 'if-none-match': shellEtag } } : {}),
    });
    if (res.status === 304 && shellCache) {
      shellFetchedAt = Date.now(); // unchanged upstream — keep the body, restart the clock
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.text();
    // A shell must look like an HTML document — never cache an error page.
    if (!/<!doctype html>/i.test(body)) throw new Error('not an html document');
    shellCache = body;
    shellEtag = res.headers.get('etag');
    shellFetchedAt = Date.now();
  } catch (err) {
    log.warn('spa_shell_fetch_failed', { url, error: err instanceof Error ? err.message : String(err) });
    // Keep any last-good shell (stale beats broken); first fetch failure → null.
    if (shellCache === undefined) shellCache = null;
    shellFetchedAt = Date.now(); // back off a full TTL before retrying
  }
}

/**
 * An in-flight refresh may block a NEW one for only this long.
 *
 * INCIDENT 2026-08-08. The refresh below used to be pure fire-and-forget, and on
 * Cloud Run that means it may NEVER RUN: the service sets
 * `run.googleapis.com/cpu-throttling=true`, so once a response is flushed the
 * instance gets ~no CPU and a detached continuation simply does not resume. The
 * promise never settles, `shellRefreshing` is never cleared, and the guard
 * `(expired && !shellRefreshing)` then disables EVERY future refresh for the life
 * of that instance.
 *
 * Measured, not inferred: `/` served a pruned bundle for 16+ minutes across
 * repeated probes while Cloud Logging showed 10 `human_shell` lines and ZERO
 * `spa_shell_fetch_failed` — the fetch had not failed, it had never settled. Only
 * forcing new instances cleared it.
 *
 * The unit tests did not catch it because Node in a test has ample CPU, so the
 * detached promise always settled inside a 100 ms sleep. The test asserted a
 * runtime the production host does not provide.
 */
const SHELL_REFRESH_WEDGE_MS = 15_000;
/**
 * How long a request will WAIT for an expiry refresh before serving the stale
 * shell. This is the other half of the fix: on a CPU-throttled host the ONLY
 * reliable place to finish the fetch is inside a request, so the refresh is now
 * awaited — but bounded, so the hot path can never block on a slow origin. The
 * fetch to Hosting measures ~100 ms, well inside this.
 */
const SHELL_REFRESH_AWAIT_MS = 1_000;

/** Resolve when `p` settles or `ms` elapses, whichever comes first. */
function withDeadline(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // `unref` so a pending deadline can never hold the process open against the
    // SIGTERM shutdown path.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void p.finally(() => { clearTimeout(timer); resolve(); });
  });
}

async function spaShellHtml(): Promise<string | null> {
  const url = process.env.OPENWOP_SPA_SHELL_URL?.trim();
  if (url) {
    const now = Date.now();
    const expired = now - shellFetchedAt >= shellTtlMs();
    // A refresh that has been "in flight" past the wedge bound is treated as
    // dead. Without this one starved continuation is permanent.
    const wedged = shellRefreshing !== null && now - shellRefreshStartedAt >= SHELL_REFRESH_WEDGE_MS;
    if (shellCache === undefined || (expired && (shellRefreshing === null || wedged))) {
      shellRefreshStartedAt = now;
      const refresh = fetchShellFromUrl(url).finally(() => { shellRefreshing = null; });
      shellRefreshing = refresh;
      // First load blocks (nothing to serve yet). Later refreshes are awaited
      // too, but only up to SHELL_REFRESH_AWAIT_MS — long enough to finish
      // in-request on a throttled instance, short enough that a hung origin
      // costs one bounded wait and still serves the last-good shell.
      if (shellCache === undefined) await refresh;
      else await withDeadline(refresh, SHELL_REFRESH_AWAIT_MS);
    }
    return shellCache ?? null;
  }
  if (shellCache !== undefined) return shellCache;
  const file = process.env.OPENWOP_SPA_SHELL_FILE?.trim();
  if (!file) { shellCache = null; return null; }
  try {
    shellCache = await readFile(file, 'utf8');
  } catch {
    log.warn('spa_shell_unreadable', { file });
    shellCache = null;
  }
  return shellCache;
}

/** Test-only: reset the shell cache between cases. */
/** Test-only: the resolved TTL, so a test can assert the DEFAULT window
 *  directly instead of trusting a comment about it. */
export function __shellTtlMsForTests(): number { return shellTtlMs(); }

/**
 * Test-only: age the in-flight refresh past the wedge bound, so a test can
 * exercise "the starved refresh no longer blocks a new one" without sleeping
 * SHELL_REFRESH_WEDGE_MS of real time.
 */
export function __expireShellRefreshForTests(): void {
  shellRefreshStartedAt = Date.now() - SHELL_REFRESH_WEDGE_MS - 1;
}

export function __resetShellCacheForTests(): void {
  shellCache = undefined;
  shellRefreshing = null;
  shellRefreshStartedAt = 0;
  shellEtag = null; // the validator must reset with the body it belongs to
  shellFetchedAt = 0;
  shellRefreshing = null;
}
