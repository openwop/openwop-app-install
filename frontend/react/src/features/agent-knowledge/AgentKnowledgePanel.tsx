/**
 * Agent Knowledge panel (ADR 0038) — the per-agent knowledge & memory surface on
 * the agent workspace. Two honest source kinds under one mental model:
 *   - Documents (cited)   → a KB collection BOUND to the agent (ADR 0011). Create
 *     a collection, paste a document; chunks are embedded + retrievable WITH a
 *     source title to cite.
 *   - Notes / facts (recalled) → the agent's private RFC-0004 memory namespace.
 *     Gated on the "curated notes" toggle (`memoryWritable`); auto-recalled by
 *     dispatch every turn.
 *
 * A "Try a retrieval" box previews what the agent would recall for a query
 * (cited chunks + facts). Always-on since 2026-06-16 (graduated off the
 * `agent-knowledge` toggle, ADR 0038 § Correction); the backend is the authority
 * (every call is RBAC + IDOR + profile-policy gated, fail-closed).
 *
 * `ui/` cohesion: surface-card / chip / action-bar / Notice / StateCard / Field
 * + the Lucide icon set (no emoji-as-icon). NON-NORMATIVE host-ext config.
 */

import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import {
  getAgentKnowledge,
  createBoundCollection,
  unbindCollection,
  ingestText,
  importFromConnection,
  deleteDocument,
  setMemoryWritable,
  retrieve,
  listOrgs,
  type AgentKnowledgeView,
  type BoundCollection,
  type RetrieveResult,
  type Org,
} from './agentKnowledgeClient.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Field, TextField, SelectField } from '../../ui/Field.js';
import {
  DatabaseIcon, FileTextIcon, MessageSquareIcon, SearchIcon, PlusIcon, TrashIcon, SparklesIcon,
} from '../../ui/icons/index.js';

export function AgentKnowledgePanel({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [view, setView] = useState<AgentKnowledgeView | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const v = await getAgentKnowledge(rosterId);
    setView(v);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [v, o] = await Promise.all([getAgentKnowledge(rosterId), listOrgs().catch(() => [])]);
        if (cancelled) return;
        setView(v);
        setOrgs(o);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rosterId]);

  const run = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      setNotice(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <StateCard title={t('loadingKnowledge')} loading />;

  return (
    <div className="u-grid u-gap-4 agentknowledge-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="intro" values={{ persona }} components={[<span key="0" />, <strong key="1" />, <span key="2" />, <strong key="3" />]} />
      </p>

      <DocumentsSection
        view={view}
        orgs={orgs}
        onCreate={(orgId, name) => run(() => createBoundCollection(rosterId, orgId, name).then(() => undefined), t('collectionCreated'))}
        onIngest={(orgId, collectionId, title, text) => run(() => ingestText(rosterId, orgId, collectionId, title, text).then(() => undefined), t('documentIngested'))}
        onImport={(orgId, collectionId, ref) => run(() => importFromConnection(rosterId, orgId, collectionId, 'google', ref).then(() => undefined), t('importedFromDrive'))}
        onUnbind={(collectionId) => run(() => unbindCollection(rosterId, collectionId), t('collectionUnbound'))}
        onDeleteDoc={(orgId, collectionId, documentId) => run(() => deleteDocument(rosterId, orgId, collectionId, documentId), t('documentRemoved'))}
      />

      <NotesSection
        view={view}
        onToggleWritable={(writable) => run(() => setMemoryWritable(rosterId, writable).then(() => undefined), writable ? t('curatedNotesEnabled') : t('curatedNotesDisabled'))}
      />

      <RetrieveSection rosterId={rosterId} persona={persona} />
    </div>
  );
}

/* ───────────────────────────── documents ───────────────────────────── */

