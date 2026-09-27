/**
 * TOCU-1 (ADR 0604) — disclose tool-output compaction in the run surfaces.
 *
 * THE DEFECT. The lossy compaction kernel replaces the middle of a long array
 * with `{"_elided": N}` and, since ADR 0604, names dropped empty fields in
 * `{"_emptied": [...]}`. Because the `compact` node is `role:"action"`, that
 * output is PERSISTED into the run event log — and `_elided` had SIX hits across
 * four files, all backend, tests and docs. Zero under `frontend/react/src`, zero
 * i18n keys. So an operator reading a run step saw
 *
 *     { "items": [ {...}, {...}, {...}, { "_elided": 137 }, {...} ] }
 *
 * as ordinary JSON, and a SHORTENED ARRAY READ AS A COMPLETE ONE. That is the
 * absence-is-a-claim family arriving in the UI: the marker is the honesty
 * affordance, and rendering it raw destroys the affordance while keeping the
 * loss.
 *
 * `findCompactionMarkers` walks a payload for both markers and returns what was
 * removed, so the notice can say HOW MANY rows are missing rather than "this was
 * shortened somehow". Exported separately from the component so it is testable
 * without a renderer.
 */
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { formatNumber } from '../i18n/format.js';

/** The two markers the ADR 0099 kernel writes. Kept in one place so a rename
 *  in `backend/typescript/src/features/tool-output-compaction/compact.ts`
 *  breaks the pinned test in `__tests__/CompactionNotice.test.tsx`, not silently
 *  the UI. */
export const ELIDED_MARKER = '_elided';
export const EMPTIED_MARKER = '_emptied';

export interface CompactionMarkers {
  /** Total rows removed by array elision, summed across every elided array. */
  elidedRows: number;
  /** Distinct field names dropped for being empty, in first-seen order. */
  emptiedFields: string[];
}

/**
 * Walk any JSON-ish value for compaction markers. Total and defensive — a run
 * payload is untrusted shape, so this must never throw on a cycle, a huge blob
 * or a primitive.
 */
export function findCompactionMarkers(payload: unknown): CompactionMarkers {
  let elidedRows = 0;
  const emptiedFields: string[] = [];
  const seen = new Set<unknown>();

  const walk = (v: unknown, depth: number): void => {
    if (depth > 64 || v === null || typeof v !== 'object') return;
    if (seen.has(v)) return; // cycles: a payload is arbitrary shape
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    const elided = obj[ELIDED_MARKER];
    if (typeof elided === 'number' && Number.isFinite(elided) && elided > 0) elidedRows += elided;
    const emptied = obj[EMPTIED_MARKER];
    if (Array.isArray(emptied)) {
      for (const k of emptied) if (typeof k === 'string' && !emptiedFields.includes(k)) emptiedFields.push(k);
    }
    for (const [k, val] of Object.entries(obj)) {
      // Do not descend INTO the disclosure itself — its members are key names,
      // not payload, and counting them would inflate the very number the notice
      // exists to state accurately.
      if (k === EMPTIED_MARKER) continue;
      walk(val, depth + 1);
    }
  };

  try {
    walk(payload, 0);
  } catch {
    /* a malformed payload must never break the inspector */
  }
  return { elidedRows, emptiedFields };
}

export function hasCompactionMarkers(m: CompactionMarkers): boolean {
  return m.elidedRows > 0 || m.emptiedFields.length > 0;
}

/**
 * The disclosure itself.
 *
 * `variant="info"`, NOT `error`: a shortened list is a descriptive fact about
 * content already on screen, not a failed action. `Notice` maps `error` to
 * `role="alert"` + `aria-live="assertive"`, which interrupts — wrong for this.
 *
 * `announce` delegates to the always-mounted `GlobalLiveRegion`, which is the
 * mechanism that actually speaks. It matters because this component is
 * CONDITIONALLY MOUNTED, so its own live region would enter the DOM with the
 * text already inside — and a region that arrives complete announces nothing
 * while looking perfectly correct in the DOM and passing any attribute-level
 * test (see the `Notice` docblock, PR #2615/#2616). Without it this would be a
 * SIGHTED-ONLY disclosure, i.e. exactly the defect for the subset of users
 * least able to notice a shortened array.
 *
 * ── review M10: WHY `announce` IS NOW OPT-IN, DEFAULT OFF ──
 *
 * It used to announce unconditionally, and `RunTimeline` renders this component
 * INSIDE a collapsed `<details>`. `<details>` children MOUNT while collapsed,
 * so every marker-carrying event in the selected segment announced on mount —
 * describing content the operator has not opened. And `ui/announce.tsx` stores
 * a SINGLE `politeMsg`, so N notices collapse to one: the operator hears a
 * count from whichever event happened to render last, attached to nothing.
 * The unit test rendered ONE component in isolation and could not see either.
 *
 * So the announcement belongs to the surface the operator actually opened —
 * `RunStepInspector`, which renders the payload expanded — and the collapsed
 * timeline disclosure renders the notice SILENTLY. It is still visible the
 * instant the disclosure is opened, which is when it is true that the operator
 * is reading the payload.
 */
export function CompactionNotice({ markers, announce = false }: { markers: CompactionMarkers; announce?: boolean }) {
  const { t } = useTranslation('runs');
  if (!hasCompactionMarkers(markers)) return null;
  const parts: string[] = [];
  if (markers.elidedRows > 0) parts.push(t('compactionElidedRows', { count: markers.elidedRows, n: formatNumber(markers.elidedRows) }));
  if (markers.emptiedFields.length > 0) parts.push(t('compactionEmptiedFields', { fields: markers.emptiedFields.join(', ') }));
  const body = parts.join(' ');
  return (
    <Notice variant="info" {...(announce ? { announce: `${t('compactionNoticeTitle')} ${body}` } : {})}>
      <strong>{t('compactionNoticeTitle')}</strong> {body}
    </Notice>
  );
}
