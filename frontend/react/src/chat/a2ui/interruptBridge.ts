/**
 * Interrupt → A2UI surface bridge (ADR 0051 Phase 3).
 *
 * The chat already renders open interrupts as cards keyed by
 * `interrupt.<kind>` (the textarea/buttons in `registry/defaultCards.tsx`).
 * When a producer raises a `clarification` interrupt with a `data.form`
 * (RFC 0255 §E, `{ catalogVersion, surface }` or an A2UI v0.9 form), we render it with the `ui.a2ui-surface` card instead: a real form whose
 * collected field values become the `{ answers }` resume value. This is the
 * "structured clarification / parameter collection instead of a free-text
 * textarea" use case (e.g. a meeting-scheduling form).
 *
 * It is purely additive: an interrupt WITHOUT a well-formed surface falls back
 * to its default `interrupt.<kind>` card (return `null`). The `A2uiSurfaceCard`
 * renderer itself fail-closes on a surface that doesn't validate against the
 * host-pinned catalog (it runs `parseSurface` on the raw payload), so we hand
 * the surface through untyped — no cast, the renderer is the validator.
 */

import type { OpenInterrupt } from '../../client/interruptsClient.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface A2uiInterruptCard {
  cardType: 'ui.a2ui-surface';
  /** Mirrors the `ui.a2ui-surface` payload shape `{ catalogVersion, surface }`.
   *  `surface` is left `unknown` on purpose — `A2uiSurfaceCard.parseSurface`
   *  validates it against the host catalog and fail-closes on a bad shape. */
  payload: { catalogVersion: string; surface: unknown } | V09CardPayload;
}

/** RFC 0209 (ADR 0749) — an A2UI v0.9 surface on an interrupt: one version-2
 *  payload, or several of ONE surface (`surfaces`, folded in order). Left
 *  unvalidated here for the same reason as `surface` above: the renderer's
 *  profile parse is the validator and fail-closes. */
export type V09CardPayload = Record<string, unknown> | { surfaces: unknown[] };

/**
 * If `interrupt.data.form` carries an A2UI surface, return the `ui.a2ui-surface`
 * card props to render it; otherwise return `null` (caller falls back to
 * `interrupt.<kind>`). ADR 1013 D5: `data.form` is the only place a form lives.
 */
export function a2uiInterruptCard(
  interrupt: Pick<OpenInterrupt, 'data'> | null | undefined,
): A2uiInterruptCard | null {
  const data = interrupt?.data;
  if (!isRecord(data) || !isRecord(data.form)) return null;
  const form = data.form;
  if (Array.isArray(form.surfaces) && form.surfaces.length > 0) {
    return { cardType: 'ui.a2ui-surface', payload: { surfaces: form.surfaces } };
  }
  if (form.version === 'v0.9') return { cardType: 'ui.a2ui-surface', payload: form };
  if (!isRecord(form.surface) || typeof form.catalogVersion !== 'string') return null;
  return {
    cardType: 'ui.a2ui-surface',
    payload: { catalogVersion: form.catalogVersion, surface: form.surface },
  };
}
