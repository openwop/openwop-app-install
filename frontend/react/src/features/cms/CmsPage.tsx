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
import {
  assetUrl,
  createPage,
  deletePage,
  getPage,
  listMediaAssets,
  listOrgs,
  listPages,
  savePage,
  transition,
  SECTION_TYPES,
  type MediaAssetRef,
  type Org,
  type Page,
  type Section,
  type SectionType,
  type WorkflowAction,
} from './cmsClient.js';

function blankSection(type: SectionType): Section {
  const data: Record<string, unknown> =
    type === 'hero' ? { heading: '' }
      : type === 'richText' ? { text: '' }
        : type === 'image' ? { token: '' }
          : type === 'cta' ? { label: '', url: '' }
            : { columns: [{ text: '' }] };
  return { sectionId: `new:${Math.random().toString(36).slice(2)}`, type, data };
}

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

  // Section mutation helpers operate on the in-memory selected page.
  const patchSection = (i: number, data: Record<string, unknown>): void =>
    setSelected((p) => (p ? { ...p, sections: p.sections.map((s, j) => (j === i ? { ...s, data } : s)) } : p));
  const moveSection = (i: number, dir: -1 | 1): void =>
    setSelected((p) => {
      if (!p) return p;
      const j = i + dir;
      if (j < 0 || j >= p.sections.length) return p;
      const next = [...p.sections];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...p, sections: next };
    });
  const addSection = (type: SectionType): void => setSelected((p) => (p ? { ...p, sections: [...p.sections, blankSection(type)] } : p));
  const removeSection = (i: number): void => setSelected((p) => (p ? { ...p, sections: p.sections.filter((_, j) => j !== i) } : p));

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
                {selected.sections.map((s, i) => (
                  <div key={s.sectionId} className="surface-card u-gap-2 u-p-3">
                    <div className="u-flex u-gap-1 u-items-center">
                      <span className="chip chip--accent">{s.type}</span>
                      <span className="u-flex-1" />
                      <button type="button" className="btn-ghost" onClick={() => moveSection(i, -1)} aria-label="Move up">↑</button>
                      <button type="button" className="btn-ghost" onClick={() => moveSection(i, 1)} aria-label="Move down">↓</button>
                      <button type="button" className="btn-ghost" onClick={() => removeSection(i)} aria-label="Remove section"><TrashIcon /></button>
                    </div>
                    <SectionFields section={s} assets={assets} onChange={(data) => patchSection(i, data)} />
                  </div>
                ))}

                <div className="action-bar">
                  <select aria-label="Add section" defaultValue="" onChange={(e) => { if (e.target.value) { addSection(e.target.value as SectionType); e.target.value = ''; } }} className="u-w-auto">
                    <option value="">+ Add section…</option>
                    {SECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span className="u-flex-1" />
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> Save</button>
                </div>
              </div>

              {/* Preview */}
              <div className="surface-card u-gap-3">
                <strong>Preview</strong>
                {selected.sections.length === 0 ? <span className="u-label-sm">Add a section to preview.</span> : selected.sections.map((s) => <SectionPreview key={s.sectionId} section={s} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MediaTokenField({ value, assets, onChange, label }: { value: string; assets: MediaAssetRef[]; onChange: (v: string) => void; label: string }): JSX.Element {
  // Preserve an already-set token that isn't in the current asset list (asset
  // deleted, or token from another source) — otherwise the <select> would show
  // blank and SAVING would silently drop the reference (code-review data-loss).
  const known = assets.some((a) => (a.serveToken ?? '') === value);
  return (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{label} (Media token)</span>
      {assets.length > 0 ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {!known && value ? <option value={value}>(current token)</option> : null}
          {assets.map((a) => <option key={a.assetId} value={a.serveToken ?? ''}>{a.name}</option>)}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste a media token" />
      )}
    </label>
  );
}

/** Section `data` is an open bag (`Record<string, unknown>`); coerce reads to string for inputs. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function SectionFields({ section, assets, onChange }: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const d = section.data;
  const set = (k: string, v: unknown): void => onChange({ ...d, [k]: v });
  switch (section.type) {
    case 'hero':
      return (
        <div className="u-grid u-gap-2">
          <label className="u-grid u-gap-1"><span className="u-label-sm">Heading</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Subheading</span><input value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <MediaTokenField value={str(d.imageToken)} assets={assets} onChange={(v) => set('imageToken', v)} label="Hero image" />
        </div>
      );
    case 'richText':
      return <label className="u-grid u-gap-1"><span className="u-label-sm">Text (markdown)</span><textarea rows={4} value={str(d.text)} onChange={(e) => set('text', e.target.value)} /></label>;
    case 'image':
      return (
        <div className="u-grid u-gap-2">
          <MediaTokenField value={str(d.token)} assets={assets} onChange={(v) => set('token', v)} label="Image" />
          <label className="u-grid u-gap-1"><span className="u-label-sm">Alt text</span><input value={str(d.alt)} onChange={(e) => set('alt', e.target.value)} /></label>
        </div>
      );
    case 'cta':
      return (
        <div className="u-grid u-gap-2">
          <label className="u-grid u-gap-1"><span className="u-label-sm">Label</span><input value={str(d.label)} onChange={(e) => set('label', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">URL</span><input value={str(d.url)} onChange={(e) => set('url', e.target.value)} placeholder="https://…" /></label>
        </div>
      );
    case 'columns': {
      const cols: { text: string }[] = Array.isArray(d.columns) ? d.columns : [];
      return (
        <div className="u-grid u-gap-2">
          {cols.map((c, i) => (
            <input key={i} value={c.text ?? ''} onChange={(e) => set('columns', cols.map((x, j) => (j === i ? { text: e.target.value } : x)))} placeholder={`Column ${i + 1}`} />
          ))}
          <button type="button" className="btn-ghost" onClick={() => set('columns', [...cols, { text: '' }])}><PlusIcon /> Add column</button>
        </div>
      );
    }
    default:
      return <span className="u-label-sm">Unknown section.</span>;
  }
}

function SectionPreview({ section }: { section: Section }): JSX.Element {
  const d = section.data;
  switch (section.type) {
    case 'hero':
      return (
        <div className="cms-hero-preview">
          {str(d.imageToken) ? <img src={assetUrl(str(d.imageToken))} alt="" className="cms-hero-img" /> : null}
          <strong className="cms-hero-heading">{str(d.heading)}</strong>
          {str(d.subheading) ? <span className="u-label-sm">{str(d.subheading)}</span> : null}
        </div>
      );
    case 'richText':
      // Backend-sanitized; rendered as text here (no dangerouslySetInnerHTML in the sample preview).
      return <p className="cms-richtext">{String(d.text ?? '')}</p>;
    case 'image':
      return str(d.token) ? <img src={assetUrl(str(d.token))} alt={str(d.alt)} className="cms-img" /> : <span className="u-label-sm">(no image)</span>;
    case 'cta':
      return <span className="chip chip--accent">{str(d.label)}{str(d.url) ? ` → ${str(d.url)}` : ''}</span>;
    case 'columns': {
      const cols: { text: string }[] = Array.isArray(d.columns) ? d.columns : [];
      return (
        <div className="cms-columns" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols.length)}, 1fr)` }}>
          {cols.map((c: { text: string }, i: number) => <div key={i} className="cms-column-cell">{c.text}</div>)}
        </div>
      );
    }
    default:
      return <span className="u-label-sm">Unknown section.</span>;
  }
}
