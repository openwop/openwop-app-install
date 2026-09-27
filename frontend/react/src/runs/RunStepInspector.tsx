/**
 * RunStepInspector — §A4 "debugging studio" playhead. Driven by the
 * RunTimeline selection (its `onSelectSeq`), it shows the event(s) at the
 * selected sequence plus the agent activity *up to that point*, so the
 * timeline becomes a scrubber synchronized with the inspector — and any
 * step is one click from a fork. Pure composition of existing surfaces.
 */
import { Button } from '../ui/Button.js';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunEventDoc } from '@openwop/openwop';
import { RunAgentTrace } from './RunAgentTrace.js';
import { CompactionNotice, findCompactionMarkers } from './CompactionNotice.js';
import { formatNumber } from '../i18n/format.js';

interface Props {
  events: readonly RunEventDoc[];
  seq: number;
  onForkFrom?: (seq: number) => void;
}

export function RunStepInspector({ events, seq, onForkFrom }: Props) {
  const { t } = useTranslation('runs');
  const atSeq = useMemo(() => events.filter((e) => e.sequence === seq), [events, seq]);
  const upToHere = useMemo(
    () => events.filter((e) => e.sequence <= seq).sort((a, b) => a.sequence - b.sequence),
    [events, seq],
  );
  // TOCU-1 / review M10 — the marker walk is a full recursive traversal of an
  // arbitrarily large run payload. It used to run inline in the render body,
  // once per event, on a component that re-renders on EVERY streamed event.
  // Memoised on the (already memoised) event set, keyed by sequence.
  const markersBySeq = useMemo(
    () => new Map(atSeq.map((ev) => [ev.sequence, findCompactionMarkers(ev.payload)])),
    [atSeq],
  );

  return (
    <div className="card" data-run-step-inspector>
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <h2 className="u-m-0 u-flex-1">
          {t('stepInspector')} <span className="muted u-fs-12 u-fw-400">{t('stepInspectorAt', { seq: formatNumber(seq) })}</span>
        </h2>
        {onForkFrom && (
          <Button variant="secondary" onClick={() => onForkFrom(seq)} title={t('forkFromHereTitle')}>
            {t('forkFromHere')}
          </Button>
        )}
      </div>

      {atSeq.length === 0 ? (
        <p className="muted u-m-0">{t('noEventAtSeq', { seq: formatNumber(seq) })}</p>
      ) : (
        atSeq.map((ev) => (
          <div key={ev.sequence} className="u-mt-2">
            <code className="u-fs-12">{ev.type}</code>
            {/* TOCU-1 (ADR 0604) — BEFORE the payload, not after: an operator who
                reads the JSON first has already been misled by the time a footnote
                arrives. `announce` lives HERE and not in the timeline (review
                M10): this is the surface that renders the payload EXPANDED, so
                it is the one place where "you are reading a shortened list" is
                true at the moment it is spoken. */}
            <CompactionNotice markers={markersBySeq.get(ev.sequence) ?? { elidedRows: 0, emptiedFields: [] }} announce />
            <pre className="runstep-payload-pre">{JSON.stringify(ev.payload ?? {}, null, 2)}</pre>
          </div>
        ))
      )}

      <h3 className="runstep-activity-heading">
        {t('agentActivityUpToPoint')}
      </h3>
      <RunAgentTrace events={upToHere} />
    </div>
  );
}
