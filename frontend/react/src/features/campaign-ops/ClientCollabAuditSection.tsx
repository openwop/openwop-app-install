/**
 * ADR 0958 D7 / P5 — the audit review: who was invited, given or refused
 * access, and which files came in and were decided, for this client, newest
 * first. It reads the tenant's tamper-evident audit chain, which records ids
 * only; names are today's, so a person who was erased reads as removed.
 *
 * Lazy (own chunk), agency admins only. Renders nothing when external
 * collaborators are off or the caller does not manage the client. A failed
 * read is said with a retry, never shown as "no activity".
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { formatDate, formatTime } from '../../i18n/format.js';
import { CampaignOpsError } from './campaignOpsClient.js';
import { listCollabAudit, type CollabAuditEvent } from './collabAuditClient.js';

type Load = { kind: 'loading' } | { kind: 'hidden' } | { kind: 'failed' } | { kind: 'ready'; events: CollabAuditEvent[]; truncated: boolean };
type TFn = ReturnType<typeof useTranslation>['t'];

const FIRST = 20;
const KNOWN = new Set([
  'collaborator.invite', 'collaborator.adopt', 'collaborator.add-link-only', 'collaborator.accept', 'collaborator.reactivate',
  'collaborator.suspend', 'collaborator.revoke', 'grant.create', 'grant.revoke',
  'intake.submit', 'intake.withdraw', 'intake.accept', 'intake.reject',
]);

const hidden = (e: unknown): boolean =>
  e instanceof CampaignOpsError && (e.status === 403 || (e.status === 404 && /not enabled/i.test(e.message)));

/** The i18n key of an action; an action this build does not know is said generically. */
export function auditActionKey(action: string): string {
  return KNOWN.has(action) ? `auditAction_${action.replace(/[.-]/g, '_')}` : 'auditAction_other';
}

const KIND_KEYS: Record<string, string> = { campaign: 'auditKind_campaign', 'creative-brief': 'auditKind_creative_brief' };
const ACTION_KEYS: Record<string, string> = {
  view: 'auditGrantAction_view', comment: 'auditGrantAction_comment', upload: 'auditGrantAction_upload',
  'mark-ready': 'auditGrantAction_mark_ready', decide: 'auditGrantAction_decide',
};

/** A grant's kind and actions in words, never as raw ids; one this build does
 *  not know is said generically. */
export function kindLabel(kind: string, t: TFn): string {
  return t(KIND_KEYS[kind] ?? 'auditKind_other');
}
function actionsLabel(actions: readonly string[], t: TFn): string {
  return actions.map((a) => t(ACTION_KEYS[a] ?? 'auditGrantAction_other')).join(', ');
}

function detail(e: CollabAuditEvent, t: TFn): string | null {
  const raw = e.resource?.kind ?? e.resourceKind;
  const kind = raw ? kindLabel(raw, t) : undefined;
  if (e.action === 'grant.create' && kind) return t('auditDetailGrant', { kind, actions: actionsLabel(e.actions ?? [], t) });
  if (kind && e.action === 'grant.revoke') return t('auditDetailKind', { kind });
  if (typeof e.files === 'number') return t('auditDetailFiles', { count: e.files });
  if (typeof e.assets === 'number') return t('auditDetailAssets', { count: e.assets });
  return null;
}

export function ClientCollabAuditSection({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-ops');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [all, setAll] = useState(false);

  const refresh = useCallback(async () => {
    try { setLoad({ kind: 'ready', ...(await listCollabAudit(orgId)) }); }
    catch (e) { setLoad(hidden(e) ? { kind: 'hidden' } : { kind: 'failed' }); }
  }, [orgId]);
  useEffect(() => { setLoad({ kind: 'loading' }); setAll(false); void refresh(); }, [refresh]);

  if (load.kind === 'hidden') return null;
  const events = load.kind === 'ready' ? load.events : [];
  const shown = all ? events : events.slice(0, FIRST);
  return (
    <section className="surface-card" aria-labelledby="campaign-ops-collab-audit">
      <h3 id="campaign-ops-collab-audit" className="u-mt-0 u-fs-15">{t('auditHeading')}</h3>
      <p className="muted u-fs-13 u-mt-0">{t('auditIntro')}</p>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('auditLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('auditLoadFailed')} announcePolite message={t('auditLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('intakeRetry')}</Button>} />
      ) : null}
      {load.kind === 'ready' && events.length === 0 ? <p className="muted u-mb-0">{t('auditEmpty')}</p> : null}
      {shown.length > 0 ? (
        <ol className="u-list-plain u-grid u-gap-2 u-m-0" aria-label={t('auditListLabel')}>
          {shown.map((e) => {
            const d = detail(e, t);
            return (
              <li key={e.seq} className="u-flex u-flex-wrap u-gap-2 u-items-baseline u-fs-13">
                <time dateTime={e.at} className="muted">{t('auditWhen', { date: formatDate(e.at), time: formatTime(e.at) })}</time>
                <span className="u-fw-600">{e.collaborator?.displayName ?? (e.collaboratorId ? t('auditRemovedPerson') : t('auditNoPerson'))}</span>
                <span>{t(auditActionKey(e.action))}</span>
                {d ? <span className="muted">{d}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {!all && events.length > FIRST ? (
        <Button variant="link" onClick={() => setAll(true)}>{t('auditShowAll', { count: events.length })}</Button>
      ) : null}
      {load.kind === 'ready' && load.truncated ? <p className="muted u-fs-13 u-mb-0">{t('auditTruncated')}</p> : null}
    </section>
  );
}
