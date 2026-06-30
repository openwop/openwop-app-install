/**
 * SubjectKnowledgePanel (ADR 0046 follow-on) — the ONE knowledge-curation browser
 * for every subject. Create/bind a KB collection, ingest a text document, remove
 * one, and search the corpus (documents + the subject's memory, via the shared
 * composition). Subject-agnostic: it takes a `client` (the CRUD/retrieve calls)
 * and `copy` (subject-flavored labels), so the SAME UI serves a person's profile
 * (My Profile → Knowledge) and a project (Project → Knowledge) — the visible
 * counterpart of the one backend seam.
 *
 * `ui/` cohesion: surface-card / Field / chip / Notice / StateCard / icons; tokens only.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Field, TextField, SelectField } from '../ui/Field.js';
import { DatabaseIcon, FileTextIcon, LockIcon, SearchIcon, PlusIcon, TrashIcon } from '../ui/icons/index.js';

export interface KnowledgeDoc { documentId: string; title: string; contentTrust?: 'trusted' | 'untrusted' }
export interface KnowledgeCollection { collectionId: string; orgId: string; name: string; documentCount: number; documents: KnowledgeDoc[]; managed?: 'strategy' | 'priority-matrix' }
export interface KnowledgeOrg { orgId: string; name: string }
export interface KnowledgeRetrieveResult { hasResults: boolean; chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }> }

/** The subject-agnostic operations the panel drives. */
export interface SubjectKnowledgeClient {
  getKnowledge: () => Promise<{ collections: KnowledgeCollection[] }>;
  listOrgs: () => Promise<KnowledgeOrg[]>;
  createCollection: (orgId: string, name: string) => Promise<{ collections: KnowledgeCollection[] }>;
  unbindCollection: (collectionId: string) => Promise<void>;
  ingestText: (orgId: string, collectionId: string, title: string, text: string) => Promise<{ collections: KnowledgeCollection[] }>;
  deleteDocument: (orgId: string, collectionId: string, documentId: string) => Promise<void>;
  retrieve: (query: string) => Promise<KnowledgeRetrieveResult>;
}

export interface SubjectKnowledgeCopy {
  intro: React.ReactNode;
  emptyBody: string;
  searchTitle: string;
  searchPlaceholder: string;
}

export function SubjectKnowledgePanel({ client, copy, readOnly = false }: { client: SubjectKnowledgeClient; copy: SubjectKnowledgeCopy; readOnly?: boolean }): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [view, setView] = useState<{ collections: KnowledgeCollection[] } | null>(null);
  const [orgs, setOrgs] = useState<KnowledgeOrg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [v, o] = await Promise.all([client.getKnowledge(), client.listOrgs().catch(() => [])]);
        if (!cancelled) { setView(v); setOrgs(o); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : t('loadError')); }
    })();
    return () => { cancelled = true; };
  }, [client, t]);

  const run = async (op: () => Promise<{ collections: KnowledgeCollection[] } | void>, ok: string): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await op();
      setView(next ?? await client.getKnowledge());
      setNotice(ok);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionError')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-4">
      <p className="muted u-fs-13 u-m-0">{copy.intro}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {readOnly ? null : (
        <CreateSource orgs={orgs} busy={busy} onCreate={(orgId, name) => run(() => client.createCollection(orgId, name), t('sourceCreated'))} />
      )}

      {view === null ? (
        <StateCard icon={<DatabaseIcon size={20} />} title={t('loadingTitle')} loading />
      ) : view.collections.length === 0 ? (
        <StateCard icon={<DatabaseIcon size={20} />} title={t('emptyTitle')} body={copy.emptyBody} />
      ) : (
        view.collections.map((col) => (
          <CollectionCard
            key={col.collectionId}
            col={col}
            busy={busy}
            readOnly={readOnly}
            onIngest={(title, text) => run(() => client.ingestText(col.orgId, col.collectionId, title, text), t('documentAdded'))}
            onDeleteDoc={(documentId) => run(() => client.deleteDocument(col.orgId, col.collectionId, documentId).then(() => undefined), t('documentRemoved'))}
            onUnbind={() => run(() => client.unbindCollection(col.collectionId).then(() => undefined), t('sourceUnbound'))}
          />
        ))
      )}

      <RetrieveSection busy={busy} client={client} copy={copy} />
    </div>
  );
}

function CreateSource({ orgs, busy, onCreate }: { orgs: KnowledgeOrg[]; busy: boolean; onCreate: (orgId: string, name: string) => void }): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const effectiveOrg = orgId || orgs[0]?.orgId || '';
  return (
    <form
      className="surface-card surface-form"
      onSubmit={(e) => { e.preventDefault(); if (!effectiveOrg || !name.trim() || busy) return; onCreate(effectiveOrg, name.trim()); setName(''); }}
    >
      <SelectField label={t('workspaceLabel')} value={effectiveOrg} onChange={(e) => setOrgId(e.target.value)}>
        {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </SelectField>
      <TextField label={t('newSourceLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newSourcePlaceholder')} />
      <button type="submit" className="primary" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createSource')}</button>
    </form>
  );
}

