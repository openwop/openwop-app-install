/**
 * ADR 0944 P4 — the "Client memory" panel on the Operations page: what this
 * client's agents share, and only this client's.
 *
 * - Notes: the trusted facts people wrote (add, remove).
 * - Waiting for review: facts the agents suggested; nothing enters the memory
 *   until a person approves it.
 * - Knowledge: which of the client's own collections the agents search.
 * - What the agents wrote: their summaries, marked unverified, with expiry.
 * - "Ask the team": opens the one chat bound to this client (`/chat?client=`).
 * - Erase (agency admins): empties the client's memory everywhere.
 *
 * A failed read is shown as a failure with a retry, never as an empty list.
 * Lazy-loaded by the page (entry-chunk budget).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { CheckboxField, TextareaField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { useFormat } from '../../i18n/useFormat.js';
import {
  addClientNote, decideClientNoteProposal, getClientMemorySources, listClientNoteProposals, listClientNotes,
  listClientRecall, purgeClientMemory, removeClientNote, setClientMemorySources, CampaignOpsError,
  type ClientMemorySources, type ClientNote, type ClientNoteProposal, type ClientRecallEntry,
} from './campaignOpsClient.js';

/** A row's text, shortened for a button's accessible name. */
const short = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

interface MemoryData {
  notes: ClientNote[];
  proposals: ClientNoteProposal[];
  recall: ClientRecallEntry[];
  sources: ClientMemorySources;
}

