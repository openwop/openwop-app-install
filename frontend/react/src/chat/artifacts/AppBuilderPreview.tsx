/**
 * canvas.app-builder inline renderer (ADR 0153 Phase 2 + ADR 0305 Phase C). Renders a
 * structured app design — the `canvas.app-builder` artifact payload — inline in the
 * chat artifact workbench: each screen as a framed device preview of its component
 * tree, plus the navigation connectors. READ-ONLY here; the full-screen editor reuses
 * this SAME renderer (one renderer) via the `editPaths` seam (ADR 0305 Phase B).
 *
 * SAFETY: the component tree is approximated from a CLOSED set of host components —
 * every text value is React-escaped, images use a plain <img src> behind a scheme
 * allowlist, icons resolve from a closed name→glyph map (unknown → neutral glyph),
 * theme colors are re-validated as 6-hex before touching a CSS variable, and an
 * unknown component `type` renders as an inert labeled placeholder. No untrusted
 * HTML, no code execution (the constrained-JSON-vs-pinned-catalog model, ADR 0153 §R4).
 *
 * Data binding (ADR 0305 Phase C): in READ mode a bound `list` unrolls its children
 * per design-time sample row with `{{field}}` interpolation (plain text substitution —
 * values render as React text). In EDIT mode (`editPaths`) the authored tree renders
 * once, so paths stay 1:1 with the document.
 */

import { Button } from '../../ui/Button.js';
import type { ComponentType, CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import {
  HomeIcon, SearchIcon, SettingsIcon, UserIcon, UsersIcon, HeartIcon, StarIcon,
  BellIcon, CalendarIcon, ClockIcon, MailIcon, PhoneIcon, CameraIcon, ImageIcon,
  MapPinIcon, SendIcon, PlusIcon, CheckIcon, XIcon, ArrowRightIcon, ArrowLeftIcon,
  MenuIcon, FilterIcon, DownloadIcon, CircleIcon, PlayIcon,
} from '../../ui/icons/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';
import { STATE_ATTR } from '../../canvas/dnd.js';

/** ART-3: untrusted model-provided image URL — allow only web/data/relative
 *  schemes (mirrors EventStreamView.resolveAssetUrl's posture). */
function safeImageSrc(u: string): string | null {
  return /^(https?:|data:image\/|\/(?!\/))/i.test(u.trim()) ? u : null;
}
/** Links in a generated document are still untrusted input. Keep the runtime's
 * navigation surface closed to web URLs and same-origin paths. */
function safeHref(u: string): string | null {
  return /^(https?:\/\/|\/(?!\/))/i.test(u.trim()) ? u.trim() : null;
}
/** Only a strict 6-digit hex reaches a CSS variable (architect amendment 3). */
function safeHex(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}
/** Relative luminance (sRGB, WCAG formula) of a validated 6-hex color. */
function relLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

/** Closed icon vocabulary — keep in step with the backend catalog's ICON_NAMES
 *  (dual-list by package boundary; unknown names fall back to a neutral glyph). */
const ICON_MAP: Record<string, ComponentType<{ size?: number; style?: CSSProperties }>> = {
  home: HomeIcon, search: SearchIcon, settings: SettingsIcon, user: UserIcon,
  users: UsersIcon, heart: HeartIcon, star: StarIcon, bell: BellIcon,
  calendar: CalendarIcon, clock: ClockIcon, mail: MailIcon, phone: PhoneIcon,
  camera: CameraIcon, image: ImageIcon, 'map-pin': MapPinIcon, send: SendIcon,
  plus: PlusIcon, check: CheckIcon, x: XIcon, 'arrow-right': ArrowRightIcon,
  'arrow-left': ArrowLeftIcon, menu: MenuIcon, filter: FilterIcon, download: DownloadIcon,
};
export const APP_BUILDER_ICON_NAMES = Object.keys(ICON_MAP);

interface CompNode { type: string; props?: Record<string, unknown>; children?: CompNode[]; hidden?: boolean; actions?: unknown[]; bindings?: Record<string, { path?: string; fallback?: string; format?: string }> }
interface Screen { id: string; name: string; route?: string; isInitial?: boolean; components?: CompNode[] }
interface Connector { from: string; to: string; trigger?: string; label?: string }
interface DataSource { id: string; name?: string; fields?: string[]; rows?: Record<string, unknown>[] }
interface App {
  name: string; description?: string; theme?: string;
  themeColors?: { primary?: string; secondary?: string };
  screens: Screen[]; connectors?: Connector[]; dataSources?: DataSource[];
}

const MAX_DEPTH = 20;
type Row = Record<string, unknown>;

const interp = (s: string, row?: Row): string =>
  row ? s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, f: string) => String(row[f] ?? '')) : s;

