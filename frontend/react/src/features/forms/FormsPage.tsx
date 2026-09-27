/**
 * Forms — the collection page (host-extension product feature — ADR 0017).
 *
 * A STANDARD collection page per DESIGN.md §4.5: `PageHeader` → create toolbar
 * (blank + ADR 0516 templates) → one `.filterbar` row (search + status facet +
 * `<ViewToggle>`) → a `.card-grid` of `<FormCard>` or a `.surface-card.list-view`
 * of `<FormRow>` → designed `<StateCard>` states. Opening a form NAVIGATES to
 * `/forms/:formId` (ADR 0519); the builder, publish controls, submissions, and
 * delete all live there.
 *
 * WHAT THIS REPLACED, and why it was a defect and not a style choice: the page
 * used to stack the builder and the submissions list UNDER the collection, with
 * the open form held in component state and mirrored to `?form=`. Three things
 * followed from that, all of them canon violations:
 *   - the "cells" were `onClick` buttons, so cmd-click, middle-click, "copy link
 *     address", and browser history did nothing (rule 12);
 *   - delete sat on the collection cell — one mis-aimed click away from the row
 *     you meant to open (rule 12 puts destructive actions on the detail surface);
 *   - the list had no Grid⇄List toggle and rendered bare `<span>` text for its
 *     empty and no-match states (rules 11, 13).
 * The `?form=` mirror was the stacked-master-detail lane of rule 12, which Forms
 * qualified for as a "builder-selector page". It is a full-page collection of
 * homogeneous entities, so the path-route lane is the correct one.
 *
 * The failed-read honesty this page earned the hard way (UX-WS-1, the ADR 0508
 * fallout) is preserved throughout: a read that FAILS never renders as "you have
 * none". Each read keeps its own failed flag, distinct from `null` (loading).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Button } from '../../ui/Button.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { TemplateGalleryDialog } from '../../ui/TemplateGallery.js';
import { toast } from '../../ui/toast.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { bidiIsolate } from '../../lib/bidi.js';
import { ClipboardIcon, GlobeIcon, LayoutGridIcon, LockIcon, PlusIcon } from '../../ui/icons/index.js';
import {
  createForm, createFormFromTemplate, listForms, listFormTemplates, listOrgs,
  FormsRequestError,
  type FormDef, type FormField, type FormTemplate, type Org,
} from './formsClient.js';
import { FormCard, FormRow, formHref } from './FormViews.js';

/** R2 FRM2-15 — starter labels resolve through i18n at CREATION time: the
 *  hard-coded English pair shipped English public labels to a pt-BR
 *  operator's first form. Keys stay stable ASCII. */
const starterFields = (t: (k: string) => string): FormField[] => [
  { key: 'name', label: t('starterNameLabel'), type: 'text', required: true },
  { key: 'email', label: t('starterEmailLabel'), type: 'email', required: true },
];

