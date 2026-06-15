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
 * (cited chunks + facts). Self-gates on the `agent-knowledge` toggle via
 * useFeatureAccess; the backend is the authority (every call is RBAC + IDOR +
 * profile-policy gated, fail-closed).
 *
 * `ui/` cohesion: surface-card / chip / action-bar / Notice / StateCard / Field
 * + the Lucide icon set (no emoji-as-icon). NON-NORMATIVE host-ext config.
 */

import { useEffect, useState } from 'react';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  getAgentKnowledge,
  createBoundCollection,
  unbindCollection,
  ingestText,
  importFromConnection,
  deleteDocument,
  setMemoryWritable,
  addNote,
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
  const access = useFeatureAccess('agent-knowledge');
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
    if (access.loading || !access.enabled) { setLoading(false); return undefined; }
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
  }, [rosterId, access.loading, access.enabled]);

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

  if (access.loading || loading) return <StateCard title="Loading knowledge…" loading />;

  if (!access.enabled) {
    return (
      <StateCard
        icon={<DatabaseIcon size={20} />}
        title="Agent Knowledge is not enabled"
        body="Turn on the Agent Knowledge feature for this workspace to give this agent its own documents and facts."
      />
    );
  }

  return (
    <div className="u-grid u-gap-4 agentknowledge-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <p className="muted u-fs-13 u-m-0">
        Give {persona} its own knowledge: <strong>documents</strong> it can cite, and private{' '}
        <strong>notes &amp; facts</strong> it recalls each turn. Host-local config — not the agent's protocol manifest.
      </p>

      <DocumentsSection
        view={view}
        orgs={orgs}
        onCreate={(orgId, name) => run(() => createBoundCollection(rosterId, orgId, name).then(() => undefined), 'Collection created and bound.')}
        onIngest={(orgId, collectionId, title, text) => run(() => ingestText(rosterId, orgId, collectionId, title, text).then(() => undefined), 'Document ingested.')}
        onImport={(orgId, collectionId, ref) => run(() => importFromConnection(rosterId, orgId, collectionId, 'google', ref).then(() => undefined), 'Imported from Google Drive.')}
        onUnbind={(collectionId) => run(() => unbindCollection(rosterId, collectionId), 'Collection unbound.')}
        onDeleteDoc={(orgId, collectionId, documentId) => run(() => deleteDocument(rosterId, orgId, collectionId, documentId), 'Document removed.')}
      />

      <NotesSection
        view={view}
        onToggleWritable={(writable) => run(() => setMemoryWritable(rosterId, writable).then(() => undefined), writable ? 'Curated notes enabled.' : 'Curated notes disabled.')}
        onAddNote={(content) => run(() => addNote(rosterId, content).then(() => undefined), 'Note added.')}
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
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const collections = view?.collections ?? [];

  useEffect(() => { if (!orgId && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId]);

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<FileTextIcon size={16} />} title="Documents" hint="Bound knowledge collections — chunked, embedded, and cited when recalled." />

      {orgs.length === 0 ? (
        <Notice variant="info">Create an organization first to hold this agent&apos;s documents.</Notice>
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
          <SelectField label="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)} containerStyle={{ minWidth: '12rem' }}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
          <TextField label="New collection name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Account playbook" containerStyle={{ minWidth: '14rem' }} />
          <button type="submit" className="primary" disabled={!name.trim() || !orgId || busy}>
            <PlusIcon size={14} /> Create collection
          </button>
        </form>
      )}

      {collections.length === 0 ? (
        <p className="muted u-fs-13 u-m-0">No documents bound yet. Create a collection, then add a document below.</p>
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
          <span className="chip chip--muted">{col.documentCount} doc{col.documentCount === 1 ? '' : 's'}</span>
        </div>
        <button type="button" className="secondary u-text-danger" onClick={() => { if (window.confirm(`Unbind "${col.name}" from this agent? The collection itself is kept.`)) void onUnbind(); }}>
          Unbind
        </button>
      </div>

      {col.documents.length > 0 ? (
        <ul className="u-list-none u-m-0 u-p-0 u-grid u-gap-1 u-mb-2">
          {col.documents.map((d) => (
            <li key={d.documentId} className="action-bar u-justify-between u-items-center">
              <span className="u-fs-13 u-flex u-items-center u-gap-1">
                <span className="muted u-flex" aria-hidden="true"><FileTextIcon size={12} /></span> {d.title}
                {d.contentTrust === 'untrusted' ? (
                  <span className="chip chip--warning u-fs-12" title="Imported from an external source (e.g. Google Drive or a trigger). Treated as untrusted — fenced when the agent reads it, never followed as instructions (ADR 0038 §C).">External · unverified</span>
                ) : null}
                <span className="muted u-fs-12">· {d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'}</span>
              </span>
              <button type="button" className="icon-button" aria-label={`Remove ${d.title}`} title="Remove document" onClick={() => { if (window.confirm(`Remove "${d.title}"?`)) void onDeleteDoc(d.documentId); }}>
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
          void onIngest(title.trim() || 'Untitled', text.trim()).finally(() => { setBusy(false); setTitle(''); setText(''); });
        }}
      >
        <TextField label="Document title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Q3 account notes" />
        <Field label="Document text" help="Pasted text is chunked + embedded for cited retrieval.">
          {(w) => <textarea {...w} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the document content…" />}
        </Field>
        <div className="action-bar">
          <button type="submit" className="primary" disabled={!text.trim() || busy}>
            <PlusIcon size={14} /> Add document
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
          label="Import from Google Drive"
          value={driveRef}
          onChange={(e) => setDriveRef(e.target.value)}
          placeholder="https://docs.google.com/document/d/…"
          containerStyle={{ minWidth: '18rem' }}
        />
        <button type="submit" className="secondary" disabled={!driveRef.trim() || importing}>
          Import from Drive
        </button>
      </form>
      <p className="muted u-fs-12 u-m-0 u-mt-1">Paste a Drive/Docs link — imported with citation. Requires a connected Google account.</p>
    </div>
  );
}

/* ───────────────────────────── notes ───────────────────────────── */

function NotesSection({
  view, onToggleWritable, onAddNote,
}: {
  view: AgentKnowledgeView | null;
  onToggleWritable: (writable: boolean) => Promise<void>;
  onAddNote: (content: string) => Promise<void>;
}): JSX.Element {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const writable = view?.memoryWritable ?? false;

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<MessageSquareIcon size={16} />} title="Notes & facts" hint="Private to this agent; recalled automatically each turn (not cited)." />

      <label className="action-bar u-items-center u-gap-2 u-mb-3">
        <input type="checkbox" checked={writable} onChange={(e) => void onToggleWritable(e.target.checked)} />
        <span className="u-fs-13">Allow curated notes for this agent</span>
        <span className={`chip ${writable ? 'chip--success' : 'chip--muted'}`}>{writable ? 'enabled' : 'disabled'}</span>
      </label>

      {writable ? (
        <form
          className="u-grid u-gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim() || busy) return;
            setBusy(true);
            void onAddNote(note.trim()).finally(() => { setBusy(false); setNote(''); });
          }}
        >
          <Field label="Add a note or fact">
            {(w) => <textarea {...w} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The CFO prefers Friday status updates." />}
          </Field>
          <div className="action-bar u-justify-between u-items-center">
            <span className="muted u-fs-12">{view?.noteCount ?? 0} note{(view?.noteCount ?? 0) === 1 ? '' : 's'} stored</span>
            <button type="submit" className="primary" disabled={!note.trim() || busy}><PlusIcon size={14} /> Add note</button>
          </div>
        </form>
      ) : (
        <p className="muted u-fs-13 u-m-0">Enable curated notes to add private facts this agent will recall.</p>
      )}
    </div>
  );
}

/* ───────────────────────────── retrieve preview ───────────────────────────── */

function RetrieveSection({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RetrieveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="surface-card agentknowledge-card">
      <SectionHead icon={<SparklesIcon size={16} />} title="Try a retrieval" hint={`Preview what ${persona} would recall for a query.`} />
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
        <TextField label="Query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What do we know about the account?" containerStyle={{ minWidth: '18rem', flex: 1 }} />
        <button type="submit" className="secondary" disabled={!query.trim() || busy}><SearchIcon size={14} /> Retrieve</button>
      </form>

      {result ? (
        result.hasResults ? (
          <ul className="u-list-none u-m-0 u-p-0 u-grid u-gap-2 u-mt-3">
            {result.chunks.map((c, i) => (
              <li key={i} className="surface-card agentknowledge-inset u-fs-13">
                {c.kind === 'kb' && c.title ? <span className="chip chip--accent u-mb-1">{c.title}</span> : <span className="chip chip--muted u-mb-1">note</span>}
                {c.contentTrust === 'untrusted' ? <span className="chip chip--warning u-mb-1 u-ml-1" title="Untrusted external content — fenced when the agent reads it (ADR 0038 §C).">external</span> : null}
                <div>{c.content}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted u-fs-13 u-mt-3 u-mb-0">No matches — add documents or notes above.</p>
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
