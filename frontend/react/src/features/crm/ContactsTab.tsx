/**
 * Contacts tab (the preserved tenant-wide rolodex + segments, ADR 0211 §2) —
 * extracted out of CrmPage.tsx per the ReportsTab.tsx precedent (CRMGAP-FE-10).
 * Zero behavior change from the inline version.
 */
import { Button } from '../../ui/Button.js';
import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatList, formatRelativeTime } from '../../i18n/format.js';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import { Modal } from '../../ui/Modal.js';
import { TextField } from '../../ui/Field.js';
import { announce } from '../../ui/announce.js';
import { UserIcon, SparklesIcon } from '../../ui/icons/index.js';
import { stageComposerDraft } from '../../chat/composerSeed.js';
import {
  CONTACT_STAGES,
  createContact,
  createSegment,
  deleteContact,
  deleteSegment,
  getContactLeadScore,
  listContacts,
  listSegmentMembers,
  listSegments,
  listContactFields,
  triageContact,
  updateContactFields,
  type Contact,
  type ContactFieldDef,
  type ContactStage,
  type LeadScore,
  type Segment,
} from './crmClient.js';
import { ContactCustomFieldInputs, customFieldInputId, missingRequired, toDraft, toWire, type CustomFieldDraft } from './ContactCustomFields.js';
import { crmActionError, focusFirst, looksLikeEmail } from './crmUiHelpers.js';

/** The CRM segment-author copilot (ADR 0265 / CDP-C) — the ADR 0058/0073
 *  deep-link target ("no second chat system"). */
const SEGMENT_AUTHOR_AGENT = 'feature.crm.agents.segment-author';

