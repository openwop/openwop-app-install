/**
 * The ONE public call-to-action link + its URL predicates, shared by the section
 * renderer and the lazily-loaded pricing section (so the pricing code can split
 * into its own chunk without a second copy of the link-safety rules).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isInternalHref } from '../../lib/internalHref.js';

/** An http(s)/mailto URL is safe as an external link; anything else is not. */
export const isSafeHref = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());
/** An internal app path (`/agents`) — single leading slash, NOT `//` or `/\`
 *  (both normalize to a protocol-relative EXTERNAL URL → open-redirect shape),
 *  and no control character or whitespace (ADR 0836 D7 — the shared predicate). */
export const isInternal = (url: string): boolean => isInternalHref(url.trim());
/** ADR 0920 D6 — a same-page fragment (`#film`): it cannot leave the page, so it
 *  is a plain anchor, never a router navigation. Mirrors the backend `safeLink`. */
export const isFragment = (url: string): boolean => /^#[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(url.trim());

export function CtaLink({ label, url, primary, ariaLabel, icon }: { label: string; url: string; primary?: boolean; ariaLabel?: string; icon?: ReactNode }): JSX.Element | null {
  if (!label) return null;
  const cls = `fp-btn ${primary ? 'fp-btn--primary' : 'fp-btn--ghost'}`;
  // ADR 0920 D3 — an optional leading glyph (the hero's play icon); decorative.
  const body = icon ? <><span className="fp-btn__icon" aria-hidden="true">{icon}</span>{label}</> : label;
  if (isInternal(url)) return <Link className={cls} to={url} aria-label={ariaLabel}>{body}</Link>;
  if (isFragment(url)) return <a className={cls} href={url.trim()} aria-label={ariaLabel}>{body}</a>;
  if (url && isSafeHref(url)) return <a className={cls} href={url} rel="noopener noreferrer" aria-label={ariaLabel}>{body}</a>;
  // SITE-R2-4 — an empty/unsafe URL used to render a button-STYLED <span> that
  // did nothing: unfocusable, unclickable, invisible to keyboard/SR users, yet
  // visually a primary call-to-action. An action nobody can complete must not
  // be offered — render nothing (like an empty label above).
  return null;
}
