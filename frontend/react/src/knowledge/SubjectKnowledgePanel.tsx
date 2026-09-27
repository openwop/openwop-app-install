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

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { useOrgSelection } from '../ui/useOrgSelection.js';

import { confirm } from '../ui/confirm.js';import { StateCard } from '../ui/StateCard.js';
import { Field, TextField, SelectField } from '../ui/Field.js';
import { DatabaseIcon, FileTextIcon, LockIcon, SearchIcon, PlusIcon, TrashIcon } from '../ui/icons/index.js';

export interface KnowledgeDoc { documentId: string; title: string; contentTrust?: 'trusted' | 'untrusted' }
export interface KnowledgeCollection { collectionId: string; orgId: string; name: string; documentCount: number; documents: KnowledgeDoc[]; managed?: 'strategy' | 'priority-matrix' }
export interface KnowledgeOrg { orgId: string; name: string }
/** `failedSources` (ADR 0583 / KB-UX-3) — the sources whose retrieval leg
 *  FAULTED server-side. The composition swallows those so a live turn survives,
 *  which made `hasResults:false` the same value an empty corpus produces: this
 *  panel rendered an internal error as "No matches", on `/profile` and on every
 *  project. Non-empty ⇒ PARTIAL, and the panel says so instead of claiming
 *  absence. The SPA could not fix this alone; the lie was made on the server. */
export interface KnowledgeRetrieveResult { hasResults: boolean; chunks: Array<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>; failedSources?: Array<'kb' | 'memory'> }

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
  /** ADR 0666 D6 (`PKWF-8`) — OPTIONAL audience disclosure, rendered at the CREATE door.
   *
   *  A slot rather than a fixed string because the audience differs per consumer: a PROJECT
   *  corpus is membership-scoped, a PERSONAL one is not (its collection carries no
   *  `boundSubject`, so org scope is the whole rule). Omitting it keeps every existing consumer
   *  unchanged; supplying a wrong sentence would be worse than none.
   *
   *  Placed here, next to the control that MAKES the collection, for the reason ADR 0664 D2
   *  paid to learn on the agent lane: that is the door where the grant actually happens, and
   *  copy on a bind-existing control would have been shown to nobody. */
  createAudience?: string;
}

export function SubjectKnowledgePanel({ client, copy, readOnly = false }: { client: SubjectKnowledgeClient; copy: SubjectKnowledgeCopy; readOnly?: boolean }): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [view, setView] = useState<{ collections: KnowledgeCollection[] } | null>(null);
  // FRGATE-5 — was `useState<KnowledgeOrg[]>([])` fed by
  // `client.listOrgs().catch(() => [])`, so a FAILED workspace read was
  // indistinguishable from "you have no workspaces": the select rendered with no
  // options, `effectiveOrg` fell to '', and Create sat permanently disabled with
  // nothing on screen saying why. A dead control is worse than a wrong sentence.
  //
  // `useOrgSelection` already owns exactly this — it keeps `orgs: null` until the
  // read RESOLVES (never `[]` as a failure sentinel), exposes `orgsFailed` and a
  // `retry`, and carries a cancellation guard this panel hand-rolled. It takes the
  // lister as its FIRST ARGUMENT, so the injected `client` fits without change;
  // I had assumed it would not, and that assumption was wrong.
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection<KnowledgeOrg>(client.listOrgs);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Orgs are now loaded by `useOrgSelection` on its own effect, so this
        // read stands alone. Fan-out is unchanged — `Promise.all` of two
        // promises was already two requests — but the two can now resolve in
        // either order, so nothing below may assume orgs are present when the
        // knowledge view arrives. Verified: the only consumer is `CreateSource`,
        // which renders from `orgs` independently.
        const v = await client.getKnowledge();
        if (!cancelled) setView(v);
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
      {/* KB-UX-9 (closed 2026-09-03) — the sibling half of the Knowledge Base
          announcement pass. This Notice reports BOTH the failed knowledge read
          (`:83`) and a failed attach/detach (`:94`), and it carried no
          `announce`, so an assistive-tech user got nothing on either. The
          announced string is a `t()` sentence rather than `error` itself:
          `error` can be the server's own prose, which is exactly what
          `ui/Notice.tsx` says the string parameter exists to keep out of the
          live region. The detail stays on screen, unchanged. */}
      {error ? <Notice variant="error" announce={t('errorAnnounce')}>{error}</Notice> : null}
      {/* FRGATE-5 — the panel already owned an error Notice, but it was wired only
          to `run()` (the MUTATION helper). The workspace read failed silently into
          `[]`, so the create form's only signal was a disabled button. `announce`
          is required, not decoration: `variant="warning"` renders role="status",
          and a polite region that arrives complete announces nothing. */}
      {orgsFailed ? (
        <Notice variant="warning" announce={t('orgsFailed')}>
          {t('orgsFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={retryOrgs}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}

      {readOnly ? null : (
        <CreateSource
          orgs={orgs} orgsFailed={orgsFailed} busy={busy}
          {...(copy.createAudience ? { audience: copy.createAudience } : {})}
          onCreate={(orgId, name) => run(() => client.createCollection(orgId, name), t('sourceCreated'))}
        />
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
            onDeleteDoc={(documentId) => { void confirm({ title: t('deleteDocConfirm'), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) run(() => client.deleteDocument(col.orgId, col.collectionId, documentId).then(() => undefined), t('documentRemoved')); }); }}
            onUnbind={() => { void confirm({ title: t('unbindConfirm'), danger: true, confirmLabel: t('common:remove') }).then((ok) => { if (ok) run(() => client.unbindCollection(col.collectionId).then(() => undefined), t('sourceUnbound')); }); }}
          />
        ))
      )}

      <RetrieveSection busy={busy} client={client} copy={copy} />
    </div>
  );
}

