/**
 * ADR 1015 — the tenant site visitor runtime on a bound custom domain.
 *
 * A customer hostname serves prerendered HTML and no SPA (ADR 0384). This module
 * decides whether that page also loads the one first-party script that runs the
 * visitor modules (consent banner, beacons, heat, replay) against the public
 * routes on the SAME hostname, and serves that script from the image.
 *
 *   - The script is injected only on a bound custom-domain request, only when the
 *     workspace's `custom-domains.visitor-runtime` toggle is on, and only when the
 *     image carries a runtime manifest. Otherwise the page is byte-identical to
 *     what it was before this ADR (D4).
 *   - Only files the manifest names are served (D6). The manifest is written by
 *     the frontend runtime build into the image, so the page and its script ship
 *     together and cannot skew.
 *   - Every prerender response carries a CSP that admits only same-origin script
 *     (D7), so CMS content can never add script beside ours.
 *
 * Host-extension only; no wire change.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Request, Response } from 'express';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { boundSiteOf, DESIGNED_PAGES_TOGGLE, SITE_RUNTIME_TOGGLE } from '../../host/boundSite.js';
import { siteBrandCssFor } from '../../host/siteBrand.js';
import { hasPublishedPage } from './publishingService.js';

const log = createLogger('site-runtime');

export { DESIGNED_PAGES_TOGGLE, SITE_RUNTIME_TOGGLE } from '../../host/boundSite.js';


/** D7 — the prerender document policy. JSON-LD blocks are data, not script. */
export const PRERENDER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' https: data:",
  "media-src 'self' https:",
  'frame-src https:',
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' https: data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function setPrerenderSecurityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', PRERENDER_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

interface RuntimeManifest { entry: string; files: ReadonlySet<string>; /** ADR 1030 D2 */ style?: string }

/** Where the runtime build lands in the image (Dockerfile `site-runtime` stage). */
function runtimeDir(): string {
  return resolve(process.env.OPENWOP_SITE_RUNTIME_DIR?.trim() || join(process.cwd(), 'site-runtime'));
}

let manifestPromise: Promise<RuntimeManifest | null> | null = null;

/** Read the manifest once. Missing (ENOENT) or malformed ⇒ null: that is a fact
 *  about this image, so it is cached. Any other I/O failure THROWS, so the caller
 *  can drop the latch and retry instead of caching a transient fault. */
