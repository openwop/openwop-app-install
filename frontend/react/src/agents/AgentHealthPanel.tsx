/**
 * Agent health (ADR 0029 Part 1 / ADR 0023 §12 T8) — the Chief of Staff's
 * operating metrics, surfaced at the bottom of its agent workspace page next to
 * Recurring tasks. It reuses the existing superadmin-gated /assistant/health
 * endpoint (the same builder the standalone page used) — no parallel metrics
 * store. The panel renders ONLY when the endpoint resolves (admins); for
 * non-admins getAssistantHealth returns null and the panel stays hidden.
 *
 * The metrics (action approval/edit/citation rates, taint share, stale
 * commitments, loop status) are the assistant's domain, so the workspace page
 * gates this on `roleKey === 'chief-of-staff'` — the same gate as Recurring
 * tasks. A generic per-agent telemetry surface would be a separate concept;
 * this deliberately reuses what already exists.
 *
 * Presentation: a plain-language verdict strip (the one-glance answer AND the
 * next step) over KPI tiles + labelled rate meters, reusing the run-stat /
 * wf-outcome display-numeral house style. Counts always show (a "0 failed" tile
 * is reassuring, not noise); the four quality rates collapse to a single hint
 * until the agent has sent an action, so a brand-new agent reads as calm rather
 * than a wall of "—". Only the two unambiguous alarms — failed actions, stale
 * commitments — carry semantic colour; ambiguous rates (a high edit rate is not
 * clearly "good") stay neutral.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getAssistantHealth, type AssistantHealth } from '../features/assistant/assistantClient.js';
import { relativeTime } from './agentViewModel.js';
import { formatDateTime } from '../i18n/format.js';
import {
  AlertIcon, CheckIcon, ClockIcon, InboxIcon, LinkIcon,
  PencilIcon, QuoteIcon, SendIcon, SparklesIcon, ThumbsUpIcon,
} from '../ui/icons/index.js';

type Tone = 'danger' | 'warn' | 'accent' | 'success' | 'muted';

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

const VERDICT_ICON: Record<Tone, (props: { size?: number }) => JSX.Element> = {
  danger: AlertIcon,
  warn: ClockIcon,
  accent: InboxIcon,
  success: CheckIcon,
  muted: SparklesIcon,
};

/** The one-glance answer AND the next step: alarms first (failures, then stale
 *  commitments), then attention (awaiting approval), then a plain healthy/idle
 *  read. `note` tells the admin what to do, not just what the state is. */
function verdict(h: AssistantHealth, persona: string): { tone: Tone; label: string; note: string } {
  if (h.actions.failed > 0) {
    return { tone: 'danger', label: `${plural(h.actions.failed, 'action')} failed`, note: 'Open the Activity tab to see what went wrong.' };
  }
  if (h.commitments.stale > 0) {
    return { tone: 'warn', label: `${plural(h.commitments.stale, 'commitment')} stale`, note: 'These have gone quiet and may need a nudge or to be closed out.' };
  }
  if (h.actions.pending > 0) {
    return { tone: 'accent', label: `${h.actions.pending} awaiting approval`, note: 'Drafted actions are waiting for your review before they go out.' };
  }
  if (h.actions.sent > 0 || h.commitments.open > 0) {
    return { tone: 'success', label: 'Healthy', note: 'Running clean — nothing needs your attention right now.' };
  }
  return { tone: 'muted', label: 'Idle', note: `No actions drafted yet — metrics fill in as ${persona} starts working.` };
}

function Tile({ icon, label, value, tone }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warn' | 'accent' | undefined;
}): JSX.Element {
  return (
    <div className={`agenthealth-tile${tone ? ` agenthealth-tile--${tone}` : ''}`}>
      <span className="agenthealth-tile-l">{icon}{label}</span>
      <span className="agenthealth-n">{value}</span>
    </div>
  );
}

function Rate({ icon, label, value, help }: {
  icon: ReactNode;
  label: string;
  value: number | null;
  help: string;
}): JSX.Element {
  // Floor a non-null fill at 2% so a tiny-but-present rate still reads as a sliver.
  const width = value === null ? 0 : Math.max(2, Math.round(value * 100));
  return (
    <div className="agenthealth-rate" title={help}>
      <span className="agenthealth-rate-head">
        <span className="agenthealth-rate-l">{icon}{label}</span>
        <span className={`agenthealth-rate-v${value === null ? ' muted' : ''}`}>{pct(value)}</span>
      </span>
      <span className="agenthealth-meter" aria-hidden="true">
        <span className="agenthealth-meter-fill" style={{ width: `${width}%` }} />
      </span>
    </div>
  );
}

/** Hero ring gauge for approval rate — the agent drafts outbound actions for a
 *  human to approve, so "what share do I approve?" is the core trust signal and
 *  earns the card's one focal element. Colours come from CSS classes (the
 *  tsx-color-literal guard forbids inline stroke colours); only the geometric
 *  dash offset is computed inline. */
