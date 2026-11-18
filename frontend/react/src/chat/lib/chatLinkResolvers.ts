/**
 * ADR 1040 D7 F4 (Book AI P47) — feature links in assistant markdown.
 *
 * A feature registers a scheme (`bookai`), and a link the model writes as
 * `bookai:book/123` (or `bookai://book/123`) renders as an IN-APP link only
 * after the feature's `resolve(id, ctx)` returns a route for THIS viewer (the
 * resolver does its own authorized read). Everything else renders as plain
 * text: an unregistered scheme, a `null` answer, a throw, and any answer that is
 * not a same-origin in-app path (`javascript:`, `data:`, `https://…`,
 * `//host`, `/\host`, anything with a backslash or a control character).
 *
 * Pure frontend: no wire, no new route. Ordinary `http(s)`/`mailto` links are
 * unchanged (react-markdown's `defaultUrlTransform`, a new tab).
 */
import { defaultUrlTransform } from 'react-markdown';

export interface ChatLinkContext {
  /** Aborted when the link unmounts; a resolver should pass it to its fetch. */
  signal: AbortSignal;
}

/** `id` is MODEL TEXT (whatever followed `scheme:`): untrusted. A resolver must
 *  treat it as an opaque lookup key and encode it into any URL it builds. */
export type ChatLinkResolve = (id: string, ctx: ChatLinkContext) => Promise<string | null> | string | null;

const RESOLVERS = new Map<string, ChatLinkResolve>();
const SCHEME = /^[a-z][a-z0-9+.-]{1,31}$/;
/** Schemes a feature can never claim: the browser's own, and the dangerous ones. */
const RESERVED = new Set(['http', 'https', 'mailto', 'tel', 'javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'ftp', 'ws', 'wss']);

/** Register at the owning feature's module load. Throws on a malformed,
 *  reserved or duplicate scheme (a programming error, never runtime state). */
export function registerChatLinkResolver(scheme: string, resolve: ChatLinkResolve): void {
  if (!SCHEME.test(scheme) || RESERVED.has(scheme)) throw new Error(`chat link scheme "${scheme}" is not allowed.`);
  if (RESOLVERS.has(scheme)) throw new Error(`chat link scheme "${scheme}" is already registered.`);
  RESOLVERS.set(scheme, resolve);
}

/** Test seam. */
export function __unregisterChatLinkResolver(scheme: string): void {
  RESOLVERS.delete(scheme);
}

/** `{ scheme, id }` when `href` uses a REGISTERED scheme, else undefined. */
export function parseFeatureLink(href: string | undefined): { scheme: string; id: string; resolve: ChatLinkResolve } | undefined {
  if (!href) return undefined;
  const colon = href.indexOf(':');
  if (colon <= 0) return undefined;
  const scheme = href.slice(0, colon).toLowerCase();
  const resolve = RESOLVERS.get(scheme);
  if (!resolve) return undefined;
  const id = href.slice(colon + 1).replace(/^\/\//, '');
  return id ? { scheme, id, resolve } : undefined;
}

/** react-markdown `urlTransform`: keep a registered feature link verbatim (it
 *  is resolved later, never used as an href as is); everything else goes
 *  through the default sanitizer exactly as before. */
export function chatUrlTransform(url: string): string {
  return parseFeatureLink(url) ? url : defaultUrlTransform(url);
}

/** Is `route` a same-origin, in-app PATH? The only answer a resolver may give. */
export function isSafeInAppPath(route: unknown): route is string {
  return safeInAppPath(route) !== null;
}

/** The NORMALIZED in-app path (`pathname + search + hash`) for a safe answer,
 *  else null. What the link uses: the resolver's raw string never is. */
export function safeInAppPath(route: unknown): string | null {
  if (typeof route !== 'string' || route.length === 0 || route.length > 2048) return null;
  if (!route.startsWith('/') || route.startsWith('//')) return null;
  // A backslash is read as a slash by browsers (`/\evil.com` → `//evil.com`),
  // and a control character can hide one; neither belongs in an app route.
  if (/[\\\u0000-\u001f\u007f]/.test(route)) return null;
  try {
    const base = 'https://app.invalid';
    const u = new URL(route, base);
    if (u.origin !== base) return null;
    // `/..//evil.com` normalizes to the path `//evil.com`: same origin to the
    // router, but a protocol-relative URL to anything that later redirects to it.
    if (u.pathname.startsWith('//')) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
