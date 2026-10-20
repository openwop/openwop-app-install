/**
 * Campaign operations inbox (ADR 0926 D1/D3, P0) — the "Operations" tab of the
 * Campaign Studio hub.
 *
 * One client at a time (P0), picked from the clients the caller can see. A
 * composer asks for a change; three columns show what is waiting for review,
 * what is in progress, and what needs attention. The composer is a structured
 * form that submits to the request service — NOT a chat (CLAUDE.md "one AI
 * chat"). Lists poll every 15 s while the tab is visible and right after every
 * action. Preview clients carry a persistent "nothing is written" banner.
 *
 * Plain words only: the copy never names the engine underneath (pinned by
 * `__tests__/copyDenylist.test.ts`).
 *
 * @see docs/adr/0926-campaign-ops-operator-inbox-and-preview-onboarding.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { CheckboxField, SelectField, TextareaField, TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { useLiveRegion } from '../../ui/announce.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import {
  listClients, updateClient, listAssets, listRequests, submitRequest, answerQuestions, reviseRequest,
  listChangeSets, getChangeSetDiff, requestApproval, listJobs, approveChangeSet, rejectChangeSet,
  CampaignOpsError,
  type ClientAccount, type CampaignAsset, type ChangeRequest, type ChangeSet, type DiffEntry, type Job, type JobStep,
} from './campaignOpsClient.js';
import { ChangeDiff } from './ChangeDiff.js';

type TFn = ReturnType<typeof useTranslation>['t'];

const POLL_MS = 15_000;
const IN_PROGRESS: ReadonlySet<ChangeRequest['status']> = new Set(['interpreting', 'needs_facts', 'proposing']);
const KNOWN_REASONS = new Set(['newer_human_edit', 'readback_mismatch', 'publish_blocked', 'not_authorized', 'preview_only', 'email_already_sent', 'unknown']);

/** The server's message when it sent one (409/403 copy is already plain), else ours. */
function errorText(e: unknown, t: TFn): string {
  if (e instanceof CampaignOpsError) {
    if (e.message) return e.message;
    if (e.reason === 'separation-of-duties') return t('forbiddenSelfApproval');
    if (e.status === 409) return t('conflictReload');
  }
  return t('actionFailed');
}

export function stepReasonKey(reason: string | undefined): string | null {
  if (!reason) return null;
  return KNOWN_REASONS.has(reason) ? `reason_${reason}` : 'reason_other';
}

interface OrgData {
  assets: CampaignAsset[] | null;
  assetsFailed: boolean;
  requests: ChangeRequest[];
  changeSets: ChangeSet[];
  jobs: Job[];
  loaded: boolean;
  failed: boolean;
}
const EMPTY_DATA: OrgData = { assets: null, assetsFailed: false, requests: [], changeSets: [], jobs: [], loaded: false, failed: false };

export function OperationsPage(): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const { embedded } = useHub();
  // Inside the Campaign Studio hub the console owns the page chrome.
  if (embedded) return <OperationsInbox />;
  return (
    <div className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      <OperationsInbox />
    </div>
  );
}

