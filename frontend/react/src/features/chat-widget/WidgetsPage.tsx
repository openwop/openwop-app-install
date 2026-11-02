/**
 * Chat widgets admin (ADR 0127 Phase 4).
 *
 * Provision / list / rotate-token / delete the org's embeddable widgets; show the
 * paste-ready embed snippet. The PUBLIC runtime is the separate origin-gated gateway —
 * this is the authed admin surface. Org picker → DataTable; mirrors the reviewed
 * admin-page precedent.
 *
 * NO TOGGLE READ ON THE PAGE. The `chat-widget` toggle (ADR 0820 §8.2 restored it;
 * default ON, Support bundle) is enforced SERVER-side on every operator route through
 * `authorizeOrgScope` (toggle + plan), so a tenant with the feature off sees the load
 * error rather than a page that pretends to work. (This docstring used to say the
 * feature had no toggle at all; that was true between ADR 0134 and ADR 0820.)
 * Exposure is still controlled PER WIDGET too (`enabled` + a token + a non-empty
 * `allowedDomains`).
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
import { listWidgets, provisionWidget, rotateWidgetToken, deleteWidget, patchWidget, listOrgs, embedSnippet, WidgetApiError, isWidgetByokRequired, type Widget, type Org } from '../../client/chatWidgetClient.js';
import { listAgents, type AgentEntry } from '../../client/agentsClient.js';
import { useNavigate } from 'react-router-dom';
import { WidgetGrantEditor } from './WidgetGrantEditor.js';
import { WidgetConversations } from './WidgetConversations.js';
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
  const [viewing, setViewing] = useState<Widget | null>(null); // ADR 1018 D3 — visitor conversations
  // §4.5 collection kit — gated search over the widgets table (agent or an
  // allowed domain); feeds a separate memo over the unfiltered rows.
  const [query, setQuery] = useState('');
  // grade-ux `CW68U-2` — the agent is PICKED from the roster, not typed: a typo used to
  // make a widget that reported "Active" while every visitor turn 404'd. The server
  // refuses an unservable id too; the free-text input stays only if the roster read fails.
  // A failed roster read is its own state: the form falls back to the typed id (the
  // server still refuses an unservable one) rather than reading as "no agents".
  const [agents, setAgents] = useState<readonly AgentEntry[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  useEffect(() => { void listAgents().then(setAgents).catch(() => setAgentsFailed(true)); }, []);
  const navigate = useNavigate();
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
    // The server names what was wrong (an unservable agent, a non-host domain entry).
    catch (err) {
      const field = err instanceof WidgetApiError ? err.field : undefined;
      // ADR 1018 D8 — checked first: no own model key, whatever field it names.
      setError(isWidgetByokRequired(err) ? t('byokRequired')
        : field === 'agentId' ? t('createErrorAgent')
        : field === 'allowedDomains' && err instanceof WidgetApiError && err.entry ? t('createErrorDomain', { entry: err.entry })
          : t('createError'));
    }
    finally { setCreating(false); }
  }, [newAgent, newDomains, creating, orgId, load, t]);

  const onRotate = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('rotateConfirmTitle'), body: t('rotateConfirmBody'), confirmLabel: t('rotate') }))) return;
    await rotateWidgetToken(orgId, w.widgetId).then(setSnippetFor).catch(() => setError(t('loadError')));
    load(orgId);
  }, [orgId, load, t]);

  const onDelete = useCallback(async (w: Widget) => {
    if (!(await confirm({ title: t('deleteConfirmTitle'), body: t('deleteConfirmBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    await deleteWidget(orgId, w.widgetId).catch(() => setError(t('loadError')));
    setSnippetFor((s) => (s?.widgetId === w.widgetId ? null : s));
    setViewing((v) => (v?.widgetId === w.widgetId ? null : v));
    load(orgId);
  }, [orgId, load, t]);

  // grade-ux `CW68U-8` — a widget disabled when its agent was deleted could not be
  // turned back on from the UI.
  const onToggleEnabled = useCallback(async (w: Widget) => {
    // grade-ux CW68U-17 — turning a LIVE public widget off is confirmed first.
    if (w.enabled && !(await confirm({ title: t('disableConfirmTitle'), body: t('disableConfirmBody', { domains: w.allowedDomains.join(', ') }), confirmLabel: t('disable') }))) return;
    // CW68U-16 — the server refuses to enable a widget whose agent is gone; say so.
    await patchWidget(orgId, w.widgetId, { enabled: !w.enabled }).catch((err: unknown) => setError(t(isWidgetByokRequired(err) ? 'byokRequired'
      : err instanceof WidgetApiError && err.field === 'agentId' ? 'enableErrorAgent' : 'loadError')));
    load(orgId);
  }, [orgId, load, t]);

  const columns = useMemo<DataColumn<Widget>[]>(() => [
    { key: 'agent', header: t('colAgent'), sortValue: (r) => r.agentId, render: (r) => r.agentId },
    { key: 'domains', header: t('colDomains'), render: (r) => r.allowedDomains.join(', ') },
    { key: 'status', header: t('colStatus'), render: (r) => <StatusBadge status={r.enabled ? 'completed' : 'paused'} label={t(r.enabled ? 'active' : 'disabled')} /> },
    { key: 'actions', header: '', align: 'right', render: (r) => (
      <span className="u-flex u-gap-1 u-justify-end">
        <Button variant="secondary" size="sm" onClick={() => setViewing(r)}>{t('conversations')}</Button>
        <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>{t('configure')}</Button>
        <Button variant="quiet" size="sm" onClick={() => void onToggleEnabled(r)}>{t(r.enabled ? 'disable' : 'enable')}</Button>
        <Button variant="secondary" size="sm" onClick={() => setSnippetFor(r)}>{t('embed')}</Button>
        <Button variant="secondary" size="sm" onClick={() => void onRotate(r)}>{t('rotate')}</Button>
        <Button variant="quiet" size="sm" onClick={() => void onDelete(r)}>{t('delete')}</Button>
      </span>
    ) },
  ], [t, onRotate, onDelete, onToggleEnabled]);

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
        <label className="field"><span className="field-label">{t('newAgent')}</span>
          {!agentsFailed && agents && agents.length > 0 ? (
            <select value={newAgent} onChange={(e) => setNewAgent(e.target.value)}>
              <option value="">{t('newAgentPlaceholder')}</option>
              {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.label || a.agentId}</option>)}
            </select>
          ) : (
            <input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} />
          )}
        </label>
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
      {viewing && <WidgetConversations orgId={orgId} widget={viewing} onClose={() => setViewing(null)} />}
      {snippetFor && (
        <section className="surface-card u-p-3 u-mt-2" aria-label={t('embedAria')}>
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
          {/* grade-ux CW68U-1 — the console's origin is never on a widget's allowlist,
              so the agent is tried in the ONE chat (deep link), not in a second panel. */}
          <p className="u-fs-11 u-mb-1">
            <Button variant="quiet" size="sm" onClick={() => navigate(`/chat?agent=${encodeURIComponent(snippetFor.agentId)}`)}>{t('tryAgent')}</Button>
            <span className="muted"> {t('tryAgentHint')}</span>
          </p>
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
