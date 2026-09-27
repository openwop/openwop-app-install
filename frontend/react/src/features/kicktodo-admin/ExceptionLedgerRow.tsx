/**
 * ADR 0460 Phase 2 — the Exception Ledger Row (ADR 0438 §4.4 grammar).
 *
 * Composes existing primitives — it does NOT fork ReviewCard and adds no colour
 * CSS. Severity is conveyed BY SHAPE (a per-severity glyph) + a localized label
 * chip, never colour alone (DESIGN.md §5.3/§11). Each row shows: severity glyph +
 * label · the server one-liner · the server-authoritative owner · a mono id · ONE
 * safe action that DEEP-LINKS the owning surface · an inline audit expander (the
 * ReviewCard `<details class="review-card__trace">` pattern). The row renders only
 * what the server read backs — no painted status.
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { BanIcon, AlertIcon, FlagIcon, InfoIcon } from '../../ui/icons/index.js';
import { formatDate, formatRelativeTime } from '../../i18n/format.js';
import {
  getExceptionAudit,
  type ExceptionAuditEntry,
  type ExceptionRow,
  type ExceptionSeverity,
} from '../../client/kicktodoExceptionsClient.js';

const SEV_ICON: Record<ExceptionSeverity, typeof AlertIcon> = {
  blocker: BanIcon,
  'action-required': AlertIcon,
  attention: FlagIcon,
  degraded: InfoIcon,
};
const SEV_CHIP: Record<ExceptionSeverity, string> = {
  blocker: 'chip chip--danger',
  'action-required': 'chip chip--danger',
  attention: 'chip chip--warning',
  degraded: 'chip chip--warning',
};

export function ExceptionLedgerRow({ row }: { row: ExceptionRow }): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const Icon = SEV_ICON[row.severity];
  // ADR 0301 slice — approval-backed rows (`approval:<id>`) fetch their
  // GOVERNANCE_DECISION chain entries ON EXPAND (never a page-load fan-out).
  // undefined = not fetched; 'loading'; null = read failed; [] = no decision yet.
  const approvalId = row.id.startsWith('approval:') ? row.id.slice('approval:'.length) : null;
  const [slice, setSlice] = useState<ExceptionAuditEntry[] | null | 'loading' | undefined>(undefined);
  const loadAudit = () => {
    if (!approvalId) return;
    setSlice('loading');
    void getExceptionAudit(approvalId).then(setSlice).catch(() => setSlice(null));
  };
  const onToggleAudit = (open: boolean) => {
    if (!open || !approvalId || slice !== undefined) return;
    loadAudit();
  };
  // 0438 §4.4 — the AGE pill: relative time is the queue's working unit
  // ("2 hours ago" scans; an absolute stamp lives in the audit expander).
  const detectedAgo = row.audit.detectedAt ? formatRelativeTime(row.audit.detectedAt) : '';
  const detectedAbs = row.audit.detectedAt ? formatDate(row.audit.detectedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return (
    <li className="surface-card">
      <div className="action-bar">
        <Icon size={14} aria-hidden />
        <span className={SEV_CHIP[row.severity]}>{t(`severity_${row.severity}`)}</span>
        <strong>{row.label}</strong>
      </div>
      <div className="action-bar">
        <span className="muted u-fs-13">{t('exceptionOwner', { owner: row.owner.label })}</span>
        <code className="u-fs-13">{row.id}</code>
        {detectedAgo && <span className="chip chip--muted" title={detectedAbs}>{detectedAgo}</span>}
        <Link className="btn-accent-solid btn-sm" to={row.action.href}>{t(row.action.labelKey)}</Link>
      </div>
      <details className="review-card__trace" onToggle={(e) => onToggleAudit((e.target as HTMLDetailsElement).open)}>
        <summary>{t('exceptionAudit')}</summary>
        {/* The expander carries what the ROW doesn't (source lane, owner
            kind/ref, the absolute stamp) — never a restatement of the row's
            own fields. */}
        <ul className="review-card__provenance" aria-label={t('exceptionAudit')}>
          <li className="chip chip--muted">{t('exceptionAuditSource', { source: row.source })}</li>
          <li className="chip chip--muted">{t('exceptionAuditOwner', { kind: row.owner.kind, ref: row.owner.ref })}</li>
          {detectedAbs && <li className="chip chip--muted">{t('exceptionAuditDetected', { when: detectedAbs })}</li>}
        </ul>
        {/* ADR 0301 — the chain slice: actor → before → after per decision,
            note verbatim. Only approval-backed rows have a chain lane; an
            empty slice is stated honestly (pending / predates the chain). */}
        {approvalId && (
          <div className="u-fs-13">
            {slice === 'loading' && <p className="muted u-m-0">{t('exceptionChainLoading')}</p>}
            {slice === null && (
              <Notice variant="error" announce={t('exceptionChainError')}>
                {t('exceptionChainError')}
                <div className="action-bar"><Button size="sm" variant="secondary" onClick={loadAudit}>{t('retry')}</Button></div>
              </Notice>
            )}
            {Array.isArray(slice) && slice.length === 0 && <p className="muted u-m-0">{t('exceptionChainEmpty')}</p>}
            {Array.isArray(slice) && slice.length > 0 && (
              <ul role="list" className="list-plain">
                {slice.map((e) => (
                  <li key={e.seq}>
                    <code className="u-fs-13">
                      {t('exceptionChainLine', {
                        actor: e.payload.actor ?? t('exceptionChainUnattributed'),
                        before: e.payload.before ?? 'pending',
                        after: e.payload.outcome ?? '?',
                      })}
                    </code>
                    {e.payload.note && <span className="muted"> · {e.payload.note}</span>}
                    <span className="muted"> · {formatDate(e.at, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </details>
    </li>
  );
}