function ApprovalGauge({ rate }: { rate: number }): JSX.Element {
  const r = 30;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="agenthealth-gauge" role="img" aria-label={`Approval rate ${Math.round(rate * 100)} percent`}>
      <svg viewBox="0 0 72 72" className="agenthealth-gauge-svg" aria-hidden="true">
        <circle className="agenthealth-gauge-track" cx="36" cy="36" r={r} fill="none" strokeWidth="6" />
        <circle
          className="agenthealth-gauge-fill" cx="36" cy="36" r={r} fill="none" strokeWidth="6"
          strokeLinecap="round" transform="rotate(-90 36 36)"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - rate)}
        />
      </svg>
      <span className="agenthealth-gauge-c">
        <span className="agenthealth-gauge-n">{Math.round(rate * 100)}%</span>
        <span className="agenthealth-gauge-l">approved</span>
      </span>
    </div>
  );
}

export function AgentHealthPanel({ persona = 'this agent' }: { persona?: string }): JSX.Element | null {
  const [health, setHealth] = useState<AssistantHealth | null>(null);

  useEffect(() => {
    // Admin-only; resolves null on 403 and the panel stays hidden.
    void getAssistantHealth().then(setHealth).catch(() => {});
  }, []);

  if (!health) return null;

  return <AgentHealthView health={health} persona={persona} />;
}

/** Presentational view (no fetching). Split out so the dev preview entry can
 *  exercise every verdict/empty state without a backend or admin session. */
export function AgentHealthView({ health, persona = 'this agent' }: { health: AssistantHealth; persona?: string }): JSX.Element {
  const { actions: a, commitments: c } = health;
  const v = verdict(health, persona);
  const VerdictIcon = VERDICT_ICON[v.tone];
  const generated = new Date(health.generatedAt);
  const ratesPending =
    a.approvalRate === null && a.editRate === null && a.citationCoverage === null && a.taintedShare === null;

  return (
    <article className="surface-card agenthealth">
      <header className="agenthealth-head">
        <div className="u-grid u-gap-1">
          <h2 className="u-m-0">Agent health</h2>
          <p className="muted u-m-0 u-fs-12" title={formatDateTime(generated)}>
            Operating metrics · admin-only · generated {relativeTime(health.generatedAt) ?? formatDateTime(generated)}
          </p>
        </div>
      </header>

      <div className="agenthealth-summary">
        {a.approvalRate !== null ? <ApprovalGauge rate={a.approvalRate} /> : null}
        <div className={`agenthealth-verdict agenthealth-verdict--${v.tone}`} role="status">
          <VerdictIcon size={16} />
          <span><strong>{v.label}</strong> — {v.note}</span>
        </div>
      </div>

      <section className="agenthealth-section">
        <h3 className="agenthealth-group">Actions</h3>
        <div className="agenthealth-tiles">
          <Tile icon={<InboxIcon size={13} />} label="Pending" value={a.pending} tone={a.pending > 0 ? 'accent' : undefined} />
          <Tile icon={<SendIcon size={13} />} label="Sent" value={a.sent} />
          <Tile icon={<AlertIcon size={13} />} label="Failed" value={a.failed} tone={a.failed > 0 ? 'danger' : undefined} />
        </div>
        {ratesPending ? (
          <p className="agenthealth-hint muted">
            <PencilIcon size={14} /> Quality rates start tracking once {persona} sends its first action.
          </p>
        ) : (
          <div className="agenthealth-rates">
            <Rate icon={<ThumbsUpIcon size={13} />} label="Approval rate" value={a.approvalRate}
              help="Share of drafted actions you approved." />
            <Rate icon={<PencilIcon size={13} />} label="Edited before send" value={a.editRate}
              help="Share of approved actions you edited before they went out." />
            <Rate icon={<QuoteIcon size={13} />} label="Cited" value={a.citationCoverage}
              help="Share of actions that carried a source citation." />
            <Rate icon={<LinkIcon size={13} />} label="From connected content" value={a.taintedShare}
              help="Share of actions that drew on connected (untrusted) sources." />
          </div>
        )}
      </section>

      <section className="agenthealth-section">
        <h3 className="agenthealth-group">Commitments</h3>
        <div className="agenthealth-tiles">
          <Tile icon={<ClockIcon size={13} />} label="Open" value={c.open} />
          <Tile icon={<AlertIcon size={13} />} label="Stale" value={c.stale} tone={c.stale > 0 ? 'warn' : undefined} />
        </div>
        <div className="agenthealth-rates">
          <Rate icon={<QuoteIcon size={13} />} label="Cited" value={c.citationCoverage}
            help="Share of open commitments backed by a source citation." />
        </div>
      </section>
    </article>
  );
}
