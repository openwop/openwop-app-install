/**
 * ADR 0363 P2 — the shared authored-content accessibility checker.
 *
 * Generalizes the document-editor's `documentA11yIssues` (ADR 0334) into ONE
 * vocabulary that CMS pages, app-builder screens, and documents all reuse. The
 * checker is deliberately DECOUPLED from every feature's native model: it walks a
 * normalized {@link ContentA11yModel}, and each feature owns a tiny pure projector
 * (`doc→model`, `page→model`, `screen→model`) that imports only the model type.
 * This is the boundary that keeps the checker from coupling to editor internals.
 *
 * FE-resident by design (the `/architect` P2 review): editors run it synchronously
 * client-side, and the WCAG contrast math (`brand/theme/contrast`) is FE-only.
 * Phase 3's backend `accessibility.check` node is a small pure rules twin (the
 * `pmToMarkdown` FE↔BE-twin precedent) returning locale-free `kind`/`wcag`.
 *
 * @see docs/adr/0363-authored-content-accessibility.md
 */

import { meetsAA } from '../brand/theme/contrast.js';
import { parseColorToRgb } from '../brand/theme/oklch.js';

export type A11yIssueKind =
  | 'missing-alt'
  | 'heading-skip'
  | 'low-contrast'
  | 'link-text';

export type A11ySeverity = 'error' | 'warning';

/** A normalized accessibility finding. The checker sets `messageKey` (one per
 *  finding shape); the shared panel resolves it against the `a11y` i18n ns. */
export interface A11yIssue {
  id: string;
  kind: A11yIssueKind;
  severity: A11ySeverity;
  /** The WCAG success criterion, e.g. '1.1.1'. */
  wcag: string;
  /** An opaque reference into the source model (block/section/component id). */
  nodeRef?: string;
  messageKey: string;
  params?: Record<string, number | string>;
}

/** The normalized shape every feature projects its content into. Absent arrays
 *  simply contribute no findings — a surface supplies only what it authors. */
export interface ContentA11yModel {
  images: { alt?: string; decorative?: boolean; ref?: string }[];
  headings: { level: number; ref?: string }[];
  links: { text?: string; ref?: string }[];
  /** Authored foreground/background pairs (concrete CSS colors). */
  colorPairs?: { fg: string; bg: string; ref?: string; large?: boolean }[];
}

/** Link text that fails WCAG 2.4.4 "in context" — non-descriptive on its own. */
const GENERIC_LINK_TEXT = new Set(['click here', 'here', 'read more', 'more', 'link', 'this', 'learn more', 'go', 'click']);

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Spread an optional `nodeRef` only when present (exactOptionalPropertyTypes). */
const refOf = (r: string | undefined): { nodeRef?: string } => (r ? { nodeRef: r } : {});

/** Missing alt text on non-decorative images (WCAG 1.1.1). */
function checkImages(model: ContentA11yModel): A11yIssue[] {
  const issues: A11yIssue[] = [];
  model.images.forEach((img, i) => {
    if (img.decorative) return; // decorative ⇒ alt="" is correct, not a defect
    if (!norm(img.alt)) {
      issues.push({ id: `missing-alt-${i}`, kind: 'missing-alt', severity: 'error', wcag: '1.1.1', messageKey: 'missingAlt', ...refOf(img.ref) });
    }
  });
  return issues;
}

/** Skipped heading levels break screen-reader outline navigation (WCAG 1.3.1).
 *  The first heading sets the base; a jump of more than one level down is flagged. */
function checkHeadings(model: ContentA11yModel): A11yIssue[] {
  const issues: A11yIssue[] = [];
  let prev = 0;
  model.headings.forEach((h, i) => {
    if (prev && h.level > prev + 1) {
      issues.push({ id: `heading-skip-${i}`, kind: 'heading-skip', severity: 'error', wcag: '1.3.1', messageKey: 'headingSkip', ...refOf(h.ref), params: { from: prev, to: h.level } });
    }
    prev = h.level;
  });
  return issues;
}

/** Empty or non-descriptive link text (WCAG 2.4.4). */
function checkLinks(model: ContentA11yModel): A11yIssue[] {
  const issues: A11yIssue[] = [];
  model.links.forEach((link, i) => {
    const text = norm(link.text).toLowerCase();
    if (!text) {
      issues.push({ id: `link-empty-${i}`, kind: 'link-text', severity: 'warning', wcag: '2.4.4', messageKey: 'linkEmpty', ...refOf(link.ref) });
    } else if (GENERIC_LINK_TEXT.has(text)) {
      issues.push({ id: `link-generic-${i}`, kind: 'link-text', severity: 'warning', wcag: '2.4.4', messageKey: 'linkGeneric', ...refOf(link.ref), params: { text: norm(link.text) } });
    }
  });
  return issues;
}

/** Authored foreground/background pairs below the WCAG 1.4.3 AA ratio (advisory —
 *  the concrete color is frozen at pick-time against one theme; see the ADR). */
function checkContrast(model: ContentA11yModel): A11yIssue[] {
  const issues: A11yIssue[] = [];
  (model.colorPairs ?? []).forEach((pair, i) => {
    const fg = parseColorToRgb(pair.fg);
    const bg = parseColorToRgb(pair.bg);
    if (!fg || !bg) return; // unparseable ⇒ silently skip (never a false positive)
    if (!meetsAA(fg, bg, pair.large)) {
      issues.push({ id: `low-contrast-${i}`, kind: 'low-contrast', severity: 'warning', wcag: '1.4.3', messageKey: 'lowContrast', ...refOf(pair.ref) });
    }
  });
  return issues;
}

/** Run every check over a normalized model. Pure; `[]` = no issues found. */
export function checkContentA11y(model: ContentA11yModel): A11yIssue[] {
  return [...checkImages(model), ...checkHeadings(model), ...checkLinks(model), ...checkContrast(model)];
}
