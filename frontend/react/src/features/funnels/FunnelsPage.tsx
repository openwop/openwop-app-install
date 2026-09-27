/**
 * Funnels builder (ADR 0294 / Funnel A, Phase 5). Master–detail: the org's
 * funnels list + a selected-funnel editor — ordered steps (each bound to a CMS
 * page; "Edit page" deep-links the CMS Page Builder — no editor fork),
 * lifecycle (publish/unpublish/archive), per-step analytics
 * (derived rollups + rebuild), and per-step A/B splits with honest results.
 * Gated by the `funnels` toggle.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import {
  listOrgs, listFunnels, createFunnel,
  publishFunnel, unpublishFunnel, archiveFunnel,
  type Org, type Funnel,
} from './funnelsClient.js';

const statusChip = (status: Funnel['status']): string =>
  status === 'published' ? 'chip chip--success' : status === 'archived' ? 'chip chip--muted' : 'chip chip--warning';

export function FunnelsPage(): JSX.Element {
  const { t } = useTranslation('funnels');
  const { t: tc } = useTranslation('common');
  const fmt = useFormat();
  const navigate = useNavigate();
  // `useFeatureAccess` returns an OBJECT, so the previous `const enabled = …`
  // + `if (!enabled)` was ALWAYS truthy: the "not enabled" branch below was dead
  // and this page rendered regardless of its toggle. (The object-ness was visible
  // a few lines down, where `enabled.enabled` is what the org read already used.)
  // Destructure the flag, and keep the org read gated on it so a disabled feature
  // touches no network.
  const access = useFeatureAccess('funnels');

  const [rows, setRows] = useState<Funnel[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  // The open funnel rides the URL (`?org=&funnel=`, the CRM deep-link pattern —
  // routing-correction wave): shareable, reload-stable, back/forward-friendly.
  const [searchParams] = useSearchParams();
  // One-shot snapshot of the inbound `?org=` deep link, read before the org
  // list resolves.
  const [deepLinkOrg] = useState(() => searchParams.get('org'));
  // The SHARED org selector (ui/useOrgSelection) — the seam 17 other pages
  // already use. It keeps `initialOrgId` only when that org is present in the
  // fetched list, which is exactly the deep-link validation this page did by
  // hand, and it distinguishes "no workspaces" from "could not read them"
  // (the raw `.catch(() => setOrgs([]))` it replaces could not).
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, deepLinkOrg ?? '');
  /** A table cell's href. The funnel opens at its OWN URL (ADR 0522) — the
   *  `?funnel=` mirror this page used to keep is gone with the stacked editor,
   *  and with it `setSelectedId` / `editSteps`, which moved to the detail page. */
  const funnelHref = useCallback(
    (id: string): string => `/funnels/${encodeURIComponent(id)}${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`,
    [orgId],
  );
  // §4.5 collection controls — search + status filter feed a SEPARATE view memo
  // (visibleRows); the `?funnel=` validity effect keeps checking the FULL rows,
  // so filtering the table never drops the URL selection.
  const [query, setQuery] = useState('');
  const [fStatus, setFStatus] = useState('');

  const visibleRows = useMemo(() => (rows ?? []).filter((f) =>
    (!query.trim() || f.name.toLowerCase().includes(query.trim().toLowerCase()))
    && (!fStatus || f.status === fStatus),
  ), [rows, query, fStatus]);

  // One-shot snapshot of the inbound `?org=` deep-link (read before the org
  // list resolves; stable so the org-load effect doesn't re-run on param writes).

  const load = useCallback(async (org: string) => {
    if (!org) return;
    setRowsFailed(false);
    try {
      // The CMS page list moved with the step editor (ADR 0522) — the table
      // needs only the funnels.
      setRows(await listFunnels(org)); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); setRows([]); setRowsFailed(true); }
  }, [t]);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);
  // Selection validity: an org switch or a delete leaves `?funnel=` naming a
  // funnel that is not in the loaded rows — drop it from the URL.
  const refresh = useCallback(async () => { await load(orgId); }, [load, orgId]);

  const add = useCallback(async () => {
    if (!orgId || !newName.trim()) return;
    setBusy(true);
    try {
      const funnel = await createFunnel(orgId, { name: newName.trim() });
      setNewName('');
      toast.success(t('funnelAdded'));
      // Land on the new funnel's OWN URL — creating and staying on the table
      // would hide the thing you just made among the rows.
      navigate(funnelHref(funnel.funnelId));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, newName, navigate, funnelHref, t]);

  const lifecycle = useCallback(async (f: Funnel, action: 'publish' | 'unpublish' | 'archive') => {
    try {
      if (action === 'publish') await publishFunnel(orgId, f.funnelId);
      else if (action === 'unpublish') {
        // FN-B-5 -- one click took a LIVE public URL down with no confirm.
        if (!(await confirm({ title: t('unpublishConfirm', { name: f.name }), body: t('unpublishBody'), danger: true, confirmLabel: t('unpublish') }))) return;
        await unpublishFunnel(orgId, f.funnelId);
      }
      else {
        if (!(await confirm({ title: t('archiveConfirm', { name: f.name }), danger: true, confirmLabel: t('archive') }))) return;
        await archiveFunnel(orgId, f.funnelId);
      }
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
  }, [orgId, refresh, t]);

  const columns = useMemo<DataColumn<Funnel>[]>(() => [
    // §4.5 rule 12 — a real `<Link>` to the funnel's own URL. As an onClick it
    // looked identical and silently broke cmd-click, middle-click, "copy link
    // address", and Back/Forward.
    { key: 'name', header: t('colName'), render: (f) => <Link to={funnelHref(f.funnelId)}>{f.name}</Link>, sortValue: (f) => f.name },
    { key: 'slug', header: t('colSlug'), render: (f) => <code>{f.slug}</code> },
    { key: 'status', header: t('colStatus'), render: (f) => <span className={statusChip(f.status)}>{t(`status_${f.status}`)}</span>, sortValue: (f) => f.status },
    { key: 'steps', header: t('colSteps'), render: (f) => fmt.number(f.steps.length), sortValue: (f) => f.steps.length },
    { key: 'actions', header: '', render: (f) => (
      <span className="action-bar">
        {f.status === 'draft' ? <Button variant="quiet" aria-disabled={f.steps.length === 0} onClick={() => { if (f.steps.length === 0) { toast.error(t('publishNeedsSteps')); return; } void lifecycle(f, 'publish'); }}>{t('publish')}</Button> : null}
        {f.status === 'published' ? <Button variant="quiet" onClick={() => void lifecycle(f, 'unpublish')}>{t('unpublish')}</Button> : null}
        {f.status !== 'archived' ? <Button variant="quiet" onClick={() => void lifecycle(f, 'archive')}>{t('archive')}</Button> : null}
        {/* Delete is NOT here — §4.5 rule 12 puts destructive actions on the
            entity's own surface, beside the name that says which funnel is
            about to go. Lifecycle stays: those are operate-surface actions you
            take while scanning the table (the rule-11 `<DataTable>` lane). */}
      </span>
    ) },
  ], [t, fmt, lifecycle, funnelHref]);

  // The toggle has not resolved yet — a shape-matched skeleton UNDER the real
  // header, not a `StateCard`: the card's only text would be the page title, so
  // it reads as a terminal answer, and it unmounts `PageHeader` on the way in and
  // out. (The corpus majority — `commerce`, `commerce-ucp-buyer`, `webinars`,
  // `creative-video` — keeps the header and swaps the body.)
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="funnels.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={4} columns={["40%","20%","15%","10%"]} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="funnels.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }


  return (
    <section className="u-grid u-gap-4" data-walkthrough="funnels.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* Branch order is load-bearing, and it is no longer this page's to get
          right: `OrgSelectionState` owns it (failed → zero-orgs → children) and
          owns the noun. Both org states still sit ABOVE the loading branch,
          because the loading branch is what BOTH of them render otherwise — the
          funnel read they wait for never starts. Taking the table as CHILDREN is
          what makes that unskippable.
          It wraps the FORM too (the custom-domains shape). It did not, and the
          cost was the picker: outside the wrapper the org `<select>` still
          rendered in both org states, and in both of them `orgs` has no entries
          — a labelled combobox with nothing in it, announced as "Organization,
          combo box, 0 items". A control with no options is not a control; the
          card that replaces it says what happened. With no organization the
          submit could not write anything anyway (`disabled={… || !orgId}`).
          Loading keeps a real placeholder option, because that state DOES render
          the form and an empty combobox is no better there. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('ui:orgPickerLabel')}</span>
          {/* The picker lists ORGANIZATIONS and nothing else. Its three
              placeholder options ("Loading workspaces…", "Could not load
              workspaces", "No workspaces") were the second voice on this
              screen, and they used the OTHER noun: `noOrgs: 'No workspaces'`
              sat five lines from `noOrgsTitle: 'No organizations'` in the same
              catalog. `OrgSelectionState` below now says all three states once,
              in one noun — so the select says none of them. */}
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldName')}</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('namePlaceholder')} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !orgId || !newName.trim()}>{t('addFunnel')}</Button>
      </form>

            {rows === null ? <SkeletonRows rows={4} columns={["40%","20%","15%","10%"]} /> : rowsFailed ? (
        <StateCard announce title={tc('loadFailedTitle')} body={tc('loadFailedBody')} action={<Button variant="secondary" onClick={() => void refresh()}>{tc('retry')}</Button>} />
      ) : rows.length === 0 ? (
        <StateCard title={t('noFunnelsTitle')} body={t('noFunnelsBody')} />
      ) : (
        <div className="u-grid u-gap-3">
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            {rows.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            {/* Self-describing "All statuses" option carries the facet's label — an
                eyebrow label would break the one-row filterbar baseline. */}
            <select className="ui-input filterbar-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label={t('filterStatus')}>
              <option value="">{t('filterAllStatuses')}</option>
              {(['draft', 'published', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
            </select>
          </div>
          {visibleRows.length === 0 ? (
            <StateCard
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => { setQuery(''); setFStatus(''); }}>{t('clearSearch')}</Button>}
            />
          ) : (
            <DataTable caption={t('captionFunnels')} columns={columns} rows={visibleRows} rowKey={(f) => f.funnelId} />
          )}
        </div>
      )}
      </OrgSelectionState>

    </section>
  );
}
