/**
 * Shared CMS sections editor (ADR 0027) — the section list + per-section fields +
 * add/move/remove controls, extracted from CmsPage so BOTH the org-scoped CMS
 * page editor AND the host-level home-page editor (Admin → Content → Front page)
 * use ONE editor. It's a controlled component: give it `sections` + `onChange`.
 */
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { SECTION_TYPES, type MediaAssetRef, type Section, type SectionType } from './cmsClient.js';

function blankSection(type: SectionType): Section {
  const data: Record<string, unknown> =
    type === 'hero' ? { heading: '' }
      : type === 'richText' ? { text: '' }
        : type === 'image' ? { token: '' }
          : type === 'cta' ? { label: '', url: '' }
            : { columns: [{ text: '' }] };
  return { sectionId: `new:${Math.random().toString(36).slice(2)}`, type, data };
}

/** Section `data` is an open bag; coerce reads to string for inputs. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function MediaTokenField({ value, assets, onChange, label }: { value: string; assets: MediaAssetRef[]; onChange: (v: string) => void; label: string }): JSX.Element {
  // Preserve an already-set token absent from the current asset list (deleted /
  // foreign token) — else the <select> blanks and SAVING drops the reference.
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

/** A mono "eyebrow" + serif "heading" shared by marketing-block sections. */
function HeadFields({ d, set }: { d: Record<string, unknown>; set: (k: string, v: unknown) => void }): JSX.Element {
  return (
    <>
      <label className="u-grid u-gap-1"><span className="u-label-sm">Eyebrow (small mono label)</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder="The platform" /></label>
      <label className="u-grid u-gap-1"><span className="u-label-sm">Heading</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
    </>
  );
}

function SectionFields({ section, assets, onChange }: { section: Section; assets: MediaAssetRef[]; onChange: (data: Record<string, unknown>) => void }): JSX.Element {
  const d = section.data;
  const set = (k: string, v: unknown): void => onChange({ ...d, [k]: v });
  switch (section.type) {
    case 'hero':
      return (
        <div className="u-grid u-gap-2">
          <label className="u-grid u-gap-1"><span className="u-label-sm">Eyebrow</span><input value={str(d.eyebrow)} onChange={(e) => set('eyebrow', e.target.value)} placeholder="Open protocol · v1.1" /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Heading</span><input value={str(d.heading)} onChange={(e) => set('heading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Subheading (supports **markdown**)</span><textarea rows={2} value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <div className="u-grid u-gap-1 u-grid-2">
            <input value={str(d.ctaLabel)} onChange={(e) => set('ctaLabel', e.target.value)} placeholder="Primary button label" />
            <input value={str(d.ctaUrl)} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="/agents or https://…" />
            <input value={str(d.ctaLabel2)} onChange={(e) => set('ctaLabel2', e.target.value)} placeholder="Secondary button label" />
            <input value={str(d.ctaUrl2)} onChange={(e) => set('ctaUrl2', e.target.value)} placeholder="https://…" />
          </div>
          <MediaTokenField value={str(d.imageToken)} assets={assets} onChange={(v) => set('imageToken', v)} label="Hero image" />
        </div>
      );
    case 'richText':
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">Text (markdown: **bold**, *italic*, `code`, [link](url))</span><textarea rows={5} value={str(d.text)} onChange={(e) => set('text', e.target.value)} /></label>
        </div>
      );
    case 'image':
      return (
        <div className="u-grid u-gap-2">
          <MediaTokenField value={str(d.token)} assets={assets} onChange={(v) => set('token', v)} label="Image" />
          <label className="u-grid u-gap-1"><span className="u-label-sm">Alt text</span><input value={str(d.alt)} onChange={(e) => set('alt', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Caption</span><input value={str(d.caption)} onChange={(e) => set('caption', e.target.value)} /></label>
        </div>
      );
    case 'cta':
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1"><span className="u-label-sm">Subheading</span><input value={str(d.subheading)} onChange={(e) => set('subheading', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Button label</span><input value={str(d.label)} onChange={(e) => set('label', e.target.value)} /></label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">Button URL</span><input value={str(d.url)} onChange={(e) => set('url', e.target.value)} placeholder="/agents or https://…" /></label>
        </div>
      );
    case 'columns': {
      const cols: { title?: string; text?: string }[] = Array.isArray(d.columns) ? d.columns : [];
      const setCol = (i: number, patch: Record<string, string>): void =>
        set('columns', cols.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="u-grid u-gap-2">
          <HeadFields d={d} set={set} />
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">Layout</span>
            <select value={str(d.layout) || 'cards'} onChange={(e) => set('layout', e.target.value)}>
              <option value="cards">Cards (feature grid)</option>
              <option value="steps">Steps (numbered)</option>
              <option value="stats">Stats (value + label)</option>
            </select>
          </label>
          {cols.map((c, i) => (
            <div key={i} className="surface-card u-grid u-gap-1 u-p-2">
              <input value={c.title ?? ''} onChange={(e) => setCol(i, { title: e.target.value })} placeholder={`Item ${i + 1} title / stat value`} />
              <textarea rows={2} value={c.text ?? ''} onChange={(e) => setCol(i, { text: e.target.value })} placeholder="Body / label" />
              <button type="button" className="btn-ghost u-w-auto" onClick={() => set('columns', cols.filter((_, j) => j !== i))} aria-label="Remove item"><TrashIcon /> Remove</button>
            </div>
          ))}
          <button type="button" className="btn-ghost u-w-auto" onClick={() => set('columns', [...cols, { title: '', text: '' }])}><PlusIcon /> Add item</button>
        </div>
      );
    }
    default:
      return <span className="u-label-sm">Unknown section.</span>;
  }
}

export function SectionsEditor({ sections, assets, onChange }: {
  sections: Section[];
  assets: MediaAssetRef[];
  onChange: (sections: Section[]) => void;
}): JSX.Element {
  const patch = (i: number, data: Record<string, unknown>): void => onChange(sections.map((s, j) => (j === i ? { ...s, data } : s)));
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const a = sections[i];
    const b = sections[j];
    if (!a || !b) return;
    const next = [...sections];
    next[i] = b;
    next[j] = a;
    onChange(next);
  };
  const remove = (i: number): void => onChange(sections.filter((_, j) => j !== i));
  const add = (type: SectionType): void => onChange([...sections, blankSection(type)]);
  return (
    <div className="u-grid u-gap-2">
      {sections.map((s, i) => (
        <div key={s.sectionId} className="surface-card u-gap-2 u-p-3">
          <div className="u-flex u-gap-1 u-items-center">
            <span className="chip chip--accent">{s.type}</span>
            <span className="u-flex-1" />
            <button type="button" className="btn-ghost" onClick={() => move(i, -1)} aria-label="Move up">↑</button>
            <button type="button" className="btn-ghost" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            <button type="button" className="btn-ghost" onClick={() => remove(i)} aria-label="Remove section"><TrashIcon /></button>
          </div>
          <SectionFields section={s} assets={assets} onChange={(data) => patch(i, data)} />
        </div>
      ))}
      <div className="action-bar">
        <select aria-label="Add section" defaultValue="" onChange={(e) => { if (e.target.value) { add(e.target.value as SectionType); e.target.value = ''; } }} className="u-w-auto">
          <option value="">+ Add section…</option>
          {SECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </div>
  );
}
