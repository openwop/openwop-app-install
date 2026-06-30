/**
 * Shared helpers + constants for the Inspector sidebar.
 *
 *   - `textareaValue` — pretty-prints a stored JSON-or-string value so the
 *     `textarea` kind round-trips object defaults without losing formatting.
 *   - `countNonBlankLines` — shared utility for the `maxItems` UX hint.
 *   - `useHostAdvertisedModelCapabilities` — computed union of the
 *     capabilities the host advertises across its installed models.
 *   - `TRIGGER_RULE_OPTIONS` / `CONDITION_OPS` — edge-inspector option tables.
 */

import { useEffect, useState } from 'react';
import { getCapabilities } from '../../client/runsClient.js';
import type { EdgeCondition, EdgeTriggerRule } from '../schema/workflow.js';

/** Capabilities the host advertises across its installed models. Computed
 *  union for the gap check; `null` while discovery is in flight or absent. */
export function useHostAdvertisedModelCapabilities(): Set<string> | null {
  const [caps, setCaps] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((c) => {
        if (cancelled) return;
        // Per schemas/capabilities.schema.json §modelCapabilities.advertised:
        // a flat list of capability identifiers.
        const advertised = (c as { capabilities?: { modelCapabilities?: { advertised?: string[] } } })
          .capabilities?.modelCapabilities?.advertised;
        if (Array.isArray(advertised)) {
          setCaps(new Set(advertised));
        }
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, []);
  return caps;
}

/** Stringify a textarea value. Pack `configSchema`s with `default` set to
 *  an object/array (collapsed to `kind: 'textarea'` by the JSON-Schema
 *  converter) come through as the raw default rather than a pre-stringified
 *  blob — pretty-print it so the user sees readable JSON instead of
 *  `[object Object]`. */
export function textareaValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function countNonBlankLines(s: string): number {
  return s.split('\n').filter((line) => line.trim().length > 0).length;
}

// `label` is the persisted enum value (also shown verbatim in the picker);
// `helpKey` resolves to translated copy in the `builder` namespace.
export const TRIGGER_RULE_OPTIONS: { value: EdgeTriggerRule; label: string; helpKey: string }[] = [
  { value: 'all_success', label: 'all_success', helpKey: 'triggerHelpAllSuccess' },
  { value: 'any_success', label: 'any_success', helpKey: 'triggerHelpAnySuccess' },
  { value: 'all_complete', label: 'all_complete', helpKey: 'triggerHelpAllComplete' },
  { value: 'none_failed', label: 'none_failed', helpKey: 'triggerHelpNoneFailed' },
  { value: 'any_failed', label: 'any_failed', helpKey: 'triggerHelpAnyFailed' },
];

// `labelKey` resolves to translated copy in the `builder` namespace.
export const CONDITION_OPS: { value: EdgeCondition['op']; labelKey: string; needsValue: boolean }[] = [
  { value: 'eq', labelKey: 'condOpEq', needsValue: true },
  { value: 'neq', labelKey: 'condOpNeq', needsValue: true },
  { value: 'truthy', labelKey: 'condOpTruthy', needsValue: false },
  { value: 'falsy', labelKey: 'condOpFalsy', needsValue: false },
  { value: 'exists', labelKey: 'condOpExists', needsValue: false },
  { value: 'contains', labelKey: 'condOpContains', needsValue: true },
];
