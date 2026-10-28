/**
 * Campaign playbooks (ADR 0959 P5) — the "Playbooks" tab of the Campaign Studio hub.
 *
 * Read-mostly: the library and its versions, which client runs which version (with its rollout
 * ring and whether its copy was changed since install), and rollouts. A rollout is PLANNED here
 * (per client: what changes, what conflicts), then REQUESTED — which opens one review in the
 * shared Reviews inbox; this page never approves. Applying, applying a ring, advancing and rolling
 * back show the server's own refusal copy verbatim.
 *
 * Writing a new version is not a form here (a version is workflow content): it is the API, and,
 * once the campaign Producer exists (ADR 0943), a chat with it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatDateTime } from '../../i18n/format.js';
import { Button } from '../../ui/Button.js';
import { CheckboxField, SelectField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { useHub } from '../../chrome/hubContext.js';
import { listClients } from '../campaign-ops/campaignOpsClient.js';
import {
  advanceRollout, applyRing, applyTarget, listInstallations, listPlaybooks, listRollouts, listVersions, planRollout,
  requestRollout, rollbackTarget, setRing, PlaybooksError,
  type Drift, type Installation, type PlaybookSummary, type PlaybookVersion, type Ring, type Rollout, type TargetClass, type TargetPlan,
} from './playbooksClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const RINGS: Ring[] = ['canary', 'early', 'general', 'held'];

function errorText(e: unknown, t: TFn): string {
  if (e instanceof PlaybooksError && e.message) return e.message;
  return t('actionFailed');
}

const DRIFT_CHIP: Record<Drift, string> = { none: 'chip chip--success', edited: 'chip chip--warning', missing: 'chip chip--danger' };
const CLASS_CHIP: Record<TargetClass, string> = { clean: 'chip chip--success', conflicts: 'chip chip--warning', detached: 'chip chip--danger' };

export function PlaybooksPage(): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const { embedded } = useHub();
  if (embedded) return <div data-walkthrough="campaign-playbooks"><PlaybooksConsole /></div>;
  return (
    <div className="u-grid u-gap-4" data-walkthrough="campaign-playbooks">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      <PlaybooksConsole />
    </div>
  );
}

function PlaybooksConsole(): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    setFailed(false);
    listPlaybooks()
      .then((rows) => { if (!live) return; setPlaybooks(rows); setSelected((s) => s || rows[0]?.playbookId || ''); })
      .catch(() => { if (live) setFailed(true); });
    // Client names are a convenience: on failure the page shows the org id, it does not fail.
    listClients().then(({ clients }) => { if (live) setNames(Object.fromEntries(clients.map((c) => [c.orgId, c.displayName]))); }).catch(() => undefined);
    return () => { live = false; };
  }, [reload]);

  if (failed) return <StateCard announce title={t('loadFailedTitle')} body={t('loadFailedBody')} action={<Button onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>} />;
  if (!playbooks) return <StateCard loading title={t('loading')} />;
  if (playbooks.length === 0) return <StateCard title={t('emptyTitle')} body={t('emptyBody')} />;

  const current = playbooks.find((p) => p.playbookId === selected);
  return (
    <div className="u-grid u-gap-4">
      <SelectField label={t('playbookLabel')} value={selected} onChange={(e) => setSelected(e.target.value)} className="u-minw-240">
        {playbooks.map((p) => <option key={p.playbookId} value={p.playbookId}>{t('playbookOption', { title: p.title, version: p.latestVersion })}</option>)}
      </SelectField>
      {current ? <PlaybookDetail key={current.playbookId} playbook={current} nameOf={(o) => names[o] ?? o} /> : null}
    </div>
  );
}

function PlaybookDetail({ playbook, nameOf }: { playbook: PlaybookSummary; nameOf: (orgId: string) => string }): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const [versions, setVersions] = useState<PlaybookVersion[] | null>(null);
  const [installs, setInstalls] = useState<Installation[] | null>(null);
  const [rollouts, setRollouts] = useState<Rollout[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setFailed(false);
    Promise.all([listVersions(playbook.playbookId), listInstallations(playbook.playbookId), listRollouts(playbook.playbookId)])
      .then(([v, i, r]) => { if (!live) return; setVersions(v); setInstalls(i); setRollouts(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [playbook.playbookId, tick]);

  const act = useCallback(async (fn: () => Promise<unknown>, done: string) => {
    setNotice(null);
    try { await fn(); setNotice({ kind: 'success', text: done }); } catch (e) { setNotice({ kind: 'error', text: errorText(e, t) }); }
    refresh();
  }, [refresh, t]);

  if (failed) return <StateCard announce title={t('detailFailedTitle')} body={t('loadFailedBody')} action={<Button onClick={refresh}>{t('retry')}</Button>} />;
  if (!versions || !installs || !rollouts) return <StateCard loading title={t('loading')} />;

  return (
    <div className="u-grid u-gap-4">
      {notice ? <Notice variant={notice.kind === 'error' ? 'error' : 'success'} announce={notice.text}>{notice.text}</Notice> : null}
      <VersionsSection versions={versions} />
      <ClientsSection installs={installs} nameOf={nameOf} onRing={(orgId, ring) => void act(() => setRing(orgId, playbook.playbookId, ring), t('ringSaved'))} />
      <PlanSection playbook={playbook} versions={versions} installs={installs} nameOf={nameOf} onRequested={(text) => { setNotice({ kind: 'success', text }); refresh(); }} />
      <RolloutsSection rollouts={rollouts} nameOf={nameOf} act={act} />
    </div>
  );
}

function VersionsSection({ versions }: { versions: PlaybookVersion[] }): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const columns: DataColumn<PlaybookVersion>[] = [
    { key: 'version', header: t('colVersion'), render: (v) => v.version, rowHeader: true },
    { key: 'published', header: t('colPublished'), render: (v) => formatDateTime(v.publishedAt), sortValue: (v) => v.publishedAt },
    { key: 'changelog', header: t('colChangelog'), render: (v) => v.changelog || t('noChangelog'), cellClassName: 'muted' },
  ];
  return (
    <section className="surface-card u-grid u-gap-2" aria-labelledby="pb-versions">
      <h2 id="pb-versions">{t('versionsHeading')}</h2>
      <DataTable columns={columns} rows={versions} rowKey={(v) => v.version} caption={t('versionsHeading')} />
    </section>
  );
}

function ClientsSection({ installs, nameOf, onRing }: { installs: Installation[]; nameOf: (o: string) => string; onRing: (orgId: string, ring: Ring) => void }): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const columns: DataColumn<Installation>[] = [
    { key: 'client', header: t('colClient'), render: (i) => nameOf(i.orgId), rowHeader: true, sortValue: (i) => nameOf(i.orgId) },
    { key: 'version', header: t('colVersion'), render: (i) => i.pinnedVersion, sortValue: (i) => i.pinnedVersion },
    { key: 'state', header: t('colState'), render: (i) => <span className={DRIFT_CHIP[i.drift]}>{t(`drift_${i.drift}`)}</span> },
    {
      key: 'ring', header: t('colRing'),
      render: (i) => (
        <SelectField label={t('ringFor', { client: nameOf(i.orgId) })} value={i.ring ?? 'general'} onChange={(e) => onRing(i.orgId, e.target.value as Ring)}>
          {RINGS.map((r) => <option key={r} value={r}>{t(`ring_${r}`)}</option>)}
        </SelectField>
      ),
    },
  ];
  return (
    <section className="surface-card u-grid u-gap-2" aria-labelledby="pb-clients">
      <h2 id="pb-clients">{t('clientsHeading')}</h2>
      <p className="muted">{t('clientsHelp')}</p>
      <DataTable columns={columns} rows={installs} rowKey={(i) => i.orgId} caption={t('clientsHeading')} empty={<StateCard title={t('noInstallsTitle')} body={t('noInstallsBody')} />} />
    </section>
  );
}

function PlanSection({ playbook, versions, installs, nameOf, onRequested }: {
  playbook: PlaybookSummary; versions: PlaybookVersion[]; installs: Installation[]; nameOf: (o: string) => string; onRequested: (text: string) => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const [toVersion, setToVersion] = useState(versions[0]?.version ?? '');
  const [byRing, setByRing] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<TargetPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const invalidatePlan = (): void => { previewRequest.current++; setPlan(null); setBusy(false); };
  const eligible = useMemo(() => installs.filter((i) => i.pinnedVersion !== toVersion && (i.ring ?? 'general') !== 'held'), [installs, toVersion]);
  const orgIds = byRing ? eligible.map((i) => i.orgId) : [...picked];

  const preview = async (): Promise<void> => {
    const requestId = ++previewRequest.current;
    setBusy(true); setError(null); setPlan(null);
    try { const next = await planRollout(playbook.playbookId, toVersion, orgIds); if (requestId === previewRequest.current) setPlan(next); }
    catch (e) { if (requestId === previewRequest.current) setError(errorText(e, t)); }
    finally { if (requestId === previewRequest.current) setBusy(false); }
  };
  const request = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await requestRollout(playbook.playbookId, toVersion, byRing ? { rings: true } : { orgIds });
      setPlan(null);
      onRequested(t('requested'));
    } catch (e) { setError(errorText(e, t)); } finally { setBusy(false); }
  };

  return (
    <section className="surface-card u-grid u-gap-2" aria-labelledby="pb-plan">
      <h2 id="pb-plan">{t('planHeading')}</h2>
      <p className="muted">{t('planHelp')}</p>
      <SelectField label={t('toVersionLabel')} value={toVersion} onChange={(e) => { invalidatePlan(); setToVersion(e.target.value); }}>
        {versions.map((v) => <option key={v.version} value={v.version}>{v.version}</option>)}
      </SelectField>
      <CheckboxField label={t('byRingLabel')} help={t('byRingHelp')} checked={byRing} onChange={(e) => { invalidatePlan(); setByRing(e.target.checked); }} />
      {!byRing ? (
        <fieldset className="u-grid u-gap-1">
          <legend>{t('pickClientsLegend')}</legend>
          {eligible.length === 0 ? <p className="muted">{t('nobodyToUpgrade')}</p> : eligible.map((i) => (
            <CheckboxField key={i.orgId} label={nameOf(i.orgId)} checked={picked.has(i.orgId)} onChange={(e) => {
              invalidatePlan(); const next = new Set(picked); if (e.target.checked) next.add(i.orgId); else next.delete(i.orgId); setPicked(next);
            }} />
          ))}
        </fieldset>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <div className="action-bar">
        <Button variant="secondary" loading={busy} disabled={orgIds.length === 0} onClick={() => void preview()}>{t('previewPlan')}</Button>
        <Button loading={busy} disabled={!plan || plan.length === 0} onClick={() => void request()}>{t('requestApproval')}</Button>
      </div>
      {plan ? <PlanTable plan={plan} nameOf={nameOf} /> : null}
    </section>
  );
}

function PlanTable({ plan, nameOf }: { plan: TargetPlan[]; nameOf: (o: string) => string }): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const columns: DataColumn<TargetPlan>[] = [
    { key: 'client', header: t('colClient'), render: (p) => nameOf(p.orgId), rowHeader: true },
    { key: 'from', header: t('colFrom'), render: (p) => p.fromVersion },
    { key: 'class', header: t('colReadiness'), render: (p) => <span className={CLASS_CHIP[p.class]}>{t(`class_${p.class}`)}</span> },
    {
      key: 'changes', header: t('colChanges'),
      render: (p) => t('changesSummary', {
        steps: p.chainDiff.added.length + p.chainDiff.removed.length + p.chainDiff.changed.length,
        values: p.configDiff.changes.length + p.configDiff.truncated,
        content: p.contentDiff.filter((c) => c.action !== 'unchanged').length,
      }),
    },
    { key: 'conflicts', header: t('colConflicts'), render: (p) => (p.conflicts.length ? p.conflicts.map((c) => c.message).join(' ') : t('none')), cellClassName: 'muted' },
  ];
  return <DataTable columns={columns} rows={plan} rowKey={(p) => p.orgId} caption={t('planHeading')} stack />;
}

function RolloutsSection({ rollouts, nameOf, act }: { rollouts: Rollout[]; nameOf: (o: string) => string; act: (fn: () => Promise<unknown>, done: string) => Promise<void> }): JSX.Element {
  const { t } = useTranslation('campaign-playbooks');
  const [confirm, setConfirm] = useState<{ rolloutId: string; orgId: string } | null>(null);
  if (rollouts.length === 0) {
    return (
      <section className="surface-card u-grid u-gap-2" aria-labelledby="pb-rollouts">
        <h2 id="pb-rollouts">{t('rolloutsHeading')}</h2>
        <p className="muted">{t('noRollouts')}</p>
      </section>
    );
  }
  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby="pb-rollouts">
      <h2 id="pb-rollouts">{t('rolloutsHeading')}</h2>
      {rollouts.map((r) => {
        const open = r.mode === 'rings' && r.rings ? r.rings[r.ringIndex ?? 0] : undefined;
        return (
          <article key={r.rolloutId} className="u-grid u-gap-2">
            <h3>{t('rolloutTitle', { version: r.toVersion, date: formatDate(r.createdAt) })} <span className="chip chip--muted">{t(`status_${r.status}`)}</span></h3>
            {r.status === 'awaiting_approval' ? <p className="muted">{t('awaitingApprovalHelp')}</p> : null}
            {r.status === 'halted' ? <Notice variant="warning">{t('haltedHelp', { clients: (r.haltedOrgIds ?? []).map(nameOf).join(', ') })}</Notice> : null}
            {open && r.status === 'approved' ? (
              <div className="action-bar">
                <span className="muted">{t('openRing', { ring: t(`ring_${open.name}`) })}</span>
                <Button size="sm" variant="secondary" onClick={() => void act(async () => {
                  const result = await applyRing(r.rolloutId);
                  if (result.failed.length) throw new PlaybooksError(t('ringNeedsAttention', { clients: result.failed.map((f) => nameOf(f.orgId)).join(', ') }), 409, 'content_partial');
                }, t('ringApplied'))}>{t('applyRing')}</Button>
                <Button size="sm" variant="secondary" onClick={() => void act(() => advanceRollout(r.rolloutId), t('advanced'))}>{t('advance')}</Button>
              </div>
            ) : null}
            <ul className="u-grid u-gap-1">
              {r.plan.map((p) => {
                const st = r.targets[p.orgId]?.status ?? 'pending';
                return (
                  <li key={p.orgId} className="action-bar">
                    <span>{nameOf(p.orgId)}</span>
                    <span className={CLASS_CHIP[p.class]}>{t(`class_${p.class}`)}</span>
                    <span className="chip chip--muted">{t(`target_${st}`)}</span>
                    {r.status === 'approved' && st === 'pending' ? (
                      <Button size="sm" onClick={() => (p.class === 'detached' ? setConfirm({ rolloutId: r.rolloutId, orgId: p.orgId }) : void act(() => applyTarget(r.rolloutId, p.orgId, false), t('applied')))}>{t('apply')}</Button>
                    ) : null}
                    {st === 'applied' ? (
                      <Button size="sm" variant="quiet" onClick={() => void act(() => rollbackTarget(r.rolloutId, p.orgId), t('rolledBack'))}>{t('rollback')}</Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
      {confirm ? (
        <ConfirmDialog
          title={t('overwriteTitle', { client: nameOf(confirm.orgId) })}
          body={t('overwriteBody')}
          confirmLabel={t('overwriteConfirm')}
          danger
          onConfirm={() => { const c = confirm; setConfirm(null); void act(() => applyTarget(c.rolloutId, c.orgId, true), t('applied')); }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}