function CollectionCard({ col, busy, readOnly, onIngest, onDeleteDoc, onUnbind }: {
  col: KnowledgeCollection; busy: boolean; readOnly: boolean;
  onIngest: (title: string, text: string) => void;
  onDeleteDoc: (documentId: string) => void;
  onUnbind: () => void;
}): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  // A managed collection's CONTENT is synced (read-only); binding (unbind) stays.
  const contentReadOnly = readOnly || !!col.managed;
  return (
    <div className="surface-card u-flex u-flex-col u-gap-3">
      <div className="action-bar u-justify-between u-items-center">
        <span className="u-flex u-items-center u-gap-2"><DatabaseIcon size={16} /> <strong>{col.name}</strong>
          {col.managed ? <span className="chip chip--muted" title={t('syncedTitle', { source: t(`syncedSource_${col.managed}`) })}><LockIcon size={12} /> {t('syncedBadge')}</span> : null}
          <span className="chip chip--muted">{t('docCount', { count: col.documentCount })}</span></span>
        {readOnly ? null : <button type="button" className="ghost" disabled={busy} onClick={onUnbind}>{t('unbind')}</button>}
      </div>
      {col.managed ? <Notice variant="info">{t('syncedNotice', { source: t(`syncedSource_${col.managed}`) })}</Notice> : null}

      {col.documents.length > 0 ? (
        <ul className="u-flex u-flex-col u-gap-1 u-m-0 u-p-0" style={{ listStyle: 'none' }}>
          {col.documents.map((d) => (
            <li key={d.documentId} className="action-bar u-justify-between u-items-center">
              <span className="u-flex u-items-center u-gap-2"><FileTextIcon size={14} /> {d.title}
                {d.contentTrust === 'untrusted' ? <span className="chip chip--warning u-fs-12" title={t('externalUnverifiedTitle')}>{t('externalUnverified')}</span> : null}
              </span>
              {contentReadOnly ? null : <button type="button" className="ghost" aria-label={t('removeDocument')} title={t('removeDocument')} disabled={busy} onClick={() => onDeleteDoc(d.documentId)}><TrashIcon size={14} /></button>}
            </li>
          ))}
        </ul>
      ) : null}

      {contentReadOnly ? null : (
        <form
          className="u-flex u-flex-col u-gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!title.trim() || !text.trim() || busy) return; onIngest(title.trim(), text.trim()); setTitle(''); setText(''); }}
        >
          <TextField label={t('documentTitleLabel')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('documentTitlePlaceholder')} />
          <Field label={t('documentTextLabel')}>
            {(w) => <textarea {...w} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('documentTextPlaceholder')} />}
          </Field>
          <div className="action-bar u-justify-end">
            <button type="submit" className="primary" disabled={!title.trim() || !text.trim() || busy}><PlusIcon size={14} /> {t('addDocument')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function RetrieveSection({ busy, client, copy }: { busy: boolean; client: SubjectKnowledgeClient; copy: SubjectKnowledgeCopy }): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeRetrieveResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="surface-card u-flex u-flex-col u-gap-2">
      <span className="u-flex u-items-center u-gap-2"><SearchIcon size={16} /> <strong>{copy.searchTitle}</strong></span>
      {err ? <Notice variant="error">{err}</Notice> : null}
      <form
        className="action-bar u-gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim() || searching || busy) return;
          setSearching(true); setErr(null);
          void client.retrieve(query.trim()).then(setResult).catch((x) => setErr(x instanceof Error ? x.message : t('searchError'))).finally(() => setSearching(false));
        }}
      >
        <input type="search" aria-label={copy.searchTitle} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.searchPlaceholder} />
        <button type="submit" className="primary" aria-busy={searching} disabled={!query.trim() || searching || busy}>
          <SearchIcon size={14} /> {searching ? t('searching') : t('common:search')}
        </button>
      </form>
      {result ? (
        result.hasResults ? (
          <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0" style={{ listStyle: 'none' }}>
            {result.chunks.map((c, i) => (
              <li key={i} className="surface-card u-flex u-flex-col u-gap-1">
                <span className="u-flex u-items-center u-gap-1">
                  {c.kind === 'kb' && c.title ? <span className="chip chip--accent">{c.title}</span> : <span className="chip chip--muted">{t('note')}</span>}
                  {c.contentTrust === 'untrusted' ? <span className="chip chip--warning u-fs-12">{t('external')}</span> : null}
                </span>
                <span className="u-fs-14">{c.content}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted u-fs-13 u-m-0">{t('noMatches')}</p>
      ) : null}
    </div>
  );
}
