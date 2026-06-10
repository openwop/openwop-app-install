/**
 * RunStepInspector — §A4 "debugging studio" playhead. Driven by the
 * RunTimeline selection (its `onSelectSeq`), it shows the event(s) at the
 * selected sequence plus the agent activity *up to that point*, so the
 * timeline becomes a scrubber synchronized with the inspector — and any
 * step is one click from a fork. Pure composition of existing surfaces.
 */
import { useMemo } from 'react';
import type { RunEventDoc } from '@openwop/openwop';
import { RunAgentTrace } from './RunAgentTrace.js';

interface Props {
  events: readonly RunEventDoc[];
  seq: number;
  onForkFrom?: (seq: number) => void;
}

export function RunStepInspector({ events, seq, onForkFrom }: Props) {
  const atSeq = useMemo(() => events.filter((e) => e.sequence === seq), [events, seq]);
  const upToHere = useMemo(
    () => events.filter((e) => e.sequence <= seq).sort((a, b) => a.sequence - b.sequence),
    [events, seq],
  );

  return (
    <div className="card" data-run-step-inspector>
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <h2 className="u-m-0 u-flex-1">
          Step inspector <span className="muted u-fs-12 u-fw-400">· at #{seq}</span>
        </h2>
        {onForkFrom && (
          <button type="button" className="secondary" onClick={() => onForkFrom(seq)} title="Fork a new run from this point">
            Fork from here
          </button>
        )}
      </div>

      {atSeq.length === 0 ? (
        <p className="muted u-m-0">No event at #{seq}.</p>
      ) : (
        atSeq.map((ev) => (
          <div key={ev.sequence} className="u-mt-2">
            <code className="u-fs-12">{ev.type}</code>
            <pre className="runstep-payload-pre">{JSON.stringify(ev.payload ?? {}, null, 2)}</pre>
          </div>
        ))
      )}

      <h3 className="runstep-activity-heading">
        Agent activity up to this point
      </h3>
      <RunAgentTrace events={upToHere} />
    </div>
  );
}
