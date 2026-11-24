/**
 * ADR 1156 — the chat card for a held tool call, under the agent turn that raised it.
 *
 * The card IS the conversation-tools ledger row (ADR 1156 D1): it reads the row through
 * the same `capability-scope` read the composer control uses and decides through the
 * same approvals route, with the version it showed. It is not an interrupt. One press on
 * Approve approves exactly this call and sends the Continue message through the
 * surface's own submit (D4). Its outcome comes from the run log (D5): carried out,
 * refused with the tool's own words, or not used because the agent asked for something
 * else. The description is the tool's own (D3), with the raw arguments behind a toggle.
 *
 * Lazy-loaded by the message feed, with its client.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import { CheckIcon } from '../ui/icons/index.js';
import { ApprovalConflictError, getCapabilityScope, isExpiredApproval, resolveToolApproval, type ApprovalLine, type CapabilityScopeView, type ToolApproval } from './capabilityScopeClient.js';

export interface HeldCall {
  askId: string;
  toolName: string;
  requestedAt: string;
  outcome?: 'ran' | 'refused' | 'superseded';
  reason?: string;
}

/** What a feature's own card (`tool-approval.<toolName>`, ADR 1156 D9) receives. */
export interface HeldCallCardPayload {
  toolName: string;
  state: HeldCallState;
  lines?: ApprovalLine[];
  requestedInput?: string;
  inputTruncated?: boolean;
  reason?: string;
  mayApprove: boolean;
}

export type HeldCallState = 'loading' | 'waiting' | 'approved' | 'declined' | 'ran' | 'refused' | 'superseded' | 'gone';

export interface HeldCallCardProps {
  sessionId: string;
  held: HeldCall;
  /** Changes when the conversation moves on: the card re-reads the ledger. */
  refreshKey: number;
  /** The surface's own submit, for the Continue message. */
  onContinue: (text: string) => void;
  /** A feature's registered card for this tool (ADR 1156 D9), rendered in place of the
   *  default. `approve` / `decline` go through the same decision as the default card. */
  renderCustom?: (payload: HeldCallCardPayload, onAction: (actionId: string) => Promise<void>) => ReactNode;
}

/** The ledger row this card is: the latest ask from this turn (an older row without an
 *  `askId` is matched by the version the event recorded). */
function rowFor(view: CapabilityScopeView | null, held: HeldCall): ToolApproval | undefined {
  return view?.approvals.find((a) => a.toolName === held.toolName && (a.askId ? a.askId === held.askId : a.requestedAt === held.requestedAt));
}

function stateOf(held: HeldCall, row: ToolApproval | undefined, loaded: boolean, local: 'approved' | 'declined' | null): HeldCallState {
  if (held.outcome) return held.outcome;
  if (row?.status === 'pending' && !isExpiredApproval(row)) return local ?? 'waiting';
  if (row?.status === 'approved') return 'approved';
  if (row?.status === 'denied') return 'declined';
  if (local) return local;
  return loaded ? 'gone' : 'loading';
}

/** Group consecutive lines under their heading. */
function groupLines(lines: readonly ApprovalLine[]): Array<{ group?: string; lines: string[] }> {
  const out: Array<{ group?: string; lines: string[] }> = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.group === l.group) last.lines.push(l.text);
    else out.push({ ...(l.group ? { group: l.group } : {}), lines: [l.text] });
  }
  return out;
}