function DocumentsSection({
  view, orgs, onCreate, onIngest, onImport, onUnbind, onDeleteDoc,
}: {
  view: AgentKnowledgeView | null;
  orgs: Org[];
  onCreate: (orgId: string, name: string) => Promise<void>;
  onIngest: (orgId: string, collectionId: string, title: string, text: string) => Promise<void>;
  onImport: (orgId: string, collectionId: string, ref: string) => Promise<void>;
  onUnbind: (collectionId: string) => Promise<void>;
  onDeleteDoc: (orgId: string, collectionId: string, documentId: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const collections = view?.collections ?? [];

  useEffect(() => { if (!orgId && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId]);

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<FileTextIcon size={16} />} title={t('documentsTitle')} hint={t('documentsHint')} />

      {orgs.length === 0 ? (
        <Notice variant="info">{t('documentsCreateOrgFirst')}</Notice>
      ) : (
        <form
          className="action-bar u-gap-2 u-items-end u-wrap u-mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !orgId || busy) return;
            setBusy(true);
            void onCreate(orgId, name.trim()).finally(() => { setBusy(false); setName(''); });
          }}
        >
          <SelectField label={t('organizationLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)} containerStyle={{ minWidth: '12rem' }}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
          <TextField label={t('newCollectionNameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newCollectionNamePlaceholder')} containerStyle={{ minWidth: '14rem' }} />
          <button type="submit" className="primary" disabled={!name.trim() || !orgId || busy}>
            <PlusIcon size={14} /> {t('createCollection')}
          </button>
        </form>
      )}

      {collections.length === 0 ? (
        <p className="muted u-fs-13 u-m-0">{t('noDocumentsBound')}</p>
      ) : (
        <div className="u-grid u-gap-3">
          {collections.map((c) => (
            <CollectionCard
              key={c.collectionId}
              col={c}
              onIngest={(title, text) => onIngest(c.orgId, c.collectionId, title, text)}
              onImport={(ref) => onImport(c.orgId, c.collectionId, ref)}
              onUnbind={() => onUnbind(c.collectionId)}
              onDeleteDoc={(documentId) => onDeleteDoc(c.orgId, c.collectionId, documentId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionCard({
  col, onIngest, onImport, onUnbind, onDeleteDoc,
}: {
  col: BoundCollection;
  onIngest: (title: string, text: string) => Promise<void>;
  onImport: (ref: string) => Promise<void>;
  onUnbind: () => Promise<void>;
  onDeleteDoc: (documentId: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [driveRef, setDriveRef] = useState('');
  const [importing, setImporting] = useState(false);

  return (
    <div className="surface-card agentknowledge-inset agentknowledge-collection">
      <div className="action-bar u-justify-between u-items-center u-mb-2">
        <div className="u-flex u-items-center u-gap-2">
          <span className="muted u-flex u-items-center" aria-hidden="true"><DatabaseIcon size={14} /></span>
          <strong>{col.name}</strong>
          <span className="chip chip--muted">{t('docCount', { count: col.documentCount })}</span>
        </div>
        <button type="button" className="secondary u-text-danger" onClick={() => { void confirm({ title: t('unbindConfirm', { name: col.name }), danger: true }).then((ok) => { if (ok) void onUnbind(); }); }}>
          {t('unbind')}
        </button>
      </div>

      {col.documents.length > 0 ? (
        <ul className="u-list-none u-m-0 u-p-0 u-grid u-gap-1 u-mb-2">
          {col.documents.map((d) => (
            <li key={d.documentId} className="action-bar u-justify-between u-items-center">
              <span className="u-fs-13 u-flex u-items-center u-gap-1">
                <span className="muted u-flex" aria-hidden="true"><FileTextIcon size={12} /></span> {d.title}
                {d.contentTrust === 'untrusted' ? (
                  <span className="chip chip--warning u-fs-12" title={t('externalUnverifiedTitle')}>{t('externalUnverified')}</span>
                ) : null}
                <span className="muted u-fs-12">{t('chunkCount', { count: d.chunkCount })}</span>
              </span>
              <button type="button" className="icon-button" aria-label={t('removeDocumentLabel', { title: d.title })} title={t('removeDocumentTitle')} onClick={() => { void confirm({ title: t('removeDocumentConfirm', { title: d.title }), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) void onDeleteDoc(d.documentId); }); }}>
                <TrashIcon size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="u-grid u-gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          void onIngest(title.trim() || t('untitledDocument'), text.trim()).finally(() => { setBusy(false); setTitle(''); setText(''); });
        }}
      >
        <TextField label={t('documentTitleLabel')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('documentTitlePlaceholder')} />
        <Field label={t('documentTextLabel')} help={t('documentTextHelp')}>
          {(w) => <textarea {...w} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('documentTextPlaceholder')} />}
        </Field>
        <div className="action-bar">
          <button type="submit" className="primary" disabled={!text.trim() || busy}>
            <PlusIcon size={14} /> {t('addDocument')}
          </button>
        </div>
      </form>

      <form
        className="action-bar u-gap-2 u-items-end u-wrap u-mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!driveRef.trim() || importing) return;
          setImporting(true);
          void onImport(driveRef.trim()).finally(() => { setImporting(false); setDriveRef(''); });
        }}
      >
        <TextField
          label={t('importFromDriveLabel')}
          value={driveRef}
          onChange={(e) => setDriveRef(e.target.value)}
          placeholder={t('importFromDrivePlaceholder')}
          containerStyle={{ minWidth: '18rem' }}
        />
        <button type="submit" className="secondary" disabled={!driveRef.trim() || importing}>
          {t('importFromDrive')}
        </button>
      </form>
      <p className="muted u-fs-12 u-m-0 u-mt-1">{t('importFromDriveHint')}</p>
    </div>
  );
}

/* ───────────────────────────── notes ───────────────────────────── */

function NotesSection({
  view, onToggleWritable,
}: {
  view: AgentKnowledgeView | null;
  onToggleWritable: (writable: boolean) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const writable = view?.memoryWritable ?? false;

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<MessageSquareIcon size={16} />} title={t('notesTitle')} hint={t('notesHint')} />

      <label className="action-bar u-items-center u-gap-2 u-mb-3">
        <input type="checkbox" checked={writable} onChange={(e) => void onToggleWritable(e.target.checked)} />
        <span className="u-fs-13">{t('allowCuratedNotes')}</span>
        <span className={`chip ${writable ? 'chip--success' : 'chip--muted'}`}>{writable ? t('enabled') : t('disabled')}</span>
      </label>

      {/* ADR 0041 — browse/add/remove the actual memories in the Memory tab; this
          section keeps only the recall opt-in (whether dispatch may recall them). */}
      <p className="muted u-fs-13 u-m-0">
        {writable
          ? <Trans t={t} i18nKey="notesStored" count={view?.noteCount ?? 0} components={[<span key="0" />, <strong key="1" />]} />
          : <Trans t={t} i18nKey="notesEnablePrompt" components={[<span key="0" />, <strong key="1" />]} />}
      </p>
    </div>
  );
}

/* ───────────────────────────── retrieve preview ───────────────────────────── */

function RetrieveSection({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element {
  const { t } = useTranslation('agent-knowledge');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RetrieveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<SparklesIcon size={16} />} title={t('retrieveTitle')} hint={t('retrieveHint', { persona })} />
      {err ? <Notice variant="error">{err}</Notice> : null}
      <form
        className="action-bar u-gap-2 u-items-end u-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim() || busy) return;
          setBusy(true);
          setErr(null);
          void retrieve(rosterId, query.trim())
            .then(setResult)
            .catch((e2) => setErr(e2 instanceof Error ? e2.message : String(e2)))
            .finally(() => setBusy(false));
        }}
      >
        <TextField label={t('queryLabel')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('queryPlaceholder')} containerStyle={{ minWidth: '18rem', flex: 1 }} />
        <button type="submit" className="secondary" disabled={!query.trim() || busy}><SearchIcon size={14} /> {t('retrieve')}</button>
      </form>

      {result ? (
        result.hasResults ? (
          <ul className="u-list-none u-m-0 u-p-0 u-grid u-gap-2 u-mt-3">
            {result.chunks.map((c, i) => (
              <li key={i} className="surface-card agentknowledge-inset u-fs-13">
                {c.kind === 'kb' && c.title ? <span className="chip chip--accent u-mb-1">{c.title}</span> : <span className="chip chip--muted u-mb-1">{t('retrieveNoteChip')}</span>}
                {c.contentTrust === 'untrusted' ? <span className="chip chip--warning u-mb-1 u-ml-1" title={t('retrieveExternalTitle')}>{t('retrieveExternalChip')}</span> : null}
                <div>{c.content}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted u-fs-13 u-mt-3 u-mb-0">{t('retrieveNoMatches')}</p>
        )
      ) : null}
    </div>
  );
}

function SectionHead({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }): JSX.Element {
  return (
    <div className="agentknowledge-section-head u-mb-3">
      <span className="muted" aria-hidden="true">{icon}</span>
      <div>
        <div className="u-fw-600">{title}</div>
        {hint ? <div className="muted u-fs-12">{hint}</div> : null}
      </div>
    </div>
  );
}
