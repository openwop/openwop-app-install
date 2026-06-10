/**
 * RunProvenancePanel — the "who/what/when produced this output" card.
 *
 * Consolidates a run's provenance into one auditable view, derived purely
 * from the run's event log (+ the snapshot for parent linkage and the open
 * interrupt). It answers, for any agent output: what workflow produced it,
 * which model(s) reasoned, what the human did (a gate, an edit, nothing),
 * and when — plus the trigger that caused the run (RFC 0040 causation).
 *
 * This is a DERIVED summary, not a stored attestation record: there is no
 * signed co-authorship unit here (that's the approval-inbox surface). The
 * caveat is surfaced so the card never implies more provenance than exists.
 *
 * Sources, all already on the run's event log:
 *   - origin/timing    → run.started / run.completed / first+last event
 *   - models           → provider.usage (RFC 0026) + model.capability.*
 *   - reasoning        → agent.reasoned / agent.decided / agent.toolCalled
 *   - human action     → interrupt.requested / run.resumed + snapshot.interrupt
 *   - causation        → event.causationId (RFC 0040) / snapshot.parentRunId
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';
import { ScaleIcon, SparklesIcon, ClockIcon, InfoIcon, ChevronRightIcon } from '../ui/icons/index.js';

interface Props {
  events: readonly RunEventDoc[];
  snapshot?: RunSnapshot | null;
}

export interface ModelUse {
  provider: string;
  model: string;
  calls: number;
}

export interface ProvenanceSummary {
  workflowId?: string | undefined;
  status?: string | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  /** RFC 0040 — the trigger event that caused this run, if any. */
  causationId?: string | undefined;
  /** Sub-workflow linkage from the snapshot. */
  parentRunId?: string | undefined;
  models: ModelUse[];
  /** A model.capability.substituted event fired (the requested class was downgraded). */
  substituted: boolean;
  reasoningSteps: number;
  decisions: number;
  toolCalls: number;
  /** Confidence range across agent.decided events that carried a numeric confidence. */
  confidence?: { min: number; max: number } | undefined;
  human: {
    interrupts: number;
    kinds: string[];
    resumes: number;
    /** The run is currently parked on an open interrupt. */
    open: boolean;
  };
  inputs?: unknown;
  output?: unknown;
  engineVersion?: string | undefined;
  eventCount: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Pure aggregation over the run's event log + snapshot. Exported for unit test. */
export function summarizeProvenance(
  events: readonly RunEventDoc[],
  snapshot?: RunSnapshot | null,
): ProvenanceSummary {
  const models = new Map<string, ModelUse>();
  let substituted = false;
  let reasoningSteps = 0;
  let decisions = 0;
  let toolCalls = 0;
  let confMin = Infinity;
  let confMax = -Infinity;
  let interrupts = 0;
  const interruptKinds = new Set<string>();
  let resumes = 0;
  let causationId: string | undefined;
  let engineVersion: string | undefined;
  let inputs: unknown;
  let output: unknown;
  let startedAt: string | undefined = snapshot?.startedAt;
  let completedAt: string | undefined = snapshot?.completedAt;

  for (const ev of events) {
    if (!causationId && ev.causationId) causationId = ev.causationId;
    if (!engineVersion && ev.engineVersion) engineVersion = ev.engineVersion;
    const p = asRecord(ev.payload);
    switch (ev.type) {
      case 'run.started':
        startedAt ??= ev.timestamp;
        inputs = p.inputs ?? p.input ?? inputs;
        break;
      case 'run.completed':
        completedAt ??= ev.timestamp;
        output = p.output ?? p.outputs ?? p.result ?? output;
        break;
      case 'provider.usage': {
        const provider = String(p.provider ?? 'unknown');
        const model = String(p.model ?? 'unknown');
        const key = `${provider}::${model}`;
        const row = models.get(key) ?? { provider, model, calls: 0 };
        row.calls += 1;
        models.set(key, row);
        break;
      }
      case 'model.capability.substituted':
        substituted = true;
        break;
      case 'agent.reasoned':
        reasoningSteps += 1;
        break;
      case 'agent.toolCalled':
        toolCalls += 1;
        break;
      case 'agent.decided':
        decisions += 1;
        if (typeof p.confidence === 'number') {
          confMin = Math.min(confMin, p.confidence);
          confMax = Math.max(confMax, p.confidence);
        }
        break;
      case 'interrupt.requested':
        interrupts += 1;
        if (typeof p.kind === 'string') interruptKinds.add(p.kind);
        break;
      case 'run.resumed':
        resumes += 1;
        break;
      default:
        break;
    }
  }

  // Fall back to the event-log span when the snapshot omits timing.
  const firstEvent = events[0];
  if (!startedAt && firstEvent) startedAt = firstEvent.timestamp;
  const lastEvent = events[events.length - 1];
  if (!completedAt && lastEvent && ['run.completed', 'run.failed', 'run.cancelled'].includes(lastEvent.type)) {
    completedAt = lastEvent.timestamp;
  }
  const durationMs = startedAt && completedAt
    ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
    : undefined;

  const openInterruptKind = snapshot?.interrupt?.kind;
  if (openInterruptKind) interruptKinds.add(openInterruptKind);

  return {
    workflowId: snapshot?.workflowId,
    status: snapshot?.status,
    startedAt,
    completedAt,
    durationMs,
    causationId,
    parentRunId: snapshot?.parentRunId,
    models: [...models.values()].sort((a, b) => b.calls - a.calls),
    substituted,
    reasoningSteps,
    decisions,
    toolCalls,
    confidence: confMin <= confMax ? { min: confMin, max: confMax } : undefined,
    human: {
      interrupts: Math.max(interrupts, openInterruptKind ? 1 : 0),
      kinds: [...interruptKinds],
      resumes,
      open: Boolean(openInterruptKind),
    },
    inputs,
    output,
    engineVersion,
    eventCount: events.length,
  };
}