function pstrRaw(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = props?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** A form control can mutate preview state only through an explicit two-way
 * `state.<id>` binding. The type's declared bindings remain the source of truth;
 * this renderer never invents variable names from labels or component paths. */
function boundStateName(node: CompNode, prop: string, ctx: Ctx): string | undefined {
  if (!ctx.act) return undefined;
  const path = node.bindings?.[prop]?.path;
  const match = typeof path === 'string' ? /^state\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(path) : null;
  return match?.[1];
}
function textControlProps(node: CompNode, prop: string, p: Record<string, unknown> | undefined, ctx: Ctx): Record<string, unknown> {
  const state = boundStateName(node, prop, ctx);
  const value = p?.[prop];
  if (!state) return value === undefined ? {} : { defaultValue: String(value) };
  return { value: value === undefined || value === null ? '' : String(value), onChange: () => undefined, [STATE_ATTR]: state };
}
function boolControlProps(node: CompNode, prop: string, p: Record<string, unknown> | undefined, ctx: Ctx): Record<string, unknown> {
  const state = boundStateName(node, prop, ctx);
  const checked = p?.[prop] === true || p?.[prop] === 'true';
  if (!state) return { defaultChecked: checked };
  return { checked, onChange: () => undefined, [STATE_ATTR]: state };
}
function pnum(props: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = props?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const splitList = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const initials = (name: string | undefined): string => (name ?? '').split(/\s+/).map((w) => w.charAt(0)).join('').slice(0, 2).toUpperCase() || '?';

function parseApp(content: string): App | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !Array.isArray(o.screens)) return null;
  return raw as App;
}

interface Ctx { row?: Row; sources: Map<string, DataSource>; vars?: Record<string, unknown>; act?: boolean }

/** ADR 0345 3b — resolve `state.X` binding paths into effective prop values
 *  (fallback + minimal formatting). Other roots (`op.*`/`model.*`/`source.*`)
 *  resolve to the fallback until the 3c mock runtime — never a silent blank. */
function resolveBoundProps(node: CompNode, vars: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const bindings = node.bindings;
  if (!bindings || typeof bindings !== 'object') return node.props;
  const out: Record<string, unknown> = { ...node.props };
  for (const [prop, b] of Object.entries(bindings)) {
    if (!b || typeof b.path !== 'string') continue;
    const segs = b.path.split('.');
    const [root, head] = segs;
    let val: unknown;
    if (root === 'state' && vars && head && head in vars) val = vars[head];
    // ADR 0345 3c — op results live under the reserved `op.<id>` key; deeper
    // segments walk the result object ({status, rows, message}).
    if (root === 'op' && vars && head) {
      let cur: unknown = vars[`op.${head}`];
      for (const seg of segs.slice(2)) {
        cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[seg] : undefined;
      }
      val = cur;
    }
    if (val === undefined || val === null || val === '') { out[prop] = b.fallback ?? ''; continue; }
    if (b.format === 'number' && typeof val === 'number') out[prop] = new Intl.NumberFormat().format(val);
    else if (b.format === 'currency' && typeof val === 'number') out[prop] = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(val);
    else if (b.format === 'date') out[prop] = String(val);
    else out[prop] = typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? String(val) : JSON.stringify(val);
  }
  return out;
}

/** Render one component node from the closed catalog. Unknown types → inert placeholder.
 *
 *  `path` (ADR 0305 Phase B) is the editor seam: when present, the component's
 *  root element is stamped `data-cv-path="i.j.k"` + `draggable` so the editor
 *  can select/drag via DELEGATED events without forking this renderer. Chat
 *  usage passes no path — output is unchanged. Paths index into ONE screen's
 *  tree (the editor renders a single-screen doc), so they align with `selPath`. */