function CreateSource({ orgs, orgsFailed, busy, audience, onCreate }: {
  /** `null` while the read is in flight — never `[]` as a failure sentinel. */
  orgs: readonly KnowledgeOrg[] | null;
  orgsFailed: boolean;
  busy: boolean;
  audience?: string;
  onCreate: (orgId: string, name: string) => void;
}): JSX.Element {
  const { t } = useTranslation('knowledge');
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const effectiveOrg = orgId || orgs?.[0]?.orgId || '';
  return (
    <form
      className="surface-card surface-form"
      onSubmit={(e) => { e.preventDefault(); if (!effectiveOrg || !name.trim() || busy) return; onCreate(effectiveOrg, name.trim()); setName(''); }}
    >
      <SelectField label={t('workspaceLabel')} value={effectiveOrg} onChange={(e) => setOrgId(e.target.value)}>
        {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </SelectField>
      <TextField label={t('newSourceLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newSourcePlaceholder')} />
      <Button variant="primary" type="submit" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createSource')}</Button>
      {/* The button is disabled with no selectable workspace. The panel Notice
          directly above carries the retry; this says WHY the control is dead at
          the point a reader is looking at it, rather than leaving them to infer
          it from an empty select. Distinguishes a failed read from a workspace
          list that is genuinely empty. */}
      {/* ADR 0666 D6 — who will be able to read what this control creates. Before the create
          button, not after: a disclosure a reader meets only once they have already clicked is
          not a disclosure. */}
      {audience ? <p className="muted u-fs-12 u-m-0">{audience}</p> : null}
      {orgsFailed ? <p className="muted u-fs-12 u-m-0">{t('orgsFailedInline')}</p>
        : orgs !== null && orgs.length === 0 ? <p className="muted u-fs-12 u-m-0">{t('orgsNoneYet')}</p>
        : null}
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
        {readOnly ? null : <Button variant="quiet" disabled={busy} onClick={onUnbind}>{t('unbind')}</Button>}
      </div>
      {col.managed ? <Notice variant="info">{t('syncedNotice', { source: t(`syncedSource_${col.managed}`) })}</Notice> : null}

      {col.documents.length > 0 ? (
        <ul className="u-flex u-flex-col u-gap-1 u-m-0 u-p-0 u-list-none">
          {col.documents.map((d) => (
            <li key={d.documentId} className="action-bar u-justify-between u-items-center">
              <span className="u-flex u-items-center u-gap-2"><FileTextIcon size={14} /> {d.title}
                {d.contentTrust === 'untrusted' ? <span className="chip chip--warning u-fs-12" title={t('externalUnverifiedTitle')}>{t('externalUnverified')}</span> : null}
              </span>
              {contentReadOnly ? null : <Button variant="quiet" aria-label={t('removeDocument')} title={t('removeDocument')} disabled={busy} onClick={() => onDeleteDoc(d.documentId)}><TrashIcon size={14} /></Button>}
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
            <Button variant="primary" type="submit" disabled={!title.trim() || !text.trim() || busy}><PlusIcon size={14} /> {t('addDocument')}</Button>
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
      {err ? <Notice variant="error" announce={err}>{err}</Notice> : null}
      <form
        className="action-bar u-gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim() || searching || busy) return;
          // Clear the previous answer FIRST — a failure that left it up would
          // render the last query's chunks (or "No matches") under the new
          // question (the KB-UX-1 stale-claim family).
          setSearching(true); setErr(null); setResult(null);
          void client.retrieve(query.trim())
            .then(setResult)
            .catch((x) => { setResult(null); setErr(x instanceof Error ? x.message : t('searchError')); })
            .finally(() => setSearching(false));
        }}
      >
        <input type="search" aria-label={copy.searchTitle} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.searchPlaceholder} />
        <Button variant="primary" type="submit" aria-busy={searching} disabled={!query.trim() || searching || busy}>
          <SearchIcon size={14} /> {searching ? t('searching') : t('common:search')}
        </Button>
      </form>
      {/* KB-UX-3 — a faulted source is reported, never folded into "No matches". */}
      {result && (result.failedSources?.length ?? 0) > 0 ? (
        <Notice variant="warning" announce={t('retrievePartial')}>
          {t('retrievePartial')}{' '}
          <span className="muted">{t('retrievePartialSources', { sources: result.failedSources!.map((s) => t(`retrieveSource_${s}`)).join(', ') })}</span>
        </Notice>
      ) : null}
      {result ? (
        result.hasResults ? (
          <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0 u-list-none">
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
        // Reachable ONLY from a retrieval where every source answered.
        ) : (result.failedSources?.length ?? 0) > 0 ? null : <p className="muted u-fs-13 u-m-0">{t('noMatches')}</p>
      ) : null}
    </div>
  );
}
