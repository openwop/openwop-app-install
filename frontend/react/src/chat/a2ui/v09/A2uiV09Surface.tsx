/**
 * A2uiV09Surface — renders a folded A2UI v0.9 surface (RFC 0209, ADR 0749)
 * inside the existing chat A2UI card (`../A2uiSurfaceCard.tsx`). Not a new chat
 * panel: the card registry mounts it for `ui.a2ui-surface` exactly as it mounts
 * the 0.9.1 tree, and its actions ride the same resume/exchange handlers.
 *
 * Invariants (each has a probe in `../__tests__/`):
 *  - render-needs-root   — nothing of the surface renders, and no action is
 *    enabled, until the fold holds a `root` (a quiet pending line instead).
 *  - no-code-exec        — every string is a React text node; unknown content
 *    was refused by `profile.ts` before this file sees it.
 *  - no-network-egress   — the profile has no URL-bearing component, and the
 *    only side effect is `onAction('resolve' | 'exchange', value)`.
 *  - action-confinement  — a Button's event name picks between exactly those
 *    two; the value is its `context` resolved against the data model, or the
 *    whole model when it has none (RFC 0209 §C.10).
 *
 * Deliberate choices:
 *  - `theme.primaryColor` is IGNORED. An agent-supplied color painted into app
 *    chrome is a way to dress an untrusted surface as the host's own UI; the
 *    card keeps the host's tokens. `agentDisplayName` is shown as provenance.
 *  - Agent headings never become real `<h1>`–`<h5>`: `role="heading"` offset
 *    below the chat's own outline, as the 0.9.1 renderer does.
 *  - `validationRegexp` is not evaluated in script (RFC 0209 unresolved Q2,
 *    ReDoS); only the pure `required` check gates submission.
 */
import { Fragment, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, type ButtonVariant } from '../../../ui/Button.js';
import { Notice } from '../../../ui/Notice.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../../../ui/Field.js';
import type { CardProps } from '../../registry/types.js';
import { getAt, setAt, type SurfaceState } from './fold.js';
import type { Binding, DynString, DynValue, RequiredCheck, V09Component } from './profile.js';

const MAX_DEPTH = 32;

/**
 * ADR 0755 (WIT-A2UI-1) — the most elements one surface may EXPAND to. The
 * profile bounds each array (256 children, 512 components) but not the product:
 * `children` may legally repeat an id, so root→256×a, a→256×b, b→256×c is four
 * components and ~16.7M rendered elements — a few KB of agent output that
 * freezes the tab. 2048 = 4 × the 512-component cap: every surface the profile
 * admits without id repetition fits, with headroom for honest reuse.
 */
export const MAX_RENDER_NODES = 2048;

/**
 * The expansion walk `render` and `textOf` would perform, counted and cut off at
 * the budget — O(MAX_RENDER_NODES), never O(the expansion). A Button's child is
 * walked because `labelOf` walks it. Same path/depth guards as `render`.
 */
export function exceedsRenderBudget(components: ReadonlyMap<string, V09Component>, budget = MAX_RENDER_NODES): boolean {
  let count = 0;
  const walk = (id: string, depth: number, path: ReadonlySet<string>): boolean => {
    const c = components.get(id);
    if (!c || depth > MAX_DEPTH || path.has(id)) return false;
    if (++count > budget) return true;
    const inner = new Set(path).add(id);
    if (c.component === 'Column' || c.component === 'Row') return c.children.some((k) => walk(k, depth + 1, inner));
    if (c.component === 'Card' || c.component === 'Button') return walk(c.child, depth + 1, inner);
    return false;
  };
  return walk('root', 0, new Set());
}

/** An agent may bind an ISO 8601 value (`2026-09-24T10:00:00Z`); the native
 *  inputs accept only their own lexical forms and show EMPTY for anything else. */
function toInputValue(v: string, type: 'date' | 'time' | 'datetime-local'): string {
  const m = /^(\d{4}-\d{2}-\d{2})?T?(\d{2}:\d{2})?/.exec(v);
  const date = m?.[1];
  const time = m?.[2] ?? (/^(\d{2}:\d{2})/.exec(v)?.[1]);
  if (type === 'date') return date ?? '';
  if (type === 'time') return time ?? '';
  return date && time ? `${date}T${time}` : date ? `${date}T00:00` : '';
}
const isBinding = (v: unknown): v is Binding => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Binding).path === 'string';