function OperationsInbox(): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [clients, setClients] = useState<ClientAccount[] | null>(null);
  const [agencyAdmin, setAgencyAdmin] = useState(false);
  const [clientsFailed, setClientsFailed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [reloadClients, setReloadClients] = useState(0);
  const [data, setData] = useState<OrgData>(EMPTY_DATA);
  const [status, setStatus] = useLiveRegion();
  const orgRef = useRef(orgId);
  orgRef.current = orgId;

  useEffect(() => {
    let cancelled = false;
    setClientsFailed(false);
    void listClients()
      .then((out) => {
        if (cancelled) return;
        setClients(out.clients);
        setAgencyAdmin(out.agencyAdmin);
        setOrgId((cur) => (cur && out.clients.some((c) => c.orgId === cur) ? cur : (out.clients[0]?.orgId ?? '')));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof CampaignOpsError && e.status === 404 && /not enabled/i.test(e.message)) { setDisabled(true); return; }
        setClientsFailed(true);
      });
    return () => { cancelled = true; };
  }, [reloadClients]);

  const client = useMemo(() => clients?.find((c) => c.orgId === orgId) ?? null, [clients, orgId]);

  const load = useCallback(async (forOrg: string): Promise<void> => {
    const [assets, requests, changeSets, jobs] = await Promise.allSettled([
      listAssets(forOrg), listRequests(forOrg), listChangeSets(forOrg), listJobs(forOrg),
    ]);
    if (orgRef.current !== forOrg) return; // the operator switched clients meanwhile
    const listsOk = requests.status === 'fulfilled' && changeSets.status === 'fulfilled' && jobs.status === 'fulfilled';
    setData((prev) => ({
      assets: assets.status === 'fulfilled' ? assets.value : prev.assets,
      assetsFailed: assets.status === 'rejected',
      requests: requests.status === 'fulfilled' ? requests.value : prev.requests,
      changeSets: changeSets.status === 'fulfilled' ? changeSets.value : prev.changeSets,
      jobs: jobs.status === 'fulfilled' ? jobs.value : prev.jobs,
      loaded: prev.loaded || listsOk,
      failed: !listsOk,
    }));
  }, []);

  const refresh = useCallback(() => { if (orgRef.current) void load(orgRef.current); }, [load]);

  useEffect(() => {
    setData(EMPTY_DATA);
    if (!orgId) return undefined;
    void load(orgId);
    const tick = (): void => { if (document.visibilityState === 'visible') void load(orgId); };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [orgId, load]);

  if (disabled) return <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  if (clientsFailed) {
    return <StateCard announce title={t('loadFailedTitle')} body={t('loadFailedBody')} action={<Button onClick={() => setReloadClients((n) => n + 1)}>{t('retry')}</Button>} />;
  }
  if (clients === null) return <StateCard loading title={t('loading')} />;
  if (clients.length === 0) return <StateCard title={t('noClientsTitle')} body={t('noClientsBody')} />;

  return (
    <section className="u-grid u-gap-4" aria-labelledby="campaign-ops-title" data-walkthrough="campaign-ops.page">
      <h2 id="campaign-ops-title" className="sr-only">{t('title')}</h2>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{status}</p>

      <ClientBar
        clients={clients}
        client={client}
        orgId={orgId}
        onSelect={setOrgId}
        agencyAdmin={agencyAdmin}
        onModeChanged={(updated) => {
          setClients((cur) => cur?.map((c) => (c.orgId === updated.orgId ? updated : c)) ?? cur);
          setStatus(t(`modeChanged_${updated.mode}`, { name: updated.displayName }));
        }}
      />

      {client?.mode === 'preview' ? (
        <Notice variant="info">
          <strong>{t('previewBanner')}</strong> {t('previewBannerDetail')}
        </Notice>
      ) : null}

      {orgId ? (
        <>
          <Composer key={orgId} orgId={orgId} assets={data.assets} assetsFailed={data.assetsFailed} onStatus={setStatus} onDone={refresh} />
          {data.failed ? <Notice variant="warning" announce={t('listsFailed')}>{t('listsFailed')}</Notice> : null}
          {!data.loaded && !data.failed ? <StateCard loading title={t('loading')} /> : null}
          {data.loaded ? <Columns orgId={orgId} data={data} onStatus={setStatus} onDone={refresh} /> : null}
        </>
      ) : null}
    </section>
  );
}

