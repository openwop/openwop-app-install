/**
 * A2uiSurfaceCard — renders an agent-authored A2UI surface (ADR 0051, RFC 0102).
 *
 * The renderer is the whole point of the "declarative, not code" security
 * model: it walks a surface document and renders ONLY the host-pinned catalog
 * components (`catalog.ts`), collects field values into local form state, and
 * routes the user's action back through the EXISTING chat machinery — an
 * interrupt resume (`action.target: "resume"`) or a conversation exchange
 * (`action.target: "exchange"`, RFC 0005). It never evaluates surface-supplied
 * code, never injects markup (all text is rendered as React text nodes), and an
 * action can do nothing but resume/exchange — it is not a channel into the host.
 *
 * Security invariants enforced here (RFC 0102 §A):
 *  - `a2ui-surface-no-code-exec`  — out-of-catalog / malformed surface ⇒ a
 *    fail-closed `<Notice>`, never a render of unknown content.
 *  - `a2ui-action-confinement`    — the only side effects are `onAction('resolve' | 'exchange', …)`,
 *    which the registry binds to the interrupt-resume / conversation-exchange APIs.
 *
 * Card type `ui.a2ui-surface` — the core, un-namespaced envelope kind RFC 0102
 * settled on (a vendor detour was reverted in the openwop-1 review). Shape is
 * aligned 1:1 with `schemas/envelopes/ui.a2ui-surface.schema.json`: the
 * `component` discriminator and the `surface` wrapper.
 */

import { useState, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../../client/interruptsClient.js';
import { exchange } from '../conversationClient.js';
import { registerCard } from '../registry/CardRegistry.js';
import type { CardProps } from '../registry/types.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, SelectField, CheckboxField } from '../../ui/Field.js';
import {
  A2UI_CATALOG_VERSION,
  parseSurface,
  isFieldComponent,
  type A2uiComponent,
  type A2uiFieldComponent,
} from './catalog.js';

type FieldValue = string | boolean;

/** Seed the form state from the surface's field components. */
function initialValues(components: readonly A2uiComponent[]): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const c of components) {
    if (!isFieldComponent(c)) continue;
    if (c.component === 'field.checkbox') values[c.id] = c.default ?? false;
    else if (c.component === 'field.select') values[c.id] = c.options[0]?.value ?? '';
    else values[c.id] = '';
  }
  return values;
}

/** A required field is unsatisfied when its value is empty. */
function missingRequired(components: readonly A2uiComponent[], values: Record<string, FieldValue>): boolean {
  return components.some((c) => {
    if (!isFieldComponent(c)) return false;
    if (c.component === 'field.checkbox') return false; // a checkbox is never "required-empty"
    if (!('required' in c) || !c.required) return false;
    const v = values[c.id];
    return typeof v !== 'string' || v.trim() === '';
  });
}

