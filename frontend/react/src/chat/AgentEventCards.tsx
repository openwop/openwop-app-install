/**
 * Inline cards for the agent.* event family (RFC 0002 §B), rendered
 * under the assistant bubble:
 *
 *   - ToolCallCard      `agent.toolCalled` + matching `agent.toolReturned`
 *   - HandoffIndicator  `agent.handoff`
 *   - DecisionBadge     `agent.decided`
 *
 * Three cards, three shapes, all consistent with the ThoughtsDisclosure
 * visual idiom (muted by default, expand-on-click for detail). Zero
 * new deps; CSS-only animations gated on prefers-reduced-motion.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDecision,
  AgentHandoff,
  AgentToolCall,
  AgentVerified,
} from './hooks/useChatSession.js';
import { formatDurationMs, formatPercent } from '../i18n/format.js';
import { ScaleIcon, ShieldIcon, WrenchIcon } from '../ui/icons/index.js';

function formatDuration(ms: number): string {
  return formatDurationMs(ms);
}

function jsonPreview(value: unknown, max = 200): string {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * TOCU-6 (ADR 0604) + review M9 — the tool-error sentence, resolved through
 * LITERAL `t()` calls.
 *
 * The first cure built the key dynamically:
 *
 *     t([`toolErr_${call.error.code}`, 'toolErrGeneric'] as unknown as string)
 *
 * which worked at runtime and was INVISIBLE to `check-i18n`, so
 * `chat:toolErr_forbidden` and `chat:toolErr_invalid_args` were reported as
 * ORPHANED CATALOG KEYS — and `/cleanup` hunts orphans by name. The batch
 * traded a hardcoded-English defect for a gate-invisible one, and the cast was
 * the only `as unknown as string` in the entire frontend `src/`.
 *
 * A switch over literal keys is what the key-parity gate can actually see. An
 * unknown code still falls through to `toolErrGeneric`, so a new transport
 * status can never render as a bare machine token — the property TOCU-6 exists
 * for. Adding a code means adding a case AND four catalog entries, which is the
 * work the gate is supposed to force.
 */
export function toolErrorMessage(t: (k: string) => string, code: string | undefined): string {
  switch (code) {
    case 'forbidden': return t('toolErr_forbidden');
    case 'invalid_args': return t('toolErr_invalid_args');
    default: return t('toolErrGeneric');
  }
}

// ── Tool call card ─────────────────────────────────────────────────