function ClientBar({ clients, client, orgId, onSelect, agencyAdmin, onModeChanged }: {
  clients: ClientAccount[]; client: ClientAccount | null; orgId: string; onSelect: (id: string) => void;
  agencyAdmin: boolean; onModeChanged: (c: ClientAccount) => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = client?.mode === 'preview' ? 'live' : 'preview';
  const nameOf = (c: ClientAccount): string =>
    c.status === 'paused' ? t('clientPaused', { name: c.displayName }) : c.status === 'archived' ? t('clientArchived', { name: c.displayName }) : c.displayName;

  return (
    <div className="u-flex u-flex-wrap u-items-end u-gap-3">
      <SelectField label={t('clientLabel')} value={orgId} onChange={(e) => onSelect(e.target.value)} className="u-minw-240">
        {clients.map((c) => <option key={c.orgId} value={c.orgId}>{nameOf(c)}</option>)}
      </SelectField>
      {client ? (
        <span className={`chip ${client.mode === 'live' ? 'chip--success' : 'chip--muted'}`}>
          {client.mode === 'live' ? t('liveBadge') : t('previewBadge')}
        </span>
      ) : null}
      {client && agencyAdmin ? (
        <Button size="sm" variant={next === 'live' ? 'secondary' : 'quiet'} onClick={() => { setError(null); setConfirming(true); }}>
          {next === 'live' ? t('switchToLive') : t('switchToPreview')}
        </Button>
      ) : null}
      {client && confirming ? (
        <ConfirmDialog
          title={next === 'live' ? t('switchToLiveTitle', { name: client.displayName }) : t('switchToPreviewTitle', { name: client.displayName })}
          body={next === 'live' ? t('switchToLiveBody') : t('switchToPreviewBody')}
          confirmLabel={next === 'live' ? t('switchToLive') : t('switchToPreview')}
          busy={busy}
          error={error ?? undefined}
          errorAnnounce={error ?? undefined}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            void updateClient(client.orgId, { mode: next })
              .then((updated) => { onModeChanged(updated); setConfirming(false); })
              .catch((e: unknown) => setError(errorText(e, t)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}

function Composer({ orgId, assets, assetsFailed, onStatus, onDone }: {
  orgId: string; assets: CampaignAsset[] | null; assetsFailed: boolean; onStatus: (s: string) => void; onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [text, setText] = useState('');
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const selected = (assets ?? []).filter((a) => !excluded.has(a.assetId)).map((a) => a.assetId);

  useEffect(() => { if (duplicate) reasonRef.current?.focus(); }, [duplicate]);

  const send = async (override?: { reason: string }): Promise<void> => {
    if (!text.trim()) { setError(t('submitNeedsText')); return; }
    if (selected.length === 0) { setError(t('submitNeedsAsset')); return; }
    if (override && !override.reason.trim()) { setError(t('duplicateNeedsReason')); return; }
    setBusy(true); setError(null); onStatus(t('sending'));
    try {
      const out = await submitRequest(orgId, { text: text.trim(), assetIds: selected, ...(override ? { overrideDuplicate: { reason: override.reason.trim() } } : {}) });
      if (out.duplicate) { setDuplicate(true); onStatus(t('duplicateTitle')); return; }
      setText(''); setDuplicate(false); setReason('');
      onStatus(t('sent'));
    } catch (e) {
      setError(errorText(e, t)); onStatus('');
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <form className="surface-card u-grid u-gap-3" aria-labelledby="campaign-ops-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h3 id="campaign-ops-composer" className="u-m-0 u-fs-15">{t('composerHeading')}</h3>
      <TextareaField label={t('composerLabel')} help={t('composerHelp')} rows={3} value={text} onChange={(e) => { setText(e.target.value); setDuplicate(false); }} />
      <fieldset className="u-fieldset-bare u-grid u-gap-1">
        <legend className="field-label">{t('assetsLegend')}</legend>
        {assetsFailed && assets === null ? <p className="u-text-danger u-fs-13 u-m-0">{t('assetsFailed')}</p> : null}
        {assets === null && !assetsFailed ? <p className="u-text-muted u-fs-13 u-m-0">{t('loading')}</p> : null}
        {assets !== null && assets.length === 0 ? <p className="u-text-muted u-fs-13 u-m-0">{t('assetsEmpty')}</p> : null}
        {assets && assets.length > 0 ? (
          <ul className="u-list-plain u-flex u-flex-wrap u-gap-3 u-m-0">
            {assets.map((a) => (
              <li key={a.assetId}>
                <CheckboxField
                  label={a.label}
                  checked={!excluded.has(a.assetId)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setExcluded((cur) => { const n = new Set(cur); if (on) n.delete(a.assetId); else n.add(a.assetId); return n; });
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      {duplicate ? (
        <Notice variant="warning">
          <div className="u-grid u-gap-2">
            <strong>{t('duplicateTitle')}</strong>
            <span>{t('duplicateBody')}</span>
            <TextField ref={reasonRef} label={t('duplicateReasonLabel')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="u-flex u-gap-2">
              <Button size="sm" loading={busy} onClick={() => void send({ reason })}>{t('duplicateSendAnyway')}</Button>
              <Button size="sm" variant="quiet" onClick={() => { setDuplicate(false); setReason(''); }}>{t('duplicateCancel')}</Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}

      <div className="u-flex u-gap-2">
        <Button type="submit" variant="primary" loading={busy} disabled={duplicate}>{busy ? t('sending') : t('submit')}</Button>
      </div>
    </form>
  );
}

function Columns({ orgId, data, onStatus, onDone }: { orgId: string; data: OrgData; onStatus: (s: string) => void; onDone: () => void }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  // One row per request version; keep only the newest row per request.
  const latest = useMemo(() => {
    const byId = new Map<string, ChangeRequest>();
    for (const r of data.requests) {
      const cur = byId.get(r.requestId);
      if (!cur || r.version > cur.version) byId.set(r.requestId, r);
    }
    return [...byId.values()];
  }, [data.requests]);
  const requestText = useMemo(() => new Map(latest.map((r) => [r.requestId, r.text])), [latest]);

  const review = data.changeSets.filter((c) => c.status === 'in_review');
  const proposed = data.changeSets.filter((c) => c.status === 'proposed');
  const stale = data.changeSets.filter((c) => c.status === 'stale');
  const working = latest.filter((r) => IN_PROGRESS.has(r.status));
  const failedReqs = latest.filter((r) => r.status === 'failed' || r.status === 'no_changes');
  const runningJobs = data.jobs.filter((j) => j.status === 'running');
  const attentionJobs = data.jobs.filter((j) => j.status === 'needs_attention');
  const doneJobs = data.jobs.filter((j) => j.status === 'finished').slice(0, 5);

  const progressCount = working.length + proposed.length + runningJobs.length;
  const attentionCount = attentionJobs.length + failedReqs.length + stale.length;

  return (
    <div className="u-grid u-gap-4">
      <div className="u-grid-3 u-gap-4 u-items-start">
        <Column id="review" title={t('colReview')} count={review.length} empty={t('colReviewEmpty')}>
          {review.map((cs) => (
            <li key={cs.changeSetId}><ChangeSetCard orgId={orgId} cs={cs} requestText={requestText.get(cs.requestId)} onStatus={onStatus} onDone={onDone} /></li>
          ))}
        </Column>
        <Column id="progress" title={t('colProgress')} count={progressCount} empty={t('colProgressEmpty')}>
          {working.map((r) => <li key={r.requestId}><RequestCard orgId={orgId} req={r} onStatus={onStatus} onDone={onDone} /></li>)}
          {proposed.map((cs) => (
            <li key={cs.changeSetId}><ChangeSetCard orgId={orgId} cs={cs} requestText={requestText.get(cs.requestId)} onStatus={onStatus} onDone={onDone} /></li>
          ))}
          {runningJobs.map((j) => <li key={j.jobId}><JobCard job={j} /></li>)}
        </Column>
        <Column id="attention" title={t('colAttention')} count={attentionCount} empty={t('colAttentionEmpty')}>
          {attentionJobs.map((j) => <li key={j.jobId}><JobCard job={j} /></li>)}
          {failedReqs.map((r) => <li key={r.requestId}><RequestCard orgId={orgId} req={r} onStatus={onStatus} onDone={onDone} /></li>)}
          {stale.map((cs) => (
            <li key={cs.changeSetId}>
              <article className="surface-card u-grid u-gap-1" aria-label={t('changeSet_stale')}>
                <span className="chip chip--warning u-self-start">{t('changeSet_stale')}</span>
                {requestText.get(cs.requestId) ? <p className="u-m-0 u-fs-13">{requestText.get(cs.requestId)}</p> : null}
                <p className="u-m-0 u-fs-13">{cs.staleReason ? t(`stale_${cs.staleReason}`) : t('changeSet_stale')}</p>
                <p className="u-m-0 u-fs-12 u-text-muted">{t('staleAction')}</p>
              </article>
            </li>
          ))}
        </Column>
      </div>
      {doneJobs.length > 0 ? (
        <section aria-labelledby="campaign-ops-col-done" className="u-grid u-gap-2">
          <h3 id="campaign-ops-col-done" className="u-m-0 u-fs-13 u-text-muted">{t('colDone')}</h3>
          <ul className="u-list-plain u-grid u-gap-1 u-m-0 u-fs-13">
            {doneJobs.map((j) => (
              <li key={j.jobId} className="u-flex u-flex-wrap u-gap-2">
                <span>{j.steps.map((s) => s.label).join(', ')}</span>
                {j.outcome ? <span className="u-text-muted">{t('jobOutcome', { confirmed: j.outcome.confirmed, total: j.outcome.total })}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Column({ id, title, count, empty, children }: { id: string; title: string; count: number; empty: string; children: React.ReactNode }): JSX.Element {
  const headingId = `campaign-ops-col-${id}`;
  return (
    <section aria-labelledby={headingId} className="u-grid u-gap-2 u-min-w-0">
      <h3 id={headingId} className="u-m-0 u-fs-14 u-flex u-items-center u-gap-2">
        {title} <span className="chip chip--muted">{count}</span>
      </h3>
      {count === 0 ? <p className="u-text-muted u-fs-13 u-m-0">{empty}</p> : <ul className="u-list-plain u-grid u-gap-2 u-m-0">{children}</ul>}
    </section>
  );
}

function RequestCard({ orgId, req, onStatus, onDone }: { orgId: string; req: ChangeRequest; onStatus: (s: string) => void; onDone: () => void }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const questions = req.status === 'needs_facts' ? (req.interpretation?.questions ?? []) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(req.text);
  const tone = req.status === 'failed' ? 'chip--danger' : req.status === 'no_changes' ? 'chip--warning' : req.status === 'needs_facts' ? 'chip--accent' : 'chip--muted';

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true); setError(null); onStatus(t('sending'));
    try { await fn(); onStatus(done); setEditing(false); }
    catch (e) { setError(errorText(e, t)); onStatus(''); }
    finally { setBusy(false); onDone(); }
  };

  const submitAnswers = (): void => {
    const list = questions.map((q) => ({ questionId: q.id, value: (answers[q.id] ?? '').trim() }));
    if (list.some((a) => !a.value)) { setError(t('answerNeedsValue')); return; }
    void act(() => answerQuestions(orgId, req.requestId, list), t('answered'));
  };

  return (
    <article className="surface-card u-grid u-gap-2" aria-label={t(`request_${req.status}`, { defaultValue: req.status })}>
      <div className="u-flex u-flex-wrap u-items-center u-gap-2">
        <span className={`chip ${tone}`}>{t(`request_${req.status}`, { defaultValue: req.status })}</span>
        {req.version > 1 ? <span className="u-fs-12 u-text-muted">{t('version', { n: req.version })}</span> : null}
      </div>
      <p className="u-m-0 u-fs-13 u-prewrap">{req.text}</p>
      {req.status === 'failed' && req.failure?.message ? <p className="u-m-0 u-fs-13 u-text-danger">{req.failure.message}</p> : null}
      {req.status === 'no_changes' ? <p className="u-m-0 u-fs-13">{t('noChangesBody')}</p> : null}

      {questions.length > 0 && !editing ? (
        <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); submitAnswers(); }}>
          {questions.map((q) => (
            <div key={q.id} className="u-grid u-gap-1">
              {q.options && q.options.length > 0 ? (
                <fieldset className="u-fieldset-bare u-grid u-gap-1">
                  <legend className="field-label">{q.prompt}</legend>
                  <div className="u-flex u-flex-wrap u-gap-1">
                    {q.options.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        className="chip"
                        aria-pressed={answers[q.id] === opt}
                        onClick={() => setAnswers((cur) => ({ ...cur, [q.id]: opt }))}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <TextField label={q.prompt} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((cur) => ({ ...cur, [q.id]: e.target.value }))} />
              )}
            </div>
          ))}
          <div className="u-flex u-gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy}>{t('answerSubmit')}</Button>
          </div>
        </form>
      ) : null}

      {editing ? (
        <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void act(() => reviseRequest(orgId, req.requestId, draft.trim()), t('sent')); }}>
          <TextareaField label={t('editLabel')} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="u-flex u-gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!draft.trim()}>{t('editSave')}</Button>
            <Button size="sm" variant="quiet" onClick={() => { setEditing(false); setDraft(req.text); }}>{t('editCancel')}</Button>
          </div>
        </form>
      ) : req.status === 'needs_facts' || req.status === 'failed' || req.status === 'no_changes' ? (
        <div className="u-flex u-gap-2">
          <Button size="sm" variant="quiet" onClick={() => { setDraft(req.text); setEditing(true); }}>{t('edit')}</Button>
        </div>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
    </article>
  );
}

function ChangeSetCard({ orgId, cs, requestText, onStatus, onDone }: {
  orgId: string; cs: ChangeSet; requestText: string | undefined; onStatus: (s: string) => void; onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  const [busy, setBusy] = useState<'review' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const approvalId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiffFailed(false);
    void getChangeSetDiff(orgId, cs.changeSetId)
      .then((out) => { if (!cancelled) setDiff(out.diff); })
      .catch(() => { if (!cancelled) setDiffFailed(true); });
    return () => { cancelled = true; };
  }, [orgId, cs.changeSetId, cs.hash]);

  /** The approval id: remembered from "Send for review", else re-asked (idempotent). */
  const ensureApproval = async (): Promise<string> => {
    if (approvalId.current) return approvalId.current;
    const out = await requestApproval(orgId, cs.changeSetId);
    approvalId.current = out.approvalId;
    return out.approvalId;
  };

  const act = async (kind: 'review' | 'approve' | 'reject', fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(kind); setError(null); onStatus(t('sending'));
    try { await fn(); onStatus(done); setRejecting(false); }
    catch (e) { setError(errorText(e, t)); onStatus(''); }
    finally { setBusy(null); onDone(); }
  };

  const label = t(`changeSet_${cs.status}`, { defaultValue: cs.status });
  return (
    <article className="surface-card u-grid u-gap-2" aria-label={label}>
      <span className={`chip ${cs.status === 'in_review' ? 'chip--accent' : 'chip--muted'} u-self-start`}>{label}</span>
      {requestText ? (
        <p className="u-m-0 u-fs-13"><span className="u-text-muted">{t('requestLabel')}: </span>{requestText}</p>
      ) : null}
      {diffFailed ? <p className="u-m-0 u-fs-13 u-text-danger">{t('diffFailed')}</p>
        : diff === null ? <p className="u-m-0 u-fs-13 u-text-muted">{t('diffLoading')}</p>
        : <ChangeDiff diff={diff} />}
      <div className="u-flex u-flex-wrap u-gap-2">
        {cs.status === 'proposed' ? (
          <Button size="sm" variant="primary" loading={busy === 'review'} disabled={busy !== null}
            onClick={() => void act('review', async () => { const out = await requestApproval(orgId, cs.changeSetId); approvalId.current = out.approvalId; }, t('sentForReview'))}>
            {t('sendForReview')}
          </Button>
        ) : null}
        {cs.status === 'in_review' ? (
          <>
            <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={busy !== null || diff === null}
              onClick={() => void act('approve', async () => approveChangeSet(await ensureApproval(), cs.hash), t('approved'))}>
              {t('approve')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { setError(null); setRejecting(true); }}>
              {t('reject')}
            </Button>
          </>
        ) : null}
      </div>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {rejecting ? (
        <ConfirmDialog
          title={t('rejectTitle')}
          body={(
            <div className="u-grid u-gap-2">
              <p className="u-m-0">{t('rejectBody')}</p>
              <TextField label={t('rejectNoteLabel')} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          confirmLabel={t('rejectConfirm')}
          danger
          busy={busy === 'reject'}
          error={error ?? undefined}
          onCancel={() => setRejecting(false)}
          onConfirm={() => void act('reject', async () => rejectChangeSet(await ensureApproval(), note.trim() || undefined), t('rejected'))}
        />
      ) : null}
    </article>
  );
}

function JobCard({ job }: { job: Job }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const tone = job.status === 'needs_attention' ? 'chip--warning' : job.status === 'finished' ? 'chip--success' : 'chip--muted';
  const label = t(`job_${job.status}`);
  return (
    <article className="surface-card u-grid u-gap-2" aria-label={label}>
      <div className="u-flex u-flex-wrap u-items-center u-gap-2">
        <span className={`chip ${tone}`}>{label}</span>
        {job.outcome ? <span className="u-fs-12 u-text-muted">{t('jobOutcome', { confirmed: job.outcome.confirmed, total: job.outcome.total })}</span> : null}
      </div>
      <ul className="u-list-plain u-grid u-gap-1 u-m-0">
        {job.steps.map((s) => <li key={s.assetId}><StepLine step={s} /></li>)}
      </ul>
    </article>
  );
}

function StepLine({ step }: { step: JobStep }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const reasonKey = stepReasonKey(step.reason);
  const bad = step.state === 'conflicted' || step.state === 'incomplete';
  return (
    <div className="u-grid u-fs-13">
      <span className="u-flex u-flex-wrap u-gap-2">
        <strong>{step.label}</strong>
        <span className={bad ? 'u-text-warning' : step.state === 'confirmed' ? 'u-text-success' : 'u-text-muted'}>{t(`step_${step.state}`)}</span>
      </span>
      {reasonKey ? <span className="u-text-muted u-fs-12">{t(reasonKey)}</span> : null}
    </div>
  );
}