function fmtDuration(ms?: number): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** The human-action chip — encodes "agents propose, humans dispose" for a
 *  finished run: a gate that's open, one a human resolved, or no gate at all. */
function humanChip(human: ProvenanceSummary['human']): { cls: string; label: string } {
  if (human.open) return { cls: 'chip--warning chip--pulse', label: 'Awaiting human' };
  if (human.resumes > 0) return { cls: 'chip--success', label: `Human resolved ${human.resumes}` };
  if (human.interrupts > 0) return { cls: 'chip--muted', label: `${human.interrupts} gate, unresolved` };
  return { cls: 'chip--muted', label: 'Autonomous — no human gate' };
}

function jsonPreview(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 4000 ? `${s.slice(0, 4000)}\n… (truncated)` : s;
  } catch {
    return String(v);
  }
}

export function RunProvenancePanel({ events, snapshot }: Props) {
  const p = useMemo(() => summarizeProvenance(events, snapshot), [events, snapshot]);
  if (p.eventCount === 0) return null;

  const duration = fmtDuration(p.durationMs);
  const human = humanChip(p.human);
  const hasInputs = p.inputs !== undefined && p.inputs !== null;
  const hasOutput = p.output !== undefined && p.output !== null;

  return (
    <div className="card">
      <div className="u-flex u-items-center u-gap-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">Provenance</h2>
        <span className={`chip ${human.cls}`}>{human.label}</span>
      </div>

      {/* Origin & timing */}
      <dl className="runprov-timing-dl">
        {p.workflowId && (
          <>
            <dt className="muted">Workflow</dt>
            <dd className="u-m-0 u-mono">{p.workflowId}</dd>
          </>
        )}
        {p.startedAt && (
          <>
            <dt className="muted">Started</dt>
            <dd className="u-m-0 u-iflex u-items-center u-gap-1">
              <ClockIcon size={12} /> {new Date(p.startedAt).toLocaleString()}
              {duration && <span className="muted"> · {duration}</span>}
            </dd>
          </>
        )}
        {p.engineVersion && (
          <>
            <dt className="muted">Engine</dt>
            <dd className="u-m-0 u-mono">{p.engineVersion}</dd>
          </>
        )}
        {(p.causationId || p.parentRunId) && (
          <>
            <dt className="muted">Caused by</dt>
            <dd className="u-m-0">
              {p.parentRunId ? (
                <Link to={`/runs/${encodeURIComponent(p.parentRunId)}`} className="inline-link u-iflex u-items-center u-gap-0-5">
                  parent run <ChevronRightIcon size={12} />
                </Link>
              ) : (
                <span className="u-mono" title="RFC 0040 causation id">{p.causationId}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {/* Model(s) — the AI half of co-authorship */}
      {p.models.length > 0 && (
        <div className="u-mt-3 u-flex u-wrap u-gap-1-5 u-items-center">
          <SparklesIcon size={13} />
          {p.models.map((m) => (
            <span key={`${m.provider}::${m.model}`} className="chip chip--ai" title={`${m.calls} call(s)`}>
              {m.provider}/{m.model}{m.calls > 1 ? ` ×${m.calls}` : ''}
            </span>
          ))}
          {p.substituted && (
            <span className="chip chip--warning" title="A requested model class was downgraded (model.capability.substituted)">
              substituted
            </span>
          )}
        </div>
      )}

      {/* Reasoning trace summary */}
      {(p.reasoningSteps > 0 || p.decisions > 0 || p.toolCalls > 0) && (
        <p className="muted runprov-reasoning-line">
          {p.reasoningSteps > 0 && `${p.reasoningSteps} reasoning step${p.reasoningSteps === 1 ? '' : 's'}`}
          {p.decisions > 0 && `${p.reasoningSteps > 0 ? ' · ' : ''}${p.decisions} decision${p.decisions === 1 ? '' : 's'}`}
          {p.confidence && ` (confidence ${p.confidence.min.toFixed(2)}–${p.confidence.max.toFixed(2)})`}
          {p.toolCalls > 0 && ` · ${p.toolCalls} tool call${p.toolCalls === 1 ? '' : 's'}`}
        </p>
      )}

      {/* Inputs / output — the bookends of the produced artifact */}
      {(hasInputs || hasOutput) && (
        <div className="runprov-io-stack">
          {hasInputs && (
            <details>
              <summary className="muted u-fs-12 u-cursor-pointer">Inputs</summary>
              <pre className="u-mono u-fs-12 u-overflow-auto u-mbox-t1">{jsonPreview(p.inputs)}</pre>
            </details>
          )}
          {hasOutput && (
            <details>
              <summary className="muted u-fs-12 u-cursor-pointer">Output</summary>
              <pre className="u-mono u-fs-12 u-overflow-auto u-mbox-t1">{jsonPreview(p.output)}</pre>
            </details>
          )}
        </div>
      )}

      <p className="muted runprov-caveat">
        <InfoIcon size={12} style={{ flexShrink: 0, marginTop: 1 }} />
        Derived from this run&apos;s event log — a transparent provenance trail, not a signed attestation record.
      </p>
    </div>
  );
}
