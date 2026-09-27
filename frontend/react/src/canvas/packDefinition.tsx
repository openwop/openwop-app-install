/**
 * Canvas framework — the data→definition adapter for PACK canvas types
 * (ADR 0310 Phase D, Tier-1 FE-less packs). A pack ships elements-trait editor
 * HINTS as pure data (`x-openwop-app.canvas` → the catalog route's `editor`
 * payload); this synthesizes a runtime `CanvasEditorDefinition` from them:
 * pass-through coercion (the pack's own artifact schema validates on save),
 * element collections with data labels/adders/fields, doc-level props, and a
 * generic read-only content view as the Renderer. The typed-definition rule
 * stands for FIRST-PARTY types — this adapter is the one deliberate data seam,
 * and it validates the hint shape before trusting it.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CanvasEditorDefinition } from './CanvasEditorPage.js';
import type { CanvasNode, CanvasPropDef, ElementsCollectionDef } from './types.js';
import type { FrameBase } from './frameOps.js';
import { readElements } from './elementOps.js';

/** The `editor` payload shape (mirrors backend host/canvasPackTypes.ts). */
export interface PackEditorHints {
  docNameKey?: string;
  docPropDefs?: CanvasPropDef[];
  collections: {
    key: string;
    label: string;
    max: number;
    min?: number;
    itemLabelField?: string;
    adders: { id: string; label: string; defaults: Record<string, unknown> }[];
    fields: CanvasPropDef[];
  }[];
}

/** A pack canvasTypeId rides URLs and API paths — the same strict slug the
 *  backend loader enforces (a crafted route param must not steer the client
 *  onto another API path). */
export const PACK_CANVAS_TYPE_ID_RE = /^canvas\.[a-z0-9][a-z0-9-]{0,63}$/;

/** Field names become object keys the editor writes — never the prototype chain. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Narrow an untrusted catalog `editor` payload; null when unusable. */
export function parsePackEditorHints(raw: unknown): PackEditorHints | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!Array.isArray(e.collections) || e.collections.length === 0) return null;
  const collections: PackEditorHints['collections'] = [];
  for (const c of e.collections) {
    const col = (c ?? {}) as Record<string, unknown>;
    if (typeof col.key !== 'string' || !col.key || UNSAFE_KEYS.has(col.key) || typeof col.label !== 'string' || typeof col.max !== 'number' || col.max < 1) return null;
    if (typeof col.min === 'number' && col.min > col.max) return null; // GC-CV-6: bounds sanity, mirroring the loader
    if (!Array.isArray(col.adders) || !col.adders.length || !Array.isArray(col.fields)) return null;
    collections.push({
      key: col.key,
      label: col.label,
      max: col.max,
      ...(typeof col.min === 'number' ? { min: col.min } : {}),
      ...(typeof col.itemLabelField === 'string' ? { itemLabelField: col.itemLabelField } : {}),
      adders: col.adders.map((a) => {
        const ad = (a ?? {}) as Record<string, unknown>;
        const raw = ad.defaults && typeof ad.defaults === 'object' && !Array.isArray(ad.defaults) ? (ad.defaults as Record<string, unknown>) : {};
        return {
          id: typeof ad.id === 'string' ? ad.id : 'item',
          label: typeof ad.label === 'string' ? ad.label : 'Item',
          // GC-CV-5: adder defaults become editor-written keys — screen them.
          defaults: Object.fromEntries(Object.entries(raw).filter(([k]) => !UNSAFE_KEYS.has(k))),
        };
      }),
      fields: (col.fields as unknown[]).filter((f): f is CanvasPropDef => {
        const p = (f ?? {}) as Record<string, unknown>;
        return typeof p.name === 'string' && Boolean(p.name) && !UNSAFE_KEYS.has(p.name) && typeof p.type === 'string';
      }),
    });
  }
  return {
    collections,
    ...(typeof e.docNameKey === 'string' && e.docNameKey && !UNSAFE_KEYS.has(e.docNameKey) ? { docNameKey: e.docNameKey } : {}),
    ...(Array.isArray(e.docPropDefs) ? { docPropDefs: e.docPropDefs.filter((f): f is CanvasPropDef => { const p = (f ?? {}) as Record<string, unknown>; return typeof p.name === 'string' && Boolean(p.name) && !UNSAFE_KEYS.has(p.name) && typeof p.type === 'string'; }) } : {}),
  };
}

const trunc = (v: unknown): string => (typeof v === 'string' && v ? (v.length > 32 ? `${v.slice(0, 32)}…` : v) : '');

