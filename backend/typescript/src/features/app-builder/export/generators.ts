/**
 * Multi-framework source generators (ADR 0173 + ADR 0305 Phase C) for the CLOSED
 * `canvas.app-builder` component catalog. The known-type set derives from
 * `APP_BUILDER_COMPONENTS` — never a hand-copied list (that drifted once); the
 * Phase-C parity test pins every catalog type to a mapping in EVERY generator.
 *
 * Each generator walks the same `AppModel` and emits `ExportedFile[]` + `warnings[]`
 * (an unknown/unmapped component type degrades to a warning, never an error — the
 * additivity rule as the closed catalog evolves). Output is templated markup, NEVER
 * executable model code (the closed catalog guarantees this); all text is escaped.
 *
 * Data binding (ADR 0305 Phase C): `expandBindings` UNROLLS a bound list's children
 * per design-time sample row, interpolating `{{field}}` into string props BEFORE
 * generation — so every generator inherits binding with its own escaping applied to
 * the interpolated values (architect amendment 2), with zero per-target binding code.
 *
 * @see docs/adr/0173-code-export-multi-framework.md
 * @see docs/adr/0305-app-builder-editor-parity-program.md §Phase C
 */

export type ExportTarget = 'react-tailwind' | 'react-styled' | 'vue-tailwind' | 'html-css' | 'react-native' | 'flutter' | 'nextjs';
export const EXPORT_TARGETS: readonly ExportTarget[] = ['react-tailwind', 'react-styled', 'vue-tailwind', 'html-css', 'react-native', 'flutter', 'nextjs'];

export interface ComponentNode {
  type: string;
  props?: Record<string, unknown>;
  children?: ComponentNode[];
  // ADR 0344 2b — authoring traits: hidden nodes never reach generated source;
  // locked is editor-only and carries no export meaning.
  hidden?: boolean;
  locked?: boolean;
}
export interface DataSourceModel {
  id: string;
  name: string;
  fields?: string[];
  rows?: Record<string, unknown>[];
}
export interface ScreenModel {
  id: string;
  name: string;
  route?: string;
  isInitial?: boolean;
  components?: ComponentNode[];
}
export interface AppModel {
  name: string;
  description?: string;
  theme?: 'default' | 'light' | 'dark';
  themeColors?: { primary?: string; secondary?: string };
  screens: ScreenModel[];
  dataSources?: DataSourceModel[];
}
export interface ExportedFile {
  path: string;
  content: string;
}
export interface GenerateResult {
  files: ExportedFile[];
  warnings: string[];
}

// ── shared helpers ───────────────────────────────────────────────────────────

function escapeHtml(raw: unknown): string {
  // Grade pass 2026-07-07 (F2): braces are escaped too — this output lands in
  // JSX and Vue TEXT contexts where `{expr}` / `{{ expr }}` would compile as a
  // LIVE expression in the exported app. Entities neutralize that in every
  // HTML-family target.
  return String(raw ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}
/** Grade pass 2026-07-07 (F2): ids are interpolated into generated JS/Vue/Dart
 *  STRING and COMMENT contexts — sanitize to the slug charset the validator
 *  enforces on save (defense in depth for surface-inline models). */
function jsId(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}
/** JS single-quoted string-literal escaper — for URL-ish values that must NOT be
 *  HTML-entity-encoded (entities corrupt URLs in JSX/RN source; F12). */
function jsStr(raw: unknown): string {
  return String(raw ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '').replace(/</g, '\\u003C');
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
/** Only a strict 6-digit hex survives into generated style values (amendment 3). */
/** Grade code-F4: only web/mail/relative URL schemes reach generated href/src
 *  — mirrors the in-app renderer's safeImageSrc posture, so an AI/API-authored
 *  `javascript:` URI can never execute in an exported page. */
function safeUrl(v: unknown): string {
  const u = typeof v === 'string' ? v.trim() : '';
  if (!u) return '';
  return /^(https?:|mailto:|\/(?!\/)|\.\/|\.\.\/|#)/i.test(u) ? u : '';
}

function safeColor(v: unknown): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '';
}
/** Parse the static `table` props: comma-separated columns; one row per line. */
function tableData(p: Record<string, unknown>): { cols: string[]; rows: string[][] } {
  const cols = splitList(p.columns);
  // Grade data-F3: limit-split each row to the column count — the LAST column
  // absorbs extra commas, so "$8,560" survives whole (the shipped `report`
  // template sheared before). Mirrored in the frontend CompView renderer.
  const rows = String(typeof p.rows === 'string' ? p.rows : '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(',').map((c) => c.trim());
    return cols.length && parts.length > cols.length
      ? [...parts.slice(0, cols.length - 1), parts.slice(cols.length - 1).join(',')]
      : parts;
  });
  return { cols, rows };
}

function splitList(v: unknown): string[] {
  return str(v).split(',').map((s) => s.trim()).filter(Boolean);
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
/** PascalCase, safe identifier for a screen component/file name. */
function pascal(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(s) ? s : `Screen${s}`;
}
/** Grade pass 2026-07-07 (F12): distinct screens can pascal-collide ("Home" vs
 *  "home!") → duplicate file paths (JSZip last-wins) and duplicate JS import
 *  identifiers. Dedupe per app with a numeric suffix. */
function uniquePascal(screens: readonly ScreenModel[]): (ScreenModel & { comp: string })[] {
  const used = new Map<string, number>();
  return screens.map((s) => {
    const base = pascal(s.name);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return { ...s, comp: n === 0 ? base : `${base}${n + 1}` };
  });
}

function indent(s: string, n: number): string {
  const pad = '  '.repeat(n);
  return s.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}
const gap = (g: unknown): string => ({ none: '0', sm: '0.5rem', md: '1rem', lg: '2rem' } as Record<string, string>)[str(g, 'md')] ?? '1rem';
const padRem = (g: unknown): string => ({ none: '0', sm: '0.5rem', md: '1rem', lg: '2rem' } as Record<string, string>)[str(g, 'none')] ?? '0';
const radPx = (r: unknown): string => ({ none: '0', sm: '4px', md: '8px', lg: '16px', pill: '999px' } as Record<string, string>)[str(r, 'none')] ?? '0';
const shadowCss = (s: unknown): string => ({ none: 'none', sm: '0 1px 3px rgba(0,0,0,.12)', md: '0 4px 12px rgba(0,0,0,.15)' } as Record<string, string>)[str(s, 'none')] ?? 'none';
const twGap = (g: unknown): string => ({ none: 'gap-0', sm: 'gap-2', md: 'gap-4', lg: 'gap-8' } as Record<string, string>)[str(g, 'md')] ?? 'gap-4';
const twPad = (g: unknown): string => ({ none: '', sm: 'p-2', md: 'p-4', lg: 'p-8' } as Record<string, string>)[str(g, 'none')] ?? '';
const twRad = (r: unknown): string => ({ none: '', sm: 'rounded', md: 'rounded-lg', lg: 'rounded-2xl', pill: 'rounded-full' } as Record<string, string>)[str(r, 'none')] ?? '';
const twShadow = (s: unknown): string => ({ none: '', sm: 'shadow-sm', md: 'shadow-md' } as Record<string, string>)[str(s, 'none')] ?? '';
const hideCls = (h: unknown): string => str(h, 'never') === 'mobile' ? ' hide-mobile' : str(h, 'never') === 'desktop' ? ' hide-desktop' : '';
const twHide = (h: unknown): string => str(h, 'never') === 'mobile' ? ' max-sm:hidden' : str(h, 'never') === 'desktop' ? ' sm:hidden' : '';
const initials = (name: unknown): string => str(name).split(/\s+/).map((w) => w.charAt(0)).join('').slice(0, 2).toUpperCase() || '?';
const stars = (v: unknown, max: unknown): string => { const m = clamp(num(max, 5), 1, 10); const n = clamp(Math.round(num(v, 0)), 0, m); return '★'.repeat(n) + '☆'.repeat(m - n); };

interface Warn { push: (t: string, w: string) => void }
// Warnings fire for EVERY unmapped type — unknown (AI-authored) types degrade
// gracefully at export time, and a KNOWN catalog type hitting a mapper's default
// is catalog↔generator drift the zero-warnings parity test must catch (it was
// previously muted for known types, hiding exactly that drift — audit gap #5).
const makeWarn = (warnings: string[]): Warn => ({ push: (_t, msg) => { warnings.push(msg); } });

// ── data binding: unroll sample rows before generation ───────────────────────
const interpolate = (s: string, row: Record<string, unknown>): string =>
  s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, f: string) => String(row[f] ?? ''));

function interpolateNode(n: ComponentNode, row: Record<string, unknown>): ComponentNode {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props ?? {})) props[k] = typeof v === 'string' ? interpolate(v, row) : v;
  const out: ComponentNode = { type: n.type, props };
  if (n.children) out.children = n.children.map((c) => interpolateNode(c, row));
  return out;
}

/** Replace every bound list's children with per-sample-row interpolated copies.
 *  After this pass no generator needs binding awareness; values flow through each
 *  generator's own escaping. An unknown source id leaves the list as-authored. */
/** ADR 0344 2b — drop `hidden` nodes (whole subtrees) before generation, ONE
 *  shared pass so no per-target mapper needs hidden-awareness. */
export function stripHidden(app: AppModel): AppModel {
  const keep = (nodes: ComponentNode[] | undefined): ComponentNode[] | undefined =>
    nodes?.filter((n) => n.hidden !== true).map((n) => ({ ...n, ...(n.children ? { children: keep(n.children) ?? [] } : {}) }));
  return { ...app, screens: app.screens.map((s) => ({ ...s, components: keep(s.components) ?? [] })) };
}

export function expandBindings(app: AppModel): AppModel {
  const sources = new Map((app.dataSources ?? []).map((s) => [s.id, s]));
  const expand = (n: ComponentNode): ComponentNode => {
    const out: ComponentNode = { ...n, ...(n.children ? { children: n.children.map(expand) } : {}) };
    if (n.type === 'list') {
      const src = sources.get(str(n.props?.bind));
      if (src && Array.isArray(src.rows) && src.rows.length && n.children?.length) {
        out.children = src.rows.flatMap((row) => (n.children ?? []).map((c) => interpolateNode(c, row)));
        out.props = { ...out.props }; delete (out.props as Record<string, unknown>).bind;
      }
    }
    return out;
  };
  return { ...app, screens: app.screens.map((s) => ({ ...s, components: (s.components ?? []).map(expand) })) };
}