function FieldControl(
  { component, value, onChange }: {
    component: A2uiFieldComponent;
    value: FieldValue;
    onChange: (v: FieldValue) => void;
  },
): JSX.Element {
  switch (component.component) {
    case 'field.text':
      return (
        <TextField
          label={component.label}
          required={component.required}
          placeholder={component.placeholder ?? ''}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'field.date':
      return (
        <TextField
          label={component.label}
          required={component.required}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'field.select':
      return (
        <SelectField
          label={component.label}
          required={component.required}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {component.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </SelectField>
      );
    case 'field.checkbox':
      return (
        <CheckboxField
          label={component.label}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
  }
}

function Heading({ level, text }: { level: number | undefined; text: string }): JSX.Element {
  // The catalog allows levels 1–6, but the surface is AGENT-authored and lives
  // inside the chat thread — emitting an arbitrary <h1>/<h2> would hijack the
  // document outline (DESIGN.md §11 + §5.5: never skip a level; the page <h1> is
  // the page marquee). So we never map the agent's `level` to a real heading
  // tag: render via `role="heading"` with the level OFFSET below the card's own
  // <h3> title (agent level 1 → aria-level 4 … 6), so an agent can't inject a
  // top-of-outline heading. Visual size stays token-driven.
  const ariaLevel = Math.min((level ?? 1) + 3, 6);
  return <div role="heading" aria-level={ariaLevel} className="u-mbox-b2 u-fs-13 u-fw-600">{text}</div>;
}

export function A2uiSurfaceCard({ payload, onAction, isLoading }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const parsed = parseSurface(payload);
  // Hooks must run unconditionally — seed from the parsed components, or empty.
  const [values, setValues] = useState<Record<string, FieldValue>>(
    () => (parsed.ok ? initialValues(parsed.payload.surface.components) : {}),
  );
  const hintId = useId();

  // Fail-closed: a surface we cannot fully validate against the closed catalog
  // is never rendered as interactive UI (a2ui-surface-no-code-exec).
  if (!parsed.ok) {
    return (
      <div className="card u-bg-surface-2">
        <Notice variant="warning">
          {t('a2uiUnsafe', { reason: parsed.reason })}
        </Notice>
      </div>
    );
  }
  const { surface, catalogVersion } = parsed.payload;

  // Catalog-version mismatch is fail-closed — the host renders only the version
  // it pins (RFC 0102 §A; the wire refuses unknown versions with
  // `unknown_schema_version`).
  if (catalogVersion !== A2UI_CATALOG_VERSION) {
    return (
      <div className="card u-bg-surface-2">
        <Notice variant="warning">
          {t('a2uiVersionMismatch', { surfaceVersion: catalogVersion, hostVersion: A2UI_CATALOG_VERSION })}
        </Notice>
      </div>
    );
  }

  const missing = missingRequired(surface.components, values);
  const actionsDisabled = isLoading === true || missing;
  // Accessible reason for a disabled action (don't leave the button mute).
  const showHint = missing && isLoading !== true;

  return (
    <div className="card u-bg-surface-2">
      {surface.title && <h3 className="u-mbox-b2 u-fs-13">{surface.title}</h3>}
      {surface.components.map((c, i) => {
        if (c.component === 'heading') return <Heading key={i} level={c.level} text={c.text} />;
        if (c.component === 'text') return <p key={i} className="u-mbox-b2 u-fs-13">{c.text}</p>;
        if (isFieldComponent(c)) {
          return (
            <div key={i} className="form-row">
              <FieldControl
                component={c}
                value={values[c.id] ?? (c.component === 'field.checkbox' ? false : '')}
                onChange={(v) => setValues((s) => ({ ...s, [c.id]: v }))}
              />
            </div>
          );
        }
        return null; // action.button rendered in the button row below
      })}
      {showHint && (
        <p id={hintId} className="field-help u-mbox-b2">{t('a2uiFillRequired')}</p>
      )}
      <div className="button-row u-wrap u-gap-1-5">
        {surface.components
          .filter((c): c is Extract<A2uiComponent, { component: 'action.button' }> => c.component === 'action.button')
          .map((btn) => (
            <button
              key={btn.id}
              className={btn.action.target === 'resume' ? '' : 'secondary'}
              disabled={actionsDisabled}
              {...(showHint ? { 'aria-describedby': hintId } : {})}
              // a2ui-action-confinement: a surface action can do exactly one
              // thing — resume the open interrupt OR send a conversation
              // exchange, with the collected values. The registry binds
              // 'resolve'/'exchange' to those two host APIs; there is no path
              // from a surface to any other host call. The button `id` rides
              // along so a multi-button surface (e.g. approve/reject) is
              // distinguishable in the resume value.
              onClick={() => onAction(
                btn.action.target === 'exchange' ? 'exchange' : 'resolve',
                { action: btn.id, ...values },
              )}
            >
              {btn.label}
            </button>
          ))}
      </div>
    </div>
  );
}

/** Resume the open interrupt with the collected values (action.target: resume). */
async function resolveInterrupt(resumeValue: unknown, ctx: { runId: string; nodeId?: string }): Promise<boolean> {
  if (!ctx.nodeId) return false;
  await resolveByRun(ctx.runId, ctx.nodeId, resumeValue);
  return true;
}

/** Send the collected values as a conversation exchange (action.target: exchange, RFC 0005). */
async function exchangeMessage(content: unknown, ctx: { runId: string; nodeId?: string }): Promise<boolean> {
  if (!ctx.nodeId) return false;
  await exchange(ctx.runId, ctx.nodeId, { content });
  return true;
}

let registered = false;

/** Register the A2UI surface renderer into the chat card registry. Idempotent;
 *  call once at chat boot (alongside `registerDefaultCards`). */
export function registerA2uiSurfaceCard(): void {
  if (registered) return;
  registerCard({
    cardType: 'ui.a2ui-surface',
    label: 'A2UI surface',
    Component: A2uiSurfaceCard,
    actionHandlers: { resolve: resolveInterrupt, exchange: exchangeMessage },
  });
  registered = true;
}
