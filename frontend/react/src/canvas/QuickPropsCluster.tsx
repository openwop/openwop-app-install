/**
 * QuickPropsCluster (ADR 0362 / §7.12 CV-13) — the bar's contextual
 * FORMATTING cluster: the current selection's `quick`-marked prop defs
 * rendered as compact controls (boolean → aria-pressed toggle; options →
 * a compact Menu). Derives from the SAME `CanvasPropDef` list and write
 * path the property panel uses — bar and panel cannot drift. At most 3
 * controls render (bar budget; dev-warn beyond); the panel stays the
 * complete surface (§7 canon 4/5).
 */
import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { Menu } from '../ui/Menu.js';
import { ChevronDownIcon } from '../ui/icons/index.js';
import type { CanvasPropDef } from './types.js';

/** Loose t-shape so react-i18next's TFunction assigns under exactOptionalPropertyTypes. */
export type TypeTranslator = (key: string, opts?: { defaultValue: string }) => string;

export const QUICK_MAX = 3;

/** The renderable quick defs: booleans, options-bearing defs, and (v2 —
 *  ADR 0362) number + color. */
export function quickDefs(defs: readonly CanvasPropDef[] | undefined): CanvasPropDef[] {
  const q = (defs ?? []).filter((p) => p.quick === true && (p.type === 'boolean' || p.type === 'number' || p.type === 'color' || (Array.isArray(p.options) && p.options.length > 0)));
  if (import.meta.env.DEV && q.length > QUICK_MAX) {
    console.warn(`[canvas] ${q.length} quick props marked — only the first ${QUICK_MAX} render (ADR 0362 bar budget)`);
  }
  return q.slice(0, QUICK_MAX);
}

export function QuickPropsCluster({ defs, valueOf, onSet, tt, label }: {
  defs: readonly CanvasPropDef[];
  valueOf: (name: string) => unknown;
  onSet: (name: string, value: unknown) => void;
  /** The type-namespace translator (ADR 0340 `prop_*`/`opt_*` machinery). */
  tt: TypeTranslator;
  /** Localized group label (canvas ns — the chassis supplies it). */
  label: string;
}): JSX.Element | null {
  if (defs.length === 0) return null;
  // SL-G7 — same precedence as PropertyForm: an explicit `labelKey` wins over the
  // derived `prop_<name>`. Kept in step deliberately, so a def that needs one does
  // not translate in the panel and fall back to English in the quick cluster.
  const propLabel = (p: CanvasPropDef): string => tt(p.labelKey ?? `prop_${p.name}`, { defaultValue: p.label ?? p.name });
  const optLabel = (p: CanvasPropDef, v: string): string => tt(`opt_${p.name}_${v}`, { defaultValue: v });
  return (
    <span className="cv-editor__quick" role="group" aria-label={label}>
      {defs.map((p) => {
        if (p.type === 'boolean') {
          const on = valueOf(p.name) === true;
          return (
            <Button
              key={p.name}
              variant="secondary" size="sm" className={on ? 'is-active' : undefined}
              aria-pressed={on}
              title={propLabel(p)}
              // The locked-checkbox precedent: false stores as ABSENT.
              onClick={() => onSet(p.name, on ? undefined : true)}
            >
              {propLabel(p)}
            </Button>
          );
        }
        if (p.type === 'number') {
          return (
            <QuickNumber key={p.name} def={p} label={propLabel(p)} value={valueOf(p.name)} onSet={onSet} />
          );
        }
        if (p.type === 'color') {
          const cur = valueOf(p.name);
          // A native picker needs a #rrggbb value; when the stored value is
          // absent/named/short-hex, the quick control HIDES and the panel's
          // full ColorField (theme swatches + eyedropper) remains the surface
          // — no hardcoded fallback color (the token gate is right to ban one).
          if (typeof cur !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(cur)) return null;
          return (
            <input
              key={p.name}
              type="color"
              className="cv-editor__quick-color"
              aria-label={propLabel(p)}
              title={propLabel(p)}
              value={cur}
              onChange={(e) => onSet(p.name, e.target.value)}
            />
          );
        }
        const raw = valueOf(p.name);
        const current = typeof raw === 'string' && raw ? raw : (typeof p.default === 'string' ? p.default : (p.options?.[0] ?? ''));
        return (
          <Menu
            key={p.name}
            label={propLabel(p)}
            triggerClassName="secondary btn-sm"
            triggerTitle={propLabel(p)}
            triggerContent={<>{optLabel(p, current)} <ChevronDownIcon size={12} /></>}
            items={(p.options ?? []).map((v) => ({
              id: v,
              label: optLabel(p, v),
              onSelect: () => onSet(p.name, v),
            }))}
          />
        );
      })}
    </span>
  );
}

/** ADR 0362 v2 — a compact bar number field. Drafts locally and commits ONE
 *  history step on blur/Enter (the DEF-6 text contract); clamps to the def's
 *  bounds like the panel does. */
function QuickNumber({ def, label, value, onSet }: {
  def: CanvasPropDef;
  label: string;
  value: unknown;
  onSet: (name: string, value: unknown) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (typeof value === 'number' ? String(value) : '');
  const commit = (): void => {
    if (draft === null) return;
    const n = Number(draft);
    if (Number.isFinite(n)) {
      const lo = def.min ?? -Infinity, hi = def.max ?? Infinity;
      onSet(def.name, Math.max(lo, Math.min(hi, n)));
    }
    setDraft(null);
  };
  return (
    <input
      type="number"
      className="ui-input cv-editor__quick-num"
      aria-label={label}
      title={label}
      value={shown}
      {...(def.min !== undefined ? { min: def.min } : {})}
      {...(def.max !== undefined ? { max: def.max } : {})}
      {...(def.step !== undefined ? { step: def.step } : {})}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
