/**
 * ADR 0363 P3 — the backend rules TWIN of the FE `a11y/contentA11y.ts` checker.
 *
 * The editors run the checker client-side (P2); the workflow node + agent tool
 * (`accessibility.check`) run the SAME rules server-side. FE and BE don't share a
 * module (separate builds), so this is a deliberate pure twin — the established
 * `pmToMarkdown` FE↔BE precedent. A parity test (`accessibility-content-a11y`)
 * pins the two to the same fixtures so they can't drift.
 *
 * The backend twin is locale-free: it returns `{ kind, severity, wcag, nodeRef? }`
 * only — no `messageKey`/`params` (i18n is a FE concern). The rules
 * (checkImages/checkHeadings/checkLinks/checkContrast) are equivalent to the FE
 * checker for the inputs that reach a workflow; the ONE deliberate narrowing is
 * the color parser (hex/rgb only — see `parseColorToRgb`), which fail-safely
 * skips oklch/named colors the FE would parse. Keep the rest in lockstep.
 */

export type A11yIssueKind = 'missing-alt' | 'heading-skip' | 'low-contrast' | 'link-text';
export type A11ySeverity = 'error' | 'warning';

export interface A11yIssue {
  kind: A11yIssueKind;
  severity: A11ySeverity;
  wcag: string;
  nodeRef?: string;
}

export interface ContentA11yModel {
  images: { alt?: string; decorative?: boolean; ref?: string }[];
  headings: { level: number; ref?: string }[];
  links: { text?: string; ref?: string }[];
  colorPairs?: { fg: string; bg: string; ref?: string; large?: boolean }[];
}

const GENERIC_LINK_TEXT = new Set(['click here', 'here', 'read more', 'more', 'link', 'this', 'learn more', 'go', 'click']);
const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const refOf = (r: string | undefined): { nodeRef?: string } => (r ? { nodeRef: r } : {});

// ── WCAG 2.x contrast math (twin of frontend brand/theme/contrast.ts) ────────
type Rgb = readonly [number, number, number]; // sRGB 0..1

function lin(c: number): number {
  // Threshold matches the FE twin (brand/theme/contrast.ts) exactly.
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function wcagRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function meetsAA(fg: Rgb, bg: Rgb, large = false): boolean {
  return wcagRatio(fg, bg) >= (large ? 3 : 4.5);
}

/** Parse a concrete CSS color to sRGB 0..1 — hex (#rgb/#rrggbb) + rgb()/rgba().
 *  Authored theme colors that reach a workflow validate as 6-digit hex upstream,
 *  so this covers the real inputs. Anything else (oklch(), named, #rrggbbaa) →
 *  null → the check SKIPS it (fail-safe: never a false positive). This is a
 *  deliberately narrower parser than the FE `parseColorToRgb` (which also parses
 *  oklch); the twin's rules are equivalent for hex/rgb, and skipping richer
 *  formats can only under-report, never mis-report. */
function parseColorToRgb(css: string): Rgb | null {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  if (m) {
    const v = (x: string): number => Math.max(0, Math.min(255, Number(x))) / 255;
    return [v(m[1]!), v(m[2]!), v(m[3]!)];
  }
  return null;
}

// ── Rules (twin of the FE checkers) ──────────────────────────────────────────

function checkImages(model: ContentA11yModel): A11yIssue[] {
  const out: A11yIssue[] = [];
  model.images.forEach((img) => {
    if (img.decorative) return;
    if (!norm(img.alt)) out.push({ kind: 'missing-alt', severity: 'error', wcag: '1.1.1', ...refOf(img.ref) });
  });
  return out;
}

function checkHeadings(model: ContentA11yModel): A11yIssue[] {
  const out: A11yIssue[] = [];
  let prev = 0;
  model.headings.forEach((h) => {
    if (prev && h.level > prev + 1) out.push({ kind: 'heading-skip', severity: 'error', wcag: '1.3.1', ...refOf(h.ref) });
    prev = h.level;
  });
  return out;
}

function checkLinks(model: ContentA11yModel): A11yIssue[] {
  const out: A11yIssue[] = [];
  model.links.forEach((link) => {
    const text = norm(link.text).toLowerCase();
    if (!text || GENERIC_LINK_TEXT.has(text)) out.push({ kind: 'link-text', severity: 'warning', wcag: '2.4.4', ...refOf(link.ref) });
  });
  return out;
}

function checkContrast(model: ContentA11yModel): A11yIssue[] {
  const out: A11yIssue[] = [];
  (model.colorPairs ?? []).forEach((pair) => {
    const fg = parseColorToRgb(pair.fg);
    const bg = parseColorToRgb(pair.bg);
    if (!fg || !bg) return;
    if (!meetsAA(fg, bg, pair.large)) out.push({ kind: 'low-contrast', severity: 'warning', wcag: '1.4.3', ...refOf(pair.ref) });
  });
  return out;
}

/** Run every check over a normalized model. Pure; `[]` = no issues. */
export function checkContentA11y(model: ContentA11yModel): A11yIssue[] {
  return [...checkImages(model), ...checkHeadings(model), ...checkLinks(model), ...checkContrast(model)];
}

/** Coerce untrusted node/tool input into a safe {@link ContentA11yModel} (bounded,
 *  unknown keys dropped) — inline content, NOT an artifact ref (NodeContext has no
 *  artifact-read seam; P3 correction). */
export function coerceContentA11yModel(raw: unknown): ContentA11yModel {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 2000) : []);
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    images: arr(o.images).map((x) => {
      const i = (x ?? {}) as Record<string, unknown>;
      return { alt: s(i.alt), decorative: i.decorative === true, ref: s(i.ref) };
    }),
    headings: arr(o.headings).map((x) => {
      const i = (x ?? {}) as Record<string, unknown>;
      return { level: typeof i.level === 'number' ? i.level : 1, ref: s(i.ref) };
    }),
    links: arr(o.links).map((x) => {
      const i = (x ?? {}) as Record<string, unknown>;
      return { text: s(i.text), ref: s(i.ref) };
    }),
    colorPairs: arr(o.colorPairs).map((x) => {
      const i = (x ?? {}) as Record<string, unknown>;
      return { fg: s(i.fg) ?? '', bg: s(i.bg) ?? '', ref: s(i.ref), large: i.large === true };
    }),
  };
}