export function FormsPage(): JSX.Element {
  const { t } = useTranslation('forms');
  const navigate = useNavigate();
  const access = useFeatureAccess('forms');

  // `?org=` is honoured as the initial selection (a shared link lands where it
  // says); the picker writes it back so the choice survives a reload.
  const [searchParams, setSearchParams] = useSearchParams();
  /** One-shot snapshot of the inbound `?org=` deep link, read BEFORE the org
   *  list resolves. Snapshotting (rather than reading `searchParams` inside the
   *  effect) is what keeps the effect's dep list honest — the picker rewrites
   *  the URL, and a live read would refetch the org list on every rewrite. The
   *  Funnels page established this idiom. */
  /** The shared read. FR-R2-1's local fix wrote `setOrgs([])` beside an
   *  `orgsFailed` flag, so the zero-org branch had to ask a second question to
   *  know what it was looking at; the hook keeps `orgs` null on failure and the
   *  question disappears. `?org=` is honoured when the read confirms it. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, searchParams.get('org') ?? '');

  const [forms, setForms] = useState<FormDef[] | null>(null);
  /** The list read FAILED — distinct from `null` (loading) and `[]` (genuinely
   *  none). This page's empty state INSTRUCTS ("create your first form"), so
   *  showing it after a failed read would invite creating a duplicate. */
  const [formsFailed, setFormsFailed] = useState(false);
  /** ADR 0516 — installed form templates (pack-sourced). `null` = still loading. */
  const [templates, setTemplates] = useState<FormTemplate[] | null>(null);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | FormDef['status']>('');
  const [viewMode, setViewMode] = useViewMode('forms', 'grid');
  const [galleryOpen, setGalleryOpen] = useState(false);

  const chooseOrg = useCallback((next: string) => {
    setOrgId(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set('org', next); else p.delete('org');
      return p;
    }, { replace: true });
    // `setOrgId` comes from `ui/useOrgSelection` now rather than from a local
    // `useState`, so the linter can no longer prove it stable across renders.
    // It IS — the hook returns the raw setter — but declaring it is cheaper than
    // asserting it, and a suppression here would outlive the reason for it.
  }, [setSearchParams, setOrgId]);

  /**
   * FORM-UX-5 (ADR 0584) — map a TYPED failure to LOCALIZED copy.
   *
   * The idiom this replaces — `e instanceof Error ? e.message : t('…')` — could
   * never select `t`, because `formsClient` always threw an `Error` (and a
   * network rejection is a `TypeError`, which is also one). So this page's three
   * fallback strings were dead in all four locales and every failure rendered
   * raw English server text. The server's own words are kept as a DETAIL, never
   * as the whole message. Mirrors `CsmPage.failureCopy`.
   */
  const failureCopy = useCallback((err: unknown, fallbackKey: string): { title: string; detail?: string } => {
    if (err instanceof FormsRequestError) {
      const title = err.status === 403 ? t('failureForbidden')
        : err.status === 404 ? t('failureNotFound')
          : err.status === 400 || err.status === 422 ? t('failureRejected')
            : err.status === 429 ? t('failureRateLimited')
              : err.status >= 500 ? t('failureServer')
                : t(fallbackKey);
      return err.detail ? { title, detail: err.detail } : { title };
    }
    return { title: t('failureOffline') };
  }, [t]);

  const [formsAttempt, setFormsAttempt] = useState(0); // R2 FRM2-16 — the failed card's retry
  useEffect(() => {
    if (!orgId) return;
    // FORM-UX-6 — CLEAR the error as the read re-enters loading. It had exactly
    // one `setError` and no reset, while the Notice that rendered it sat OUTSIDE
    // the failed branch — so a successful RETRY (or a switch to a workspace that
    // loads fine) painted the forms AND a red "Failed to load forms." above them.
    setForms(null); setFormsFailed(false); setError(null);
    let live = true; // ignore a stale resolution if the org changed mid-flight
    void listForms(orgId)
      .then((f) => { if (live) { setForms(f); setError(null); } })
      .catch((e) => {
        if (!live) return;
        const { detail } = failureCopy(e, 'loadFormsFailed');
        setError(detail ?? null);
        setFormsFailed(true);
      });
    return () => { live = false; };
  }, [orgId, t, formsAttempt, failureCopy]);

  // ADR 0516 — the template catalog rides the same org as the forms list.
  useEffect(() => {
    if (!orgId) { setTemplates(null); setTemplatesFailed(false); return undefined; }
    let live = true;
    setTemplates(null); setTemplatesFailed(false);
    void listFormTemplates(orgId)
      .then((tpl) => { if (live) setTemplates(tpl); })
      // A failed catalog read must not read as "no templates installed" (UX-WS-1
      // family) — the picker says so instead of quietly disappearing.
      .catch(() => { if (live) { setTemplates(null); setTemplatesFailed(true); } });
    return () => { live = false; };
  }, [orgId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (forms ?? []).filter((f) =>
      (!q || f.title.toLowerCase().includes(q)) && (!statusFilter || f.status === statusFilter));
  }, [forms, query, statusFilter]);

  const clearFilters = useCallback(() => { setQuery(''); setStatusFilter(''); }, []);

  // Create → land on the new form's OWN URL. Creating and then leaving the user
  // on the list would hide the thing they just made below the fold.
  const createNew = useCallback(async () => {
    if (!orgId || !newTitle.trim() || busy) return;
    setBusy(true);
    try {
      const form = await createForm(orgId, { title: newTitle.trim(), fields: starterFields(t), createToContact: true });
      setNewTitle('');
      toast.success(t('formCreated'));
      navigate(formHref(form, orgId));
    } catch (e) { const c = failureCopy(e, 'createFailed'); toast.error(c.detail ? `${c.title} ${c.detail}` : c.title); }
    finally { setBusy(false); }
  }, [orgId, newTitle, busy, navigate, t, failureCopy]);

  const createFromTemplate = useCallback(async (templateId: string) => {
    if (!orgId || busy) return;
    setBusy(true);
    try {
      const form = await createFormFromTemplate(orgId, templateId);
      toast.success(t('templateCreated'));
      navigate(formHref(form, orgId));
    } catch (e) { const c = failureCopy(e, 'templateCreateFailed'); toast.error(c.detail ? `${c.title} ${c.detail}` : c.title); }
    finally { setBusy(false); }
  }, [orgId, busy, navigate, t, failureCopy]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => chooseOrg(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div data-walkthrough="forms.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {/* FORM-UX-6 — the second competing failure surface is GONE. The read's
          failure is told once, by the `StateCard` below (the Users-&-Auth
          single-surface rule); the server's own words ride there as a detail
          line rather than as a red banner that outlived the failure. */}

      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<GlobeIcon size={20} />}
      >
        <>
          {/* New-form toolbar (§5.1 .surface-form) — blank, or from a template. */}
          <form
            className="surface-card surface-form u-mb-4"
            onSubmit={(e) => { e.preventDefault(); void createNew(); }}
          >
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('newFormLabel')}</span>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('newFormPlaceholder')} maxLength={200} />
            </label>
            {/* §4.5 rule 4 — THE action on this page, so the solid accent fill. */}
            <Button type="submit" variant="accent-solid" disabled={busy || !newTitle.trim()}><PlusIcon size={14} /> {t('newFormButton')}</Button>

            {/* ADR 0516 — start from a template. Pack-sourced; the SERVER creates
                through `createForm`, so the fields are sanitized there and this
                never posts field definitions itself.

                §4.5 rule 14 — ONE affordance that opens the shared gallery, not
                an inline strip of every template. The catalog is pack-sourced,
                so its size is not ours to assume: four chips became a wall at
                forty, with nothing to search and no room to say what a template
                contains. The strip also gave a failed catalog read nowhere
                honest to go; the gallery owns that state. */}
            <div className="u-flex u-flex-col u-gap-1">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setGalleryOpen(true)}
              >
                <LayoutGridIcon size={14} /> {t('templatesOpenGallery')}
              </Button>
              {/* Kept from the inline strip this replaced (PR 2921): saying a
                  template creates an editable DRAFT is what makes the button
                  safe to press. It belongs beside the affordance, not inside
                  the dialog — it answers "what happens if I click this?". */}
              <span className="u-label-sm muted">{t('templatesReassurance')}</span>
            </div>
          </form>

          {galleryOpen ? (
            <TemplateGalleryDialog
              title={t('templatesGalleryTitle')}
              items={templates?.map((tpl) => ({
                id: tpl.templateId,
                // DOCTPL-19 review F5 — every PACK-AUTHORED string is
                // bidi-ISOLATED before mixing into app chrome, so a hostile
                // template's RTL controls cannot reorder the copy around it
                // (ADR 0516's own stated residual: "a hostile template can
                // still phish"). Wrapped consistently, so the gallery's
                // category filter equality still holds.
                label: bidiIsolate(tpl.label),
                ...(tpl.description ? { description: bidiIsolate(tpl.description) } : {}),
                ...(tpl.category ? { category: bidiIsolate(tpl.category) } : {}),
                meta: [
                  t('subFieldCount', { count: tpl.fields.length }),
                  // DOCTPL-19 — source attribution (pack@version): the cheap
                  // half of the ADR 0516 §Provenance phishing mitigation. A
                  // technical identifier by design — it names the installable.
                  ...(tpl.packName ? [bidiIsolate(`${tpl.packName}@${tpl.packVersion ?? '?'}`)] : []),
                ],
              })) ?? null}
              failed={templatesFailed}
              busy={busy}
              emptyTitle={t('templatesEmptyTitle')}
              emptyBody={t('templatesEmptyBody')}
              onClose={() => setGalleryOpen(false)}
              onUse={(id) => void createFromTemplate(id)}
            />
          ) : null}

          {forms === null && formsFailed ? (
            <StateCard
              announce icon={<ClipboardIcon size={20} />} title={t('loadFailedTitle')}
              body={error ? `${t('loadFailedBody')} ${error}` : t('loadFailedBody')}
              action={<Button variant="secondary" onClick={() => setFormsAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
            />
          ) : forms === null ? (
            <StateCard icon={<ClipboardIcon size={20} />} title={t('loadingForms')} loading />
          ) : forms.length === 0 ? (
            <StateCard icon={<ClipboardIcon size={20} />} title={t('noFormsTitle')} body={t('noFormsBody')} />
          ) : (
            <>
              <div className="filterbar" role="group" aria-label={t('filterGroup')}>
                {/* Gated on the UNFILTERED total, so the controls can't vanish
                    mid-search and strand the user in a filtered list (rule 13). */}
                {forms.length > 3 ? (
                  <>
                    <input
                      type="search"
                      className="ui-input filterbar-search"
                      placeholder={t('filterPlaceholder')}
                      aria-label={t('filterAria')}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {/* Status facet (rule 13) — self-describing "All …" first option. */}
                    <select
                      className="ui-input filterbar-select"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value as '' | FormDef['status'])}
                      aria-label={t('filterStatusLabel')}
                    >
                      <option value="">{t('allStatuses')}</option>
                      <option value="draft">{t('status_draft')}</option>
                      <option value="published">{t('status_published')}</option>
                    </select>
                  </>
                ) : null}
                <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
              </div>

              <p className="sr-only" role="status" aria-live="polite">{t('resultCount', { count: visible.length })}</p>

              {visible.length === 0 ? (
                <StateCard
                  icon={<ClipboardIcon size={20} />}
                  title={t('noMatchTitle')}
                  body={t('noMatchBody')}
                  action={<Button variant="secondary" onClick={clearFilters}>{t('clearFilters')}</Button>}
                />
              ) : viewMode === 'grid' ? (
                <div className="card-grid">
                  {visible.map((f) => <FormCard key={f.formId} form={f} orgId={orgId} />)}
                </div>
              ) : (
                <div className="surface-card list-view">
                  {visible.map((f) => <FormRow key={f.formId} form={f} orgId={orgId} />)}
                </div>
              )}
            </>
          )}
        </>
      </OrgSelectionState>
    </div>
  );
}