export function ToolCallCard({ call }: { call: AgentToolCall }): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const inFlight = call.finishedAt == null;
  const durationMs = call.finishedAt
    ? Date.parse(call.finishedAt) - Date.parse(call.startedAt)
    : 0;
  const isError = !!call.error;
  const accent = isError ? 'var(--color-danger)' : 'var(--clay-text)';

  return (
    <div
      className="agentevt-card"
      style={{
        borderLeft: `2px solid ${accent}`,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="agentevt-toggle-btn"
      >
        <span className="muted u-iflex" aria-hidden>
          <WrenchIcon size={12} />
        </span>
        <span className="u-fw-600">{call.toolName}</span>
        {call.agentId && (
          // RFC 0040 cross-host causation — surface which agent issued the
          // call. Mono-font chip matches the HandoffIndicator idiom.
          <span
            className="muted u-mono u-fs-10"
            title={t('calledBy', { agentId: call.agentId })}
          >
            @{call.agentId}
          </span>
        )}
        <span
          className="muted u-ml-auto u-tabular u-fs-11 u-iflex u-items-center u-gap-1-5"
        >
          {inFlight ? (
            <>
              {t('running')}
              <span className="think-dots u-gap-0-5" aria-hidden>
                <span className="think-dot" />
                <span className="think-dot" />
                <span className="think-dot" />
              </span>
            </>
          ) : isError ? t('failed') : formatDuration(durationMs)}
        </span>
      </button>
      {open && (
        <div className="u-mt-1-5 u-flex u-flex-col u-gap-1-5">
          {/* TOCU-7 (ADR 0604) — the `Inputs` and `Result` disclosures that used
              to sit here were UNREACHABLE CODE, and that is worse than absent:
              they look like a tool-transparency affordance while showing nothing.
              `AgentToolCall.inputs` / `.outcome` had readers and NO writer
              anywhere in the SPA — the sole construction site
              (`hooks/chatSession/lib.ts`) sets only callId/toolName/agentId/
              startedAt, and the settle branch only finishedAt/error. The backend
              makes it structural, not accidental: `agent.toolCalled` carries an
              `argsHash`, never the args, and `agent.toolReturned` carries no
              result payload at all (RFC 0064 — see
              `features/workflow-author/agentTools.ts`). Restoring these needs a
              WIRE change, i.e. an RFC in `../openwop`, so they are deleted here
              rather than left as dead honesty. Tracked with TOCU-4/WFAU-4. */}
          {isError && call.error && (
            <div className="agentevt-error">
              <strong>{call.error.code}:</strong>{' '}
              {/* TOCU-6 (ADR 0604) — resolve the sentence HERE, where `t` exists.
                  `message` is only rendered when a transport actually supplies
                  one; the three English literals that used to arrive in it are
                  gone. See `toolErrorMessage` above for why the key lookup is a
                  switch over literals rather than a template (review M9). */}
              {call.error.message ?? toolErrorMessage(t, call.error.code)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Handoff indicator ───────────────────────────────────────────────

export function HandoffIndicator({ handoff }: { handoff: AgentHandoff }): JSX.Element {
  return (
    <div
      className="agentevt-handoff"
      title={handoff.reason}
    >
      <span className="u-mono">{handoff.fromAgentId}</span>
      <span aria-hidden className="u-o-60">→</span>
      <span className="u-mono">{handoff.toAgentId}</span>
      {handoff.reason && (
        <span className="muted u-ml-1 u-fs-10 u-italic">
          {handoff.reason}
        </span>
      )}
    </div>
  );
}

// ── Decision badge ──────────────────────────────────────────────────

export function DecisionBadge({ decision }: { decision: AgentDecision }): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const conf = decision.confidence;
  const confColor =
    conf == null ? 'var(--ink-3)' :
    conf >= 0.7 ? 'var(--color-success)' :
    conf >= 0.5 ? 'var(--color-warning)' :
                  'var(--color-danger)';
  const decisionLabel = typeof decision.decision === 'string'
    ? decision.decision
    : typeof decision.decision === 'object' && decision.decision && 'next' in (decision.decision as Record<string, unknown>)
      ? String((decision.decision as Record<string, unknown>).next)
      : 'decision';

  return (
    <div className="u-mt-1-5 u-pad-6x10 u-bg-surface-2 u-border u-radius u-fs-12">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="agentevt-toggle-btn"
      >
        <span className="muted u-iflex" aria-hidden><ScaleIcon size={12} /></span>
        <span className="u-fw-600">{t('decisionLabel', { decision: decisionLabel })}</span>
        {conf != null && (
          <span
            className="agentevt-conf-chip"
            style={{
              border: `1px solid ${confColor}`,
              color: confColor,
            }}
          >
            {formatPercent(conf, { maximumFractionDigits: 0 })}
          </span>
        )}
      </button>
      {open && (
        <details open className="u-mt-1-5">
          <summary className="muted u-cursor-pointer u-fs-11">{t('rawDecision')}</summary>
          <pre className="agentevt-pre">
            {jsonPreview(decision.decision, 2000)}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── Verification card (RFC 0090 `agent.verified`) ──────────────────
//
// A content-free critic verdict over the actor's result: pass / fail /
// revise, with optional criteria keys + confidence. Mirrors the
// DecisionBadge idiom (token-styled box, ui/icons, color + label — never
// color alone, per DESIGN.md §5.3).
export function VerificationCard({ verified }: { verified: AgentVerified }): JSX.Element {
  const { t } = useTranslation('chat');
  const { verdict, confidence: conf, criteria, target } = verified;
  const tone =
    verdict === 'pass' ? 'var(--color-success)' :
    verdict === 'fail' ? 'var(--color-danger)' :
                         'var(--color-warning)';
  const label =
    verdict === 'pass' ? t('verified') :
    verdict === 'fail' ? t('verificationFailed') :
                         t('revisionRequested');
  return (
    <div
      className="agentevt-card"
      style={{
        borderLeft: `2px solid ${tone}`,
      }}
    >
      <div className="u-iflex u-items-center u-gap-1-5 u-w-full">
        <span className="agentevt-icon" style={{ color: tone }} aria-hidden><ShieldIcon size={12} /></span>
        <span className="agentevt-verdict-label" style={{ color: tone }}>{label}</span>
        <span className="muted u-fs-11">{t('verificationTarget', { target })}</span>
        {conf != null && (
          <span
            className="agentevt-conf-chip"
            style={{
              border: `1px solid ${tone}`,
              color: tone,
            }}
          >
            {formatPercent(conf, { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      {criteria && criteria.length > 0 && (
        <div className="muted u-mt-1 u-fs-11 u-flex u-gap-1-5 u-wrap">
          {criteria.map((c) => (
            <code key={c} className="u-fs-10">{c}</code>
          ))}
        </div>
      )}
    </div>
  );
}
