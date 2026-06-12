/**
 * CMS + Page Builder (host-extension product feature — ADR 0009).
 *
 * Gates on useFeatureAccess('cms'). An org picker drives a page list + a
 * section-based editor (the core section set), the editorial workflow buttons
 * (the backend enforces who may approve/publish — a wrong-authority click
 * surfaces a 403 toast), and a live preview. Section images are Media-Library
 * tokens.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { FileTextIcon, LockIcon, PlusIcon, SaveIcon, TrashIcon } from '../../ui/icons/index.js';
import { RenderSection } from './SectionRenderer.js';
import { SectionsEditor } from './SectionsEditor.js';
import {
  createPage,
  deletePage,
  getPage,
  listMediaAssets,
  listOrgs,
  listPages,
  savePage,
  transition,
  type MediaAssetRef,
  type Org,
  type Page,
  type WorkflowAction,
} from './cmsClient.js';


/** Status → the workflow actions to OFFER (authority is enforced server-side). */
const ACTIONS_FOR: Record<string, WorkflowAction[]> = {
  draft: ['submit', 'publish'],
  in_review: ['approve', 'reject'],
  published: ['unpublish', 'archive'],
  archived: ['unpublish'],
};

export function CmsPage(): JSX.Element {
  const access = useFeatureAccess('cms');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [pages, setPages] = useState<Page[] | null>(null);
  const [selected, setSelected] = useState<Page | null>(null);
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadPages = useCallback((org: string) => {
    void listPages(org).then(setPages).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load pages.'));
  }, []);

  useEffect(() => {
    if (!orgId) return;
    setPages(null); setSelected(null); setError(null);
    loadPages(orgId);
    void listMediaAssets(orgId).then(setAssets).catch(() => setAssets([]));
  }, [orgId, loadPages]);

  const open = useCallback((pageId: string) => {
    void getPage(orgId, pageId).then(setSelected).catch((e) => toast.error(e instanceof Error ? e.message : 'Open failed.'));
  }, [orgId]);

  const create = useCallback(async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try { const p = await createPage(orgId, newTitle.trim()); setNewTitle(''); loadPages(orgId); setSelected(p); toast.success('Page created.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed.'); } finally { setBusy(false); }
  }, [orgId, newTitle, loadPages]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const saved = await savePage(orgId, selected.pageId, { title: selected.title, sections: selected.sections });
      setSelected(saved); loadPages(orgId); toast.success('Saved.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed.'); } finally { setBusy(false); }
  }, [orgId, selected, loadPages]);

  const runAction = useCallback(async (action: WorkflowAction) => {
    if (!selected) return;
    try { const p = await transition(orgId, selected.pageId, action); setSelected(p); loadPages(orgId); toast.success(`Page ${p.status}.`); }
    catch (e) { toast.error(e instanceof Error ? e.message : `${action} failed.`); }
  }, [orgId, selected, loadPages]);

  const remove = useCallback(async (pageId: string) => {
    try { await deletePage(orgId, pageId); if (selected?.pageId === pageId) setSelected(null); loadPages(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, selected, loadPages]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="CMS is not enabled" body="Ask an administrator to enable the CMS feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div>
      <PageHeader eyebrow="Platform" title="CMS · Page Builder" lede="Org pages with a section editor + editorial workflow." actions={orgs && orgs.length > 0 ? orgPicker : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<FileTextIcon />} title="No organizations" body="Create an organization first — pages belong to an org." />
      ) : (
        <div className="cms-layout">
          {/* Page list */}
          <div className="surface-card u-gap-2">
            <strong>Pages</strong>
            {!pages ? <Skeleton /> : pages.length === 0 ? <span className="u-label-sm">No pages yet.</span> : pages.map((p) => (
              <div key={p.pageId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selected?.pageId === p.pageId ? 'btn-primary' : 'btn-ghost'} u-justify-start u-flex-1`} onClick={() => open(p.pageId)}>
                  {p.title}
                </button>
                <span className="chip">{p.status}</span>
                <button type="button" className="btn-ghost" title="Delete" onClick={() => void remove(p.pageId)}><TrashIcon /></button>
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New page title" />
              <button type="button" className="btn-ghost" disabled={busy || !newTitle.trim()} onClick={() => void create()}><PlusIcon /></button>
            </div>
          </div>

          {/* Editor */}
          {!selected ? (
            <StateCard icon={<FileTextIcon />} title="Select a page" body="Pick a page on the left, or create one." />
          ) : (
            <div className="u-grid u-gap-4">
              <div className="surface-card u-gap-3">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <span className="chip">{selected.status}</span>
                  <span className="u-label-sm">/{selected.slug} · v{selected.version}</span>
                  <span className="u-flex-1" />
                  {ACTIONS_FOR[selected.status]?.map((a) => (
                    <button key={a} type="button" className="btn-ghost" onClick={() => void runAction(a)}>{a}</button>
                  ))}
                </div>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">Title</span>
                  <input value={selected.title} onChange={(e) => setSelected((p) => (p ? { ...p, title: e.target.value } : p))} />
                </label>

                <strong>Sections</strong>
                <SectionsEditor sections={selected.sections} assets={assets} onChange={(sections) => setSelected((p) => (p ? { ...p, sections } : p))} />

                <div className="action-bar">
                  <span className="u-flex-1" />
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> Save</button>
                </div>
              </div>

              {/* Preview */}
              <div className="surface-card u-gap-3">
                <strong>Preview</strong>
                {selected.sections.length === 0 ? <span className="u-label-sm">Add a section to preview.</span> : selected.sections.map((s) => <RenderSection key={s.sectionId} section={s} mode="editor" />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The section editor + preview now live in the shared `SectionsEditor` /
// `SectionRenderer` (ADR 0027) so the org CMS editor and the host-level home-page
// editor use the same controls.