/** Generic read-only renderer for a pack canvas doc: the name + one section
 *  per collection, each element as its field values. Data only, React-escaped
 *  — the honest Tier-1 floor (a custom preview is the Tier-2 plugin surface). */
function GenericPackContentView({ content, hints }: { content: string; hints: PackEditorHints }): JSX.Element {
  const { t } = useTranslation('canvas');
  let doc: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(content) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) doc = raw as Record<string, unknown>;
  } catch { /* fall through to the empty shell */ }
  const rawName = doc[hints.docNameKey ?? 'name'];
  const name = typeof rawName === 'string' && rawName ? rawName : '';
  // Heading hierarchy: with no doc name the sections take the h3 slot so
  // AT heading-nav never skips a level (UX review F1).
  const SectionTitle = name ? 'h4' : 'h3';
  return (
    <div className="cv-generic">
      {name ? <h3 className="cv-generic__name">{name}</h3> : null}
      {hints.collections.map((col) => (
        <section key={col.key} className="cv-generic__section">
          <SectionTitle className="cv-generic__section-title">{col.label}</SectionTitle>
          <ul className="cv-generic__list">
            {readElements(doc, col.key).map((el, i) => (
              <li key={i} className="cv-generic__item">
                {col.fields.map((f) => {
                  const v = el[f.name];
                  if (v === undefined || v === null || v === '') return null;
                  // CPKU-2 — a boolean renders a decorative ✓/— glyph (aria-hidden)
                  // PLUS an sr-only Yes/No, so a screen reader announces the state
                  // instead of "check mark" / a bare dash.
                  const shown = Array.isArray(v)
                    ? v.filter((x): x is string => typeof x === 'string').join(' · ')
                    : typeof v === 'boolean'
                      ? (<><span aria-hidden="true">{v ? '✓' : '—'}</span><span className="sr-only">{v ? t('boolYes') : t('boolNo')}</span></>)
                      : String(v as string | number);
                  return (
                    <span key={f.name} className="cv-generic__field">
                      <span className="cv-generic__field-label">{f.label ?? f.name}</span> {shown}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Synthesize the runtime definition for one pack canvas type. */
export function buildPackDefinition(canvasTypeId: string, hints: PackEditorHints): CanvasEditorDefinition<Record<string, unknown>, FrameBase, CanvasNode> {
  const nameKey = hints.docNameKey ?? 'name';
  const elements: ElementsCollectionDef[] = hints.collections.map((col) => ({
    key: col.key,
    label: col.label,
    max: col.max,
    ...(col.min !== undefined ? { min: col.min } : {}),
    adders: col.adders.map((a) => ({ id: a.id, label: a.label, make: () => JSON.parse(JSON.stringify(a.defaults)) as Record<string, unknown> })),
    labelFor: (el) => (col.itemLabelField ? trunc(el[col.itemLabelField]) : '') || col.adders[0]?.label || col.label,
    propDefs: () => col.fields,
  }));
  const Renderer = ({ content }: { content: string; editPaths?: boolean }): JSX.Element => (
    <GenericPackContentView content={content} hints={hints} />
  );
  return {
    canvasTypeId: canvasTypeId as `canvas.${string}`,
    toggleId: 'canvas-packs',
    clientBasePath: `/host/openwop-app/canvas-packs/${canvasTypeId}`,
    editorPath: `/canvas/${canvasTypeId}`,
    i18nNamespace: 'canvas-packs',
    Renderer,
    coerceDoc: (state) => {
      const doc: Record<string, unknown> = { ...state };
      if (typeof doc[nameKey] !== 'string' || !(doc[nameKey] as string).trim()) doc[nameKey] = 'Untitled';
      for (const col of hints.collections) {
        const v = doc[col.key];
        const list = Array.isArray(v) ? v.filter((el): el is Record<string, unknown> => Boolean(el) && typeof el === 'object' && !Array.isArray(el)) : [];
        // Honor the schema's minItems so the delete guard has something to hold.
        doc[col.key] = list.length || !(col.min && col.min > 0)
          ? list
          : [JSON.parse(JSON.stringify(col.adders[0]?.defaults ?? {})) as Record<string, unknown>];
      }
      return doc;
    },
    docNameKey: nameKey,
    elements,
    ...(hints.docPropDefs ? { docPropDefs: hints.docPropDefs } : {}),
  };
}

/** Memoized hook form (the definition must be referentially stable across renders). */
export function usePackDefinition(canvasTypeId: string, hints: PackEditorHints | null): CanvasEditorDefinition<Record<string, unknown>, FrameBase, CanvasNode> | null {
  return useMemo(() => (hints ? buildPackDefinition(canvasTypeId, hints) : null), [canvasTypeId, hints]);
}