/** A required check fails when its bound value is empty. */
function checkFails(c: RequiredCheck, model: unknown): boolean {
  const v = getAt(model, c.condition.args.value.path);
  if (v === undefined || v === null || v === false) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

const JUSTIFY: Record<string, string> = { start: 'u-justify-start', center: 'u-justify-center', end: 'u-justify-end', spaceBetween: 'u-justify-between', spaceAround: 'u-justify-between', spaceEvenly: 'u-justify-between' };
const ALIGN: Record<string, string> = { start: 'u-items-start', center: 'u-items-center', end: 'u-items-end' };
const HEADING_SIZE: Record<string, string> = { h1: 'u-fs-16', h2: 'u-fs-15', h3: 'u-fs-14', h4: 'u-fs-13', h5: 'u-fs-13' };
const BUTTON_VARIANT: Record<string, ButtonVariant> = { primary: 'primary', default: 'secondary', borderless: 'quiet' };

export function A2uiV09Surface({ state, onAction, isLoading }: { state: SurfaceState; onAction: CardProps['onAction']; isLoading?: boolean | undefined }): JSX.Element {
  const { t } = useTranslation('chat');
  // The user's edits fold over the surface's own data model: bound controls
  // read and write here; a literal-valued control keeps its own local value
  // (A2UI: only bound values are data), which is never submitted.
  const [model, setModel] = useState<unknown>(state.dataModel);
  const [literals, setLiterals] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const hintId = useId();

  const resolve = (v: DynString | undefined): string => (v === undefined ? '' : isBinding(v) ? String(getAt(model, v.path) ?? '') : v);
  // `Object.hasOwn`, not `in`: a component id may legally be `constructor`.
  const valueOf = (c: { id: string; value?: unknown }): unknown => (isBinding(c.value) ? getAt(model, c.value.path) : Object.hasOwn(literals, c.id) ? literals[c.id] : c.value);
  const write = (c: { id: string; value?: unknown }, v: unknown): void => {
    const bound = c.value;
    if (isBinding(bound)) setModel((m: unknown) => setAt(m, bound.path, v));
    else setLiterals((s) => ({ ...s, [c.id]: v }));
    setTouched((s) => new Set(s).add(c.id));
  };

  // Every component reachable from `root`, cycle- and depth-guarded — the set
  // whose required checks gate the actions.
  const reachable = useMemo(() => {
    const seen = new Set<string>();
    const walk = (id: string, depth: number): void => {
      if (depth > MAX_DEPTH || seen.has(id)) return;
      const c = state.components.get(id);
      if (!c) return;
      seen.add(id);
      if (c.component === 'Column' || c.component === 'Row') c.children.forEach((k) => walk(k, depth + 1));
      if (c.component === 'Card' || c.component === 'Button') walk(c.child, depth + 1);
    };
    walk('root', 0);
    return seen;
  }, [state.components]);

  if (!state.renderable) {
    // render-needs-root: the surface itself is not rendered, and no action exists.
    return <p className="u-fs-13 u-text-muted u-m-0" role="status">{state.deleted ? t('a2uiV09Closed') : t('a2uiV09Pending')}</p>;
  }

  const failing = [...reachable].some((id) => {
    const c = state.components.get(id);
    return !!c && 'checks' in c && (c.checks ?? []).some((k) => checkFails(k, model));
  });
  // A failing required check gates SUBMISSION (`resume` carries the data
  // model); an `exchange` is a conversation turn — asking a question must not
  // wait on the form being complete.
  const disabledFor = (name: 'resume' | 'exchange'): boolean => isLoading === true || (name === 'resume' && failing);
  const errorFor = (c: V09Component): string | undefined => {
    if (!('checks' in c) || !touched.has(c.id)) return undefined;
    return (c.checks ?? []).find((k) => checkFails(k, model))?.message;
  };
  const isRequired = (c: V09Component): boolean => 'checks' in c && (c.checks ?? []).length > 0;
  const help = (c: V09Component): string | undefined => (c.accessibility?.description !== undefined ? resolve(c.accessibility.description) : undefined);

  /** The text a subtree shows — a Button renders its child as a plain label
   *  (a block-level heading inside a <button> is invalid content). */
  // Defence in depth for WIT-A2UI-1: the card refuses an over-budget surface
  // before mounting this, and these walks also stop spending past the budget.
  let spent = 0;
  // The same ancestor-path cycle guard as `render` and `exceedsRenderBudget`, so the
  // label walk spends exactly what the pre-check counted (without it a
  // self-referencing label child passed the pre-check and drained the shared budget).
  const textOf = (id: string, depth: number, path: ReadonlySet<string>): string => {
    const c = state.components.get(id);
    if (!c || depth > MAX_DEPTH || path.has(id) || ++spent > MAX_RENDER_NODES) return '';
    const inner = new Set(path).add(id);
    if (c.component === 'Text') return resolve(c.text);
    if (c.component === 'Card') return textOf(c.child, depth + 1, inner);
    if (c.component === 'Row' || c.component === 'Column') return c.children.map((k) => textOf(k, depth + 1, inner)).filter(Boolean).join(' ');
    return '';
  };
  /** A Button's visible label; its a11y label only when it shows no text. */
  const labelOf = (b: Extract<V09Component, { component: 'Button' }>, path: ReadonlySet<string>): string => textOf(b.child, 0, path)
    || (b.accessibility?.label !== undefined ? resolve(b.accessibility.label) : '')
    || t('a2uiV09ActionFallback');

  const submit = (ctx: Record<string, DynValue> | undefined): unknown => {
    if (!ctx) return model;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) out[k] = isBinding(v) ? getAt(model, v.path) : v;
    return out;
  };

  const render = (id: string, depth: number, path: ReadonlySet<string>): JSX.Element | null => {
    const c = state.components.get(id);
    if (!c || depth > MAX_DEPTH || path.has(id) || ++spent > MAX_RENDER_NODES) return null;
    const inner = new Set(path).add(id);
    const weightCls = typeof c.weight === 'number' && c.weight > 0 ? 'u-flex-1 u-min-w-0' : 'u-min-w-0';
    switch (c.component) {
      case 'Text': {
        const text = resolve(c.text);
        const v = c.variant ?? 'body';
        if (v in HEADING_SIZE) {
          const level = Math.min(Number(v.slice(1)) + 3, 6);
          return <div key={id} role="heading" aria-level={level} className={`${HEADING_SIZE[v]} u-fw-600 u-m-0`}>{text}</div>;
        }
        return <p key={id} className={v === 'caption' ? 'u-fs-12 u-text-muted u-m-0' : 'u-fs-13 u-m-0'}>{text}</p>;
      }
      case 'TextField': {
        const common = {
          label: resolve(c.label),
          required: isRequired(c),
          error: errorFor(c),
          help: help(c),
          value: String(valueOf(c) ?? ''),
        };
        if (c.variant === 'longText') {
          return <TextareaField key={id} {...common} rows={3} onChange={(e) => write(c, e.target.value)} />;
        }
        return (
          <TextField
            key={id}
            {...common}
            type={c.variant === 'number' ? 'number' : 'text'}
            {...(c.variant === 'number' ? { inputMode: 'decimal' as const } : {})}
            onChange={(e) => write(c, c.variant === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
          />
        );
      }
      case 'CheckBox':
        return (
          <CheckboxField
            key={id}
            label={resolve(c.label)}
            required={isRequired(c)}
            error={errorFor(c)}
            help={help(c)}
            checked={valueOf(c) === true}
            onChange={(e) => write(c, e.target.checked)}
          />
        );
      case 'DateTimeInput': {
        // Neither flag ⇒ a date; `enableTime` alone ⇒ a time; both ⇒ both.
        const time = c.enableTime === true;
        const date = c.enableDate === true || !time;
        return (
          <TextField
            key={id}
            label={resolve(c.label) || t('a2uiV09DateLabel')}
            required={isRequired(c)}
            error={errorFor(c)}
            help={help(c)}
            type={date && time ? 'datetime-local' : time ? 'time' : 'date'}
            value={toInputValue(String(valueOf(c) ?? ''), date && time ? 'datetime-local' : time ? 'time' : 'date')}
            onChange={(e) => write(c, e.target.value)}
          />
        );
      }
      case 'ChoicePicker': {
        const raw = valueOf(c);
        const selected = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
        const label = c.label !== undefined ? resolve(c.label) : '';
        const single = c.variant === 'mutuallyExclusive';
        const toggle = (value: string): void => {
          write(c, single ? [value] : selected.includes(value) ? selected.filter((x) => x !== value) : [...selected, value]);
        };
        if (single && c.displayStyle !== 'chips') {
          return (
            <SelectField key={id} label={label} required={isRequired(c)} error={errorFor(c)} help={help(c)} value={selected[0] ?? ''} onChange={(e) => write(c, e.target.value === '' ? [] : [e.target.value])}>
              <option value="">{t('a2uiV09ChoosePlaceholder')}</option>
              {c.options.map((o) => <option key={o.value} value={o.value}>{resolve(o.label)}</option>)}
            </SelectField>
          );
        }
        const err = errorFor(c);
        const errId = `${hintId}-${id}-err`;
        return (
          <fieldset key={id} className="field u-border-0 u-p-0 u-m-0" {...(err ? { 'aria-describedby': errId } : {})}>
            {label && <legend className="field-label u-p-0">{label}{isRequired(c) ? <span className="field-required" aria-hidden="true">*</span> : null}</legend>}
            {c.displayStyle === 'chips' ? (
              // Toggle buttons in both modes, grouped + named by the fieldset
              // legend. (A `role="radio"` set would promise the arrow-key/roving
              // tabindex contract of a radio group, which plain buttons don't
              // keep — measured in the browser pass, ADR 0749 follow-up.)
              <div className="u-flex u-flex-wrap u-gap-1">
                {c.options.map((o) => (
                  // `chips` = a row of small toggle buttons (the `ui/Button`
                  // intent API; a bespoke raw chip button is a ratcheted debt).
                  <Button
                    key={o.value}
                    size="sm"
                    variant={selected.includes(o.value) ? 'primary' : 'secondary'}
                    aria-pressed={selected.includes(o.value)}
                    onClick={() => toggle(o.value)}
                  >
                    {resolve(o.label)}
                  </Button>
                ))}
              </div>
            ) : (
              c.options.map((o) => <CheckboxField key={o.value} label={resolve(o.label)} checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />)
            )}
            {err ? <div className="field-error" id={errId} role="alert">{err}</div> : null}
          </fieldset>
        );
      }
      case 'Button':
        return (
          <Button
            key={id}
            className="u-self-start"
            variant={BUTTON_VARIANT[c.variant ?? 'default'] ?? 'secondary'}
            disabled={disabledFor(c.action.event.name)}
            {...(c.action.event.name === 'resume' && failing && isLoading !== true ? { 'aria-describedby': hintId } : {})}
            // a2ui-action-confinement: resume the interrupt or send an exchange —
            // the registry binds these two to the host APIs; nothing else exists.
            onClick={() => void onAction(c.action.event.name === 'exchange' ? 'exchange' : 'resolve', submit(c.action.event.context))}
          >
            {labelOf(c, inner)}
          </Button>
        );
      case 'Column':
      case 'Row': {
        const cls = [
          'u-flex',
          c.component === 'Column' ? 'u-flex-col u-gap-2' : 'u-flex-row u-flex-wrap u-gap-1-5',
          c.justify ? JUSTIFY[c.justify] : '',
          c.align ? ALIGN[c.align] : '',
        ].filter(Boolean).join(' ');
        return (
          <div key={id} className={cls}>
            {c.children.map((k, i) => {
              const child = render(k, depth + 1, inner);
              if (!child) return null;
              const kc = state.components.get(k);
              if (kc?.component === 'Divider' && kc.axis === 'vertical') return <Fragment key={`${k}#${i}`}>{child}</Fragment>;
              // Keyed by position: `children` may legally repeat an id.
              const cls = c.component === 'Row' ? (typeof kc?.weight === 'number' && kc.weight > 0 ? 'u-flex-1 u-min-w-0' : 'u-min-w-0') : 'u-min-w-0';
              return <div key={`${k}#${i}`} className={cls}>{child}</div>;
            })}
          </div>
        );
      }
      case 'Card':
        return <div key={id} className={`u-border u-radius u-p-2 ${weightCls}`}>{render(c.child, depth + 1, inner)}</div>;
      case 'Divider':
        // Vertical: stretches to its Row's height (the Row renders it unwrapped —
        // a block wrapper would give it a content height of 0, i.e. no rule).
        return c.axis === 'vertical'
          ? <div key={id} role="separator" aria-orientation="vertical" className="u-border-l u-self-stretch" />
          : <div key={id} role="separator" className="u-border-t" />;
    }
  };

  const tree = render('root', 0, new Set());
  // Never a PARTIAL surface: if the walk ran out of budget anyway, some subtree was
  // dropped silently, so refuse the whole thing like the card's pre-check does.
  if (spent > MAX_RENDER_NODES) {
    return <Notice variant="warning">{t('a2uiUnsafe', { reason: t('a2uiV09RejectTooLarge') })}</Notice>;
  }

  return (
    <div className="u-flex u-flex-col u-gap-2">
      {state.agentDisplayName && <p className="u-fs-12 u-text-muted u-m-0">{t('a2uiV09From', { agent: state.agentDisplayName })}</p>}
      {tree}
      {failing && isLoading !== true && <p id={hintId} className="field-help u-m-0">{t('a2uiFillRequired')}</p>}
    </div>
  );
}
