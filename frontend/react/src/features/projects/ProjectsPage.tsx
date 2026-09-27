/**
 * Projects page (ADR 0046) — the `kind:'project'` Subject surface. Lists the
 * workspace's projects (the ones the caller can read) + a create form; each card
 * links to the project detail (board + memory). Uses the shared `ui/` primitives.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { FolderIcon, PlusIcon } from '../../ui/icons/index.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { listProjects, createProject, listOrgs, type Project, type Org } from './projectsClient.js';
import { ProjectCard, ProjectRow } from './ProjectViews.js';

export function ProjectsPage(): JSX.Element {
  const { t } = useTranslation('projects');
  const [projects, setProjects] = useState<Project[] | null>(null);

  const [error, setError] = useState<string | null>(null);
  /** The list read FAILED — distinct from `null` (loading) and `[]` (genuinely
   *  none). #2596's correction: the right resolution depends on what the EMPTY
   *  state says, and this one instructs. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  // ADR 0063 — only offer "Create project" to a caller who can actually write
  // somewhere in this workspace (createProject needs `workspace:write` in the
  // chosen org), so a read-only member doesn't get a form that 403s on submit.
  // This is the active-workspace write union; a multi-org caller with mixed
  // scopes still picks the org, and the backend re-checks per-org, fail-closed.
  const [canCreate, setCanCreate] = useState(false);
  /** UX_UPGRADE-projects R2 (PRJ2-M4) — the two reads that gate creation used
   *  to fail into `catch {}` / `catch(false)`. Both failures LOOK like an
   *  answer about the workspace rather than a failure to get one:
   *   - `listOrgs` → the workspace picker renders EMPTY, `effectiveOrg` is `''`,
   *     and the Create button is permanently disabled. Told: this workspace has
   *     no orgs to create in. True: the org read failed.
   *   - `getEffectiveAccess` → `canCreate` false hides the entire form. Staying
   *     fail-closed is correct (the backend re-checks anyway), but saying
   *     nothing turns "we could not confirm your permission" into "you do not
   *     have permission", which is a claim we never verified.
   *
   *  The org half is NOT hand-rolled here. The first fix added a bespoke
   *  `orgsFailed` flag + its own notice — making this the 19th copy of an idiom
   *  the app had already extracted twice over, and reproducing the mistake the
   *  extraction exists to stop: the notice went INSIDE the create form, below
   *  the picker, so a failed read still rendered a workspace `<select>` and a
   *  dead Create button above it. `useOrgSelection` owns the three states and
   *  `OrgSelectionState` owns the branch ORDER (failed → empty → loading), and
   *  the ratchet in `ui/__tests__/orgSelectionEdgeRatchet.test.ts` is what
   *  caught the duplicate. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [accessFailed, setAccessFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('projects', 'grid');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects ?? [];
    return (projects ?? []).filter(
      (p) => p.name.toLowerCase().includes(q) || (p.charter?.goal?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, query]);

  const refresh = useCallback(async () => {
    try { setLoadFailed(false); setProjects(await listProjects()); }
    catch (e) {
      setError(loadErrorMessage(t, e));
      setLoadFailed(true);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    void getEffectiveAccess()
      .then((a) => { setCanCreate(a.scopes.includes('workspace:write')); setAccessFailed(false); })
      // Still fail-closed on the affordance — but now we say WHY it is missing.
      .catch(() => { setCanCreate(false); setAccessFailed(true); });
  }, [refresh]);

  const effectiveOrg = orgId;

  const onCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!effectiveOrg || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try { await createProject(effectiveOrg, name.trim()); setName(''); await refresh(); }
    catch (er) { setError(`${t('createProjectError')} ${loadErrorMessage(t, er)}`); }
    finally { setBusy(false); }
  };

  return (
    <div data-walkthrough="projects.page">
      <PageHeader eyebrow={t('listEyebrow')} title={t('listTitle')} lede={t('listLede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* PRJ2-M4 — the access read failed, so we cannot say whether this person
          may create a project. The form stays hidden (fail-closed) and the
          reason is stated, instead of impersonating a permission answer. */}
      {accessFailed ? (
        <Notice variant="warning" announce={t('accessCheckFailed')}>{t('accessCheckFailed')}</Notice>
      ) : null}

      {canCreate ? (
        <form className="surface-card surface-form u-mb-4" onSubmit={(e) => void onCreate(e)}>
          {/* Failed → empty → loading, in that order, owned by the shared
              component. Its children render ONLY once the read succeeded with
              at least one workspace — so a failed read can no longer present a
              picker and a dead Create button, which the bespoke notice did. */}
          <OrgSelectionState
            orgs={orgs}
            orgsFailed={orgsFailed}
            retry={retryOrgs}
            variant="inline"
            emptyBody={t('orgsEmptyBody')}
            failedBody={t('orgsFailedBody')}
          >
            <SelectField label={t('ui:orgPickerLabel')} value={effectiveOrg} onChange={(e) => setOrgId(e.target.value)}>
              {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
            <TextField label={t('newProjectNameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newProjectNamePlaceholder')} />
            <Button variant="primary" type="submit" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createProject')}</Button>
          </OrgSelectionState>
        </form>
      ) : null}

      {projects === null && loadFailed ? (
        // NOT an empty list: this page's empty state reads "No projects yet —
        // create one above", which invites creating a project that may already
        // exist. Ordered ABOVE the loading branch or the spinner wins and the
        // distinction is decorative.
        <StateCard announce icon={<FolderIcon size={20} />} title={t('loadFailedTitle')} body={t('loadFailedBody')} />
      ) : projects === null ? (
        <StateCard icon={<FolderIcon size={20} />} title={t('loadingProjects')} loading />
      ) : projects.length === 0 ? (
        <StateCard icon={<FolderIcon size={20} />} title={t('noProjectsTitle')} body={t('noProjectsBody')} />
      ) : (
        <>
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            {projects.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
          </div>

          {visible.length === 0 ? (
            <StateCard
              icon={<FolderIcon size={20} />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</Button>}
            />
          ) : viewMode === 'grid' ? (
            <div className="card-grid">
              {visible.map((p) => <ProjectCard key={p.id} project={p} />)}
            </div>
          ) : (
            <div className="surface-card list-view">
              {visible.map((p) => <ProjectRow key={p.id} project={p} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
