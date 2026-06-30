/**
 * Interrupt → A2UI surface bridge (ADR 0051 Phase 3).
 *
 * The chat already renders open interrupts as cards keyed by
 * `interrupt.<kind>` (the textarea/buttons in `registry/defaultCards.tsx`).
 * When a producer raises a `clarification` (or any) interrupt that carries an
 * A2UI surface in its `data` — `{ catalogVersion, surface }`, RFC 0102 shape —
 * we render it with the `ui.a2ui-surface` card instead: a real form whose
 * collected field values become the interrupt resume value. This is the
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
  payload: { catalogVersion: string; surface: unknown };
}

/**
 * If `interrupt.data` carries an A2UI surface (`{ catalogVersion: string,
 * surface: object }`), return the `ui.a2ui-surface` card props to render it;
 * otherwise return `null` (caller falls back to `interrupt.<kind>`).
 */
export function a2uiInterruptCard(
  interrupt: Pick<OpenInterrupt, 'data'> | null | undefined,
): A2uiInterruptCard | null {
  const data = interrupt?.data;
  if (!isRecord(data)) return null;
  if (!isRecord(data.surface) || typeof data.catalogVersion !== 'string') return null;
  return {
    cardType: 'ui.a2ui-surface',
    payload: { catalogVersion: data.catalogVersion, surface: data.surface },
  };
}
