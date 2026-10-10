/**
 * RunHandoffMap — multi-agent handoff & dispatch visualization.
 *
 * Surfaces the orchestration event families as a sequence-ordered strip
 * of transition chips so a supervisor → worker → child run flow reads
 * left-to-right:
 *
 *   - `runOrchestrator.decided`               supervisor decision
 *   - `agent.handoff` (RFC 0007)              fromAgent → toAgent
 *   - `node.dispatched`                       child run spawned
 *   - `core.workflowChain.event` (RFC 0037)   dispatch lifecycle phases
 *     (dispatch.began → succeeded/failed → child.* → output.harvested)
 *   - `core.workflowChain.confidence-escalated` (RFC 0039/0044)
 *                                             low-confidence escalation marker
 *
 * ADR 0829 — a handoff or escalation that carried a structured handoff note
 * (`openwop-handoff` on `agent.handoff`, or on the `node.suspended` an
 * escalation produced) renders as a disclosure button; the note opens below the
 * strip in the shared `HandoffNoteCard`.
 *
 * Renders nothing when a run has no orchestration events (single-agent
 * / no-handoff runs).
 */

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunEventDoc } from '@openwop/openwop';
import i18n from '../i18n/index.js';
import { formatPercent } from '../i18n/format.js';
import { readHandoffNote, type HandoffNote } from './handoffNote.js';
import { HandoffNoteCard } from './HandoffNoteCard.js';
import { Button } from '../ui/Button.js';

interface Props {
  events: readonly RunEventDoc[];
}

interface Chip {
  seq: number;
  kind: 'supervisor' | 'handoff' | 'dispatch' | 'phase' | 'escalation';
  label: string;
  sublabel?: string;
  color: string;
  emphasize?: boolean;
  /** ADR 0829 — the structured handoff note this transfer carried, if any. */
  note?: HandoffNote;
}

const PHASE_COLOR: Record<string, string> = {
  'dispatch.began': 'var(--clay)',
  'dispatch.succeeded': 'var(--color-success)',
  'dispatch.failed': 'var(--color-danger)',
  'child.completed': 'var(--color-success)',
  'child.failed': 'var(--color-danger)',
  'child.cancelled': 'var(--ink-3)',
  'output.harvested': 'var(--color-info)',
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function buildChips(events: readonly RunEventDoc[]): Chip[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const chips: Chip[] = [];
  for (const ev of sorted) {
    const p = asRecord(ev.payload);
    switch (ev.type) {
      case 'runOrchestrator.decided': {
        const d = p.decision;
        const label = typeof d === 'string' ? d : (asRecord(d).kind as string) ?? i18n.t('runs:handoffDecidedFallback');
        chips.push({ seq: ev.sequence, kind: 'supervisor', label: i18n.t('runs:handoffSupervisor', { decision: label }), sublabel: p.agentId as string, color: 'var(--color-ai-text)' });
        break;
      }
      case 'agent.handoff': {
        // Tolerate canonical (fromAgentId/toAgentId) and variant (from/to).
        const from = (p.fromAgentId ?? p.from) as string | undefined;
        const to = (p.toAgentId ?? p.to) as string | undefined;
        const note = readHandoffNote(p);
        chips.push({
          seq: ev.sequence, kind: 'handoff',
          label: `${from ?? '?'} → ${to ?? '?'}`,
          ...(typeof p.reason === 'string' ? { sublabel: p.reason as string } : {}),
          color: 'var(--color-info-text)',
          ...(note ? { note } : {}),
        });
        break;
      }
      case 'node.dispatched':
        chips.push({
          seq: ev.sequence, kind: 'dispatch',
          label: i18n.t('runs:handoffDispatch', { workflowId: String(p.childWorkflowId ?? '') }).trim(),
          ...(typeof p.childStatus === 'string' ? { sublabel: p.childStatus as string } : {}),
          color: 'var(--clay-text)',
        });
        break;
      case 'core.workflowChain.event': {
        const phase = String(p.phase ?? '');
        chips.push({
          seq: ev.sequence, kind: 'phase',
          label: phase,
          ...(typeof p.workerId === 'string' ? { sublabel: p.workerId as string } : {}),
          color: PHASE_COLOR[phase] ?? 'var(--ink-3)',
        });
        break;
      }
      case 'core.workflowChain.confidence-escalated':
        chips.push({
          seq: ev.sequence, kind: 'escalation',
          label: i18n.t('runs:handoffEscalation', { kind: String(p.escalationKind ?? '') }),
          sublabel: typeof p.confidence === 'number'
            ? i18n.t('runs:handoffConfidenceFloor', {
                conf: formatPercent(p.confidence as number),
                floor: formatPercent((p.floor as number) ?? 0),
              })
            : (p.workerId as string),
          color: 'var(--color-warning-text)',
          emphasize: true,
        });
        break;
      case 'node.suspended': {
        // ADR 0829 — the escalation's note rides `node.suspended`; attach it to the
        // escalation chip the same node produced (the nearest one before it).
        const note = readHandoffNote(p);
        if (!note) break;
        const esc = [...chips].reverse().find((c) => c.kind === 'escalation' && !c.note);
        if (esc) esc.note = note;
        break;
      }
      default:
        break;
    }
  }
  return chips;
}

export function RunHandoffMap({ events }: Props) {
  const { t } = useTranslation('runs');
  const chips = useMemo(() => buildChips(events), [events]);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const noteId = useId();
  if (chips.length === 0) return null;
  const open = chips.find((c) => c.seq === openSeq && c.note);
  return (
    <div className="card">
      <h2>{t('multiAgentHandoffs')}</h2>
      <div className="handoff-map">
        {chips.map((chip, i) => (
          <div className="handoff-chip-wrap" key={`${chip.seq}-${i}`}>
            {i > 0 && <span className="handoff-arrow" aria-hidden>→</span>}
            {chip.note ? (
              <Button
                variant="quiet"
                size="sm"
                className={`handoff-chip handoff-chip--button${chip.emphasize ? ' handoff-chip-emphasize' : ''}`}
                style={{ borderColor: chip.color }}
                aria-expanded={openSeq === chip.seq}
                aria-controls={noteId}
                onClick={() => setOpenSeq(openSeq === chip.seq ? null : chip.seq)}
              >
                <span className="handoff-chip-dot" style={{ background: chip.color }} aria-hidden />
                <span className="handoff-chip-label">{chip.label}</span>
                {chip.sublabel && <span className="muted handoff-chip-sub">{chip.sublabel}</span>}
                <span className="handoff-chip-note-tag">{t('handoffNoteShow')}</span>
              </Button>
            ) : (
              <div
                className={`handoff-chip${chip.emphasize ? ' handoff-chip-emphasize' : ''}`}
                style={{ borderColor: chip.color }}
                title={`#${chip.seq} ${chip.kind}`}
              >
                <span className="handoff-chip-dot" style={{ background: chip.color }} aria-hidden />
                <span className="handoff-chip-label">{chip.label}</span>
                {chip.sublabel && <span className="muted handoff-chip-sub">{chip.sublabel}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      {open?.note && <HandoffNoteCard id={noteId} note={open.note} title={t('handoffNoteTitle', { label: open.label })} />}
    </div>
  );
}
