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

import { Button } from '../../ui/Button.js';
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
  const [orgsFailed, setOrgsFailed] = useState(false);
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
        // `listOrgs` is a companion read — a failure must not take the whole
        // knowledge panel down. But falling back to `[]` made the document
        // section render "create an organization first", instructing the user to
        // redo work that may already exist on the authority of a read that never
        // landed. Tracked separately so the empty state stays a real claim.
        const [v, o] = await Promise.all([
          getAgentKnowledge(rosterId),
          listOrgs().catch(() => { if (!cancelled) setOrgsFailed(true); return []; }),
        ]);
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
      {/* KB-UX-9 (closed 2026-09-03) — see the sibling note in
          `knowledge/SubjectKnowledgePanel.tsx`. `error` here is a raw
          `err.message` (`:78`, `:94`), so the announced text is a `t()`
          sentence and the wire string stays visible rather than spoken. */}
      {error ? <Notice variant="error" announce={t('errorAnnounce')}>{error}</Notice> : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}

      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="intro" values={{ persona }} components={[<span key="0" />, <strong key="1" />, <span key="2" />, <strong key="3" />]} />
      </p>

      <DocumentsSection
        view={view}
        orgs={orgs}
        orgsFailed={orgsFailed}
        persona={persona}
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
  view, orgs, orgsFailed, persona, onCreate, onIngest, onImport, onUnbind, onDeleteDoc,
}: {
  view: AgentKnowledgeView | null;
  orgs: Org[];
  /** ADR 0664 D2 — named in the audience disclosure, so it says WHICH agent. */
  persona: string;
  orgsFailed: boolean;
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

      {orgsFailed ? (
        // "Create an organization first" is a claim about what EXISTS; a read that
        // failed may not make it. The instruction would send the user to redo
        // work they may already have done.
        <Notice variant="error" announce={t('documentsOrgsFailed')}>{t('documentsOrgsFailed')}</Notice>
      ) : orgs.length === 0 ? (
        <Notice variant="info">{t('documentsCreateOrgFirst')}</Notice>
      ) : (
        <form
          className="surface-form u-mb-3"
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
          <Button variant="primary" type="submit" disabled={!name.trim() || !orgId || busy}>
            <PlusIcon size={14} /> {t('createCollection')}
          </Button>
        </form>
      )}

      {/*
        ADR 0664 D2 — the audience disclosure, on the door that actually grants.
        ADR 0643 R3 decided that a binding IS the grant: anyone who can address this agent
        may retrieve what is bound to it, and that access does not lapse with the binder's
        own. That decision stands; what was missing is that nobody was ever told. This panel
        had ZERO strings about who can see a bound corpus.
        Placed here rather than on a bind-existing control because there is no such control
        in the SPA — `bindCollection` has no importer; create-collection is the grant door.
      */}
      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="audienceDisclosure" values={{ persona }} components={[<strong key="0" />]} />
      </p>

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
        <Button variant="danger" onClick={() => { void confirm({ title: t('unbindConfirm', { name: col.name }), danger: true }).then((ok) => { if (ok) void onUnbind(); }); }}>
          {t('unbind')}
        </Button>
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
          <Button variant="primary" type="submit" disabled={!text.trim() || busy}>
            <PlusIcon size={14} /> {t('addDocument')}
          </Button>
        </div>
      </form>

      <form
        className="surface-form u-mt-2"
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
        <Button type="submit" variant="secondary" disabled={!driveRef.trim() || importing}>
          {t('importFromDrive')}
        </Button>
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
      {err ? <Notice variant="error" announce={err}>{err}</Notice> : null}
      <form
        className="surface-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim() || busy) return;
          setBusy(true);
          setErr(null);
          // Clear the previous answer BEFORE the request: a failure that left it
          // up would render the last query's chunks (or "No matches") under the
          // new question — the same stale-claim family as KB-UX-1.
          setResult(null);
          void retrieve(rosterId, query.trim())
            .then(setResult)
            .catch((e2) => { setResult(null); setErr(e2 instanceof Error ? e2.message : String(e2)); })
            .finally(() => setBusy(false));
        }}
      >
        <TextField label={t('queryLabel')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('queryPlaceholder')} containerStyle={{ minWidth: '18rem', flex: 1 }} />
        <Button type="submit" variant="secondary" disabled={!query.trim() || busy}><SearchIcon size={14} /> {t('retrieve')}</Button>
      </form>

      {/* KB-UX-3 — a source whose retrieval leg FAULTED is reported, never
          folded into "No matches". The partial notice sits above the results
          because it qualifies them: some of the corpus was not searched. */}
      {result && (result.failedSources?.length ?? 0) > 0 ? (
        <Notice variant="warning" announce={t('retrievePartial')}>
          {t('retrievePartial')}{' '}
          <span className="muted">{t('retrievePartialSources', { sources: result.failedSources!.map((s) => t(`retrieveSource_${s}`)).join(', ') })}</span>
        </Notice>
      ) : null}
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
        ) : (result.failedSources?.length ?? 0) > 0 ? null : (
          // Reachable ONLY from a retrieval where every source answered.
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