// ── HTML/CSS ──────────────────────────────────────────────────────────────────
function htmlNode(n: ComponentNode, w: Warn, screenHref: (id: string) => string): string {
  const p = n.props ?? {};
  const kids = (n.children ?? []).map((c) => htmlNode(c, w, screenHref)).join('\n');
  const nav = str(p.navigateTo);
  const color = safeColor(p.color);
  switch (n.type) {
    case 'stack': return `<div class="stack stack-${str(p.direction, 'vertical')}${hideCls(p.hideOn)}" style="gap:${gap(p.gap)};padding:${padRem(p.padding)}">\n${indent(kids, 1)}\n</div>`;
    case 'grid': return `<div class="grid${hideCls(p.hideOn)}" style="--cols:${clamp(num(p.columns, 2), 1, 12)};--cols-m:${clamp(num(p.columnsMobile, 1), 1, 12)};gap:${gap(p.gap)}">\n${indent(kids, 1)}\n</div>`;
    case 'card': { const inner = `<div class="card${hideCls(p.hideOn)}" style="padding:${padRem(str(p.padding, 'md') === 'none' ? 'md' : p.padding)};border-radius:${radPx(str(p.radius, 'md') === 'none' ? 'md' : p.radius)};box-shadow:${shadowCss(p.shadow)}">${p.title ? `<h3 class="card-title">${escapeHtml(p.title)}</h3>` : ''}\n${indent(kids, 1)}\n</div>`; return nav ? `<a class="card-link" href="${escapeHtml(screenHref(nav))}">${inner}</a>` : inner; }
    case 'form': return `<form class="form-group${hideCls(p.hideOn)}" onsubmit="return false" style="padding:${padRem(str(p.padding, 'md') === 'none' ? 'md' : p.padding)}"><fieldset>${p.title ? `<legend>${escapeHtml(p.title)}</legend>` : ''}\n${indent(kids, 1)}\n</fieldset></form>`;
    case 'accordion': return `<details${p.open === false ? '' : ' open'} class="accordion"><summary>${escapeHtml(p.title)}</summary>\n${indent(kids, 1)}\n</details>`;
    case 'tabs': { const labels = splitList(p.labels); return `<div class="tabs"><nav class="tabs-nav">${labels.map((l, i) => `<button class="tab${i === 0 ? ' active' : ''}">${escapeHtml(l)}</button>`).join('')}</nav>\n${indent(kids, 1)}\n</div>`; }
    case 'dialog': return `<div class="dialog" role="dialog" aria-label="${escapeHtml(p.title)}"><h3 class="dialog-title">${escapeHtml(p.title)}</h3>\n${indent(kids, 1)}\n</div>`;
    case 'drawer': return `<aside class="drawer drawer-${str(p.side, 'left')}">${p.title ? `<h3>${escapeHtml(p.title)}</h3>` : ''}\n${indent(kids, 1)}\n</aside>`;
    case 'spacer': return `<div class="spacer" style="height:${gap(p.size)}"></div>`;
    case 'heading': { const lvl = clamp(num(Number(p.level), 2), 1, 3); return `<h${lvl}${color ? ` style="color:${color}"` : ''}>${escapeHtml(p.text)}</h${lvl}>`; }
    case 'text': return `<p class="text-${str(p.fontSize, 'md')} tone-${str(p.tone, 'default')}"${color ? ` style="color:${color}"` : ''}>${escapeHtml(p.text)}</p>`;
    case 'badge': return `<span class="badge badge-${str(p.variant, 'neutral')}">${escapeHtml(p.text)}</span>`;
    case 'chip': return `<span class="chip tone-${str(p.tone, 'default')}">${escapeHtml(p.text)}</span>`;
    case 'divider': return `<hr />`;
    case 'alert': return `<div class="alert alert-${str(p.variant, 'info')}" role="status">${escapeHtml(p.text)}</div>`;
    case 'avatar': { const src = safeUrl(p.src); return src ? `<img class="avatar avatar-${str(p.size, 'md')}" src="${escapeHtml(src)}" alt="${escapeHtml(p.name)}" />` : `<span class="avatar avatar-${str(p.size, 'md')}" aria-label="${escapeHtml(p.name)}">${escapeHtml(initials(p.name))}</span>`; }
    case 'icon': return `<span class="icon icon-${escapeHtml(str(p.name, 'star'))} icon-${str(p.size, 'md')}"${color ? ` style="color:${color}"` : ''} aria-hidden="true"></span>`;
    case 'progress': { const v = clamp(num(p.value, 50), 0, 100); return `<label class="progress-wrap">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<progress value="${v}" max="100">${v}%</progress></label>`; }
    case 'rating': return `<span class="rating" aria-label="${clamp(num(p.value, 4), 0, num(p.max, 5))} of ${num(p.max, 5)}">${stars(p.value, p.max)}</span>`;
    case 'calendar': return `<div class="calendar"><div class="calendar-head">${escapeHtml(str(p.month, 'Month'))}</div><div class="calendar-grid">${Array.from({ length: 28 }, (_, i) => `<span>${i + 1}</span>`).join('')}</div></div>`;
    case 'snackbar': return `<div class="snackbar snackbar-${str(p.variant, 'info')}" role="status">${escapeHtml(p.text)}</div>`;
    case 'stepper': { const steps = splitList(p.steps); const active = clamp(num(p.active, 1), 1, Math.max(steps.length, 1)); return `<ol class="stepper">${steps.map((s, i) => `<li class="${i + 1 <= active ? 'done' : ''}">${escapeHtml(s)}</li>`).join('')}</ol>`; }
    case 'image': return `<img src="${escapeHtml(safeUrl(p.src))}" alt="${escapeHtml(p.alt)}" style="border-radius:${radPx(p.radius)}" />`;
    case 'video': { const vsrc = safeUrl(p.src); return vsrc ? `<figure class="videobox${hideCls(p.hideOn)}"><video controls src="${escapeHtml(vsrc)}"></video>${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}</figure>` : `<div class="videobox videobox-empty${hideCls(p.hideOn)}">${escapeHtml(str(p.caption, 'Video'))}</div>`; }
    case 'carousel': return `<div class="carousel">\n${indent(kids, 1)}\n</div>`;
    case 'button': { const cls = `btn btn-${str(p.variant, 'primary')}`; return nav ? `<a class="${cls}" style="border-radius:${radPx(str(p.radius, 'md') === 'none' ? 'md' : p.radius)}" href="${escapeHtml(screenHref(nav))}">${escapeHtml(p.label)}</a>` : `<button class="${cls}" style="border-radius:${radPx(str(p.radius, 'md') === 'none' ? 'md' : p.radius)}">${escapeHtml(p.label)}</button>`; }
    case 'fab': { const label = str(p.label) || str(p.icon, 'plus'); const inner = `<span class="icon icon-${escapeHtml(str(p.icon, 'plus'))}" aria-hidden="true"></span>`; return nav ? `<a class="fab" aria-label="${escapeHtml(label)}" href="${escapeHtml(screenHref(nav))}">${inner}</a>` : `<button class="fab" aria-label="${escapeHtml(label)}">${inner}</button>`; }
    case 'textInput': return `<label class="field">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="${['text', 'email', 'password', 'number'].includes(str(p.kind)) ? str(p.kind) : 'text'}" placeholder="${escapeHtml(p.placeholder)}" /></label>`;
    case 'textarea': return `<label class="field">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<textarea rows="${clamp(num(p.rows, 3), 2, 12)}" placeholder="${escapeHtml(p.placeholder)}"></textarea></label>`;
    case 'dateInput': return `<label class="field">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="${str(p.kind) === 'time' ? 'time' : str(p.kind) === 'datetime' ? 'datetime-local' : 'date'}" /></label>`;
    case 'search': return `<form class="searchbox${hideCls(p.hideOn)}" role="search" onsubmit="return false"><input type="search" placeholder="${escapeHtml(str(p.placeholder, 'Search…'))}" /></form>`;
    case 'fileUpload': return `<label class="field dropzone">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="file"${str(p.accept) === 'image' ? ' accept=\"image/*\"' : str(p.accept) === 'document' ? ' accept=\".pdf,.doc,.docx,.txt\"' : ''} />${p.hint ? `<small>${escapeHtml(p.hint)}</small>` : ''}</label>`;
    case 'checkbox': return `<label class="checkbox"><input type="checkbox"${p.checked === true ? ' checked' : ''} /> ${escapeHtml(p.label)}</label>`;
    case 'toggle': return `<label class="toggle"><input type="checkbox" role="switch"${p.on === true ? ' checked' : ''} /><span>${escapeHtml(p.label)}</span></label>`;
    case 'select': { const opts = splitList(p.options); return `<label class="field">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<select>${opts.length ? opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('') : `<option>${escapeHtml(p.placeholder || 'Select…')}</option>`}</select></label>`; }
    case 'radioGroup': { const opts = splitList(p.options); const sel = clamp(num(p.selected, 1), 1, Math.max(opts.length, 1)); return `<fieldset class="radio-group">${p.label ? `<legend>${escapeHtml(p.label)}</legend>` : ''}${opts.map((o, i) => `<label><input type="radio" name="rg"${i + 1 === sel ? ' checked' : ''} /> ${escapeHtml(o)}</label>`).join('')}</fieldset>`; }
    case 'slider': return `<label class="field">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="range" min="${num(p.min, 0)}" max="${num(p.max, 100)}" value="${num(p.value, 50)}" /></label>`;
    case 'link': return nav ? `<a href="${escapeHtml(screenHref(nav))}">${escapeHtml(p.label)}</a>` : `<a href="${escapeHtml(safeUrl(p.to) || '#')}">${escapeHtml(p.label)}</a>`;
    case 'sideNav': return `<nav class="sidenav${hideCls(p.hideOn)}">${p.title ? `<strong class="sidenav-title">${escapeHtml(p.title)}</strong>` : ''}\n${indent(kids, 1)}\n</nav>`;
    case 'navBar': return `<nav class="navbar${hideCls(p.hideOn)}">${p.brand ? `<strong class="navbar-brand">${escapeHtml(p.brand)}</strong>` : ''}\n${indent(kids, 1)}\n</nav>`;
    case 'breadcrumb': return `<nav class="breadcrumb" aria-label="Breadcrumb">${splitList(p.items).map((x) => `<span>${escapeHtml(x)}</span>`).join('<span class="crumb-sep">›</span>')}</nav>`;
    case 'pagination': { const pages = clamp(num(p.pages, 5), 1, 12); const active = clamp(num(p.active, 1), 1, pages); return `<nav class="pagination" aria-label="Pagination">${Array.from({ length: pages }, (_, i) => `<button class="${i + 1 === active ? 'active' : ''}">${i + 1}</button>`).join('')}</nav>`; }
    case 'list': return `<ul class="list">\n${indent(kids, 1)}\n</ul>`;
    case 'statCard': { const tone = str(p.tone, 'default'); return `<div class="card stat${hideCls(p.hideOn)}" style="padding:1rem;border-radius:8px"><span class="tone-muted">${escapeHtml(p.label)}</span><strong class="stat-value">${escapeHtml(p.value)}</strong>${p.delta ? `<span class="badge badge-${tone === 'default' ? 'neutral' : tone}">${escapeHtml(p.delta)}</span>` : ''}</div>`; }
    case 'table': { const { cols, rows } = tableData(p); return `<table class="table${hideCls(p.hideOn)}"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((_, i) => `<td>${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }
    default: w.push(n.type, `component '${n.type}' has no html-css mapping — skipped`); return `<!-- unsupported: ${escapeHtml(n.type)} -->`;
  }
}
const BASE_CSS = `:root{--fg:#111;--muted:#666;--accent:#2563eb;--accent-2:#7c3aed;--border:#e5e7eb;--ok:#16a34a;--warn:#ca8a04;--bad:#dc2626}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:var(--fg);line-height:1.5}
.app{max-width:960px;margin:0 auto;padding:2rem}
.stack{display:flex}.stack-vertical{flex-direction:column}.stack-horizontal{flex-direction:row}
.grid{display:grid;grid-template-columns:repeat(var(--cols,2),1fr)}
@media (max-width:640px){.grid{grid-template-columns:repeat(var(--cols-m,1),1fr)}.hide-mobile{display:none}}
@media (min-width:641px){.hide-desktop{display:none}}
.card{border:1px solid var(--border)}.card-link{text-decoration:none;color:inherit;display:block}
.form-group fieldset{display:flex;flex-direction:column;gap:.75rem;border:1px solid var(--border);border-radius:8px;padding:1rem;margin:0}.form-group legend{font-weight:600;padding:0 .25rem}
.dropzone{border:1px dashed var(--border);border-radius:8px;padding:1rem}
.navbar{display:flex;align-items:center;gap:1rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}.navbar-brand{margin-inline-end:auto}
.sidenav{display:flex;flex-direction:column;gap:.5rem;border-inline-end:1px solid var(--border);padding-inline-end:1rem;max-width:14rem}.sidenav-title{font-weight:600}
.searchbox input{width:100%;border:1px solid var(--border);border-radius:999px;padding:.5rem 1rem}
.videobox{margin:0}.videobox video{width:100%;border-radius:8px}.videobox-empty{aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:#f3f4f6;color:var(--muted);border-radius:8px}
.card-title{margin:0 0 .5rem}.stat-value{display:block;font-size:1.5rem}.table{width:100%;border-collapse:collapse;font-size:.9rem;text-align:left}.table th{border-bottom:1px solid var(--border);padding:.5rem;font-weight:600}.table td{border-bottom:1px solid var(--border);padding:.5rem}.badge,.chip{display:inline-block;padding:.15rem .5rem;border-radius:999px;background:#eee;font-size:.85rem}
.badge-accent{background:#dbeafe}.badge-success{background:#dcfce7}.badge-warning{background:#fef9c3}.badge-danger{background:#fee2e2}
.tone-muted{color:var(--muted)}.tone-accent{color:var(--accent)}.tone-success{color:var(--ok)}.tone-warning{color:var(--warn)}.tone-danger{color:var(--bad)}
.text-sm{font-size:.875rem}.text-lg{font-size:1.15rem}
.alert{padding:.75rem 1rem;border-radius:8px;border:1px solid var(--border)}.alert-info{background:#eff6ff}.alert-success{background:#f0fdf4}.alert-warning{background:#fefce8}.alert-danger{background:#fef2f2}
.snackbar{padding:.6rem 1rem;border-radius:8px;background:#111;color:#fff;display:inline-block}.snackbar-danger{background:var(--bad)}.snackbar-success{background:var(--ok)}.snackbar-warning{background:var(--warn)}
.avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:#e5e7eb;font-weight:600;overflow:hidden;object-fit:cover}
.avatar-sm{width:1.75rem;height:1.75rem;font-size:.7rem}.avatar-md{width:2.5rem;height:2.5rem;font-size:.9rem}.avatar-lg{width:4rem;height:4rem;font-size:1.3rem}
.icon{display:inline-block;width:1.25rem;height:1.25rem;background:currentColor;border-radius:3px;opacity:.75}.icon-sm{width:1rem;height:1rem}.icon-lg{width:1.75rem;height:1.75rem}
.progress-wrap{display:flex;flex-direction:column;gap:.25rem}progress{width:100%;accent-color:var(--accent)}
.rating{color:var(--warn);letter-spacing:2px}
.calendar{border:1px solid var(--border);border-radius:8px;overflow:hidden}.calendar-head{padding:.5rem 1rem;font-weight:600;border-bottom:1px solid var(--border)}
.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding:.5rem;font-size:.8rem;text-align:center;color:var(--muted)}
.stepper{display:flex;gap:1rem;list-style:none;margin:0;padding:0;counter-reset:step}.stepper li{counter-increment:step;color:var(--muted)}.stepper li::before{content:counter(step) ". "}.stepper li.done{color:var(--accent);font-weight:600}
.tabs-nav{display:flex;gap:.5rem;border-bottom:1px solid var(--border);margin-bottom:1rem}.tab{border:none;background:none;padding:.5rem .75rem;cursor:pointer}.tab.active{border-bottom:2px solid var(--accent);color:var(--accent)}
.dialog{border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:1.25rem;max-width:28rem}.dialog-title{margin:0 0 .75rem}
.drawer{border:1px solid var(--border);border-radius:8px;padding:1rem;max-width:20rem}
.accordion{border:1px solid var(--border);border-radius:8px;padding:.5rem 1rem}.accordion summary{font-weight:600;cursor:pointer}
.carousel{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory}.carousel>*{scroll-snap-align:start;flex:0 0 auto}
.fab{width:3rem;height:3rem;border-radius:50%;background:var(--accent);color:#fff;border:none;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer}
.btn{padding:.5rem 1rem;border:1px solid var(--border);cursor:pointer;display:inline-block;text-decoration:none;color:inherit}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}.btn-ghost{background:transparent}
.field{display:flex;flex-direction:column;gap:.25rem}input,select{padding:.5rem;border:1px solid var(--border);border-radius:6px}
.toggle{display:inline-flex;gap:.5rem;align-items:center}.radio-group{border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:.35rem;padding:.75rem}
.breadcrumb{display:flex;gap:.4rem;color:var(--muted);font-size:.9rem}.crumb-sep{opacity:.5}
.pagination{display:flex;gap:.25rem}.pagination button{border:1px solid var(--border);background:none;border-radius:6px;min-width:2rem;padding:.25rem;cursor:pointer}.pagination button.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.list{padding-left:1.25rem}hr{border:none;border-top:1px solid var(--border)}nav.screens{margin-bottom:1.5rem;display:flex;gap:1rem;flex-wrap:wrap}`;

function themeCss(app: AppModel): string {
  const pr = safeColor(app.themeColors?.primary);
  const sec = safeColor(app.themeColors?.secondary);
  if (!pr && !sec) return BASE_CSS;
  return BASE_CSS.replace('--accent:#2563eb', `--accent:${pr || '#2563eb'}`).replace('--accent-2:#7c3aed', `--accent-2:${sec || '#7c3aed'}`);
}

/** ADR 0348 6a — the generated theme as CSS custom properties (the closed
 *  parity gap the ADR 0343 capability manifests recorded). Absent colors emit
 *  nothing; every target keeps its stock fallback. */
function themeCssVars(app: AppModel): string {
  const pr = safeColor(app.themeColors?.primary);
  const sec = safeColor(app.themeColors?.secondary);
  if (!pr && !sec) return '';
  return `:root {\n${pr ? `  --app-primary: ${pr};\n` : ''}${sec ? `  --app-secondary: ${sec};\n` : ''}}\n`;
}

function genHtmlCss(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  // Grade pass 2026-07-07 (F12): route-derived filenames are slug-sanitized and
  // deduped — duplicate/slashed routes previously collided silently in the ZIP.
  const fileNames = new Map<string, string>();
  const usedFiles = new Set<string>();
  for (const sc of app.screens) {
    let base = (str(sc.route, sc.id).replace(/^\/+/, '').replace(/[^A-Za-z0-9._\/-]/g, '-') || jsId(sc.id) || 'screen').replace(/\/+/g, '-');
    if (!base) base = 'screen';
    let name = `${base}.html`;
    let i = 2;
    while (usedFiles.has(name)) { name = `${base}-${i}.html`; i += 1; }
    usedFiles.add(name);
    fileNames.set(sc.id, name);
  }
  const hrefFor = (id: string): string => fileNames.get(id) ?? `${jsId(id) || 'screen'}.html`;
  const files: ExportedFile[] = [{ path: 'styles.css', content: themeCss(app) }];
  const nav = app.screens.map((s) => `<a href="${escapeHtml(hrefFor(s.id))}">${escapeHtml(s.name)}</a>`).join('');
  for (const s of app.screens) {
    const body = (s.components ?? []).map((c) => htmlNode(c, w, hrefFor)).join('\n');
    const file = hrefFor(s.id);
    files.push({
      path: file,
      content: `<!doctype html>\n<html lang="en" data-theme="${str(app.theme, 'default')}">\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width,initial-scale=1"/>\n<title>${escapeHtml(app.name)} — ${escapeHtml(s.name)}</title>\n<link rel="stylesheet" href="styles.css"/>\n</head>\n<body>\n<div class="app">\n<nav class="screens">${nav}</nav>\n${indent(body, 0)}\n</div>\n</body>\n</html>\n`,
    });
  }
  return files;
}

// ── React + Tailwind ────────────────────────────────────────────────────────────
const NAV_SNIPPET = (id: string): string => ` onClick={() => window.dispatchEvent(new CustomEvent('ab:navigate', { detail: '${jsId(id)}' }))}`;

function reactNode(n: ComponentNode, w: Warn): string {
  const p = n.props ?? {};
  const kids = (n.children ?? []).map((c) => reactNode(c, w)).join('\n');
  const nav = str(p.navigateTo);
  const color = safeColor(p.color);
  const colorStyle = color ? ` style={{ color: '${color}' }}` : '';
  switch (n.type) {
    case 'stack': return `<div className="flex ${str(p.direction, 'vertical') === 'horizontal' ? 'flex-row' : 'flex-col'} ${twGap(p.gap)} ${twPad(p.padding)}${twHide(p.hideOn)}">\n${indent(kids, 1)}\n</div>`;
    case 'grid': return `<div className="grid ${twGap(p.gap)} max-sm:grid-cols-[repeat(${clamp(num(p.columnsMobile, 1), 1, 12)},minmax(0,1fr))]${twHide(p.hideOn)}" style={{ gridTemplateColumns: 'repeat(${clamp(num(p.columns, 2), 1, 12)}, 1fr)' }}>\n${indent(kids, 1)}\n</div>`;
    case 'card': return `<div className="border border-gray-200 ${twPad(str(p.padding, 'md') === 'none' ? 'md' : p.padding) || 'p-4'} ${twRad(str(p.radius, 'md') === 'none' ? 'md' : p.radius) || 'rounded-lg'} ${twShadow(p.shadow)}${twHide(p.hideOn)}"${nav ? NAV_SNIPPET(nav) : ''}>${p.title ? `<h3 className="mb-2 font-semibold">${escapeHtml(p.title)}</h3>` : ''}\n${indent(kids, 1)}\n</div>`;
    case 'form': return `<form className="flex flex-col gap-3 rounded-lg border border-gray-200 ${twPad(str(p.padding, 'md') === 'none' ? 'md' : p.padding) || 'p-4'}${twHide(p.hideOn)}" onSubmit={(e) => e.preventDefault()}>${p.title ? `<h3 className="font-semibold">${escapeHtml(p.title)}</h3>` : ''}\n${indent(kids, 1)}\n</form>`;
    case 'accordion': return `<details${p.open === false ? '' : ' open'} className="rounded-lg border border-gray-200 p-3"><summary className="cursor-pointer font-semibold">${escapeHtml(p.title)}</summary>\n${indent(kids, 1)}\n</details>`;
    case 'tabs': { const labels = splitList(p.labels); return `<div><nav className="mb-4 flex gap-2 border-b border-gray-200">${labels.map((l, i) => `<button className="px-3 py-2${i === 0 ? ' border-b-2 border-blue-600 text-blue-600' : ''}">${escapeHtml(l)}</button>`).join('')}</nav>\n${indent(kids, 1)}\n</div>`; }
    case 'dialog': return `<div role="dialog" aria-label="${escapeHtml(p.title)}" className="max-w-md rounded-xl border border-gray-200 p-5 shadow-xl"><h3 className="mb-3 font-semibold">${escapeHtml(p.title)}</h3>\n${indent(kids, 1)}\n</div>`;
    case 'drawer': return `<aside className="max-w-xs rounded-lg border border-gray-200 p-4">${p.title ? `<h3 className="mb-2 font-semibold">${escapeHtml(p.title)}</h3>` : ''}\n${indent(kids, 1)}\n</aside>`;
    case 'spacer': return `<div style={{ height: '${gap(p.size)}' }} />`;
    case 'heading': { const lvl = clamp(num(Number(p.level), 2), 1, 3); const size = lvl === 1 ? 'text-3xl' : lvl === 2 ? 'text-2xl' : 'text-xl'; return `<h${lvl} className="${size} font-bold"${colorStyle}>${escapeHtml(p.text)}</h${lvl}>`; }
    case 'text': { const size = ({ sm: 'text-sm', md: '', lg: 'text-lg' } as Record<string, string>)[str(p.fontSize, 'md')] ?? ''; const toneCls = ({ default: 'text-gray-700', muted: 'text-gray-400', accent: 'text-blue-600', success: 'text-green-600', warning: 'text-yellow-600', danger: 'text-red-600' } as Record<string, string>)[str(p.tone, 'default')] ?? 'text-gray-700'; return `<p className="${[size, toneCls].filter(Boolean).join(' ')}"${colorStyle}>${escapeHtml(p.text)}</p>`; }
    case 'badge': { const toneMap: Record<string, string> = { neutral: 'bg-gray-100', accent: 'bg-blue-100', success: 'bg-green-100', warning: 'bg-yellow-100', danger: 'bg-red-100' }; return `<span className="inline-block rounded-full px-2 py-0.5 text-sm ${toneMap[str(p.variant, 'neutral')] ?? 'bg-gray-100'}">${escapeHtml(p.text)}</span>`; }
    case 'chip': return `<span className="inline-block rounded-full border border-gray-200 px-2 py-0.5 text-sm">${escapeHtml(p.text)}</span>`;
    case 'divider': return `<hr className="border-gray-200" />`;
    case 'alert': { const toneMap: Record<string, string> = { info: 'bg-blue-50', success: 'bg-green-50', warning: 'bg-yellow-50', danger: 'bg-red-50' }; return `<div role="status" className="rounded-lg border border-gray-200 p-3 ${toneMap[str(p.variant, 'info')] ?? 'bg-blue-50'}">${escapeHtml(p.text)}</div>`; }
    case 'avatar': { const size = ({ sm: 'h-7 w-7 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-16 w-16 text-lg' } as Record<string, string>)[str(p.size, 'md')] ?? 'h-10 w-10'; const src = safeUrl(p.src); return src ? `<img src={'${jsStr(src)}'} alt={'${jsStr(p.name)}'} className="${size} rounded-full object-cover" />` : `<span aria-label="${escapeHtml(p.name)}" className="${size} inline-flex items-center justify-center rounded-full bg-gray-200 font-semibold">${escapeHtml(initials(p.name))}</span>`; }
    case 'icon': return `<span aria-hidden="true" className="inline-block ${({ sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-7 w-7' } as Record<string, string>)[str(p.size, 'md')] ?? 'h-5 w-5'} rounded bg-current opacity-75"${colorStyle} title="${escapeHtml(str(p.name, 'star'))}" />`;
    case 'progress': { const v = clamp(num(p.value, 50), 0, 100); return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<progress value={${v}} max={100} className="w-full" /></label>`; }
    case 'rating': return `<span aria-label="${clamp(num(p.value, 4), 0, num(p.max, 5))} of ${num(p.max, 5)}" className="tracking-widest text-yellow-500">${stars(p.value, p.max)}</span>`;
    case 'calendar': return `<div className="overflow-hidden rounded-lg border border-gray-200"><div className="border-b border-gray-200 p-2 font-semibold">${escapeHtml(str(p.month, 'Month'))}</div><div className="grid grid-cols-7 gap-0.5 p-2 text-center text-xs text-gray-400">${Array.from({ length: 28 }, (_, i) => `<span>${i + 1}</span>`).join('')}</div></div>`;
    case 'snackbar': { const toneMap: Record<string, string> = { info: 'bg-gray-900', success: 'bg-green-600', warning: 'bg-yellow-600', danger: 'bg-red-600' }; return `<div role="status" className="inline-block rounded-lg px-4 py-2 text-white ${toneMap[str(p.variant, 'info')] ?? 'bg-gray-900'}">${escapeHtml(p.text)}</div>`; }
    case 'stepper': { const steps = splitList(p.steps); const active = clamp(num(p.active, 1), 1, Math.max(steps.length, 1)); return `<ol className="flex gap-4">${steps.map((s, i) => `<li className="${i + 1 <= active ? 'font-semibold text-blue-600' : 'text-gray-400'}">${i + 1}. ${escapeHtml(s)}</li>`).join('')}</ol>`; }
    case 'image': return `<img src={'${jsStr(safeUrl(p.src))}'} alt={'${jsStr(p.alt)}'} className="max-w-full ${twRad(p.radius) || 'rounded'}" />`;
    case 'video': { const vsrc = safeUrl(p.src); return vsrc ? `<figure className="flex flex-col gap-1${twHide(p.hideOn)}"><video controls src="${escapeHtml(vsrc)}" className="w-full rounded-lg" />${p.caption ? `<figcaption className="text-sm text-gray-500">${escapeHtml(p.caption)}</figcaption>` : ''}</figure>` : `<div className="flex aspect-video items-center justify-center rounded-lg bg-gray-100 text-gray-400${twHide(p.hideOn)}">${escapeHtml(str(p.caption, 'Video'))}</div>`; }
    case 'carousel': return `<div className="flex snap-x gap-4 overflow-x-auto">\n${indent(kids, 1)}\n</div>`;
    case 'button': { const v: Record<string, string> = { primary: 'bg-[var(--app-primary,#2563eb)] text-white', secondary: 'bg-gray-100', ghost: 'bg-transparent' }; return `<button className="${twRad(str(p.radius, 'md') === 'none' ? 'md' : p.radius) || 'rounded-md'} px-4 py-2 ${v[str(p.variant, 'primary')] ?? v.primary}"${nav ? NAV_SNIPPET(nav) : ''}>${escapeHtml(p.label)}</button>`; }
    case 'fab': return `<button aria-label="${escapeHtml(str(p.label) || str(p.icon, 'plus'))}" className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg"${nav ? NAV_SNIPPET(nav) : ''}>+</button>`;
    case 'textInput': return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="${['text', 'email', 'password', 'number'].includes(str(p.kind)) ? str(p.kind) : 'text'}" placeholder="${escapeHtml(p.placeholder)}" className="rounded-md border border-gray-200 p-2" /></label>`;
    case 'textarea': return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<textarea rows={${clamp(num(p.rows, 3), 2, 12)}} placeholder="${escapeHtml(p.placeholder)}" className="rounded-md border border-gray-200 p-2"></textarea></label>`;
    case 'dateInput': return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="${str(p.kind) === 'time' ? 'time' : str(p.kind) === 'datetime' ? 'datetime-local' : 'date'}" className="rounded-md border border-gray-200 p-2" /></label>`;
    case 'search': return `<form role="search" className="w-full${twHide(p.hideOn)}" onSubmit={(e) => e.preventDefault()}><input type="search" placeholder="${escapeHtml(str(p.placeholder, 'Search…'))}" className="w-full rounded-full border border-gray-200 px-4 py-2" /></form>`;
    case 'fileUpload': return `<label className="flex flex-col gap-1 rounded-lg border border-dashed border-gray-300 p-4">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="file"${str(p.accept) === 'image' ? ' accept=\"image/*\"' : str(p.accept) === 'document' ? ' accept=\".pdf,.doc,.docx,.txt\"' : ''} />${p.hint ? `<small className="text-gray-500">${escapeHtml(p.hint)}</small>` : ''}</label>`;
    case 'checkbox': return `<label className="flex items-center gap-2"><input type="checkbox" defaultChecked={${p.checked === true}} /> ${escapeHtml(p.label)}</label>`;
    case 'toggle': return `<label className="flex items-center gap-2"><input type="checkbox" role="switch" defaultChecked={${p.on === true}} /> ${escapeHtml(p.label)}</label>`;
    case 'select': { const opts = splitList(p.options); return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<select className="rounded-md border border-gray-200 p-2">${opts.length ? opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('') : `<option>${escapeHtml(p.placeholder || 'Select…')}</option>`}</select></label>`; }
    case 'radioGroup': { const opts = splitList(p.options); const sel = clamp(num(p.selected, 1), 1, Math.max(opts.length, 1)); return `<fieldset className="flex flex-col gap-1 rounded-lg border border-gray-200 p-3">${p.label ? `<legend>${escapeHtml(p.label)}</legend>` : ''}${opts.map((o, i) => `<label className="flex items-center gap-2"><input type="radio" name="rg" defaultChecked={${i + 1 === sel}} /> ${escapeHtml(o)}</label>`).join('')}</fieldset>`; }
    case 'slider': return `<label className="flex flex-col gap-1">${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="range" min={${num(p.min, 0)}} max={${num(p.max, 100)}} defaultValue={${num(p.value, 50)}} /></label>`;
    case 'link': return nav ? `<a href="#" className="text-blue-600 underline"${NAV_SNIPPET(nav)}>${escapeHtml(p.label)}</a>` : `<a href="${escapeHtml(safeUrl(p.to) || '#')}" className="text-blue-600 underline">${escapeHtml(p.label)}</a>`;
    case 'sideNav': return `<nav className="flex w-56 flex-col gap-2 border-r border-gray-200 pr-4${twHide(p.hideOn)}">${p.title ? `<strong className="font-semibold">${escapeHtml(p.title)}</strong>` : ''}\n${indent(kids, 1)}\n</nav>`;
    case 'navBar': return `<nav className="flex items-center gap-4 border-b border-gray-200 pb-2${twHide(p.hideOn)}">${p.brand ? `<strong className="mr-auto font-semibold">${escapeHtml(p.brand)}</strong>` : ''}\n${indent(kids, 1)}\n</nav>`;
    case 'breadcrumb': return `<nav aria-label="Breadcrumb" className="flex gap-2 text-sm text-gray-400">${splitList(p.items).map((x) => `<span>${escapeHtml(x)}</span>`).join('<span>›</span>')}</nav>`;
    case 'pagination': { const pages = clamp(num(p.pages, 5), 1, 12); const active = clamp(num(p.active, 1), 1, pages); return `<nav aria-label="Pagination" className="flex gap-1">${Array.from({ length: pages }, (_, i) => `<button className="min-w-8 rounded border border-gray-200 p-1${i + 1 === active ? ' bg-blue-600 text-white' : ''}">${i + 1}</button>`).join('')}</nav>`; }
    case 'list': return `<ul className="list-disc pl-5">\n${indent(kids, 1)}\n</ul>`;
    case 'statCard': { const toneCls = ({ success: 'text-green-600', warning: 'text-yellow-600', danger: 'text-red-600' } as Record<string, string>)[str(p.tone, 'default')] ?? 'text-gray-500'; return `<div className="border border-gray-200 rounded-lg p-4 flex flex-col gap-1${twHide(p.hideOn)}"><span className="text-sm text-gray-500">${escapeHtml(p.label)}</span><strong className="text-2xl font-semibold">${escapeHtml(p.value)}</strong>${p.delta ? `<span className="text-sm ${toneCls}">${escapeHtml(p.delta)}</span>` : ''}</div>`; }
    case 'table': { const { cols, rows } = tableData(p); return `<table className="w-full text-left text-sm${twHide(p.hideOn)}"><thead><tr>${cols.map((c) => `<th className="border-b border-gray-200 p-2 font-semibold">${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((_, i) => `<td className="border-b border-gray-100 p-2">${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }
    default: w.push(n.type, `component '${n.type}' has no react-tailwind mapping — skipped`); return `{/* unsupported: ${escapeHtml(n.type)} */}`;
  }
}
/** The shared React App shell — nav buttons + the ab:navigate CustomEvent listener
 *  that `navigateTo` actions dispatch (real, working screen navigation). */
function reactAppShell(screenNames: (ScreenModel & { comp: string })[], styled: boolean): string {
  const initial = screenNames.find((s) => s.isInitial) ?? screenNames[0];
  const wrap = styled ? 'Container' : 'div';
  const wrapProps = styled ? '' : ' className="mx-auto max-w-3xl p-8"';
  return `import { useEffect, useState } from 'react';\n${styled ? `import { Container, NavBar, NavButton } from './ui.jsx';\n` : ''}${screenNames.map((s) => `import ${s.comp} from './screens/${s.comp}.jsx';`).join('\n')}\n\nconst SCREENS = { ${screenNames.map((s) => `'${jsId(s.id)}': ${s.comp}`).join(', ')} };\n\nexport default function App() {\n  const [screen, setScreen] = useState('${jsId(initial?.id ?? '')}');\n  useEffect(() => {\n    const onNav = (e) => { if (SCREENS[e.detail]) setScreen(e.detail); };\n    window.addEventListener('ab:navigate', onNav);\n    return () => window.removeEventListener('ab:navigate', onNav);\n  }, []);\n  const Current = SCREENS[screen] ?? (() => null);\n  return (\n    <${wrap}${wrapProps}>\n      ${styled ? '<NavBar>' : '<nav className="mb-6 flex gap-4">'}\n${screenNames.map((s) => styled ? `        <NavButton onClick={() => setScreen('${jsId(s.id)}')}>${escapeHtml(s.name)}</NavButton>` : `        <button onClick={() => setScreen('${jsId(s.id)}')} className="text-blue-600">${escapeHtml(s.name)}</button>`).join('\n')}\n      ${styled ? '</NavBar>' : '</nav>'}\n      <Current />\n    </${wrap}>\n  );\n}\n`;
}
function genReactTailwind(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [];
  const screenNames = uniquePascal(app.screens);
  for (const s of screenNames) {
    const body = (s.components ?? []).map((c) => reactNode(c, w)).join('\n');
    files.push({ path: `src/screens/${s.comp}.jsx`, content: `export default function ${s.comp}() {\n  return (\n    <div className="flex flex-col gap-4">\n${indent(body || '<div />', 3)}\n    </div>\n  );\n}\n` });
  }
  const theme = themeCssVars(app);
  if (theme) files.push({ path: 'src/theme.css', content: theme });
  files.push({ path: 'src/App.jsx', content: `${theme ? "import './theme.css';\n" : ''}${reactAppShell(screenNames, false)}` });
  files.push({ path: 'package.json', content: JSON.stringify({ name: pascal(app.name).toLowerCase(), private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18', 'react-dom': '^18' }, devDependencies: { vite: '^5', tailwindcss: '^3', '@vitejs/plugin-react': '^4' } }, null, 2) + '\n' });
  files.push({ path: 'README.md', content: `# ${app.name}\n\n${app.description ?? ''}\n\nGenerated by OpenWOP App Builder (React + Tailwind). Run \`npm install && npm run dev\`.\n` });
  return files;
}

// ── React + styled-components (real mapper, ADR 0305 Phase C) ─────────────────
function styledNode(n: ComponentNode, w: Warn): string {
  const p = n.props ?? {};
  // ADR 0348 6a — hideOn maps to a media-query wrapper (the parity gap the
  // capability manifests recorded for this target).
  const hide = str(p.hideOn);
  const out = styledNodeInner(n, w);
  return hide === 'mobile' || hide === 'desktop' ? `<HideOn $on="${hide}">\n${indent(out, 1)}\n</HideOn>` : out;
}
function styledNodeInner(n: ComponentNode, w: Warn): string {
  const p = n.props ?? {};
  const kids = (n.children ?? []).map((c) => styledNode(c, w)).join('\n');
  const nav = str(p.navigateTo);
  const navAttr = nav ? NAV_SNIPPET(nav) : '';
  const color = safeColor(p.color);
  const colorStyle = color ? ` style={{ color: '${color}' }}` : '';
  switch (n.type) {
    case 'stack': return `<Stack $dir="${str(p.direction, 'vertical')}" $gap="${gap(p.gap)}" $pad="${padRem(p.padding)}">\n${indent(kids, 1)}\n</Stack>`;
    case 'grid': return `<GridBox $cols={${clamp(num(p.columns, 2), 1, 12)}} $colsM={${clamp(num(p.columnsMobile, 1), 1, 12)}} $gap="${gap(p.gap)}">\n${indent(kids, 1)}\n</GridBox>`;
    case 'card': return `<CardBox $radius="${radPx(str(p.radius, 'md') === 'none' ? 'md' : p.radius)}" $shadow="${shadowCss(p.shadow)}"${navAttr}>${p.title ? `<CardTitle>${escapeHtml(p.title)}</CardTitle>` : ''}\n${indent(kids, 1)}\n</CardBox>`;
    case 'form': return `<FormGroup onSubmit={(e) => e.preventDefault()}>${p.title ? `<CardTitle>${escapeHtml(p.title)}</CardTitle>` : ''}\n${indent(kids, 1)}\n</FormGroup>`;
    case 'accordion': return `<Accordion${p.open === false ? '' : ' open'}><summary>${escapeHtml(p.title)}</summary>\n${indent(kids, 1)}\n</Accordion>`;
    case 'tabs': { const labels = splitList(p.labels); return `<div><TabNav>${labels.map((l, i) => `<TabBtn $active={${i === 0}}>${escapeHtml(l)}</TabBtn>`).join('')}</TabNav>\n${indent(kids, 1)}\n</div>`; }
    case 'dialog': return `<DialogBox role="dialog" aria-label="${escapeHtml(p.title)}"><CardTitle>${escapeHtml(p.title)}</CardTitle>\n${indent(kids, 1)}\n</DialogBox>`;
    case 'drawer': return `<DrawerBox>${p.title ? `<CardTitle>${escapeHtml(p.title)}</CardTitle>` : ''}\n${indent(kids, 1)}\n</DrawerBox>`;
    case 'spacer': return `<Spacer $h="${gap(p.size)}" />`;
    case 'heading': { const lvl = clamp(num(Number(p.level), 2), 1, 3); return `<Heading as="h${lvl}" $level={${lvl}}${colorStyle}>${escapeHtml(p.text)}</Heading>`; }
    case 'text': return `<Body $size="${str(p.fontSize, 'md')}" $tone="${str(p.tone, 'default')}"${colorStyle}>${escapeHtml(p.text)}</Body>`;
    case 'badge': return `<BadgePill $variant="${str(p.variant, 'neutral')}">${escapeHtml(p.text)}</BadgePill>`;
    case 'chip': return `<ChipPill>${escapeHtml(p.text)}</ChipPill>`;
    case 'divider': return `<Rule />`;
    case 'alert': return `<AlertBox role="status" $variant="${str(p.variant, 'info')}">${escapeHtml(p.text)}</AlertBox>`;
    case 'avatar': { const src = safeUrl(p.src); return src ? `<AvatarImg $size="${str(p.size, 'md')}" src={'${jsStr(src)}'} alt={'${jsStr(p.name)}'} />` : `<AvatarBubble $size="${str(p.size, 'md')}" aria-label="${escapeHtml(p.name)}">${escapeHtml(initials(p.name))}</AvatarBubble>`; }
    case 'icon': return `<IconGlyph aria-hidden="true" $size="${str(p.size, 'md')}"${colorStyle} title="${escapeHtml(str(p.name, 'star'))}" />`;
    case 'progress': { const v = clamp(num(p.value, 50), 0, 100); return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<progress value={${v}} max={100} /></FieldCol>`; }
    case 'rating': return `<Rating aria-label="${clamp(num(p.value, 4), 0, num(p.max, 5))} of ${num(p.max, 5)}">${stars(p.value, p.max)}</Rating>`;
    case 'calendar': return `<CardBox $radius="8px" $shadow="none"><CardTitle>${escapeHtml(str(p.month, 'Month'))}</CardTitle><CalendarGrid>${Array.from({ length: 28 }, (_, i) => `<span>${i + 1}</span>`).join('')}</CalendarGrid></CardBox>`;
    case 'snackbar': return `<Snack role="status" $variant="${str(p.variant, 'info')}">${escapeHtml(p.text)}</Snack>`;
    case 'stepper': { const steps = splitList(p.steps); const active = clamp(num(p.active, 1), 1, Math.max(steps.length, 1)); return `<Steps>${steps.map((s, i) => `<StepItem $done={${i + 1 <= active}}>${i + 1}. ${escapeHtml(s)}</StepItem>`).join('')}</Steps>`; }
    case 'image': return `<Img src={'${jsStr(safeUrl(p.src))}'} alt={'${jsStr(p.alt)}'} $radius="${radPx(p.radius)}" />`;
    case 'video': { const vsrc = safeUrl(p.src); return vsrc ? `<VideoBox><video controls src="${escapeHtml(vsrc)}" />${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}</VideoBox>` : `<VideoEmpty>${escapeHtml(str(p.caption, 'Video'))}</VideoEmpty>`; }
    case 'carousel': return `<CarouselRow>\n${indent(kids, 1)}\n</CarouselRow>`;
    case 'button': return `<Btn $variant="${str(p.variant, 'primary')}" $radius="${radPx(str(p.radius, 'md') === 'none' ? 'md' : p.radius)}"${navAttr}>${escapeHtml(p.label)}</Btn>`;
    case 'fab': return `<FabBtn aria-label="${escapeHtml(str(p.label) || str(p.icon, 'plus'))}"${navAttr}>+</FabBtn>`;
    case 'textInput': return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<Input type="${['text', 'email', 'password', 'number'].includes(str(p.kind)) ? str(p.kind) : 'text'}" placeholder="${escapeHtml(p.placeholder)}" /></FieldCol>`;
    case 'textarea': return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<TextArea rows={${clamp(num(p.rows, 3), 2, 12)}} placeholder="${escapeHtml(p.placeholder)}" /></FieldCol>`;
    case 'dateInput': return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<Input type="${str(p.kind) === 'time' ? 'time' : str(p.kind) === 'datetime' ? 'datetime-local' : 'date'}" /></FieldCol>`;
    case 'search': return `<SearchBox role="search" onSubmit={(e) => e.preventDefault()}><SearchInput type="search" placeholder="${escapeHtml(str(p.placeholder, 'Search…'))}" /></SearchBox>`;
    case 'fileUpload': return `<DropZone>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<Input type="file"${str(p.accept) === 'image' ? ' accept=\"image/*\"' : str(p.accept) === 'document' ? ' accept=\".pdf,.doc,.docx,.txt\"' : ''} />${p.hint ? `<small>${escapeHtml(p.hint)}</small>` : ''}</DropZone>`;
    case 'checkbox': return `<RowLabel><input type="checkbox" defaultChecked={${p.checked === true}} /> ${escapeHtml(p.label)}</RowLabel>`;
    case 'toggle': return `<RowLabel><input type="checkbox" role="switch" defaultChecked={${p.on === true}} /> ${escapeHtml(p.label)}</RowLabel>`;
    case 'select': { const opts = splitList(p.options); return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<SelectBox>${opts.length ? opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('') : `<option>${escapeHtml(p.placeholder || 'Select…')}</option>`}</SelectBox></FieldCol>`; }
    case 'radioGroup': { const opts = splitList(p.options); const sel = clamp(num(p.selected, 1), 1, Math.max(opts.length, 1)); return `<RadioSet>${p.label ? `<legend>${escapeHtml(p.label)}</legend>` : ''}${opts.map((o, i) => `<RowLabel><input type="radio" name="rg" defaultChecked={${i + 1 === sel}} /> ${escapeHtml(o)}</RowLabel>`).join('')}</RadioSet>`; }
    case 'slider': return `<FieldCol>${p.label ? `<span>${escapeHtml(p.label)}</span>` : ''}<input type="range" min={${num(p.min, 0)}} max={${num(p.max, 100)}} defaultValue={${num(p.value, 50)}} /></FieldCol>`;
    case 'link': return nav ? `<LinkText as="a" href="#"${navAttr}>${escapeHtml(p.label)}</LinkText>` : `<LinkText as="a" href="${escapeHtml(safeUrl(p.to) || '#')}">${escapeHtml(p.label)}</LinkText>`;
    case 'sideNav': return `<NavCol>${p.title ? `<NavBrand>${escapeHtml(p.title)}</NavBrand>` : ''}\n${indent(kids, 1)}\n</NavCol>`;
    case 'navBar': return `<NavRow>${p.brand ? `<NavBrand>${escapeHtml(p.brand)}</NavBrand>` : ''}\n${indent(kids, 1)}\n</NavRow>`;
    case 'breadcrumb': return `<Crumbs aria-label="Breadcrumb">${splitList(p.items).map((x) => `<span>${escapeHtml(x)}</span>`).join('<em>›</em>')}</Crumbs>`;
    case 'pagination': { const pages = clamp(num(p.pages, 5), 1, 12); const active = clamp(num(p.active, 1), 1, pages); return `<PageNav aria-label="Pagination">${Array.from({ length: pages }, (_, i) => `<PageBtn $active={${i + 1 === active}}>${i + 1}</PageBtn>`).join('')}</PageNav>`; }
    case 'list': return `<ListBox>\n${indent(kids, 1)}\n</ListBox>`;
    case 'statCard': { const v = ({ success: 'success', warning: 'warning', danger: 'danger' } as Record<string, string>)[str(p.tone, 'default')] ?? 'neutral'; return `<CardBox $radius="8px" $shadow="none"><Body $size="sm" $tone="muted">${escapeHtml(p.label)}</Body><Heading as="p" $level={2}>${escapeHtml(p.value)}</Heading>${p.delta ? `<BadgePill $variant="${v}">${escapeHtml(p.delta)}</BadgePill>` : ''}</CardBox>`; }
    case 'table': { const { cols, rows } = tableData(p); return `<TableEl><thead><tr>${cols.map((c) => `<Th>${escapeHtml(c)}</Th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((_, i) => `<Td>${escapeHtml(r[i] ?? '')}</Td>`).join('')}</tr>`).join('')}</tbody></TableEl>`; }
    default: w.push(n.type, `component '${n.type}' has no react-styled mapping — skipped`); return `{/* unsupported: ${escapeHtml(n.type)} */}`;
  }
}
const STYLED_UI = `import styled, { css } from 'styled-components';

export const Container = styled.div\`max-width: 48rem; margin: 0 auto; padding: 2rem; font-family: system-ui, sans-serif;\`;
export const NavBar = styled.nav\`display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;\`;
export const NavButton = styled.button\`border: none; background: none; color: #2563eb; cursor: pointer;\`;
export const Stack = styled.div\`display: flex; flex-direction: \${(p) => (p.$dir === 'horizontal' ? 'row' : 'column')}; gap: \${(p) => p.$gap}; padding: \${(p) => p.$pad};\`;
export const GridBox = styled.div\`display: grid; grid-template-columns: repeat(\${(p) => p.$cols}, 1fr); gap: \${(p) => p.$gap}; @media (max-width: 640px) { grid-template-columns: repeat(\${(p) => p.$colsM ?? 1}, 1fr); }\`;
export const HideOn = styled.div\`\${(p) => p.$on === 'mobile' && css\`@media (max-width: 640px) { display: none; }\`} \${(p) => p.$on === 'desktop' && css\`@media (min-width: 641px) { display: none; }\`}\`;
export const CardBox = styled.div\`border: 1px solid #e5e7eb; padding: 1rem; border-radius: \${(p) => p.$radius}; box-shadow: \${(p) => p.$shadow};\`;
export const CardTitle = styled.h3\`margin: 0 0 0.5rem; font-weight: 600;\`;
export const Accordion = styled.details\`border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.5rem 1rem; summary { font-weight: 600; cursor: pointer; }\`;
export const FormGroup = styled.form\`display: flex; flex-direction: column; gap: 0.75rem; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem;\`;
export const TabNav = styled.nav\`display: flex; gap: 0.5rem; border-bottom: 1px solid #e5e7eb; margin-bottom: 1rem;\`;
export const TabBtn = styled.button\`border: none; background: none; padding: 0.5rem 0.75rem; cursor: pointer; \${(p) => p.$active && css\`border-bottom: 2px solid var(--app-primary, #2563eb); color: var(--app-primary, #2563eb);\`}\`;
export const DialogBox = styled.div\`border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.18); padding: 1.25rem; max-width: 28rem;\`;
export const DrawerBox = styled.aside\`border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; max-width: 20rem;\`;
export const Spacer = styled.div\`height: \${(p) => p.$h};\`;
export const Heading = styled.h2\`font-weight: 700; font-size: \${(p) => (p.$level === 1 ? '1.9rem' : p.$level === 3 ? '1.2rem' : '1.5rem')}; margin: 0;\`;
export const Body = styled.p\`margin: 0; font-size: \${(p) => (p.$size === 'sm' ? '0.875rem' : p.$size === 'lg' ? '1.15rem' : '1rem')}; color: \${(p) => ({ muted: '#9ca3af', accent: 'var(--app-primary, #2563eb)', success: '#16a34a', warning: '#ca8a04', danger: '#dc2626' }[p.$tone] ?? '#374151')};\`;
export const BadgePill = styled.span\`display: inline-block; border-radius: 999px; padding: 0.15rem 0.5rem; font-size: 0.85rem; background: \${(p) => ({ accent: '#dbeafe', success: '#dcfce7', warning: '#fef9c3', danger: '#fee2e2' }[p.$variant] ?? '#eee')};\`;
export const ChipPill = styled.span\`display: inline-block; border: 1px solid #e5e7eb; border-radius: 999px; padding: 0.15rem 0.5rem; font-size: 0.85rem;\`;
export const Rule = styled.hr\`border: none; border-top: 1px solid #e5e7eb;\`;
export const AlertBox = styled.div\`border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem 1rem; background: \${(p) => ({ success: '#f0fdf4', warning: '#fefce8', danger: '#fef2f2' }[p.$variant] ?? '#eff6ff')};\`;
const avatarSize = (s) => (s === 'sm' ? '1.75rem' : s === 'lg' ? '4rem' : '2.5rem');
export const AvatarBubble = styled.span\`display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: #e5e7eb; font-weight: 600; width: \${(p) => avatarSize(p.$size)}; height: \${(p) => avatarSize(p.$size)};\`;
export const AvatarImg = styled.img\`border-radius: 50%; object-fit: cover; width: \${(p) => avatarSize(p.$size)}; height: \${(p) => avatarSize(p.$size)};\`;
export const IconGlyph = styled.span\`display: inline-block; background: currentColor; opacity: 0.75; border-radius: 3px; width: \${(p) => (p.$size === 'sm' ? '1rem' : p.$size === 'lg' ? '1.75rem' : '1.25rem')}; height: \${(p) => (p.$size === 'sm' ? '1rem' : p.$size === 'lg' ? '1.75rem' : '1.25rem')};\`;
export const Rating = styled.span\`color: #ca8a04; letter-spacing: 2px;\`;
export const CalendarGrid = styled.div\`display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; font-size: 0.8rem; text-align: center; color: #9ca3af;\`;
export const Snack = styled.div\`display: inline-block; border-radius: 8px; padding: 0.6rem 1rem; color: #fff; background: \${(p) => ({ success: '#16a34a', warning: '#ca8a04', danger: '#dc2626' }[p.$variant] ?? '#111')};\`;
export const Steps = styled.ol\`display: flex; gap: 1rem; list-style: none; margin: 0; padding: 0;\`;
export const StepItem = styled.li\`color: \${(p) => (p.$done ? 'var(--app-primary, #2563eb)' : '#9ca3af')}; font-weight: \${(p) => (p.$done ? 600 : 400)};\`;
export const Img = styled.img\`max-width: 100%; border-radius: \${(p) => p.$radius};\`;
export const CarouselRow = styled.div\`display: flex; gap: 1rem; overflow-x: auto; scroll-snap-type: x mandatory; > * { scroll-snap-align: start; flex: 0 0 auto; }\`;
export const Btn = styled.button\`padding: 0.5rem 1rem; cursor: pointer; border: 1px solid #e5e7eb; border-radius: \${(p) => p.$radius}; \${(p) => p.$variant === 'primary' && css\`background: var(--app-primary, #2563eb); color: #fff; border-color: var(--app-primary, #2563eb);\`} \${(p) => p.$variant === 'ghost' && css\`background: transparent;\`}\`;
export const FabBtn = styled.button\`width: 3rem; height: 3rem; border-radius: 50%; border: none; background: var(--app-primary, #2563eb); color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.2); cursor: pointer; font-size: 1.3rem;\`;
export const FieldCol = styled.label\`display: flex; flex-direction: column; gap: 0.25rem;\`;
export const Input = styled.input\`padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px;\`;
export const TextArea = styled.textarea\`padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; resize: vertical;\`;
export const DropZone = styled.label\`display: flex; flex-direction: column; gap: 0.25rem; border: 1px dashed #d1d5db; border-radius: 8px; padding: 1rem;\`;
export const NavRow = styled.nav\`display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem;\`;
export const NavBrand = styled.strong\`margin-right: auto; font-weight: 600;\`;
export const NavCol = styled.nav\`display: flex; flex-direction: column; gap: 0.5rem; border-right: 1px solid #e5e7eb; padding-right: 1rem; width: 14rem;\`;
export const SearchBox = styled.form\`width: 100%;\`;
export const SearchInput = styled.input\`width: 100%; border: 1px solid #e5e7eb; border-radius: 999px; padding: 0.5rem 1rem;\`;
export const VideoBox = styled.figure\`margin: 0; display: flex; flex-direction: column; gap: 0.25rem; video { width: 100%; border-radius: 8px; }\`;
export const VideoEmpty = styled.div\`aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; background: #f3f4f6; color: #9ca3af; border-radius: 8px;\`;
export const SelectBox = styled.select\`padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px;\`;
export const RowLabel = styled.label\`display: flex; align-items: center; gap: 0.5rem;\`;
export const RadioSet = styled.fieldset\`display: flex; flex-direction: column; gap: 0.35rem; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem;\`;
export const LinkText = styled.a\`color: var(--app-primary, #2563eb); text-decoration: underline; cursor: pointer;\`;
export const Crumbs = styled.nav\`display: flex; gap: 0.4rem; color: #9ca3af; font-size: 0.9rem; em { opacity: 0.5; font-style: normal; }\`;
export const PageNav = styled.nav\`display: flex; gap: 0.25rem;\`;
export const PageBtn = styled.button\`min-width: 2rem; padding: 0.25rem; border: 1px solid #e5e7eb; border-radius: 6px; background: \${(p) => (p.$active ? 'var(--app-primary, #2563eb)' : 'none')}; color: \${(p) => (p.$active ? '#fff' : 'inherit')}; cursor: pointer;\`;
export const ListBox = styled.ul\`padding-left: 1.25rem; margin: 0; display: flex; flex-direction: column; gap: 0.5rem;\`;
export const TableEl = styled.table\`width: 100%; border-collapse: collapse; font-size: 0.9rem; text-align: left;\`;
export const Th = styled.th\`border-bottom: 1px solid #e5e7eb; padding: 0.5rem; font-weight: 600;\`;
export const Td = styled.td\`border-bottom: 1px solid #f3f4f6; padding: 0.5rem;\`;
`;
function genReactStyled(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [{ path: 'src/ui.jsx', content: STYLED_UI }];
  const theme = themeCssVars(app);
  if (theme) files.push({ path: 'src/theme.css', content: theme });
  const screenNames = uniquePascal(app.screens);
  for (const s of screenNames) {
    const body = (s.components ?? []).map((c) => styledNode(c, w)).join('\n');
    files.push({ path: `src/screens/${s.comp}.jsx`, content: `import { Stack, GridBox, CardBox, CardTitle, Accordion, FormGroup, TabNav, TabBtn, DialogBox, DrawerBox, Spacer, Heading, Body, BadgePill, ChipPill, Rule, AlertBox, AvatarBubble, AvatarImg, IconGlyph, Rating, CalendarGrid, Snack, Steps, StepItem, Img, CarouselRow, Btn, FabBtn, FieldCol, Input, TextArea, DropZone, SelectBox, RowLabel, RadioSet, LinkText, NavRow, NavBrand, NavCol, SearchBox, SearchInput, VideoBox, VideoEmpty, TableEl, Th, Td, Crumbs, PageNav, PageBtn, ListBox, HideOn } from '../ui.jsx';\n\nexport default function ${s.comp}() {\n  return (\n    <Stack $dir="vertical" $gap="1rem" $pad="0">\n${indent(body || '<div />', 3)}\n    </Stack>\n  );\n}\n` });
  }
  files.push({ path: 'src/App.jsx', content: `${theme ? "import './theme.css';\n" : ''}${reactAppShell(screenNames, true)}` });
  files.push({ path: 'package.json', content: JSON.stringify({ name: pascal(app.name).toLowerCase(), private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18', 'react-dom': '^18', 'styled-components': '^6' }, devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4' } }, null, 2) + '\n' });
  return files;
}

// ── Vue + Tailwind ───────────────────────────────────────────────────────────────
function genVueTailwind(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [];
  const screenNames = uniquePascal(app.screens);
  // Vue template markup is HTML-shaped → reuse the HTML mapper; navigateTo becomes
  // an anchor the App shell intercepts via the same-id convention (#screen-id).
  const hrefFor = (id: string): string => `#${id}`;
  for (const s of screenNames) {
    const body = (s.components ?? []).map((c) => htmlNode(c, w, hrefFor)).join('\n');
    files.push({ path: `src/screens/${s.comp}.vue`, content: `<template>\n  <div class="flex flex-col gap-4">\n${indent(body || '<div />', 2)}\n  </div>\n</template>\n\n<script setup>\n</script>\n` });
  }
  const initial = screenNames.find((s) => s.isInitial) ?? screenNames[0];
  files.push({ path: 'src/App.vue', content: `<template>\n  <div class="mx-auto max-w-3xl p-8">\n    <nav class="mb-6 flex gap-4">\n${screenNames.map((s) => `      <button class="text-blue-600" @click="screen='${jsId(s.id)}'">${escapeHtml(s.name)}</button>`).join('\n')}\n    </nav>\n    <component :is="SCREENS[screen]" />\n  </div>\n</template>\n\n<script setup>\nimport { ref, onMounted, onUnmounted } from 'vue';\n${screenNames.map((s) => `import ${s.comp} from './screens/${s.comp}.vue';`).join('\n')}\nconst SCREENS = { ${screenNames.map((s) => `'${jsId(s.id)}': ${s.comp}`).join(', ')} };\nconst screen = ref('${jsId(initial?.id ?? '')}');\nconst onHash = () => { const id = location.hash.slice(1); if (SCREENS[id]) screen.value = id; };\nonMounted(() => window.addEventListener('hashchange', onHash));\nonUnmounted(() => window.removeEventListener('hashchange', onHash));\n</script>\n` });
  files.push({ path: 'src/styles.css', content: themeCss(app) });
  files.push({ path: 'package.json', content: JSON.stringify({ name: pascal(app.name).toLowerCase(), private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { vue: '^3' }, devDependencies: { vite: '^5', '@vitejs/plugin-vue': '^5', tailwindcss: '^3' } }, null, 2) + '\n' });
  return files;
}

// ── React Native ──────────────────────────────────────────────────────────────
function rnNode(n: ComponentNode, w: Warn): string {
  const p = n.props ?? {};
  const kids = (n.children ?? []).map((c) => rnNode(c, w)).join('\n');
  const nav = str(p.navigateTo);
  const navComment = nav ? ` onPress={() => { /* navigate: ${jsId(nav)} */ }}` : '';
  switch (n.type) {
    case 'stack': return `<View style={{ flexDirection: '${str(p.direction, 'vertical') === 'horizontal' ? 'row' : 'column'}', gap: ${Number(gap(p.gap).replace('rem', '')) * 16 || 16} }}>\n${indent(kids, 1)}\n</View>`;
    case 'grid': return `<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: ${Number(gap(p.gap).replace('rem', '')) * 16 || 16} }}>\n${indent(kids, 1)}\n</View>`;
    case 'card': return `<View style={styles.card}>${p.title ? `<Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>` : ''}\n${indent(kids, 1)}\n</View>`;
    case 'form': return `<View style={styles.card}>${p.title ? `<Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>` : ''}\n${indent(kids, 1)}\n</View>`;
    case 'accordion': return `<View style={styles.card}><Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>\n${indent(kids, 1)}\n</View>`;
    case 'tabs': { const labels = splitList(p.labels); return `<View><View style={{ flexDirection: 'row', gap: 12 }}>${labels.map((l, i) => `<Text style={${i === 0 ? 'styles.tabActive' : 'styles.tab'}}>${escapeHtml(l)}</Text>`).join('')}</View>\n${indent(kids, 1)}\n</View>`; }
    case 'dialog': return `<View style={styles.dialog}><Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>\n${indent(kids, 1)}\n</View>`;
    case 'drawer': return `<View style={styles.card}>${p.title ? `<Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>` : ''}\n${indent(kids, 1)}\n</View>`;
    case 'spacer': return `<View style={{ height: ${Number(gap(p.size).replace('rem', '')) * 16 || 16} }} />`;
    case 'heading': return `<Text style={styles.heading}>${escapeHtml(p.text)}</Text>`;
    case 'text': return `<Text${str(p.tone, 'default') === 'muted' ? ' style={styles.muted}' : ''}>${escapeHtml(p.text)}</Text>`;
    case 'badge': return `<Text style={styles.badge}>${escapeHtml(p.text)}</Text>`;
    case 'chip': return `<Text style={styles.badge}>${escapeHtml(p.text)}</Text>`;
    case 'divider': return `<View style={styles.divider} />`;
    case 'alert': return `<View style={styles.alert}><Text>${escapeHtml(p.text)}</Text></View>`;
    case 'avatar': { const src = safeUrl(p.src); return src ? `<Image source={{ uri: '${jsStr(src)}' }} style={styles.avatar} accessibilityLabel={'${jsStr(p.name)}'} />` : `<View style={styles.avatar}><Text>${escapeHtml(initials(p.name))}</Text></View>`; }
    case 'icon': return `<Text accessibilityLabel="${escapeHtml(str(p.name, 'star'))} icon" style={styles.icon}>●</Text>`;
    case 'progress': { const v = clamp(num(p.value, 50), 0, 100); return `<View>${p.label ? `<Text>${escapeHtml(p.label)}</Text>` : ''}<View style={styles.progressTrack}><View style={[styles.progressFill, { width: '${v}%' }]} /></View></View>`; }
    case 'rating': return `<Text style={styles.rating}>${stars(p.value, p.max)}</Text>`;
    case 'calendar': return `<View style={styles.card}><Text style={styles.cardTitle}>${escapeHtml(str(p.month, 'Month'))}</Text><Text style={styles.muted}>Calendar placeholder</Text></View>`;
    case 'snackbar': return `<View style={styles.snackbar}><Text style={styles.snackbarText}>${escapeHtml(p.text)}</Text></View>`;
    case 'stepper': { const steps = splitList(p.steps); return `<Text>${steps.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('   ')}</Text>`; }
    case 'image': return `<Image source={{ uri: '${jsStr(safeUrl(p.src))}' }} style={styles.image} accessibilityLabel={'${jsStr(p.alt)}'} />`;
    case 'video': return `<View style={[styles.card, { aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center' }]}><Text style={styles.muted}>${escapeHtml(str(p.caption, 'Video'))}</Text></View>`;
    case 'carousel': return `<ScrollView horizontal style={{ flexDirection: 'row' }}>\n${indent(kids, 1)}\n</ScrollView>`;
    case 'button': return `<Pressable style={styles.button}${navComment}><Text style={styles.buttonText}>${escapeHtml(p.label)}</Text></Pressable>`;
    case 'fab': return `<Pressable style={styles.fab} accessibilityLabel="${escapeHtml(str(p.label) || str(p.icon, 'plus'))}"${navComment}><Text style={styles.buttonText}>+</Text></Pressable>`;
    case 'textInput': return `<TextInput placeholder="${escapeHtml(p.placeholder)}" style={styles.input}${str(p.kind) === 'password' ? ' secureTextEntry' : ''}${str(p.kind) === 'number' ? ' keyboardType="numeric"' : ''} />`;
    case 'textarea': return `<TextInput multiline numberOfLines={${clamp(num(p.rows, 3), 2, 12)}} placeholder="${escapeHtml(p.placeholder)}" style={styles.input} />`;
    case 'dateInput': return `<TextInput placeholder="${str(p.kind) === 'time' ? 'HH:MM' : str(p.kind) === 'datetime' ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD'}" style={styles.input} />`;
    case 'search': return `<TextInput placeholder="${escapeHtml(str(p.placeholder, 'Search…'))}" style={[styles.input, { borderRadius: 999 }]} />`;
    case 'fileUpload': return `<View style={[styles.card, { borderStyle: 'dashed', alignItems: 'center' }]}>${p.label ? `<Text>${escapeHtml(p.label)}</Text>` : ''}<Text style={styles.muted}>${escapeHtml(str(p.hint) || 'Tap to choose a file')}</Text></View>`;
    case 'checkbox': return `<Text>${p.checked === true ? '☑' : '☐'} ${escapeHtml(p.label)}</Text>`;
    case 'toggle': return `<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Switch value={${p.on === true}} /><Text>${escapeHtml(p.label)}</Text></View>`;
    case 'select': return `<TextInput placeholder="${escapeHtml(p.placeholder || 'Select…')}" style={styles.input} />`;
    case 'radioGroup': { const opts = splitList(p.options); const sel = clamp(num(p.selected, 1), 1, Math.max(opts.length, 1)); return `<View>${p.label ? `<Text>${escapeHtml(p.label)}</Text>` : ''}${opts.map((o, i) => `<Text>${i + 1 === sel ? '◉' : '○'} ${escapeHtml(o)}</Text>`).join('')}</View>`; }
    case 'slider': { const v = clamp((num(p.value, 50) - num(p.min, 0)) / Math.max(num(p.max, 100) - num(p.min, 0), 1) * 100, 0, 100); return `<View>${p.label ? `<Text>${escapeHtml(p.label)}</Text>` : ''}<View style={styles.progressTrack}><View style={[styles.progressFill, { width: '${v}%' }]} /></View></View>`; }
    case 'link': return `<Text style={styles.link}${navComment}>${escapeHtml(p.label)}</Text>`;
    case 'sideNav': return `<View style={{ gap: 8 }}>${p.title ? `<Text style={styles.cardTitle}>${escapeHtml(p.title)}</Text>` : ''}\n${indent(kids, 1)}\n</View>`;
    case 'navBar': return `<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>${p.brand ? `<Text style={[styles.cardTitle, { marginRight: 'auto' }]}>${escapeHtml(p.brand)}</Text>` : ''}\n${indent(kids, 1)}\n</View>`;
    case 'breadcrumb': return `<Text style={styles.muted}>${splitList(p.items).map(escapeHtml).join(' › ')}</Text>`;
    case 'pagination': { const pages = clamp(num(p.pages, 5), 1, 12); const active = clamp(num(p.active, 1), 1, pages); return `<Text>${Array.from({ length: pages }, (_, i) => (i + 1 === active ? `[${i + 1}]` : ` ${i + 1} `)).join('')}</Text>`; }
    case 'list': return `<View style={{ gap: 8 }}>\n${indent(kids, 1)}\n</View>`;
    case 'statCard': { const toneColor = ({ success: '#16a34a', warning: '#ca8a04', danger: '#dc2626' } as Record<string, string>)[str(p.tone, 'default')] ?? '#6b7280'; return `<View style={styles.card}><Text style={styles.muted}>${escapeHtml(p.label)}</Text><Text style={styles.heading}>${escapeHtml(p.value)}</Text>${p.delta ? `<Text style={{ color: '${toneColor}' }}>${escapeHtml(p.delta)}</Text>` : ''}</View>`; }
    case 'table': { const { cols, rows } = tableData(p); const rowJsx = (cells: string[], bold: boolean): string => `<View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' }}>${cols.map((_, i) => `<Text style={{ flex: 1, padding: 6${bold ? ", fontWeight: '600'" : ''} }}>${escapeHtml(cells[i] ?? '')}</Text>`).join('')}</View>`; return `<View>${rowJsx(cols, true)}${rows.map((r) => rowJsx(r, false)).join('')}</View>`; }
    default: w.push(n.type, `component '${n.type}' has no react-native mapping — skipped`); return `{/* unsupported: ${escapeHtml(n.type)} */}`;
  }
}
function genReactNative(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [];
  // ADR 0348 6a — the generated theme's primary is baked into the styles
  // (idiomatic for generated RN code; falls back to the stock blue).
  const rnPrimary = safeColor(app.themeColors?.primary) ?? '#2563eb';
  const screenNames = uniquePascal(app.screens);
  for (const s of screenNames) {
    const body = (s.components ?? []).map((cc) => rnNode(cc, w)).join('\n');
    files.push({ path: `src/screens/${s.comp}.jsx`, content: `import { View, Text, Pressable, TextInput, Image, ScrollView, Switch, StyleSheet } from 'react-native';\nexport default function ${s.comp}() {\n  return (\n    <View style={styles.screen}>\n${indent(body || '<View />', 3)}\n    </View>\n  );\n}\nconst styles = StyleSheet.create({ screen: { padding: 16, gap: 16 }, card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, padding: 16, gap: 8 }, dialog: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 20, gap: 8, elevation: 6 }, cardTitle: { fontWeight: '600', marginBottom: 8 }, heading: { fontSize: 22, fontWeight: '700' }, muted: { color: '#9ca3af' }, image: { width: '100%', height: 160 }, avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#e5e7eb', alignItems: 'center', justifyContent: 'center' }, badge: { alignSelf: 'flex-start', backgroundColor: '#eee', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 }, alert: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, padding: 12, backgroundColor: '#eff6ff' }, snackbar: { backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, alignSelf: 'flex-start' }, snackbarText: { color: '#fff' }, icon: { fontSize: 16 }, rating: { color: '#ca8a04', letterSpacing: 2 }, divider: { height: 1, backgroundColor: '#e5e7eb' }, progressTrack: { height: 8, borderRadius: 4, backgroundColor: '#e5e7eb', overflow: 'hidden' }, progressFill: { height: 8, backgroundColor: '${rnPrimary}' }, tab: { color: '#9ca3af' }, tabActive: { color: '${rnPrimary}', fontWeight: '600' }, fab: { width: 48, height: 48, borderRadius: 24, backgroundColor: '${rnPrimary}', alignItems: 'center', justifyContent: 'center' }, button: { backgroundColor: '${rnPrimary}', padding: 12, borderRadius: 6, alignItems: 'center' }, buttonText: { color: '#fff' }, input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6, padding: 8 }, link: { color: '${rnPrimary}' } });\n` });
  }
  const initial = screenNames.find((s) => s.isInitial) ?? screenNames[0];
  files.push({ path: 'App.jsx', content: `import { useState } from 'react';\nimport { SafeAreaView } from 'react-native';\n${screenNames.map((s) => `import ${s.comp} from './src/screens/${s.comp}.jsx';`).join('\n')}\nconst SCREENS = { ${screenNames.map((s) => `'${jsId(s.id)}': ${s.comp}`).join(', ')} };\nexport default function App() {\n  const [screen] = useState('${jsId(initial?.id ?? '')}');\n  const Current = SCREENS[screen] ?? (() => null);\n  return (<SafeAreaView style={{ flex: 1 }}><Current /></SafeAreaView>);\n}\n` });
  files.push({ path: 'package.json', content: JSON.stringify({ name: pascal(app.name).toLowerCase(), version: '0.1.0', main: 'App.jsx', dependencies: { react: '^18', 'react-native': '^0.74' } }, null, 2) + '\n' });
  return files;
}

// ── Flutter ───────────────────────────────────────────────────────────────────
function dartStr(v: unknown): string { return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, ''); }
/** Closed icon-name → Material Icons constant map (fallback: circle). */
const FLUTTER_ICONS: Record<string, string> = {
  home: 'Icons.home', search: 'Icons.search', settings: 'Icons.settings', user: 'Icons.person',
  users: 'Icons.group', heart: 'Icons.favorite', star: 'Icons.star', bell: 'Icons.notifications',
  calendar: 'Icons.calendar_month', clock: 'Icons.schedule', mail: 'Icons.mail', phone: 'Icons.phone',
  camera: 'Icons.photo_camera', image: 'Icons.image', 'map-pin': 'Icons.location_on', send: 'Icons.send',
  plus: 'Icons.add', check: 'Icons.check', x: 'Icons.close', 'arrow-right': 'Icons.arrow_forward',
  'arrow-left': 'Icons.arrow_back', menu: 'Icons.menu', filter: 'Icons.filter_list', download: 'Icons.download',
};
function flutterNode(n: ComponentNode, w: Warn): string {
  const p = n.props ?? {};
  const kids = (n.children ?? []).map((c) => flutterNode(c, w)).join(',\n');
  const nav = str(p.navigateTo);
  const navBody = nav ? `() { /* navigate: ${jsId(nav)} */ }` : '() {}';
  switch (n.type) {
    case 'stack': return str(p.direction, 'vertical') === 'horizontal' ? `Row(children: [\n${indent(kids, 1)}\n])` : `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [\n${indent(kids, 1)}\n])`;
    case 'grid': return `Wrap(spacing: 12, runSpacing: 12, children: [\n${indent(kids, 1)}\n])`;
    case 'card': return `Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.title ? `Text('${dartStr(p.title)}', style: const TextStyle(fontWeight: FontWeight.w600)),` : ''}\n${indent(kids, 1)}\n])))`;
    case 'form': return `Form(child: Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.title ? `Text('${dartStr(p.title)}', style: const TextStyle(fontWeight: FontWeight.w600)),` : ''}\n${indent(kids, 1)}\n]))))`;
    case 'accordion': return `ExpansionTile(initiallyExpanded: ${p.open === false ? 'false' : 'true'}, title: Text('${dartStr(p.title)}'), children: [\n${indent(kids, 1)}\n])`;
    case 'tabs': { const labels = splitList(p.labels); return `Column(children: [Wrap(spacing: 12, children: [${labels.map((l) => `Text('${dartStr(l)}')`).join(', ')}]),\n${indent(kids, 1)}\n])`; }
    case 'dialog': return `Card(elevation: 8, child: Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [Text('${dartStr(p.title)}', style: const TextStyle(fontWeight: FontWeight.w600)),\n${indent(kids, 1)}\n])))`;
    case 'drawer': return `Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.title ? `Text('${dartStr(p.title)}', style: const TextStyle(fontWeight: FontWeight.w600)),` : ''}\n${indent(kids, 1)}\n])))`;
    case 'spacer': return `SizedBox(height: ${Number(gap(p.size).replace('rem', '')) * 16 || 16})`;
    case 'heading': return `Text('${dartStr(p.text)}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold))`;
    case 'text': return `Text('${dartStr(p.text)}')`;
    case 'badge': return `Chip(label: Text('${dartStr(p.text)}'))`;
    case 'chip': return `Chip(label: Text('${dartStr(p.text)}'))`;
    case 'divider': return `const Divider()`;
    case 'alert': return `Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: const Color(0xFFE5E7EB)), borderRadius: BorderRadius.circular(8)), child: Text('${dartStr(p.text)}'))`;
    case 'avatar': { const src = safeUrl(p.src); return src ? `CircleAvatar(backgroundImage: NetworkImage('${dartStr(src)}'))` : `CircleAvatar(child: Text('${dartStr(initials(p.name))}'))`; }
    case 'icon': return `Icon(${FLUTTER_ICONS[str(p.name, 'star')] ?? 'Icons.circle'})`;
    case 'progress': { const v = clamp(num(p.value, 50), 0, 100); return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.label ? `Text('${dartStr(p.label)}'),` : ''} LinearProgressIndicator(value: ${(v / 100).toFixed(2)})])`; }
    case 'rating': { const m = clamp(num(p.max, 5), 1, 10); const v = clamp(Math.round(num(p.value, 4)), 0, m); return `Row(children: [${Array.from({ length: m }, (_, i) => (i < v ? 'const Icon(Icons.star, size: 18)' : 'const Icon(Icons.star_border, size: 18)')).join(', ')}])`; }
    case 'calendar': return `Card(child: Padding(padding: const EdgeInsets.all(16), child: Text('${dartStr(str(p.month, 'Month'))} — calendar')))`;
    case 'snackbar': return `Container(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10), decoration: BoxDecoration(color: const Color(0xFF111111), borderRadius: BorderRadius.circular(8)), child: Text('${dartStr(p.text)}', style: const TextStyle(color: Color(0xFFFFFFFF))))`;
    case 'stepper': { const steps = splitList(p.steps); return `Text('${steps.map((s, i) => `${i + 1}. ${dartStr(s)}`).join('   ')}')`; }
    case 'image': return `Image.network('${dartStr(p.src)}')`;
    case 'video': return `AspectRatio(aspectRatio: 16 / 9, child: Container(color: const Color(0xFFEEEEEE), alignment: Alignment.center, child: Text('${dartStr(str(p.caption, 'Video'))}')))`;
    case 'carousel': return `SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [\n${indent(kids, 1)}\n]))`;
    case 'button': return `ElevatedButton(onPressed: ${navBody}, child: Text('${dartStr(p.label)}'))`;
    case 'fab': return `FloatingActionButton(onPressed: ${navBody}, tooltip: '${dartStr(str(p.label) || str(p.icon, 'plus'))}', child: Icon(${FLUTTER_ICONS[str(p.icon, 'plus')] ?? 'Icons.add'}))`;
    case 'textInput': return `TextField(${str(p.kind) === 'password' ? 'obscureText: true, ' : ''}decoration: InputDecoration(hintText: '${dartStr(p.placeholder)}', labelText: '${dartStr(p.label)}'))`;
    case 'textarea': return `TextField(maxLines: ${clamp(num(p.rows, 3), 2, 12)}, decoration: InputDecoration(hintText: '${dartStr(p.placeholder)}', labelText: '${dartStr(p.label)}'))`;
    case 'dateInput': return `TextField(readOnly: true, decoration: InputDecoration(hintText: '${str(p.kind) === 'time' ? 'HH:MM' : str(p.kind) === 'datetime' ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD'}', labelText: '${dartStr(p.label)}', suffixIcon: const Icon(Icons.calendar_today)))`;
    case 'search': return `TextField(decoration: InputDecoration(hintText: '${dartStr(str(p.placeholder, 'Search…'))}', prefixIcon: const Icon(Icons.search), border: OutlineInputBorder(borderRadius: BorderRadius.circular(999))))`;
    case 'fileUpload': return `OutlinedButton.icon(onPressed: null, icon: const Icon(Icons.upload_file), label: Text('${dartStr(str(p.label) || 'Choose a file')}'))`;
    case 'checkbox': return `Row(children: [Checkbox(value: ${p.checked === true}, onChanged: (_) {}), Text('${dartStr(p.label)}')])`;
    case 'toggle': return `Row(children: [Switch(value: ${p.on === true}, onChanged: (_) {}), Text('${dartStr(p.label)}')])`;
    case 'select': { const opts = splitList(p.options); return `DropdownButton<String>(items: const [${opts.map((o) => `DropdownMenuItem(value: '${dartStr(o)}', child: Text('${dartStr(o)}'))`).join(', ')}], onChanged: (_) {}, hint: Text('${dartStr(p.placeholder || 'Select…')}'))`; }
    case 'radioGroup': { const opts = splitList(p.options); const sel = clamp(num(p.selected, 1), 1, Math.max(opts.length, 1)); return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.label ? `Text('${dartStr(p.label)}'),` : ''}${opts.map((o, i) => `Text('${i + 1 === sel ? '◉' : '○'} ${dartStr(o)}')`).join(', ')}])`; }
    case 'slider': return `Slider(value: ${clamp(num(p.value, 50), num(p.min, 0), num(p.max, 100))}, min: ${num(p.min, 0)}, max: ${num(p.max, 100)}, onChanged: (_) {})`;
    case 'link': return `TextButton(onPressed: ${navBody}, child: Text('${dartStr(p.label)}'))`;
    case 'sideNav': return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${p.title ? `Text('${dartStr(p.title)}', style: const TextStyle(fontWeight: FontWeight.w600)),` : ''}\n${indent(kids, 1)}\n])`;
    case 'navBar': return `Wrap(spacing: 16, crossAxisAlignment: WrapCrossAlignment.center, children: [${p.brand ? `Text('${dartStr(p.brand)}', style: const TextStyle(fontWeight: FontWeight.w600)),` : ''}\n${indent(kids, 1)}\n])`;
    case 'breadcrumb': return `Text('${splitList(p.items).map(dartStr).join(' › ')}')`;
    case 'pagination': { const pages = clamp(num(p.pages, 5), 1, 12); const active = clamp(num(p.active, 1), 1, pages); return `Text('${Array.from({ length: pages }, (_, i) => (i + 1 === active ? `[${i + 1}]` : ` ${i + 1} `)).join('')}')`; }
    case 'list': return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [\n${indent(kids, 1)}\n])`;
    case 'statCard': return `Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('${dartStr(p.label)}', style: const TextStyle(color: Colors.grey)), Text('${dartStr(p.value)}', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold))${p.delta ? `, Text('${dartStr(p.delta)}')` : ''}])))`;
    case 'table': { const { cols, rows } = tableData(p); const cell = (t: string, bold: boolean): string => `Padding(padding: const EdgeInsets.all(6), child: Text('${dartStr(t)}'${bold ? ', style: const TextStyle(fontWeight: FontWeight.w600)' : ''}))`; const trows = [`TableRow(children: [${cols.map((c) => cell(c, true)).join(', ')}])`, ...rows.map((r) => `TableRow(children: [${cols.map((_, i) => cell(r[i] ?? '', false)).join(', ')}])`)]; return `Table(border: TableBorder.all(color: const Color(0xFFE5E7EB)), children: [${trows.join(', ')}])`; }
    default: w.push(n.type, `component '${n.type}' has no flutter mapping — skipped`); return `const SizedBox.shrink()`;
  }
}
/** ADR 0348 6a — the generated theme seeds the Material color scheme. */
function flutterTheme(app: AppModel): string {
  const pr = safeColor(app.themeColors?.primary);
  return pr ? ` theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF${pr.slice(1).toUpperCase()}))),` : '';
}
function genFlutter(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [];
  const screenNames = uniquePascal(app.screens);
  for (const s of screenNames) {
    const body = (s.components ?? []).map((cc) => flutterNode(cc, w)).join(',\n');
    files.push({ path: `lib/screens/${s.comp.toLowerCase()}.dart`, content: `import 'package:flutter/material.dart';\nclass ${s.comp} extends StatelessWidget {\n  const ${s.comp}({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return Scaffold(body: SafeArea(child: Padding(padding: const EdgeInsets.all(16), child: ListView(children: [\n${indent(body || 'const SizedBox.shrink()', 3)}\n]))));\n  }\n}\n` });
  }
  const initial = screenNames.find((s) => s.isInitial) ?? screenNames[0];
  files.push({ path: 'lib/main.dart', content: `import 'package:flutter/material.dart';\nimport 'screens/${(initial?.comp ?? 'home').toLowerCase()}.dart';\nvoid main() => runApp(const MyApp());\nclass MyApp extends StatelessWidget {\n  const MyApp({super.key});\n  @override\n  Widget build(BuildContext context) => MaterialApp(title: '${dartStr(app.name)}',${flutterTheme(app)} home: const ${initial?.comp ?? 'Home'}());\n}\n` });
  files.push({ path: 'pubspec.yaml', content: `name: ${pascal(app.name).toLowerCase()}\ndescription: '${String(app.description ?? 'Generated by OpenWOP App Builder').replace(/'/g, "''").replace(/[\n\r]/g, ' ')}'\nversion: 0.1.0\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n` });
  return files;
}