export default function HeldCallCard({ sessionId, held, refreshKey, onContinue, renderCustom }: HeldCallCardProps): JSX.Element | null {
  const { t } = useTranslation('conversationTools');
  const [view, setView] = useState<CapabilityScopeView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<'approved' | 'declined' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArgs, setShowArgs] = useState(false);

  const load = useCallback(async () => {
    try { setView(await getCapabilityScope(sessionId)); }
    catch { setView(null); }
    finally { setLoaded(true); }
  }, [sessionId]);
  useEffect(() => { void load(); }, [load, refreshKey, held.outcome]);

  const row = rowFor(view, held);
  const state = stateOf(held, row, loaded, local);
  const mayApprove = view?.viewer?.mayApprove ?? false;

  const decide = useCallback(async (decision: 'approved' | 'denied') => {
    if (!row || busy) return;
    setBusy(true);
    setError(null);
    try {
      await resolveToolApproval(sessionId, held.toolName, decision, row.requestedAt, 'call');
      setLocal(decision === 'approved' ? 'approved' : 'declined');
      if (decision === 'approved') onContinue(t('continueMessage'));
    } catch (err) {
      setError(err instanceof ApprovalConflictError ? t('approvalChanged') : t('decisionFailed'));
    } finally {
      setBusy(false);
      void load();
    }
  }, [row, busy, sessionId, held.toolName, onContinue, t, load]);

  const statusText = useMemo(() => {
    switch (state) {
      case 'approved': return t('cardApproved');
      case 'declined': return t('cardDeclined');
      case 'ran': return t('cardRan');
      case 'refused': return held.reason ? t('cardRefused', { reason: held.reason }) : t('cardRefusedNoReason');
      case 'superseded': return t('cardSuperseded');
      case 'gone': return t('cardGone');
      default: return '';
    }
  }, [state, held.reason, t]);

  const lines = state === 'waiting' ? row?.requestedLines : undefined;
  if (renderCustom) {
    const payload: HeldCallCardPayload = {
      toolName: held.toolName, state, mayApprove,
      ...(lines ? { lines } : {}),
      ...(state === 'waiting' && row?.requestedInput ? { requestedInput: row.requestedInput } : {}),
      ...(row?.inputTruncated ? { inputTruncated: true } : {}),
      ...(held.reason ? { reason: held.reason } : {}),
    };
    return <>{renderCustom(payload, async (id) => { if (id === 'approve') await decide('approved'); else if (id === 'decline') await decide('denied'); })}</>;
  }
  if (state === 'loading') return null;

  return (
    <section className="surface-card u-p-3 u-flex u-flex-col u-gap-2" aria-label={t('cardAria', { tool: held.toolName })} data-testid="held-call-card">
      <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
        <span className="u-fw-600 u-fs-13">{state === 'waiting' ? t('cardTitle') : t('cardTitleDone')}</span>
        <code className="u-fs-12">{held.toolName}</code>
      </div>
      {state === 'waiting' && (
        <>
          {lines && lines.length > 0 ? (
            <div className="u-flex u-flex-col u-gap-1">
              {groupLines(lines).map((g, i) => (
                <div key={i}>
                  {g.group && <div className="u-fs-12 u-fw-600 u-mb-1">{g.group}</div>}
                  <ul className="u-m-0 u-pl-3 u-fs-12">{g.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
                </div>
              ))}
            </div>
          ) : null}
          {row?.requestedInput ? (
            lines && lines.length > 0 ? (
              <div>
                <Button variant="link" className="u-fs-11" aria-expanded={showArgs} onClick={() => setShowArgs((v) => !v)}>
                  {showArgs ? t('cardHideDetails') : t('cardShowDetails')}
                </Button>
                {showArgs && <pre className="ct-requested-input u-fs-11 u-m-0" tabIndex={0} aria-label={`${t('requestedWith')} ${held.toolName}`}>{row.requestedInput}</pre>}
              </div>
            ) : (
              <>
                <div className="u-fs-11 muted">{t('requestedWith')}</div>
                <pre className="ct-requested-input u-fs-11 u-m-0" tabIndex={0} aria-label={`${t('requestedWith')} ${held.toolName}`}>{row.requestedInput}</pre>
              </>
            )
          ) : (!lines || lines.length === 0) && <span className="u-fs-11 muted">{t('noArguments')}</span>}
          {row?.inputTruncated && <Notice variant="warning">{t('inputHidden')}</Notice>}
          {mayApprove ? (
            <div className="u-flex u-gap-2 u-flex-wrap">
              <Button variant="primary" className="u-fs-12" disabled={busy} onClick={() => void decide('approved')} aria-label={t('cardApproveAria', { tool: held.toolName })}>
                <CheckIcon size={12} /> {busy ? t('cardWorking') : t('cardApprove')}
              </Button>
              <Button variant="secondary" className="u-fs-12" disabled={busy} onClick={() => void decide('denied')} aria-label={t('cardDeclineAria', { tool: held.toolName })}>
                {t('cardDecline')}
              </Button>
            </div>
          ) : <p className="muted u-fs-12 u-m-0">{t('notOwnerNote')}</p>}
        </>
      )}
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <p className={statusText ? 'u-fs-12 u-m-0' : 'sr-only'} role="status" aria-live="polite">{statusText}</p>
    </section>
  );
}