function CompView({ node, depth, path, apath, ctx, insideForm = false }: { node: CompNode; depth: number; path?: number[]; apath?: number[]; ctx: Ctx; insideForm?: boolean }): JSX.Element {
  const { t } = useTranslation('chat');
  // Grade pass (code F18): visible truncation instead of silently eating nodes.
  if (depth > MAX_DEPTH) return <span className="canvas-ab__unknown">…</span>;
  // ADR 0344 2b — hidden nodes: absent from READ renders (chat card, board
  // node, preview, share); dimmed with a labeled chip in EDIT mode so authors
  // can still select and un-hide them.
  if (node.hidden) {
    if (!path) return <></>;
    return (
      <div className="canvas-ab__hidden-node">
        <span className="chip chip--muted canvas-ab__hide-chip">{t('appBuilderHiddenNode')}</span>
        <CompView node={{ ...node, hidden: false }} depth={depth} ctx={ctx} path={path} />
      </div>
    );
  }
  // ADR 0345 3b — live preview: state bindings resolve into effective props.
  const p = ctx.vars ? resolveBoundProps(node, ctx.vars) : node.props;
  const pstr = (key: string): string | undefined => { const v = pstrRaw(p, key); return v === undefined ? undefined : interp(v, ctx.row); };
  const kids = Array.isArray(node.children) ? node.children : [];
  const renderKids = (childCtx: Ctx = ctx, childInsideForm = insideForm): JSX.Element[] =>
    kids.map((c, i) => <CompView key={i} node={c} depth={depth + 1} ctx={childCtx} insideForm={childInsideForm} {...(path ? { path: [...path, i] } : {})} {...(apath ? { apath: [...apath, i] } : {})} />);
  const childEls = renderKids();
  // Editor-mode markers (inert in chat): the path attr + native drag handle.
  // Runtime mode (ADR 0345 3b): action-bearing nodes get the delegated act stamp.
  const dp = {
    ...(path ? { 'data-cv-path': path.join('.'), draggable: true } : {}),
    ...(ctx.act && apath && Array.isArray(node.actions) && node.actions.length ? { 'data-cv-act': apath.join('.') } : {}),
  };
  const color = safeHex(p?.color);
  const colorStyle: CSSProperties | undefined = color ? { color } : undefined;
  const hide = pstr('hideOn');
  const hideCls = hide === 'mobile' ? ' canvas-ab--hide-mobile' : hide === 'desktop' ? ' canvas-ab--hide-desktop' : '';
  // Grade pass (UX F5): in EDIT mode the dotted outline alone was unexplained —
  // a labeled chip says WHY the component looks different.
  const hideChip = path && (hide === 'mobile' || hide === 'desktop')
    ? <span className="chip chip--muted canvas-ab__hide-chip">{t(hide === 'mobile' ? 'appBuilderHiddenMobile' : 'appBuilderHiddenDesktop')}</span>
    : null;
  switch (node.type) {
    case 'stack':
      return <div {...dp} className={`canvas-ab__stack canvas-ab__stack--${pstr('direction') === 'horizontal' ? 'h' : 'v'} canvas-ab__pad--${pstr('padding') ?? 'none'}${hideCls}`}>{hideChip}{childEls}</div>;
    case 'grid': {
      // Grade pass (F12): columnsMobile flows through a CSS var the stylesheet
      // consumes under its narrow media query — parity with html-css + preview.
      const gridVars = { gridTemplateColumns: `repeat(${clampN(pnum(p, 'columns', 2), 1, 12)}, 1fr)`, '--ab-cols-m': String(clampN(pnum(p, 'columnsMobile', 1), 1, 12)) } as CSSProperties;
      return <div {...dp} className={`canvas-ab__grid${hideCls}`} style={gridVars}>{hideChip}{childEls}</div>;
    }
    case 'card':
      return <div {...dp} className={`canvas-ab__card canvas-ab__rad--${pstr('radius') ?? 'md'} canvas-ab__shadow--${pstr('shadow') ?? 'none'}${hideCls}`} {...(pstr('navigateTo') ? { 'data-cv-nav': pstr('navigateTo') } : {})}>{hideChip}{pstr('title') ? <div className="canvas-ab__card-title">{pstr('title')}</div> : null}{childEls}</div>;
    case 'form':
      // The viewer catches submit at its stage boundary and routes a declared
      // `on: 'submit'` action through the closed runtime. Preventing the native
      // navigation here keeps chat, editor preview and public share deterministic.
      return <form {...dp} className={`canvas-ab__form${hideCls}`} onSubmit={(e) => e.preventDefault()}>{hideChip}{pstr('title') ? <div className="canvas-ab__card-title">{pstr('title')}</div> : null}{renderKids(ctx, true)}</form>;
    case 'accordion':
      return <details {...dp} className="canvas-ab__accordion" open={p?.open !== false}><summary>{pstr('title') ?? ''}</summary>{childEls}</details>;
    case 'tabs': {
      const labels = splitList(pstr('labels'));
      return <div {...dp} className="canvas-ab__tabs"><div className="canvas-ab__tabs-nav">{labels.map((l, i) => <span key={i} className={`canvas-ab__tab${i === 0 ? ' is-active' : ''}`}>{l}</span>)}</div>{childEls}</div>;
    }
    case 'dialog':
      return <div {...dp} className="canvas-ab__dialog" role="group" aria-label={pstr('title') ?? ''}><div className="canvas-ab__card-title">{pstr('title') ?? ''}</div>{childEls}</div>;
    case 'drawer':
      return <div {...dp} className={`canvas-ab__drawer canvas-ab__drawer--${pstr('side') === 'right' ? 'r' : 'l'}`}>{pstr('title') ? <div className="canvas-ab__card-title">{pstr('title')}</div> : null}{childEls}</div>;
    case 'spacer':
      return <div {...dp} className={`canvas-ab__spacer canvas-ab__spacer--${pstr('size') ?? 'md'}`} aria-hidden="true" />;
    case 'heading': {
      const level = pstr('level');
      const Heading = level === '1' ? 'h1' : level === '3' ? 'h3' : 'h2';
      return <Heading {...dp} className={`canvas-ab__heading canvas-ab__heading--${level === '1' ? '1' : level === '3' ? '3' : '2'}`} style={colorStyle}>{pstr('text') ?? ''}</Heading>;
    }
    case 'text':
      return <p {...dp} className={`canvas-ab__text canvas-ab__text--${pstr('fontSize') ?? 'md'} canvas-ab__tone--${pstr('tone') ?? 'default'}`} style={colorStyle}>{pstr('text') ?? ''}</p>;
    case 'badge':
      return <span {...dp} className={`chip canvas-ab__badge canvas-ab__badge--${pstr('variant') ?? 'neutral'}`}>{pstr('text') ?? ''}</span>;
    case 'chip':
      return <span {...dp} className={`chip canvas-ab__chip canvas-ab__tone--${pstr('tone') ?? 'default'}`}>{pstr('text') ?? ''}</span>;
    case 'divider':
      return <hr {...dp} className="canvas-ab__divider" />;
    case 'alert':
      return <div {...dp} className={`canvas-ab__alert canvas-ab__alert--${pstr('variant') ?? 'info'}`} role="note">{pstr('text') ?? ''}</div>;
    case 'avatar': {
      const raw = pstr('src'); const safe = raw ? safeImageSrc(raw) : null;
      const size = pstr('size') ?? 'md';
      return safe
        ? <img {...dp} className={`canvas-ab__avatar canvas-ab__avatar--${size}`} src={safe} alt={pstr('name') ?? ''} loading="lazy" />
        : <span {...dp} role="img" className={`canvas-ab__avatar canvas-ab__avatar--${size}`} aria-label={pstr('name') ?? ''}>{initials(pstr('name'))}</span>;
    }
    case 'icon': {
      const Glyph = ICON_MAP[pstr('name') ?? ''] ?? CircleIcon;
      const size = pstr('size') === 'sm' ? 14 : pstr('size') === 'lg' ? 24 : 18;
      return <span {...dp} className="canvas-ab__icon" style={colorStyle} title={pstr('name') ?? ''} aria-hidden="true"><Glyph size={size} /></span>;
    }
    case 'progress': {
      const v = clampN(pnum(p, 'value', 50), 0, 100);
      return <span {...dp} className="canvas-ab__progress-wrap">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<progress className="canvas-ab__progress" value={v} max={100} aria-label={pstr('label') ?? `${v}%`}><span className="canvas-ab__progress-fill" style={{ width: `${v}%` }} /></progress></span>;
    }
    case 'rating': {
      const max = clampN(pnum(p, 'max', 5), 1, 10);
      const v = clampN(Math.round(pnum(p, 'value', 4)), 0, max);
      return <span {...dp} className="canvas-ab__rating" role="img" aria-label={t('appBuilderRating', { v, max })}>{Array.from({ length: max }, (_, i) => <StarIcon key={i} size={14} {...(i < v ? {} : { style: { opacity: 0.25 } })} />)}</span>;
    }
    case 'calendar':
      return <div {...dp} className="canvas-ab__calendar"><div className="canvas-ab__calendar-head">{pstr('month') ?? ''}</div><div className="canvas-ab__calendar-grid" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <span key={i}>{i + 1}</span>)}</div></div>;
    case 'snackbar':
      return <div {...dp} className={`canvas-ab__snackbar canvas-ab__snackbar--${pstr('variant') ?? 'info'}`} role="note">{pstr('text') ?? ''}</div>;
    case 'stepper': {
      const steps = splitList(pstr('steps'));
      const active = clampN(pnum(p, 'active', 1), 1, Math.max(steps.length, 1));
      return <ol {...dp} className="canvas-ab__stepper">{steps.map((s, i) => <li key={i} className={i + 1 <= active ? 'is-done' : ''}>{s}</li>)}</ol>;
    }
    case 'image': {
      const raw = pstr('src'); const safe = raw ? safeImageSrc(raw) : null;
      return safe ? <img {...dp} className={`canvas-ab__image canvas-ab__rad--${pstr('radius') ?? 'none'}`} src={safe} alt={pstr('alt') ?? ''} loading="lazy" /> : <></>;
    }
    case 'carousel':
      return <div {...dp} className="canvas-ab__carousel">{childEls}</div>;
    case 'button': {
      /* A plain button inside a form is a native submit affordance, matching
       * the catalog's form contract. Click/navigation actions stay buttons so
       * they never accidentally submit a surrounding form. */
      const hasClickAction = Array.isArray(node.actions) && node.actions.some((a) => a && typeof a === 'object' && (a as { on?: unknown }).on === 'click');
      const submits = insideForm && !pstr('navigateTo') && !hasClickAction;
      const variant = pstr('variant') === 'ghost' ? 'quiet' : pstr('variant') === 'secondary' ? 'secondary' : 'primary';
      return <Button variant={variant} type={submits ? 'submit' : 'button'} {...dp} className={`canvas-ab__button canvas-ab__button--${pstr('variant') ?? 'primary'} canvas-ab__rad--${pstr('radius') ?? 'md'}`} {...(pstr('navigateTo') ? { 'data-cv-nav': pstr('navigateTo') } : {})}>{pstr('label') ?? ''}</Button>;
    }
    case 'fab': {
      const Glyph = ICON_MAP[pstr('icon') ?? 'plus'] ?? PlusIcon;
      return <Button variant="primary" type="button" {...dp} className="canvas-ab__fab" aria-label={pstr('label') ?? pstr('icon') ?? ''} {...(pstr('navigateTo') ? { 'data-cv-nav': pstr('navigateTo') } : {})}><Glyph size={16} aria-hidden /></Button>;
    }
    case 'textInput': {
      const kind = pstr('kind');
      const type = kind === 'email' || kind === 'password' || kind === 'number' ? kind : 'text';
      return <label {...dp} className="canvas-ab__field">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<input className="canvas-ab__input" type={type} placeholder={pstr('placeholder')} {...textControlProps(node, 'value', p, ctx)} /></label>;
    }
    case 'textarea':
      return <label {...dp} className="canvas-ab__field">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<textarea className="canvas-ab__input canvas-ab__input--area" rows={clampN(pnum(p, 'rows', 3), 2, 12)} placeholder={pstr('placeholder')} {...textControlProps(node, 'value', p, ctx)} /></label>;
    case 'dateInput': {
      const kind = pstr('kind');
      const type = kind === 'time' ? 'time' : kind === 'datetime' ? 'datetime-local' : 'date';
      return <label {...dp} className="canvas-ab__field">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<input className="canvas-ab__input" type={type} {...textControlProps(node, 'value', p, ctx)} /></label>;
    }
    case 'sideNav':
      return <nav {...dp} className={`canvas-ab__sidenav${hideCls}`}>{hideChip}{pstr('title') ? <strong className="canvas-ab__navbar-brand">{pstr('title')}</strong> : null}{childEls}</nav>;
    case 'navBar':
      return <nav {...dp} className={`canvas-ab__navbar${hideCls}`}>{hideChip}{pstr('brand') ? <strong className="canvas-ab__navbar-brand">{pstr('brand')}</strong> : null}{childEls}</nav>;
    case 'video':
      return <span {...dp} className={`canvas-ab__video${hideCls}`} role="img" aria-label={pstr('caption') ?? 'Video'}>{hideChip}<span className="canvas-ab__video-glyph" aria-hidden="true"><PlayIcon size={18} /></span>{pstr('caption') ? <span className="canvas-ab__video-caption">{pstr('caption')}</span> : null}</span>;
    case 'search':
      return <label {...dp} className={`canvas-ab__field${hideCls}`} role="search">{hideChip}<span className="sr-only">{pstr('label') ?? 'Search'}</span><input className="canvas-ab__input canvas-ab__input--search" type="search" placeholder={pstr('placeholder') ?? 'Search…'} {...textControlProps(node, 'value', p, ctx)} /></label>;
    case 'fileUpload': {
      const hintId = `canvas-ab-upload-hint-${apath?.join('-') ?? path?.join('-') ?? 'control'}`;
      return <label {...dp} className="canvas-ab__field canvas-ab__dropzone">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<input type="file" disabled aria-describedby={pstr('hint') ? hintId : undefined} /><span id={pstr('hint') ? hintId : undefined} className="canvas-ab__dropzone-body">{pstr('hint') ?? ''}</span></label>;
    }
    case 'checkbox':
      return <label {...dp} className="canvas-ab__checkbox"><input type="checkbox" {...boolControlProps(node, 'checked', p, ctx)} /> {pstr('label') ?? ''}</label>;
    case 'toggle':
      return <label {...dp} className="canvas-ab__toggle"><input type="checkbox" role="switch" {...boolControlProps(node, 'on', p, ctx)} /> <span className={`canvas-ab__toggle-track${p?.on === true || p?.on === 'true' ? ' is-on' : ''}`} aria-hidden="true"><span className="canvas-ab__toggle-knob" /></span> {pstr('label') ?? ''}</label>;
    case 'select': {
      const opts = splitList(pstr('options'));
      return <label {...dp} className="canvas-ab__field">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<select className="canvas-ab__input canvas-ab__input--select" {...textControlProps(node, 'value', p, ctx)}>{pstr('placeholder') ? <option value="">{pstr('placeholder')}</option> : null}{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>;
    }
    case 'radioGroup': {
      const opts = splitList(pstr('options'));
      const sel = clampN(pnum(p, 'selected', 1), 1, Math.max(opts.length, 1));
      const groupName = `canvas-ab-radio-${apath?.join('-') ?? path?.join('-') ?? 'group'}`;
      const state = boundStateName(node, 'value', ctx);
      const value = p?.value === undefined ? String(sel) : String(p.value);
      return <fieldset {...dp} className="canvas-ab__radio-group">{pstr('label') ? <legend className="canvas-ab__field-label">{pstr('label')}</legend> : null}{opts.map((o, i) => <label key={o} className="canvas-ab__radio"><input type="radio" name={groupName} value={String(i + 1)} checked={state ? value === String(i + 1) : undefined} defaultChecked={!state && i + 1 === sel} onChange={state ? () => undefined : undefined} {...(state ? { [STATE_ATTR]: state } : {})} /> {o}</label>)}</fieldset>;
    }
    case 'slider': {
      const min = pnum(p, 'min', 0); const max = Math.max(pnum(p, 'max', 100), min + 1);
      const v = clampN(pnum(p, 'value', 50), min, max);
      return <label {...dp} className="canvas-ab__progress-wrap">{pstr('label') ? <span className="canvas-ab__field-label">{pstr('label')}</span> : null}<input className="canvas-ab__progress" type="range" min={min} max={max} aria-label={pstr('label') ?? t('appBuilderSlider', { v, min, max })} {...textControlProps(node, 'value', p, ctx)} /></label>;
    }
    case 'link': {
      const to = pstr('navigateTo');
      const href = safeHref(pstr('to') ?? '');
      if (to) return <a {...dp} className="canvas-ab__link" href={`#${encodeURIComponent(to)}`} data-cv-nav={to}>{pstr('label') ?? ''}</a>;
      return href ? <a {...dp} className="canvas-ab__link" href={href}>{pstr('label') ?? ''}</a> : <span {...dp} className="canvas-ab__link">{pstr('label') ?? ''}</span>;
    }
    case 'breadcrumb':
      return <span {...dp} className="canvas-ab__breadcrumb">{splitList(pstr('items')).map((x, i, arr) => <span key={i}>{x}{i < arr.length - 1 ? <span className="canvas-ab__crumb-sep" aria-hidden="true"> › </span> : null}</span>)}</span>;
    case 'pagination': {
      const pages = clampN(pnum(p, 'pages', 5), 1, 12);
      const active = clampN(pnum(p, 'active', 1), 1, pages);
      return <span {...dp} className="canvas-ab__pagination">{Array.from({ length: pages }, (_, i) => <span key={i} className={`canvas-ab__page${i + 1 === active ? ' is-active' : ''}`}>{i + 1}</span>)}</span>;
    }
    case 'list': {
      const bind = pstrRaw(p, 'bind');
      const src = bind ? ctx.sources.get(bind) : undefined;
      // ADR 0345 3c — a runtime list bound to an operation result unrolls the
      // mock rows (same row-interpolation contract as sample sources).
      const itemsBinding = node.bindings?.items?.path;
      if (ctx.vars && typeof itemsBinding === 'string' && itemsBinding.startsWith('op.') && kids.length && !path) {
        const opKey = `op.${itemsBinding.split('.')[1]}`;
        const res = ctx.vars[opKey];
        const rows = res && typeof res === 'object' && Array.isArray((res as { rows?: unknown }).rows) ? (res as { rows: Row[] }).rows : [];
        return <div className="canvas-ab__list">{rows.map((row, r) => <div key={r} className="canvas-ab__list-row">{kids.map((c, i) => <CompView key={i} node={c} depth={depth + 1} ctx={{ ...ctx, row }} />)}</div>)}</div>;
      }
      // READ mode: unroll sample rows. EDIT mode (path present): render the authored
      // tree once so data-cv-path stays 1:1 with the document; show the binding chip.
      if (src && Array.isArray(src.rows) && src.rows.length && kids.length && !path) {
        return <div className="canvas-ab__list">{src.rows.map((row, r) => <div key={r} className="canvas-ab__list-row">{kids.map((c, i) => <CompView key={i} node={c} depth={depth + 1} ctx={{ ...ctx, row: row as Row }} />)}</div>)}</div>;
      }
      return <div {...dp} className="canvas-ab__list">{bind ? <span className="chip chip--muted canvas-ab__bind-chip">{src ? src.name ?? src.id : bind}</span> : null}{childEls}</div>;
    }
    // Audit gap #5 cherry-picks (catalog 37): a KPI stat tile + a static table.
    case 'statCard':
      return (
        <span {...dp} className="canvas-ab__stat">
          <span className="canvas-ab__stat-label">{pstr('label') ?? ''}</span>
          <strong className="canvas-ab__stat-value">{pstr('value') ?? ''}</strong>
          {pstr('delta') ? <span className={`chip canvas-ab__badge canvas-ab__badge--${pstr('tone') === 'default' ? 'neutral' : pstr('tone') ?? 'neutral'}`}>{pstr('delta')}</span> : null}
        </span>
      );
    case 'table': {
      const cols = splitList(pstr('columns'));
      // Grade data-F3: limit-split each row to the column count — the LAST
      // column absorbs extra commas ("$8,560" stays whole). Mirrors the
      // backend generators' tableData (dual by package boundary).
      const rows = (pstrRaw(p, 'rows') ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const parts = l.split(',').map((c) => c.trim());
        return cols.length && parts.length > cols.length
          ? [...parts.slice(0, cols.length - 1), parts.slice(cols.length - 1).join(',')]
          : parts;
      });
      return (
        <table {...dp} className="canvas-ab__table">
          <thead><tr>{cols.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{cols.map((_, ci) => <td key={ci}>{interp(r[ci] ?? '', ctx.row)}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    default:
      return <span {...dp} className="canvas-ab__unknown">{node.type}</span>;
  }
}

/** The generated theme colors → CSS custom properties, ONE owner (ADR 0342
 *  Phase 0): the full deck, the editor preview, and the board's screen nodes all
 *  read this — a forked copy is how the on-primary ink bug (UX F17) happened. */
export function appThemeVars(themeColors?: { primary?: string; secondary?: string }): CSSProperties {
  const themeVars: CSSProperties = {};
  const pr = safeHex(themeColors?.primary);
  const sec = safeHex(themeColors?.secondary);
  if (pr) {
    (themeVars as Record<string, string>)['--canvas-ab-primary'] = pr;
    // Grade pass (UX F17): text ON the user primary was theme-flipping
    // `--color-surface` — a dark user primary in dark mode went dark-on-dark.
    // Pick the ink by the primary's own relative luminance (theme-independent).
    (themeVars as Record<string, string>)['--canvas-ab-on-primary'] = relLuma(pr) > 0.5 ? 'var(--canvas-ab-ink-dark)' : 'var(--canvas-ab-ink-light)';
  }
  if (sec) (themeVars as Record<string, string>)['--canvas-ab-secondary'] = sec;
  return themeVars;
}

/** The pure deck rendering (no chrome) — shared by the inline chat card and the
 *  full-screen editor's live preview (ADR 0153 Phase 2b), so there is ONE renderer. */
export function AppBuilderContentView({ content, editPaths, runtimeState, actPaths }: { content: string; editPaths?: boolean; runtimeState?: Record<string, unknown>; actPaths?: boolean }): JSX.Element {
  const { t } = useTranslation('chat');
  const app = parseApp(content);
  if (!app) return <Notice variant="error">{t('appBuilderInvalid')}</Notice>;
  const theme = app.theme && app.theme.trim() ? app.theme : 'default';
  const sources = new Map((app.dataSources ?? []).filter((s) => typeof s?.id === 'string').map((s) => [s.id, s]));
  const ctx: Ctx = { sources, ...(runtimeState ? { vars: runtimeState } : {}), ...(actPaths ? { act: true } : {}) };
  const themeVars = appThemeVars(app.themeColors);
  return (
    <div className="canvas-ab" data-theme={theme} style={themeVars}>
      <div className="canvas-ab__head">
        <h3 className="canvas-ab__app-name">{app.name}</h3>
        {app.description ? <p className="canvas-ab__app-desc">{app.description}</p> : null}
      </div>
      <ol className="canvas-ab__screens" aria-label={t('appBuilderScreensLabel')}>
        {app.screens.map((screen) => (
          <li key={screen.id} className="canvas-ab__screen">
            <div className="canvas-ab__screen-bar">
              <span className="canvas-ab__screen-name">{screen.name}</span>
              {screen.isInitial ? <span className="chip chip--accent canvas-ab__home">{t('appBuilderInitial')}</span> : null}
              {screen.route ? <span className="canvas-ab__screen-route">{screen.route}</span> : null}
            </div>
            <div className="canvas-ab__device">
              {(screen.components ?? []).map((c, i) => <CompView key={i} node={c} depth={0} ctx={ctx} {...(editPaths ? { path: [i] } : {})} {...(actPaths ? { apath: [i] } : {})} />)}
            </div>
          </li>
        ))}
      </ol>
      {app.connectors && app.connectors.length ? (
        <div className="canvas-ab__flows">
          <span className="canvas-ab__flows-label">{t('appBuilderFlowsLabel')}</span>
          <ul className="canvas-ab__flow-list">
            {app.connectors.map((c, i) => (
              <li key={i} className="canvas-ab__flow">{c.label ? `${c.label}: ` : ''}{c.from} → {c.to}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Render ONE screen's device body — the node body for the app-builder graph /
 *  screen-flow surface (ADR 0323). Reuses the SAME safe `CompView` renderer as
 *  the full preview (no forked render path); it draws no per-screen chrome (the
 *  graph node supplies its own device frame + title bar). */
export function AppScreenPreview({ screen, theme, themeColors, dataSources }: {
  screen: { id: string; name: string; components?: CompNode[] };
  theme?: string;
  themeColors?: { primary?: string; secondary?: string };
  dataSources?: DataSource[];
}): JSX.Element {
  const sources = new Map((dataSources ?? []).filter((s): s is DataSource => typeof s?.id === 'string').map((s) => [s.id, s]));
  const ctx: Ctx = { sources };
  const th = theme && theme.trim() ? theme : 'default';
  return (
    <div className="canvas-ab canvas-ab--node" data-theme={th} style={appThemeVars(themeColors)}>
      <div className="canvas-ab__device">
        {(screen.components ?? []).map((c, i) => <CompView key={i} node={c} depth={0} ctx={ctx} />)}
      </div>
    </div>
  );
}

/** The chat inline renderer: the read-only deck + an "Open in editor" entry (ADR 0153
 *  Phase 2b) that deep-links to the full-screen editor, seeding an editable working copy
 *  from THIS run artifact (keyed by its provenance runId:nodeId — replay-safe; the
 *  artifact itself is never mutated). */
export function AppBuilderPreview({ artifact, content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { runId, nodeId } = artifact.provenance ?? {};
  const canEdit = Boolean(runId && nodeId);
  return (
    <div className="canvas-ab-card">
      {canEdit ? (
        <div className="canvas-ab-card__bar">
          <Button variant="secondary" size="sm" onClick={() => navigate(`/app-builder/new?fromArtifact=${encodeURIComponent(`${runId}:${nodeId}`)}`)}>
            {t('appBuilderOpenEditor')}
          </Button>
        </div>
      ) : null}
      <AppBuilderContentView content={content} />
    </div>
  );
}