async function readManifest(): Promise<RuntimeManifest | null> {
  let text: string;
  try {
    text = await readFile(join(runtimeDir(), 'manifest.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const raw = JSON.parse(text) as { entry?: unknown; files?: unknown; style?: unknown };
    const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string' && SAFE_FILE.test(f)) : [];
    if (typeof raw.entry !== 'string' || !files.includes(raw.entry)) return null;
    // ADR 1030 D2 — the stylesheet is served only if it is also a listed file.
    const style = typeof raw.style === 'string' && raw.style.endsWith('.css') && files.includes(raw.style) ? raw.style : undefined;
    return { entry: raw.entry, files: new Set(files), ...(style ? { style } : {}) };
  } catch {
    log.warn('site_runtime_manifest_malformed', {});
    return null;
  }
}

/**
 * The runtime manifest: `{ entry, files[] }`, written by the frontend runtime
 * build. Missing or malformed ⇒ null, which means "no runtime": nothing is
 * injected and every asset request is a 404.
 *
 * A module-scope latch, so it must recover from a FAILED attempt (the #3056
 * class, `test/detached-latch-tripwire.test.ts`): a read that fails for any
 * reason other than "no manifest" clears the latch and answers "no runtime" for
 * THIS request only; the next request reads again. Every caller awaits it in
 * the request, so the read always settles and needs no time bound.
 */
export function loadRuntimeManifest(): Promise<RuntimeManifest | null> {
  manifestPromise ??= readManifest().catch((err: unknown) => {
    manifestPromise = null;
    log.warn('site_runtime_manifest_unreadable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  return manifestPromise;
}

/** A flat, hashed asset name: no path separators, no traversal, one extension. */
const SAFE_FILE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css)$/;

function hostDisabled(): boolean {
  return (process.env.OPENWOP_SITE_RUNTIME ?? '').trim().toLowerCase() === 'off';
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The asset path for `file` under the org-pinned public prefix, which the
 *  custom-domain guard admits only for the bound org. */
export function runtimeAssetPath(orgId: string, file: string): string {
  return `/host/openwop-app/public/${encodeURIComponent(orgId)}/_rt/${encodeURIComponent(file)}`;
}

/**
 * The `<script>` tag for this response, or null when the page must stay as it
 * was: not a bound host, the host kill switch, no runtime in the image, or the
 * workspace toggle off (an unreadable toggle counts as off).
 */
export async function siteRuntimeTagFor(res: Response): Promise<string | null> {
  const site = boundSiteOf(res);
  if (!site || hostDisabled()) return null;
  const manifest = await loadRuntimeManifest();
  if (!manifest) return null;
  const on = await resolveOne(SITE_RUNTIME_TOGGLE, { tenantId: site.tenantId }).then((r) => Boolean(r?.enabled)).catch(() => false);
  if (!on) return null;
  const privacy = await privacyPathFor(site.orgId);
  return `<script type="module" src="${attr(runtimeAssetPath(site.orgId, manifest.entry))}" data-owp-org="${attr(site.orgId)}"${privacy ? ` data-owp-privacy="${attr(privacy)}"` : ''}></script>`;
}

/**
 * ADR 1030 D4 — the designed-pages `<link>` for this response, or null when the
 * page must stay plain: not a bound host, the host kill switch, no stylesheet in
 * the image, or the workspace's `custom-domains.designed-pages` off (an
 * unreadable toggle counts as off). Independent of the visitor runtime: a
 * stylesheet needs no script.
 */
export async function siteStyleTagFor(res: Response): Promise<string | null> {
  const site = boundSiteOf(res);
  if (!site || hostDisabled()) return null;
  const manifest = await loadRuntimeManifest();
  if (!manifest?.style) return null;
  const on = await resolveOne(DESIGNED_PAGES_TOGGLE, { tenantId: site.tenantId }).then((r) => Boolean(r?.enabled)).catch(() => false);
  if (!on) return null;
  const link = `<link rel="stylesheet" href="${attr(runtimeAssetPath(site.orgId, manifest.style))}">`;
  // ADR 1030 P2 — the workspace's chosen brand, as one inline token block after
  // the sheet (so it wins). Generator-made values in the injector's grammar; ''
  // when the site chose no brand.
  const tokens = await siteBrandCssFor(site.tenantId, site.orgId);
  return tokens ? `${link}\n<style>${tokens}</style>` : link;
}

/** Put the designed-pages link in `<head>` and mark `<body data-owp-site>` (every
 *  site.css rule is scoped to it). Unchanged when `link` is null. */
export function withStyleTag(html: string, link: string | null): string {
  if (!link) return html;
  const head = html.indexOf('</head>');
  const body = html.indexOf('<body>');
  if (head < 0 || body < 0 || body < head) return html;
  return `${html.slice(0, head)}${link}\n${html.slice(head, body)}<body data-owp-site>${html.slice(body + '<body>'.length)}`;
}

/** The workspace's own privacy page on its custom domain, when published; the
 *  banner shows no link otherwise. Cached a minute per org (a page read must not
 *  scan the org's pages every time). A failed read is "none". */
const PRIVACY_SLUG = 'privacy';
const privacyCache = new Map<string, { at: number; path: string | null }>();
async function privacyPathFor(orgId: string): Promise<string | null> {
  const hit = privacyCache.get(orgId);
  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  const path = await hasPublishedPage(orgId, PRIVACY_SLUG).then((yes) => (yes ? `/p/${PRIVACY_SLUG}` : null)).catch(() => null);
  if (privacyCache.size > 5_000) privacyCache.clear();
  privacyCache.set(orgId, { at: Date.now(), path });
  return path;
}

/** Insert the tag just before `</body>` (the prerender always emits one). */
export function withRuntimeTag(html: string, tag: string | null): string {
  if (!tag) return html;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html : `${html.slice(0, at)}${tag}\n${html.slice(at)}`;
}

/** Send a prerendered document: security headers always, the runtime tag when it
 *  applies. A page carrying the tag is `no-cache` (revalidated on every load), not
 *  the prerender's hour-long public cache: the tag names a hashed file that only the
 *  CURRENT image holds, so a cached page would ask for a file a deploy removed, and
 *  turning the toggle or the host switch off must take effect at once. */
export async function sendPrerenderHtml(res: Response, html: string): Promise<void> {
  setPrerenderSecurityHeaders(res);
  const [tag, style] = await Promise.all([siteRuntimeTagFor(res), siteStyleTagFor(res)]);
  // Either names a hashed file only the CURRENT image holds (see above).
  if (tag || style) res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(withRuntimeTag(withStyleTag(html, style), tag));
}

/** D6 — serve one manifest-named runtime file, or 404. */
export async function serveRuntimeAsset(req: Request, res: Response): Promise<void> {
  const file = String(req.params.file ?? '');
  const manifest = SAFE_FILE.test(file) ? await loadRuntimeManifest() : null;
  if (!manifest || !manifest.files.has(file)) {
    res.status(404).type('text/plain').send('Not found.');
    return;
  }
  let body: Buffer;
  try { body = await readFile(join(runtimeDir(), file)); } catch {
    res.status(404).type('text/plain').send('Not found.');
    return;
  }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.send(body);
}

/** Test seam: forget the cached manifest. */
export function __resetSiteRuntimeForTests(): void { manifestPromise = null; privacyCache.clear(); }
