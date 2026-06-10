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

export const TRIGGER_RULE_OPTIONS: { value: EdgeTriggerRule; label: string; help: string }[] = [
  { value: 'all_success', label: 'all_success', help: 'Default. Target fires after every upstream completes successfully.' },
  { value: 'any_success', label: 'any_success', help: 'Target fires on the first upstream success (race).' },
  { value: 'all_complete', label: 'all_complete', help: 'Target fires after every upstream reaches a terminal state regardless of outcome.' },
  { value: 'none_failed', label: 'none_failed', help: 'Target fires when every upstream completed AND none failed.' },
  { value: 'any_failed', label: 'any_failed', help: 'Target fires only when an upstream fails — error-routing path.' },
];

export const CONDITION_OPS: { value: EdgeCondition['op']; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: '= (equals)', needsValue: true },
  { value: 'neq', label: '≠ (not equal)', needsValue: true },
  { value: 'truthy', label: 'is truthy', needsValue: false },
  { value: 'falsy', label: 'is falsy', needsValue: false },
  { value: 'exists', label: 'exists', needsValue: false },
  { value: 'contains', label: 'contains', needsValue: true },
];
