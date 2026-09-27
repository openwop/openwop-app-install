/**
 * Chat widgets admin (ADR 0127 Phase 4).
 *
 * Provision / list / rotate-token / delete the org's embeddable widgets; show the
 * paste-ready embed snippet. The PUBLIC runtime is the separate origin-gated gateway —
 * this is the authed admin surface. Org picker → DataTable; mirrors the reviewed
 * admin-page precedent.
 *
 * NO FEATURE TOGGLE, deliberately. This docstring claimed the page "gates on
 * `useFeatureAccess('chat-widget')`" long after that stopped being true: the
 * per-tenant toggle was removed in the ADR 0134 graduation, so the page held a
 * hard-coded always-on `access` literal and a not-enabled branch that no input
 * could reach. Two lies for the price of one — a dead branch that read as a live
 * gate, and a docstring naming a hook the file does not import. Both are gone
 * rather than "restored": `chat-widget` registers no `toggleDefault`
 * (`backend/…/chat-widget/feature.ts`), so re-introducing the hook here would
 * resolve to the OFF FALLBACK for an ABSENT id and brick the page for everyone —
 * the trap `cms/CmsPage` already records. Exposure is controlled PER WIDGET
 * (`enabled` + a token + a non-empty `allowedDomains`), which is where a
 * widget's kill-switch belongs.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { confirm } from '../../ui/confirm.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { listWidgets, provisionWidget, rotateWidgetToken, deleteWidget, listOrgs, embedSnippet, type Widget, type Org } from '../../client/chatWidgetClient.js';
import { WidgetGrantEditor } from './WidgetGrantEditor.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';

export function WidgetsPage(): JSX.Element {
  const { t } = useTranslation('chat-widget');
  const { embedded } = useHub(); // a tab inside the Chat deployment console → drop our own header
  // HG-4 — this page hand-rolled the org read (and rolled it WRONG:
  // `.catch(() => { setOrgs([]); setOrgsFailed(true); })` still writes the `[]`
  // sentinel the third flag exists to avoid, and there was no zero-org branch at
  // all, so a tenant with no organizations got the same permanent skeleton by the
  // honest route). It now takes the shared seam, which keeps `orgs` null on
  // failure and owns the retry.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs);
  const [rows, setRows] = useState<Widget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState('');
  const [newDomains, setNewDomains] = useState('');
  const [creating, setCreating] = useState(false);
  const [snippetFor, setSnippetFor] = useState<Widget | null>(null);
  const [editing, setEditing] = useState<Widget | null>(null); // ADR 0469 P B — grant/caps editor
  // §4.5 collection kit — gated search over the widgets table (agent or an
  // allowed domain); feeds a separate memo over the unfiltered rows.
  const [query, setQuery] = useState('');
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || r.agentId.toLowerCase().includes(q) || r.allowedDomains.some((d) => d.toLowerCase().includes(q)));
  }, [rows, query]);
  // WIDGET-2 — move focus to the embed-snippet heading when it appears / changes widget.
  const embedHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback((id: string) => {
    setRows(null); setError(null);
    void listWidgets(id).then(setRows).catch(() => setError(t('loadError')));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  // WIDGET-2 — focus the embed heading when the snippet section appears (or swaps widget).
  useEffect(() => { if (snippetFor) embedHeadingRef.current?.focus(); }, [snippetFor]);

  const onCreate = useCallback(async () => {
    const agentId = newAgent.trim();
    const domains = newDomains.split(',').map((d) => d.trim()).filter(Boolean);
    // `orgId` is '' whenever the org read failed or returned none, and
    // `provisionWidget` interpolates it into the route — so without this guard a
    // user could POST a widget to a malformed org-scoped path while the failure
    // card renders below. The form sits ABOVE the OrgSelectionState wrapper, so
    // the wrapper cannot withhold it; every sibling adopter's submit carries the
    // same check.
    if (!orgId || !agentId || domains.length === 0 || creating) return;
    setCreating(true);
    try { await provisionWidget(orgId, { agentId, allowedDomains: domains }); setNewAgent(''); setNewDomains(''); load(orgId); }
    catch { setError(t('loadError')); }
    finally { setCreating(false); }
  }, [newAgent, newDomains, creating, orgId, load, t]);

  const onRotate = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('rotateConfirmTitle'), body: t('rotateConfirmBody'), confirmLabel: t('rotate') }))) return;
    await rotateWidgetToken(orgId, w.widgetId).then(setSnippetFor).catch(() => setError(t('loadError')));
    load(orgId);
  }, [orgId, load, t]);

  const onDelete = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('deleteConfirmTitle'), body: t('common:cannotBeUndone'), danger: true, confirmLabel: t('common:delete') }))) return;
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
        <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>{t('configure')}</Button>
        <Button variant="secondary" size="sm" onClick={() => setSnippetFor(r)}>{t('embed')}</Button>
        <Button variant="secondary" size="sm" onClick={() => void onRotate(r)}>{t('rotate')}</Button>
        <Button variant="quiet" size="sm" onClick={() => void onDelete(r)}>{t('delete')}</Button>
      </span>
    ) },
  ], [t, onRotate, onDelete]);

  return (
    <>
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      {orgs && orgs.length > 1 && (
        <label className="field"><span className="field-label">{t('ui:orgPickerLabel')}</span>
          <select className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
      )}
      <div className="surface-form">
        <label className="field"><span className="field-label">{t('newAgent')}</span><input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} /></label>
        <label className="field"><span className="field-label">{t('newDomains')}</span><input value={newDomains} onChange={(e) => setNewDomains(e.target.value)} placeholder={t('newDomainsPlaceholder')} /></label>
        <Button variant="primary" disabled={!orgId || !newAgent.trim() || !newDomains.trim() || creating} onClick={() => void onCreate()}>{t('create')}</Button>
      </div>
      {error && <Notice variant="error">{error}</Notice>}
      {editing && (
        <WidgetGrantEditor
          orgId={orgId}
          widget={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(orgId); }}
        />
      )}
      {snippetFor && (
        <section className="surface-card u-p-3 u-mt-2" aria-label={t('embedAria')} aria-live="polite">
          <div className="u-flex u-items-center u-justify-between u-mb-1">
            <h2 ref={embedHeadingRef} tabIndex={-1} className="u-fs-12 u-fw-600">{t('embedTitle')}</h2>
            <Button
              variant="secondary" size="sm"
              aria-label={t('copy')}
              onClick={() => {
                void copyToClipboard(embedSnippet(snippetFor.token), t('copied'));
              }}
            >{t('copy')}</Button>
          </div>
          <p className="muted u-fs-11 u-mb-1">{t('embedHint')}</p>
          <pre className="msgrender-code-pre"><code>{embedSnippet(snippetFor.token)}</code></pre>
        </section>
      )}
      {/* Both org states sit ABOVE the loading sentinel, and the order is
          `OrgSelectionState`'s: without it the failed orgs read leaves `orgId`
          empty, the rows load never fires, and the skeleton below renders
          forever with nothing explaining why — and a tenant that genuinely has
          NO organizations reached the identical dead end, which this page had no
          branch for at all. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ActivityIcon />}>
      {rows === null && !error ? (
        <SkeletonRows rows={4} columns={['1fr', '1fr', '120px', '200px']} />
      ) : (
        <>
          {rows && rows.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {rows && rows.length > 0 && visibleRows.length === 0 ? (
            <StateCard icon={<ActivityIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable columns={columns} rows={visibleRows} rowKey={(r) => r.widgetId} caption={t('title')}
              empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />} />
          )}
        </>
      )}
      </OrgSelectionState>
    </>
  );
}
