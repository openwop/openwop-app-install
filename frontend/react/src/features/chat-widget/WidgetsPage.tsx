/**
 * Chat widgets admin (ADR 0127 Phase 4).
 *
 * Provision / list / rotate-token / delete the org's embeddable widgets; show the
 * paste-ready embed snippet. The PUBLIC runtime is the separate origin-gated gateway —
 * this is the authed admin surface. Gates on `useFeatureAccess('chat-widget')`; org
 * picker → DataTable. Mirrors the reviewed admin-page precedent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { listWidgets, provisionWidget, rotateWidgetToken, deleteWidget, listOrgs, embedSnippet, type Widget, type Org } from '../../client/chatWidgetClient.js';

export function WidgetsPage(): JSX.Element {
  const { t } = useTranslation('chat-widget');
  const { embedded } = useHub(); // a tab inside the Chat deployment console → drop our own header
  const access = { enabled: true, loading: false }; // always-on (toggle removed)
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rows, setRows] = useState<Widget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState('');
  const [newDomains, setNewDomains] = useState('');
  const [creating, setCreating] = useState(false);
  const [snippetFor, setSnippetFor] = useState<Widget | null>(null);
  // WIDGET-2 — move focus to the embed-snippet heading when it appears / changes widget.
  const embedHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((c) => c || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const load = useCallback((id: string) => {
    setRows(null); setError(null);
    void listWidgets(id).then(setRows).catch(() => setError(t('loadError')));
  }, [t]);
  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  // WIDGET-2 — focus the embed heading when the snippet section appears (or swaps widget).
  useEffect(() => { if (snippetFor) embedHeadingRef.current?.focus(); }, [snippetFor]);

  const onCreate = useCallback(async () => {
    const agentId = newAgent.trim();
    const domains = newDomains.split(',').map((d) => d.trim()).filter(Boolean);
    if (!agentId || domains.length === 0 || creating) return;
    setCreating(true);
    try { await provisionWidget(orgId, { agentId, allowedDomains: domains }); setNewAgent(''); setNewDomains(''); load(orgId); }
    catch { setError(t('loadError')); }
    finally { setCreating(false); }
  }, [newAgent, newDomains, creating, orgId, load, t]);

  const onRotate = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('rotate'), confirmLabel: t('rotate') }))) return;
    await rotateWidgetToken(orgId, w.widgetId).then(setSnippetFor).catch(() => setError(t('loadError')));
    load(orgId);
  }, [orgId, load, t]);

  const onDelete = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('delete'), danger: true, confirmLabel: t('delete') }))) return;
    await deleteWidget(orgId, w.widgetId).catch(() => setError(t('loadError')));
    setSnippetFor((s) => (s?.widgetId === w.widgetId ? null : s));
    load(orgId);
  }, [orgId, load, t]);

  const columns = useMemo<DataColumn<Widget>[]>(() => [
    { key: 'agent', header: t('colAgent'), sortValue: (r) => r.agentId, render: (r) => r.agentId },
    { key: 'domains', header: t('colDomains'), render: (r) => r.allowedDomains.join(', ') },
    { key: 'status', header: t('colStatus'), render: (r) => <StatusBadge status={r.enabled ? 'completed' : 'paused'} label={t(r.enabled ? 'active' : 'disabled')} /> },
    { key: 'actions', header: '', align: 'right', render: (r) => (
      <span className="u-flex u-gap-1 u-justify-end">
        <button type="button" className="secondary btn-sm" onClick={() => setSnippetFor(r)}>{t('embed')}</button>
        <button type="button" className="secondary btn-sm" onClick={() => void onRotate(r)}>{t('rotate')}</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => void onDelete(r)}>{t('delete')}</button>
      </span>
    ) },
  ], [t, onRotate, onDelete]);

  if (!access.enabled) {
    return (<><PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} /><StateCard icon={<ActivityIcon />} title={t('disabled')} /></>);
  }

  return (
    <>
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      {orgs && orgs.length > 1 && (
        <label className="field"><span className="field-label">{t('org')}</span>
          <select className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
      )}
      <div className="u-flex u-gap-2 u-items-end">
        <label className="field"><span className="field-label">{t('newAgent')}</span><input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} /></label>
        <label className="field"><span className="field-label">{t('newDomains')}</span><input value={newDomains} onChange={(e) => setNewDomains(e.target.value)} placeholder="acme.com, app.acme.com" /></label>
        <button type="button" className="btn-primary" disabled={!newAgent.trim() || !newDomains.trim() || creating} onClick={() => void onCreate()}>{t('create')}</button>
      </div>
      {error && <Notice variant="error">{error}</Notice>}
      {snippetFor && (
        <section className="surface-card u-p-3 u-mt-2" aria-label={t('embedAria')} aria-live="polite">
          <div className="u-flex u-items-center u-justify-between u-mb-1">
            <h2 ref={embedHeadingRef} tabIndex={-1} className="u-fs-12 u-fw-600">{t('embedTitle')}</h2>
            <button
              type="button"
              className="secondary btn-sm"
              aria-label={t('copy')}
              onClick={() => {
                void navigator.clipboard?.writeText(embedSnippet(snippetFor.token))
                  .then(() => toast.success(t('copied')))
                  .catch(() => { /* clipboard blocked */ });
              }}
            >{t('copy')}</button>
          </div>
          <p className="muted u-fs-11 u-mb-1">{t('embedHint')}</p>
          <pre className="msgrender-code-pre"><code>{embedSnippet(snippetFor.token)}</code></pre>
        </section>
      )}
      {rows === null && !error ? (
        <SkeletonRows rows={4} columns={['1fr', '1fr', '120px', '200px']} />
      ) : (
        <DataTable columns={columns} rows={rows ?? []} rowKey={(r) => r.widgetId} caption={t('title')}
          empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />} />
      )}
    </>
  );
}