export function ContactsTab(): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  // ADR 0297 D3 — lead scores are fetched ON DEMAND per contact (the compute
  // walks the funnel-event stream, so never fan out across the list). 'loading'
  // marks an in-flight fetch; a LeadScore once resolved.
  const [scores, setScores] = useState<Record<string, LeadScore | 'loading'>>({});
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [stage, setStage] = useState<ContactStage>('lead');
  const [title, setTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [leadSource, setLeadSource] = useState('');
  const [busy, setBusy] = useState(false);
  // CRM-UX-7 — the tenant's contact custom-field DEFINITIONS (authored on
  // /crm/fields). A failed read is NOT "this tenant has no custom fields": it
  // would silently drop them from the create form and from every edit modal,
  // so it gets its own flag and is named on screen.
  const [fieldDefs, setFieldDefs] = useState<ContactFieldDef[] | null>(null);
  const [fieldDefsFailed, setFieldDefsFailed] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomFieldDraft>({});
  // CRM-UX-15 — required-field failures attach to THE field (aria-invalid +
  // aria-describedby, via ContactCustomFieldInputs) and focus the first one;
  // the toast still announces the whole list.
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  // CRM-UX-16 — where focus lands after a row delete unmounts its own button.
  // The move is DEFERRED to the effect below (`pendingFocusRef`), which runs
  // after the reloaded list has committed: the delete itself decides what is
  // still mounted (the last row swaps the table for the empty card, the 4th
  // contact unmounts the gated search, the grid view has no caption at all).
  const pendingFocusRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  const filterbarRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const segmentSelectRef = useRef<HTMLSelectElement>(null);
  // CRM-UX-15 — the email check the form's `noValidate` switched off, attached
  // to the field the same way the custom-field errors are.
  const emailRef = useRef<HTMLInputElement>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  // B3a: contact.lastTriage is now persisted server-side; a toggle sorts the
  // list by most-recently-triaged (default stays creation order).
  const [sortByTriage, setSortByTriage] = useState(false);
  // Collection kit (§4.5 rule 13) + the grid⇄table view (rule 11).
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<'' | ContactStage>('');
  const [viewMode, setViewMode] = useViewMode('crm-contacts', 'list');

  // ── Segments (ADR 0211 §2) — a saved filter, resolved CLIENT-side against
  // the already-loaded contact list once its live membership is fetched.
  const [segments, setSegments] = useState<Segment[] | null>(null);
  // R2 CC-SP-8 — a failed segments read was FULLY silent: saved segments read
  // as deleted.
  const [segmentsFailed, setSegmentsFailed] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState('');
  const [segmentMembers, setSegmentMembers] = useState<Contact[] | null>(null);
  const [newSegmentName, setNewSegmentName] = useState('');
  const [newSegmentStage, setNewSegmentStage] = useState<ContactStage | ''>('');
  const [segmentBusy, setSegmentBusy] = useState(false);

  // ── Why these three loaders guard their setState ────────────────────────
  // `let cancelled` is this repo's established unmount idiom (63 files). It is
  // here because the UNGUARDED version produced three UNHANDLED REJECTIONS that
  // failed `npm run ci` for everyone: a fetch still in flight when a test
  // unmounted settled after jsdom teardown, and the setState inside the
  // `.catch` handler then threw `ReferenceError: window is not defined` — a
  // throw INSIDE a catch has no further handler, so it surfaced as an unhandled
  // rejection rather than a warning.
  //
  // It is not only a test artifact: a user who navigates away mid-load has the
  // same in-flight promise resolving into an unmounted tree. The guard is the
  // fix in both cases.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  const load = useCallback(() => {
    setError(null);
    void listContacts()
      .then((c) => { if (!cancelledRef.current) setContacts(c); })
      .catch((err) => {
        if (cancelledRef.current) return;
        // HIGH-1 — a failed read leaves the collection UNKNOWN (`null`), never
        // `[]`. It used to be set to `[]` so no skeleton stranded behind the
        // error card (audit finding #1) — but the empty state is gated off
        // `error` below, so nothing strands either way, and the stale `[]`
        // was actively harmful: `load()` clears `error` synchronously, so for
        // the whole RETRY request the surface rendered a confident "No
        // contacts yet" over a list it had just failed to read. Mount was safe
        // only because `contacts` starts `null`; this makes every later read
        // behave like mount.
        setContacts(null);
        setError(crmActionError(err, 'loadContactsFailed'));
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  // CRM-UX-16 — consume the pending focus once the post-delete read has
  // committed (`contacts` is the state that read writes, success or failure).
  // The chain ends on the create form's name input, which is mounted in every
  // state of this tab — search and caption exist only for some list sizes and
  // views, and the filterbar only while there is at least one contact.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    focusFirst(searchRef.current, captionRef.current, filterbarRef.current, nameRef.current);
  }, [contacts]);

  const loadSegments = useCallback(() => {
    setSegmentsFailed(false);
    void listSegments()
      .then((sg) => { if (!cancelledRef.current) setSegments(sg); })
      .catch(() => {
        if (cancelledRef.current) return;
        setSegments([]); setSegmentsFailed(true);
        // LOW-3 — the announcement is NOT made here any more. See the single
        // consolidated announcer below: `announce` has ONE module-level polite
        // slot, so a per-catch call here raced the field-defs catch and the
        // contacts failure card, and whichever settled LAST silently erased
        // the others. The urgency contract (CRM-UX-8: polite, never assertive)
        // is unchanged — it just lives in one place now.
      });
  }, []);
  useEffect(() => { loadSegments(); }, [loadSegments]);

  const loadFieldDefs = useCallback(() => {
    setFieldDefsFailed(false);
    void listContactFields()
      .then((defs) => {
        if (cancelledRef.current) return;
        setFieldDefs(defs);
        // Seed the create form's draft so a `boolean` starts at `false` rather
        // than at "absent" — the only type whose unset state is a real value.
        setCustomDraft((cur) => ({ ...toDraft(defs), ...cur }));
      })
      .catch(() => {
        if (cancelledRef.current) return;
        setFieldDefs([]); setFieldDefsFailed(true);
        // LOW-3 — announced by the consolidated announcer below, not here.
      });
  }, []);
  useEffect(() => { loadFieldDefs(); }, [loadFieldDefs]);

  // LOW-3 — ONE polite announcement for the two SECONDARY reads.
  //
  // `announce()` writes a single module-level `politeMsg`; three announcers on
  // this tab could fire in the same tick (the contacts failure StateCard, the
  // segments catch, the field-defs catch) and the last writer won. The two
  // `.catch` announcers land AFTER the card's effect, so the message that
  // survived was reliably the least important one — the user heard "Segments
  // didn't load" while the contact list itself had failed to read.
  //
  // So: the primary failure card owns the announcement whenever it is on
  // screen, and the secondaries collapse into one line the rest of the time.
  // `formatList` keeps the join locale-correct rather than hard-coding "and".
  useEffect(() => {
    if (error) return;               // the failure card is speaking; do not talk over it
    const parts = [
      segmentsFailed ? t('segmentsLoadFailedChip') : '',
      fieldDefsFailed ? t('contactFieldsLoadFailedChip') : '',
    ].filter(Boolean);
    if (parts.length === 0) return;
    announce(formatList(parts));
  }, [error, segmentsFailed, fieldDefsFailed, t]);

  useEffect(() => {
    if (!selectedSegmentId) { setSegmentMembers(null); return; }
    // R2 CC-SP-12 — switch segment A → B fast: A's slow response must not
    // land as B's membership (last-write-wins before). The cleanup marks the
    // superseded request stale.
    let stale = false;
    void listSegmentMembers(selectedSegmentId).then((m) => {
      if (!cancelledRef.current && !stale) setSegmentMembers(m);
    }).catch((err) => {
      if (cancelledRef.current || stale) return;
      toast.error(crmActionError(err, 'segmentLoadFailed'));
      setSegmentMembers(null);
    });
    return () => { stale = true; };
  }, [selectedSegmentId, t]);

  // `useMemo`, not a bare `??`: a fresh `[]` every render re-mints the identity
  // of the three hooks below that depend on it (`add`, `saveCustomFields`, and
  // the columns memo), which `react-hooks/exhaustive-deps` fails as an error —
  // so `npm run ci`'s lint step was red on this branch before this line.
  const defs = useMemo(() => fieldDefs ?? [], [fieldDefs]);
  const add = useCallback(async () => {
    if (!name.trim()) return;
    // CRM-UX-15 — the form is `noValidate`, so this is the email check; it
    // attaches to the field (aria-invalid + aria-describedby) and focuses it.
    if (email.trim() && !looksLikeEmail(email.trim())) {
      setEmailError(t('emailInvalid'));
      emailRef.current?.focus();
      toast.error(t('emailInvalid'));
      return;
    }
    setEmailError(null);
    // CRM-UX-7 — the server enforces `required` on CREATE with a 400; saying so
    // here means the user is told which field, not handed a transport error.
    const missing = missingRequired(defs, customDraft);
    if (missing.length > 0) {
      setCustomErrors(Object.fromEntries(missing.map((d) => [d.key, t('customFieldRequiredField')])));
      document.getElementById(customFieldInputId('crm-new-contact', missing[0]!))?.focus();
      toast.error(t('customFieldRequiredMissing', { fields: missing.map((d) => d.label).join(', ') }));
      return;
    }
    setCustomErrors({});
    setBusy(true);
    try {
      const custom = toWire(defs, customDraft);
      await createContact({
        name: name.trim(), stage,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(leadSource.trim() ? { leadSource: leadSource.trim() } : {}),
        ...(Object.keys(custom).length > 0 ? { customFields: custom } : {}),
      });
      setName(''); setEmail(''); setCompany(''); setStage('lead'); setTitle(''); setPhone(''); setLeadSource('');
      setCustomDraft(toDraft(defs));
      load();
      toast.success(t('contactAdded'));
    } catch (err) { toast.error(crmActionError(err, 'addFailed')); } finally { setBusy(false); }
  }, [name, email, company, stage, title, phone, leadSource, defs, customDraft, load, t]);

  const remove = useCallback(async (id: string, name: string) => {
    // CRM-UX-17 — the consequence, from what `deleteContact` actually does.
    if (!(await confirm({ title: t('deleteRecordConfirm', { name }), body: t('deleteContactBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteContact(id);
      // CRM-UX-16 — the row (and the button that had focus) is about to
      // unmount; the effect on `contacts` moves focus once the reload lands.
      pendingFocusRef.current = true;
      load();
    } catch (err) { toast.error(crmActionError(err, 'deleteFailed')); }
  }, [load, t]);

  const triage = useCallback(async (id: string) => {
    try {
      const r = await triageContact(id);
      toast.success(t('triageStarted', { variant: r.variant ?? t('triageVariantDefault'), runId: r.runId.slice(0, 8) }));
      load(); // pick up the persisted lastTriage stamp
    } catch (err) { toast.error(crmActionError(err, 'triageFailed')); }
  }, [load, t]);

  // CC-SP-1 — email must also be settable AFTER create (an agent-created
  // contact without one could never gain an email through the UI; campaigns
  // skip it with `no_email` and Gmail sync can never match it). A one-field
  // shared-Modal edit, the KanbanPage rename precedent — never window.prompt
  // (repo convention), and the `type="email"` field keeps browser validation
  // that a prompt would bypass. Empty saves as null (clear).
  const [emailEditing, setEmailEditing] = useState<Contact | null>(null);
  const saveEmail = useCallback(async (c: Contact, raw: string) => {
    const next = raw.trim();
    if (next === (c.email ?? '')) { setEmailEditing(null); return; } // unchanged
    try {
      await updateContactFields(c.contactId, { email: next === '' ? null : next });
      setEmailEditing(null);
      load();
      toast.success(next === '' ? t('emailCleared') : t('emailSaved'));
    } catch (err) { toast.error(crmActionError(err, 'emailSaveFailed')); }
  }, [load, t]);

  // CRM-UX-7 — the values half for an EXISTING contact. Without it a custom
  // field could be defined and set at create time and then never corrected;
  // an agent-written value stayed unreachable to the human it describes.
  const [fieldsEditing, setFieldsEditing] = useState<Contact | null>(null);
  const saveCustomFields = useCallback(async (c: Contact, draft: CustomFieldDraft) => {
    const missing = missingRequired(defs, draft);
    if (missing.length > 0) { toast.error(t('customFieldRequiredMissing', { fields: missing.map((d) => d.label).join(', ') })); return; }
    try {
      // The whole map, never a partial patch of it — the server REPLACES.
      await updateContactFields(c.contactId, { customFields: toWire(defs, draft) });
      setFieldsEditing(null);
      load();
      toast.success(t('customFieldsSaved'));
    } catch (err) { toast.error(crmActionError(err, 'saveFailed')); }
  }, [defs, load, t]);

  const scoreContact = useCallback(async (id: string) => {
    setScores((prev) => ({ ...prev, [id]: 'loading' }));
    try {
      const s = await getContactLeadScore(id);
      setScores((prev) => ({ ...prev, [id]: s }));
    } catch (err) {
      setScores((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
      toast.error(crmActionError(err, 'leadScoreFailed'));
    }
  }, []);

  // The derivation, spelled out for the chip tooltip (§5.3 — the number is never
  // color-alone; the tooltip explains where it came from).
  const scoreDerivation = useCallback((s: LeadScore): string => t('leadScoreDerivation', {
    views: s.parts.funnelViews,
    completions: s.parts.funnelCompletions,
    orders: s.parts.paidOrders,
    viewWeight: s.weights.view,
    completionWeight: s.weights.completion,
    orderWeight: s.weights.paidOrder,
  }), [t]);

  // CFP D1 — the segment-author copilot (an A+ draft→validate→persist pipeline)
  // had no surface entry point. Hand the ONE chat a seeded prompt scoped to the
  // segment-author agent, whose closed-world tools build the segment for review.
  // No second chat, no bespoke form.
  const draftSegmentWithAssistant = useCallback(() => {
    stageComposerDraft(t('segmentAssistantSeed'));
    navigate(`/?agent=${encodeURIComponent(SEGMENT_AUTHOR_AGENT)}`);
  }, [navigate, t]);

  const saveSegment = useCallback(async () => {
    if (!newSegmentName.trim()) return;
    setSegmentBusy(true);
    try {
      const filters = newSegmentStage ? [{ field: 'stage' as const, op: 'eq' as const, value: newSegmentStage }] : [];
      const created = await createSegment({ name: newSegmentName.trim(), filters });
      setNewSegmentName(''); setNewSegmentStage('');
      loadSegments();
      setSelectedSegmentId(created.segmentId);
      toast.success(t('segmentSaved'));
    } catch (err) { toast.error(crmActionError(err, 'segmentSaveFailed')); } finally { setSegmentBusy(false); }
  }, [newSegmentName, newSegmentStage, loadSegments, t]);

  const removeSegment = useCallback(async (id: string, name: string) => {
    // CRM-UX-17 — a segment is a saved filter; say that no contact goes with it.
    if (!(await confirm({ title: t('deleteRecordConfirm', { name }), body: t('deleteSegmentBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteSegment(id);
      if (selectedSegmentId === id) setSelectedSegmentId('');
      // CRM-UX-16 — the Delete button only exists while a segment is
      // selected, so it unmounts with this; the segment picker (the filter
      // control it sat beside) is where focus lands.
      segmentSelectRef.current?.focus();
      loadSegments();
    } catch (err) { toast.error(crmActionError(err, 'deleteFailed')); }
  }, [selectedSegmentId, loadSegments, t]);

  const visibleContacts = useMemo(() => {
    if (!contacts) return contacts;
    let list = contacts;
    if (selectedSegmentId && segmentMembers) {
      const memberIds = new Set(segmentMembers.map((m) => m.contactId));
      list = list.filter((c) => memberIds.has(c.contactId));
    }
    // Rule 13 — search + stage facet, layered over the segment (a saved filter).
    const q = query.trim().toLowerCase();
    list = list.filter((c) =>
      (!q || c.name.toLowerCase().includes(q) || (c.title ?? '').toLowerCase().includes(q) || (c.company ?? '').toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q) || (c.leadSource ?? '').toLowerCase().includes(q))
      && (!stageFilter || c.stage === stageFilter));
    if (!sortByTriage) return list;
    return [...list].sort((a, b) => (b.lastTriage?.at ?? '').localeCompare(a.lastTriage?.at ?? ''));
  }, [contacts, sortByTriage, selectedSegmentId, segmentMembers, query, stageFilter]);

  // Lead-score affordance: a "Score" button until fetched, then a labeled chip
  // carrying the number + a tooltip that explains the derivation. Shared by the
  // table actions column and the grid card.
  const renderScore = useCallback((id: string): JSX.Element => {
    const s = scores[id];
    if (s === 'loading') return <span className="chip chip--muted" aria-busy="true">{t('leadScoreLoading')}</span>;
    // UXR-5 — the derivation was tooltip-only (title=), invisible to keyboard/SR
    // users. Tie it to the chip via aria-describedby + a visually-hidden span so
    // the number is never explained by hover alone.
    if (s) {
      const descId = `lead-score-desc-${id}`;
      return (
        <>
          <span className="chip chip--muted" title={scoreDerivation(s)} aria-describedby={descId}>{t('leadScoreChip', { score: s.score })}</span>
          <span id={descId} className="sr-only">{scoreDerivation(s)}</span>
        </>
      );
    }
    return <Button variant="quiet" onClick={() => void scoreContact(id)}>{t('leadScore')}</Button>;
  }, [scores, scoreContact, scoreDerivation, t]);

  const columns = useMemo<DataColumn<Contact>[]>(() => [
    { key: 'name', header: t('colName'), render: (c) => c.name },
    { key: 'email', header: t('colEmail'), cellClassName: 'muted', render: (c) => (
      <span className="action-bar">
        {c.email ? <a href={`mailto:${encodeURIComponent(c.email)}`}>{c.email}</a> : <span className="muted">—</span>}
        <Button variant="quiet" size="sm" onClick={() => setEmailEditing(c)} aria-label={t('emailEditLabel', { name: c.name })}>{t('common:edit')}</Button>
      </span>
    ) },
    { key: 'title', header: t('colTitle'), cellClassName: 'muted', render: (c) => c.title ?? '—' },
    { key: 'company', header: t('colCompany'), cellClassName: 'muted', render: (c) => c.company ?? '—' },
    { key: 'phone', header: t('colPhone'), cellClassName: 'muted', render: (c) => c.phone ?? '—' },
    { key: 'leadSource', header: t('colLeadSource'), cellClassName: 'muted', render: (c) => c.leadSource ?? '—' },
    { key: 'stage', header: t('colStage'), render: (c) => <span className="chip">{t(`stage_${c.stage}`)}</span>, sortValue: (c) => c.stage },
    { key: 'lastTriage', header: t('colLastTriage'), render: (c) => c.lastTriage ? (
      <span className="action-bar">
        <span className="chip">{c.lastTriage.variant ?? t('triageVariantDefault')}</span>
        <span className="muted u-fs-12">{formatRelativeTime(c.lastTriage.at)}</span>
        <Link to={`/runs/${encodeURIComponent(c.lastTriage.runId)}`} className="u-fs-12" aria-label={t('viewTriageRunLabel', { name: c.name })}>{t('viewRun')}</Link>
      </span>
    ) : <span className="muted">—</span> },
    { key: 'actions', header: '', render: (c) => (
      <span className="action-bar">
        {renderScore(c.contactId)}
        {/* CRM-UX-7 — only offered once the tenant HAS a custom field, so the
            action bar does not grow a control that opens an empty modal. */}
        {defs.length > 0 ? (
          <Button variant="quiet" onClick={() => setFieldsEditing(c)} aria-label={t('customFieldsEditLabel', { name: c.name })}>{t('customFieldsEdit')}</Button>
        ) : null}
        <Button variant="quiet" onClick={() => void triage(c.contactId)}>{t('triage')}</Button>
        <Button variant="quiet" onClick={() => void remove(c.contactId, c.name)} aria-label={t('deleteRowLabel', { name: c.name })}>{t('common:delete')}</Button>
      </span>
    ) },
  ], [triage, remove, renderScore, defs, t]);

  return (
    <div className="u-grid u-gap-4">
      {/* CRM-UX-4 — the canonical announced failed-read card (the SignTab.tsx
          bar), not a bare Notice carrying the transport's raw string. It names
          the consequence ("we cannot say what is here") and offers the ONE
          recovery that is not a page reload. */}
      {error ? (
        <StateCard
          announce
          icon={<UserIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
        />
      ) : null}
      {/* CRM-UX-15 — `noValidate`: the custom-field inputs carry `required`
          (so AT reads them as required), but the browser's native bubble would
          otherwise pre-empt `add()` — an unlocalized, un-themed message, and the
          app's own field-attached error below it would be unreachable. */}
      <form className="surface-card u-p-4 surface-form" noValidate onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldName')}</span><input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('contactNamePlaceholder')} /></label>
        <TextField ref={emailRef} label={t('fieldEmail')} type="email" error={emailError} value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setEmail(e.target.value); setEmailError(null); }} placeholder={t('contactEmailPlaceholder')} />
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCompany')}</span><input value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t('contactCompanyPlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('contactTitlePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldPhone')}</span><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('contactPhonePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldLeadSource')}</span><input value={leadSource} onChange={(e) => setLeadSource(e.target.value)} placeholder={t('contactLeadSourcePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldStage')}</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as ContactStage)}>{CONTACT_STAGES.map((s) => <option key={s} value={s}>{t(`stage_${s}`)}</option>)}</select>
        </label>
        {/* CRM-UX-7 — the tenant's own contact fields, right here in the form
            that creates the contact. */}
        <ContactCustomFieldInputs defs={defs} draft={customDraft} idPrefix="crm-new-contact" errors={customErrors} onChange={(k, v) => { setCustomDraft((cur) => ({ ...cur, [k]: v })); setCustomErrors((cur) => (k in cur ? Object.fromEntries(Object.entries(cur).filter(([key]) => key !== k)) : cur)); }} />
        {/* LOW-8 — mirrors `DealsTab`'s `pipelinesFailed` gate. A contact
            cannot be created against field definitions that were never read:
            the form silently omits every custom input, so a REQUIRED field
            comes back as a server 400 the user cannot act on. Refuse here and
            name the consequence, exactly as the deals form does. */}
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || fieldDefsFailed}>{t('addContact')}</Button>
        <p className="muted u-fs-12 u-m-0 u-w-full">
          {fieldDefsFailed ? (
            <>
              {/* NOT silence: without this the form looks like a tenant with no
                  custom fields, and a required one would 400 on submit. */}
              <span className="chip chip--danger">{t('contactFieldsLoadFailedChip')}</span>{' '}
              {t('addContactBlockedNoFields')}{' '}
              <Button variant="quiet" size="sm" onClick={loadFieldDefs}>{t('common:retry')}</Button>
            </>
          ) : (
            <Link to="/crm/fields">{t('contactFieldsLink')}</Link>
          )}
        </p>
      </form>
      {/* One filterbar row (§4.5 rules 5+11+13): gated search + stage facet +
          the triage sort, with the shared grid⇄table toggle right-aligned. */}
      {contacts !== null && contacts.length > 0 ? (
        /* CRM-UX-16 — `tabIndex={-1}` so the group can be the focus target
           after a delete in the grid view (no caption) with ≤3 contacts (no
           search); it is mounted for every non-empty list. */
        <div ref={filterbarRef} tabIndex={-1} className="filterbar" role="group" aria-label={t('filterGroup')}>
          {contacts.length > 3 ? (
            <>
              <input
                ref={searchRef}
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterContactsPlaceholder')}
                aria-label={t('filterContactsAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={stageFilter} onChange={(e) => setStageFilter(e.target.value as '' | ContactStage)} aria-label={t('filterStageLabel')}>
                <option value="">{t('allStages')}</option>
                {CONTACT_STAGES.map((s) => <option key={s} value={s}>{t(`stage_${s}`)}</option>)}
              </select>
            </>
          ) : null}
          <label className="u-iflex u-items-center u-gap-2">
            <input type="checkbox" checked={sortByTriage} onChange={(e) => setSortByTriage(e.target.checked)} />
            <span className="u-label-sm">{t('sortByLastTriage')}</span>
          </label>
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('viewTable') }} />
        </div>
      ) : null}

      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="u-label-sm">{t('segmentsTitle')}</span>
          <Button variant="secondary" size="sm" className="u-ml-auto" onClick={draftSegmentWithAssistant}>
            <SparklesIcon size={13} /> {t('segmentDraftWithAssistant')}
          </Button>
        </div>
        {segmentsFailed ? (
          <span className="action-bar">
            <span className="chip chip--danger">{t('segmentsLoadFailedChip')}</span>
            <Button variant="quiet" size="sm" onClick={loadSegments}>{t('common:retry')}</Button>
          </span>
        ) : null}
        <div className="action-bar">
          <label className="u-iflex u-items-center u-gap-2">
            <span className="u-label-sm">{t('segmentSelectLabel')}</span>
            <select ref={segmentSelectRef} value={selectedSegmentId} onChange={(e) => setSelectedSegmentId(e.target.value)} className="u-w-auto">
              <option value="">{t('segmentSelectAll')}</option>
              {(segments ?? []).map((s) => <option key={s.segmentId} value={s.segmentId}>{s.name}</option>)}
            </select>
          </label>
          {selectedSegmentId ? (
            <Button variant="quiet" onClick={() => void removeSegment(selectedSegmentId, segments?.find((s) => s.segmentId === selectedSegmentId)?.name ?? '')}>
              {t('segmentDelete')}
            </Button>
          ) : null}
        </div>
        <form className="surface-form" onSubmit={(e) => { e.preventDefault(); void saveSegment(); }}>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('segmentNameLabel')}</span>
            <input value={newSegmentName} onChange={(e) => setNewSegmentName(e.target.value)} placeholder={t('segmentNamePlaceholder')} />
          </label>
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('segmentStageLabel')}</span>
            <select value={newSegmentStage} onChange={(e) => setNewSegmentStage(e.target.value as ContactStage | '')}>
              <option value="">{t('segmentStageAny')}</option>
              {CONTACT_STAGES.map((s) => <option key={s} value={s}>{t(`stage_${s}`)}</option>)}
            </select>
          </label>
          <Button variant="primary" type="submit" disabled={segmentBusy || !newSegmentName.trim()}>{t('segmentSave')}</Button>
        </form>
      </div>

      {(() => {
        // §Correction — a failed READ must never render as an honestly-empty
        // list. The catch above sets `[]` so no skeleton is stranded (audit
        // finding #1), but that made the empty StateCard render beside the
        // error Notice: the user is told both "it broke" and "you have none".
        // `DealsTab` already gates this off `error` (finding #2); the other
        // tabs did not, and three tests PINNED the wrong behaviour.
        //
        // Return NULL, not another Notice: unlike DealsTab this tab already
        // renders the error Notice above, so re-rendering it here produced two
        // copies of the same message — caught by the test on the first run.
        if (error) return null;
        // One designed state for both views: skeleton → filter zero-match (with a
        // clear action, rule 13) → segment-empty → true-empty.
        const emptyState = contacts === null ? <SkeletonRows rows={3} columns={[160, 140, 90, 120]} />
          : (query.trim() || stageFilter) && contacts.length > 0 ? (
            <StateCard
              icon={<UserIcon />}
              title={t('noMatchesTitle')}
              body={t('noFilterMatchesBody')}
              action={<Button variant="secondary" onClick={() => { setQuery(''); setStageFilter(''); }}>{t('clearFilters')}</Button>}
            />
          ) : selectedSegmentId && segmentMembers !== null ? (
            <StateCard icon={<UserIcon />} title={t('segmentEmptyTitle')} body={t('segmentEmptyBody')} />
          ) : (
            <StateCard icon={<UserIcon />} title={t('noContactsTitle')} body={t('noContactsBody')} />
          );
        if (viewMode === 'grid' && contacts !== null && contacts.length > 0) {
          return (visibleContacts ?? []).length === 0 ? emptyState : (
            <div className="card-grid">
              {(visibleContacts ?? []).map((c) => (
                <div key={c.contactId} className="surface-card u-gap-2">
                  <div className="u-flex u-items-center u-gap-2 u-wrap">
                    <strong className="u-fs-15">{c.name}</strong>
                    <span className="chip">{t(`stage_${c.stage}`)}</span>
                  </div>
                  {c.title || c.company ? <span className="u-label-sm">{[c.title, c.company].filter(Boolean).join(' · ')}</span> : null}
                  {/* CRM-UX-20 — the card offers what the table row offers: the
                      email edit (an agent-created contact with no email could
                      otherwise only gain one from the table view) … */}
                  <span className="action-bar">
                    {c.email ? <a className="u-fs-12" href={`mailto:${encodeURIComponent(c.email)}`}>{c.email}</a> : <span className="muted u-fs-12">—</span>}
                    <Button variant="quiet" size="sm" onClick={() => setEmailEditing(c)} aria-label={t('emailEditLabel', { name: c.name })}>{t('common:edit')}</Button>
                  </span>
                  {c.leadSource ? <span className="muted u-fs-12">{t('leadSourceLine', { source: c.leadSource })}</span> : null}
                  <span className="action-bar">
                    {renderScore(c.contactId)}
                    {/* … and the custom-fields edit, on the same "only once the
                        tenant HAS a field" gate as the row. */}
                    {defs.length > 0 ? (
                      <Button variant="quiet" onClick={() => setFieldsEditing(c)} aria-label={t('customFieldsEditLabel', { name: c.name })}>{t('customFieldsEdit')}</Button>
                    ) : null}
                    <Button variant="quiet" onClick={() => void triage(c.contactId)}>{t('triage')}</Button>
                    <Button variant="quiet" onClick={() => void remove(c.contactId, c.name)} aria-label={t('deleteRowLabel', { name: c.name })}>{t('common:delete')}</Button>
                  </span>
                </div>
              ))}
            </div>
          );
        }
        return (
          <DataTable stack rows={visibleContacts ?? []} rowKey={(c) => c.contactId} columns={columns} caption={t('captionContacts')} captionRef={captionRef}
            empty={emptyState} />
        );
      })()}
      {emailEditing ? (
        <EditEmailModal
          contact={emailEditing}
          onClose={() => setEmailEditing(null)}
          onSubmit={(value) => void saveEmail(emailEditing, value)}
        />
      ) : null}
      {fieldsEditing ? (
        <EditCustomFieldsModal
          contact={fieldsEditing}
          defs={defs}
          onClose={() => setFieldsEditing(null)}
          onSubmit={(draft) => void saveCustomFields(fieldsEditing, draft)}
        />
      ) : null}
    </div>
  );
}

/** CRM-UX-7 — one contact's custom-field VALUES on the shared Modal (the
 *  EditEmailModal precedent below). Seeded from the contact's stored map, so a
 *  save never silently drops a field this form did not touch. */
function EditCustomFieldsModal({ contact, defs, onClose, onSubmit }: {
  contact: Contact;
  defs: readonly ContactFieldDef[];
  onClose: () => void;
  onSubmit: (draft: CustomFieldDraft) => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const [draft, setDraft] = useState<CustomFieldDraft>(() => toDraft(defs, contact.customFields));
  // CRM-UX-15 — the required check runs HERE so the failure can attach to the
  // field inside this modal (the parent's `saveCustomFields` keeps its own
  // guard as defence; this one is the one the user sees).
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idPrefix = `crm-fields-${contact.contactId}`;
  const submit = (): void => {
    const missing = missingRequired(defs, draft);
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((d) => [d.key, t('customFieldRequiredField')])));
      document.getElementById(customFieldInputId(idPrefix, missing[0]!))?.focus();
      toast.error(t('customFieldRequiredMissing', { fields: missing.map((d) => d.label).join(', ') }));
      return;
    }
    onSubmit(draft);
  };
  return (
    <Modal label={t('customFieldsEditTitle', { name: contact.name })} onClose={onClose}>
      {/* CRM-UX-15 — `noValidate` for the same reason as the create form. */}
      <form className="u-grid u-gap-3" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 className="u-fs-16 u-m-0">{t('customFieldsEditTitle', { name: contact.name })}</h2>
        <div className="surface-form">
          <ContactCustomFieldInputs defs={defs} draft={draft} idPrefix={idPrefix} errors={errors} onChange={(k, v) => { setDraft((cur) => ({ ...cur, [k]: v })); setErrors((cur) => (k in cur ? Object.fromEntries(Object.entries(cur).filter(([key]) => key !== k)) : cur)); }} />
        </div>
        <p className="muted u-fs-12 u-m-0">{t('customFieldsEditHint')}</p>
        <div className="action-bar u-justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit">{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** CC-SP-1 — one email field on the shared Modal (the KanbanPage rename
 *  precedent). Submitting empty CLEARS the email; the input keeps the
 *  browser's `type="email"` validation for non-empty values. */
function EditEmailModal({ contact, onClose, onSubmit }: {
  contact: Contact; onClose: () => void; onSubmit: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const [value, setValue] = useState(contact.email ?? '');
  return (
    <Modal label={t('emailEditTitle', { name: contact.name })} onClose={onClose}>
      <form className="u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
        <h2 className="u-fs-16 u-m-0">{t('emailEditTitle', { name: contact.name })}</h2>
        <TextField label={t('fieldEmail')} type="email" value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)} placeholder={t('contactEmailPlaceholder')} />
        <p className="muted u-fs-12 u-m-0">{t('emailEditClearHint')}</p>
        <div className="action-bar u-justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit">{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