// ── Next.js App Router (audit gap #6) ─────────────────────────────────────────
// Reuses the SAME injection-hardened tailwind JSX mapper as react-tailwind
// (`reactNode`), so every catalog type is covered with zero new prop semantics.
// One file-route per screen (the initial screen is `/`); tap navigation keeps
// the shared `ab:navigate` event, translated to router.push by a client bridge.
function genNextjs(app: AppModel, warnings: string[]): ExportedFile[] {
  const w = makeWarn(warnings);
  const files: ExportedFile[] = [];
  const screenNames = uniquePascal(app.screens);
  const initial = screenNames.find((s) => s.isInitial) ?? screenNames[0];
  const routeOf = (s: ScreenModel): string => (s.id === initial?.id ? '/' : `/${jsId(s.id)}`);

  for (const s of screenNames) {
    const body = (s.components ?? []).map((c) => reactNode(c, w)).join('\n');
    // Screens carry onClick handlers (ab:navigate), so they are client components.
    files.push({
      path: `components/screens/${s.comp}.jsx`,
      content: `'use client';\n\nexport default function ${s.comp}() {\n  return (\n    <div className="flex flex-col gap-4">\n${indent(body || '<div />', 3)}\n    </div>\n  );\n}\n`,
    });
    const routePath = s.id === initial?.id ? 'app/page.jsx' : `app/${jsId(s.id)}/page.jsx`;
    if (files.some((f) => f.path === routePath)) { w.push(s.id, `screen '${s.id}' collides with an existing route path — skipped`); continue; }
    files.push({
      path: routePath,
      content: `import ${s.comp} from '${s.id === initial?.id ? '../components' : '../../components'}/screens/${s.comp}.jsx';\n\nexport default function Page() {\n  return <${s.comp} />;\n}\n`,
    });
  }

  // ab:navigate → router.push (the same event the shared mapper emits).
  files.push({
    path: 'components/NavBridge.jsx',
    content: `'use client';\nimport { useEffect } from 'react';\nimport { useRouter } from 'next/navigation';\n\nconst ROUTES = { ${screenNames.map((s) => `'${jsId(s.id)}': '${routeOf(s)}'`).join(', ')} };\n\nexport default function NavBridge() {\n  const router = useRouter();\n  useEffect(() => {\n    const onNav = (e) => { const to = ROUTES[e.detail]; if (to) router.push(to); };\n    window.addEventListener('ab:navigate', onNav);\n    return () => window.removeEventListener('ab:navigate', onNav);\n  }, [router]);\n  return null;\n}\n`,
  });

  files.push({
    path: 'app/layout.jsx',
    content: `import Link from 'next/link';\nimport NavBridge from '../components/NavBridge.jsx';\nimport './globals.css';\n\nexport const metadata = { title: '${jsStr(app.name)}' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body className="mx-auto max-w-3xl p-8">\n        <NavBridge />\n        <nav className="mb-6 flex gap-4 flex-wrap">\n${screenNames.map((s) => `          <Link className="text-blue-600" href="${routeOf(s)}">${escapeHtml(s.name)}</Link>`).join('\n')}\n        </nav>\n        {children}\n      </body>\n    </html>\n  );\n}\n`,
  });
  files.push({ path: 'app/globals.css', content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${themeCssVars(app)}` });
  files.push({ path: 'tailwind.config.js', content: `module.exports = { content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'], theme: { extend: {} }, plugins: [] };\n` });
  files.push({ path: 'postcss.config.js', content: `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n` });
  files.push({ path: 'package.json', content: JSON.stringify({ name: pascal(app.name).toLowerCase(), private: true, version: '0.1.0', scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '^14', react: '^18', 'react-dom': '^18' }, devDependencies: { tailwindcss: '^3', autoprefixer: '^10', postcss: '^8' } }, null, 2) + '\n' });
  files.push({ path: 'README.md', content: `# ${app.name}\n\n${app.description ?? ''}\n\nGenerated by OpenWOP App Builder (Next.js App Router + Tailwind). Run \`npm install && npm run dev\`.\n` });
  return files;
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const GENERATORS: Record<ExportTarget, (app: AppModel, warnings: string[]) => ExportedFile[]> = {
  'html-css': genHtmlCss,
  'react-tailwind': genReactTailwind,
  'react-styled': genReactStyled,
  'vue-tailwind': genVueTailwind,
  'react-native': genReactNative,
  'flutter': genFlutter,
  'nextjs': genNextjs,
};

/** Generate framework-native source for `target`. Unknown component types become
 *  warnings (never errors), so export stays additive over the evolving catalog.
 *  Data bindings are expanded (sample rows unrolled + interpolated) up front. */
export function generate(target: ExportTarget, app: AppModel): GenerateResult {
  const warnings: string[] = [];
  const files = GENERATORS[target](expandBindings(stripHidden(app)), warnings);
  return { files, warnings };
}