interface ClientMemoryPanelProps {
  orgId: string; clientName: string; agencyAdmin: boolean; onStatus: (s: string) => void;
}
export function ClientMemoryPanel(props: ClientMemoryPanelProps): JSX.Element {
  return <MemoryForClient key={props.orgId} {...props} />;
}
function MemoryForClient({ orgId, clientName, agencyAdmin, onStatus }: ClientMemoryPanelProps): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const fmt = useFormat();
  const [data, setData] = useState<MemoryData | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const message = useCallback((e: unknown): string =>
    e instanceof CampaignOpsError && e.status === 403 ? t('memoryNoWrite') : (e instanceof Error && e.message) || t('memoryActionFailed'), [t]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void Promise.all([listClientNotes(orgId), listClientNoteProposals(orgId), listClientRecall(orgId), getClientMemorySources(orgId)])
      .then(([notes, proposals, recall, sources]) => {
        if (!live) return;
        setData({ notes, proposals, recall, sources });
        setPicked(new Set(sources.collectionIds));
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [orgId, reload]);

  /** Run one action; true when it succeeded (its error is shown otherwise). */
  const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (!mounted.current) return false;
      onStatus(done);
      return true;
    } catch (e) {
      if (mounted.current) setError(message(e));
      return false;
    } finally {
      if (mounted.current) { setBusy(null); setReload((n) => n + 1); }
    }
  };

  if (failed) {
    return <StateCard announce title={t('memoryLoadFailedTitle')} body={t('memoryLoadFailedBody')} action={<Button onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>} />;
  }
  if (!data) return <StateCard loading title={t('loading')} />;

  const sourcesChanged = picked.size !== data.sources.collectionIds.length || data.sources.collectionIds.some((id) => !picked.has(id));

  return (
    <section className="surface-card u-grid u-gap-4" aria-labelledby="client-memory-title">
      <div className="u-flex u-flex-wrap u-items-center u-gap-3">
        <h3 id="client-memory-title" className="u-m-0">{t('memoryTitle', { name: clientName })}</h3>
        <Link className="chip chip--muted" to={`/chat?client=${encodeURIComponent(orgId)}`}>{t('memoryAskTeam')}</Link>
      </div>
      <p className="muted u-m-0">{t('memoryLede')}</p>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}

      <div className="u-grid u-gap-2">
        <h4 className="u-m-0">{t('memoryNotesTitle')}</h4>
        {data.notes.length === 0 ? <p className="muted u-m-0">{t('memoryNotesEmpty')}</p> : (
          <ul className="u-grid u-gap-2 u-m-0 u-p-0 u-list-none">
            {data.notes.map((n) => (
              <li key={n.id} className="u-flex u-items-start u-gap-2">
                <span className="u-flex-1">{n.content}</span>
                <Button size="sm" variant="quiet" aria-label={t('memoryRemoveAria', { text: short(n.content) })} disabled={busy !== null} onClick={() => void act(`rm:${n.id}`, async () => { if (!(await removeClientNote(orgId, n.id)).recallCleared) throw new Error(t('memoryRemovePartial')); }, t('memoryNoteRemoved'))}>
                  {t('memoryRemove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <TextareaField label={t('memoryAddLabel')} help={t('memoryAddHelp')} value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={2000} />
        <div>
          <Button size="sm" disabled={busy !== null || draft.trim().length === 0}
            onClick={() => void act('add', async () => { await addClientNote(orgId, draft.trim()); setDraft(''); }, t('memoryNoteAdded'))}>
            {t('memoryAdd')}
          </Button>
        </div>
      </div>

      <div className="u-grid u-gap-2">
        <h4 className="u-m-0">{t('memoryProposalsTitle', { count: data.proposals.length })}</h4>
        {data.proposals.length === 0 ? <p className="muted u-m-0">{t('memoryProposalsEmpty')}</p> : (
          <ul className="u-grid u-gap-2 u-m-0 u-p-0 u-list-none">
            {data.proposals.map((p) => (
              <li key={p.proposalId} className="u-grid u-gap-1">
                <span><span className="chip chip--warning">{t('memoryUnverified')}</span> {p.content}</span>
                {p.rationale ? <span className="muted u-fs-12">{t('memoryWhy', { why: p.rationale })}</span> : null}
                <div className="u-flex u-gap-2">
                  <Button size="sm" aria-label={t('memoryApproveAria', { text: short(p.content) })} disabled={busy !== null} onClick={() => void act(`ok:${p.proposalId}`, () => decideClientNoteProposal(orgId, p.proposalId, 'approve'), t('memoryApproved'))}>{t('memoryApprove')}</Button>
                  <Button size="sm" variant="quiet" aria-label={t('memoryRejectAria', { text: short(p.content) })} disabled={busy !== null} onClick={() => void act(`no:${p.proposalId}`, () => decideClientNoteProposal(orgId, p.proposalId, 'reject'), t('memoryRejected'))}>{t('memoryReject')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="u-grid u-gap-2">
        <h4 className="u-m-0">{t('memorySourcesTitle')}</h4>
        <p className="muted u-m-0 u-fs-12">{t('memorySourcesHelp')}</p>
        {data.sources.available.length === 0 ? <p className="muted u-m-0">{t('memorySourcesEmpty')}</p> : (
          <div className="u-grid u-gap-1">
            {data.sources.available.map((c) => (
              <CheckboxField key={c.collectionId} label={c.name} checked={picked.has(c.collectionId)}
                onChange={(e) => setPicked((cur) => {
                  const next = new Set(cur);
                  if (e.target.checked) next.add(c.collectionId); else next.delete(c.collectionId);
                  return next;
                })} />
            ))}
            <div>
              <Button size="sm" variant="secondary" disabled={busy !== null || !sourcesChanged}
                onClick={() => void act('sources', () => setClientMemorySources(orgId, [...picked]), t('memorySourcesSaved'))}>
                {t('memorySourcesSave')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="u-grid u-gap-2">
        <h4 className="u-m-0">{t('memoryRecallTitle')}</h4>
        {data.recall.length === 0 ? <p className="muted u-m-0">{t('memoryRecallEmpty')}</p> : (
          <ul className="u-grid u-gap-2 u-m-0 u-p-0 u-list-none">
            {data.recall.map((r) => (
              <li key={r.id} className="u-grid u-gap-1">
                <span>
                  <span className={`chip ${r.contentTrust === 'untrusted' ? 'chip--warning' : 'chip--muted'}`}>
                    {r.contentTrust === 'untrusted' ? t('memoryUnverified') : t('memoryVerified')}
                  </span>{' '}
                  {r.content}
                </span>
                {r.expiresAt ? <span className="muted u-fs-12">{t('memoryExpires', { date: fmt.date(r.expiresAt) })}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {agencyAdmin ? (
        <div className="u-flex u-flex-wrap u-items-center u-gap-3">
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { setError(null); setErasing(true); }}>{t('memoryErase')}</Button>
          <span className="muted u-fs-12">{t('memoryEraseHelp')}</span>
        </div>
      ) : null}
      {erasing ? (
        <ConfirmDialog
          title={t('memoryEraseTitle', { name: clientName })}
          body={t('memoryEraseBody')}
          confirmLabel={t('memoryErase')}
          danger
          typeToConfirm={clientName}
          busy={busy === 'erase'}
          error={error ?? undefined}
          errorAnnounce={error ?? undefined}
          onCancel={() => setErasing(false)}
          onConfirm={() => {
            void act('erase', async () => {
              const report = await purgeClientMemory(orgId);
              if (!report.complete) throw new Error(t('memoryErasePartial'));
            }, t('memoryErased', { name: clientName })).then((ok) => { if (ok) setErasing(false); });
          }}
        />
      ) : null}
    </section>
  );
}
