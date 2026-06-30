/**
 * A2UI component catalog — the host-pinned, CLOSED allowlist of components a
 * `ui.a2ui-surface` card is permitted to render.
 *
 * This is the security spine of the A2UI integration (ADR 0051, RFC 0102 §A):
 * an agent-authored surface is *declarative data*, never code. The renderer
 * (`A2uiSurfaceCard`) walks a surface document and renders ONLY the components
 * named here; anything else is rejected fail-closed. A remote / untrusted A2A
 * agent can ship a surface without the host executing any of its code — it can
 * only *select* pre-approved widgets and bind data to them. (Invariant
 * `a2ui-surface-no-code-exec`.)
 *
 * Shape is aligned 1:1 with the core wire schema
 * `schemas/envelopes/ui.a2ui-surface.schema.json` (RFC 0102, openwop#716):
 * the discriminator is the single-string-enum **`component`** field (an `anyOf`
 * union, never `oneOf` — banned for LLM-emitted payloads, ai-envelope.md
 * §"Variant payload discrimination"), and the surface lives under a `surface`
 * wrapper `{ title?, components[] }`. The day-1 catalog is pinned to A2UI 0.9.1.
 */

import i18n from '../../i18n/index.js';

/** The A2UI catalog version this host renders — the `catalogVersion` enum value
 *  in the core schema. Surfaces targeting another version are refused. */
export const A2UI_CATALOG_VERSION = '0.9.1';

/** The closed component allowlist (day-1 catalog 0.9.1, RFC 0102 §A). */
export const SUPPORTED_COMPONENTS = [
  'heading',
  'text',
  'field.text',
  'field.date',
  'field.select',
  'field.checkbox',
  'action.button',
] as const;

export type A2uiComponentType = (typeof SUPPORTED_COMPONENTS)[number];

/** Confined action target (RFC 0102 §A rule 4): a surface action resolves to
 *  exactly one host-allowlisted destination — an interrupt resume or a
 *  conversation exchange — never an arbitrary URL/endpoint. */
export type A2uiActionTarget = 'resume' | 'exchange';

export interface A2uiSelectOption {
  value: string;
  label: string;
}

export type A2uiComponent =
  | { component: 'heading'; text: string; level?: number }
  | { component: 'text'; text: string }
  | { component: 'field.text'; id: string; label: string; placeholder?: string; required?: boolean }
  | { component: 'field.date'; id: string; label: string; required?: boolean }
  | { component: 'field.select'; id: string; label: string; required?: boolean; options: A2uiSelectOption[] }
  | { component: 'field.checkbox'; id: string; label: string; default?: boolean }
  | { component: 'action.button'; id: string; label: string; action: { target: A2uiActionTarget } };

/** A field component carries a binding `id` whose user-entered value flows into
 *  the resume/exchange payload keyed by that id. */
export type A2uiFieldComponent = Extract<A2uiComponent, { component: `field.${string}` }>;

/** The A2UI surface document — `surface` in the envelope payload. */
export interface A2uiSurface {
  title?: string;
  components: A2uiComponent[];
}

/** The full card payload for a `ui.a2ui-surface` card — mirrors the core
 *  envelope payload schema `{ catalogVersion, surface, reasoning? }`. */
export interface A2uiSurfacePayload {
  catalogVersion: string;
  surface: A2uiSurface;
  reasoning?: string;
}

export function isFieldComponent(c: A2uiComponent): c is A2uiFieldComponent {
  return c.component === 'field.text' || c.component === 'field.date'
    || c.component === 'field.select' || c.component === 'field.checkbox';
}

export type SurfaceParse =
  | { ok: true; payload: A2uiSurfacePayload }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate one component against the closed catalog. Returns null when valid,
 *  or a human-readable reason when it must be rejected. Fail-closed: any
 *  component the catalog doesn't model, or a malformed entry, is a rejection —
 *  never a silent passthrough. */
function rejectComponent(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.component !== 'string') return i18n.t('chat:a2uiRejectMissingDiscriminator');
  const c = raw.component;
  if (!(SUPPORTED_COMPONENTS as readonly string[]).includes(c)) {
    return i18n.t('chat:a2uiRejectUnknownComponent', { component: c, version: A2UI_CATALOG_VERSION });
  }
  switch (c as A2uiComponentType) {
    case 'heading':
    case 'text':
      if (typeof raw.text !== 'string') return i18n.t('chat:a2uiRejectRequiresText', { component: c });
      return null;
    case 'field.text':
    case 'field.date':
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return i18n.t('chat:a2uiRejectRequiresIdLabel', { component: c });
      return null;
    case 'field.checkbox':
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return i18n.t('chat:a2uiRejectRequiresIdLabel', { component: c });
      return null;
    case 'field.select':
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return i18n.t('chat:a2uiRejectRequiresIdLabel', { component: c });
      if (!Array.isArray(raw.options) || raw.options.length === 0) return i18n.t('chat:a2uiRejectSelectOptions');
      for (const o of raw.options) {
        if (!isRecord(o) || typeof o.value !== 'string' || typeof o.label !== 'string') return i18n.t('chat:a2uiRejectSelectOptionShape');
      }
      return null;
    case 'action.button': {
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return i18n.t('chat:a2uiRejectButtonIdLabel');
      if (!isRecord(raw.action) || (raw.action.target !== 'resume' && raw.action.target !== 'exchange')) {
        return i18n.t('chat:a2uiRejectButtonTarget');
      }
      return null;
    }
  }
}

/**
 * Parse + validate a card payload into an `A2uiSurfacePayload`, enforcing the
 * closed catalog. Fail-closed: an unrecognized component, a malformed entry, a
 * missing `surface`/`components`, or a missing `catalogVersion` yields
 * `{ ok: false }` and the renderer shows a notice instead of anything interactive.
 */
export function parseSurface(payload: unknown): SurfaceParse {
  if (!isRecord(payload)) return { ok: false, reason: i18n.t('chat:a2uiRejectPayloadNotObject') };
  if (typeof payload.catalogVersion !== 'string') return { ok: false, reason: i18n.t('chat:a2uiRejectMissingCatalogVersion') };
  if (!isRecord(payload.surface)) return { ok: false, reason: i18n.t('chat:a2uiRejectMissingSurface') };
  if (!Array.isArray(payload.surface.components)) return { ok: false, reason: i18n.t('chat:a2uiRejectMissingComponents') };
  for (const c of payload.surface.components) {
    const reason = rejectComponent(c);
    if (reason) return { ok: false, reason };
  }
  const surface: A2uiSurface = {
    ...(typeof payload.surface.title === 'string' ? { title: payload.surface.title } : {}),
    components: payload.surface.components as A2uiComponent[],
  };
  return {
    ok: true,
    payload: {
      catalogVersion: payload.catalogVersion,
      surface,
      ...(typeof payload.reasoning === 'string' ? { reasoning: payload.reasoning } : {}),
    },
  };
}
