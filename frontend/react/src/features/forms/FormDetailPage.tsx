/**
 * Form detail — `/forms/:formId` (ADR 0519).
 *
 * The builder (title, fields, destinations, submit message), the publish
 * controls + shareable URLs, the captured submissions, and Delete. Everything
 * that used to stack UNDER the collection page now lives at the entity's own
 * URL, per the §4.5 routing-correction canon (rule 12): a full-page detail gets
 * a path route, leads with a `PageHeader` whose `h1` IS the entity name, and
 * carries a "Back to Forms" ghost link.
 *
 * The page loads its OWN form by id rather than reading a list the collection
 * page happened to fetch — it is reachable by bookmark, shared link, or reload,
 * with no list in memory. `?org=` rides in from the collection cell; absent it
 * (a hand-typed or truncated link) the first workspace is used, and a form that
 * is not in the resolved workspace renders the designed not-found state instead
 * of an empty builder.
 *
 * UX-WS-1 honesty is preserved verbatim from the stacked page: every read keeps
 * its own FAILED flag, distinct from `null` (loading) and `[]` (genuinely none).
 * A 404'd submissions read must never render as "No submissions yet" — that is
 * how the ADR 0508 shared-workspace outage stayed invisible.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { CheckboxField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { useLiveRegion } from '../../ui/announce.js';
import { useUnsavedChangesWarning, useConfirmDiscardUnsaved } from '../../ui/useUnsavedChangesWarning.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { bidiIsolate } from '../../lib/bidi.js';
import { ArrowDownIcon, ArrowUpIcon, ClipboardIcon, GlobeIcon, InboxIcon, LockIcon, PlusIcon, SaveIcon, SendIcon, TrashIcon } from '../../ui/icons/index.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  deleteForm, deleteSubmission, getForm, hostedFormUrl, listIntakeLists, listOrgs, listSubmissionsPage, publicFormUrl,
  setFormStatus, updateForm, FIELD_TYPES, FormsRequestError,
  type FieldType, type FormDef, type FormField, type IntakeBinding, type Submission,
} from './formsClient.js';
import { statusChipClass } from './FormViews.js';

/** The SERVER's caps on authored strings (`formsService`: MAX_TITLE, MAX_LABEL,
 *  MAX_SUBMIT_MESSAGE, MAX_DESCRIPTION), pinned to those constants by
 *  `form-cap-parity.test.ts` reading both sources.
 *
 *  These do NOT hard-stop typing — see `CharCount`. They drive the counter and
 *  the save guard, which is what keeps the server from silently truncating.
 *  ADR 0516 Phase 2a claimed the editor already mirrored them; only
 *  `description` did, so you could type 2000 characters, watch the save SUCCEED,
 *  and get 1000 back. */
const CAPS = { title: 200, label: 1_000, submitMessage: 2_000, description: 300 } as const;

/** The server's key rule (`formsService`: `[a-zA-Z0-9_]{1,64}`). Unlike the
 *  prose caps this one THROWS a 400 rather than truncating, so an invalid key
 *  fails the whole save — the editor must catch it inline. */
const KEY_RE = /^[a-zA-Z0-9_]{1,64}$/;
const KEY_MAX = 64;

/** How far past its cap a value is (0 when within). */
const overBy = (value: string, max: number): number => Math.max(0, value.length - max);

/** One predicate for "this key would fail the save", so the input's `aria-invalid`,
 *  its `aria-describedby`, the visible error, and the save guard cannot drift. */
const keyInvalid = (key: string): boolean => key.trim() !== '' && !KEY_RE.test(key.trim());

/** Character count, following the GOV.UK / NHS pattern rather than a hard stop.
 *
 *  `maxLength` was the first attempt and it is the WRONG tool here: it silently
 *  discards the tail of a PASTE. Paste 250 characters into a 200 cap and the
 *  browser drops 50 with no signal — destroying the user's content at paste time
 *  to avoid the server destroying it at save time. The researched pattern is the
 *  opposite: let people finish the thought, then tell them what to cut.
 *  ("This component does not stop the user entering information. The user can
 *  enter more than the character limit, but they're told they've entered too
 *  many characters." — NHS design system.)
 *
 *  The count stays hidden until 80% so it does not compete with the primary
 *  task — GOV.UK's own research found drawing attention to the counter early can
 *  distract from completing the form, and their guidance explicitly allows a
 *  threshold when the limit is far above what most users need. */
function CharCount({ value, max }: { value: string; max: number }): JSX.Element {
  const { t } = useTranslation('forms');
  const over = overBy(value, max);
  const show = over > 0 || value.length >= Math.floor(max * 0.8);
  return (
    <>
      {show ? (
        <span className={over > 0 ? 'u-label-sm u-text-danger' : 'u-label-sm muted'}>
          {over > 0 ? t('charCountOver', { n: over }) : t('charCount', { n: value.length, max })}
        </span>
      ) : null}
      {/* ALWAYS mounted, even below the threshold. A live region that mounts with
          content announces NOTHING, so a region that only appears at 80% would
          stay silent for the one path most likely to blow the cap — pasting
          straight past it. Mounted empty, filled on crossing. */}
      <span className="sr-only" role="status">{over > 0 ? t('charCountOver', { n: over }) : ''}</span>
    </>
  );
}


/** A draft field carries a client-only stable `_rid` for React keys (the field
 *  `key` is user-editable and may be empty/duplicate), stripped before the API. */
type DraftField = FormField & { _rid: string };
/** ADR 0246 — the intake routing draft. An empty `listId` means "not routed"
 *  (cleared on save); a set `listId` requires a `titleField`. */
interface DraftIntake { listId: string; titleField: string; requesterField: string; notesField: string }
interface Draft { title: string; fields: DraftField[]; createToContact: boolean; emailOptInField: string; submitMessage: string; intake: DraftIntake }

const EMPTY_INTAKE: DraftIntake = { listId: '', titleField: '', requesterField: '', notesField: '' };

/** Drop any intake mapping whose field key no longer exists — a removed or
 *  renamed field must not leave a dangling reference (the select would render
 *  blank while state kept the stale key, and save would 400). grade-code FE#1. */
function pruneIntake(fields: DraftField[], intake: DraftIntake): DraftIntake {
  const keys = new Set(fields.map((f) => f.key.trim()).filter(Boolean));
  const keep = (v: string): string => (v && keys.has(v) ? v : '');
  return { listId: intake.listId, titleField: keep(intake.titleField), requesterField: keep(intake.requesterField), notesField: keep(intake.notesField) };
}

let _ridSeq = 0;
const nextRid = (): string => `f${_ridSeq++}`;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

function copy(text: string): void {
  void copyToClipboard(text, i18n.t('forms:publicUrlCopied'));
}

// Human-readable labels for the machine submission-error codes (§2 copy).
// FRMUX-2 / ADR 0648 D2 — `suppressed` is NOT a failure: the sink deliberately
// declined to create a contact for a suppressed/erased subject. Rendering it through
// the bare "error" fallback (red chip, no explanation) told the operator "contact
// creation broke — add it by hand", and the authenticated CRM route would accept
// exactly that: the UI was recruiting the operator into the erasure-resurrection
// D2 exists to prevent. It gets its own label, a non-danger chip, and a body line.
const ERR_LABEL_KEY: Record<string, string> = { no_contact_fields: 'forms:errNoContactFields', contact_create_failed: 'forms:errContactCreateFailed', suppressed: 'forms:errSuppressed', erased: 'forms:errSuppressed', suppression_unreadable: 'forms:errSuppressionUnreadable' };

/** Hydrate the editable draft from a stored form. */
function toDraft(f: FormDef): Draft {
  return {
    title: f.title,
    fields: f.fields.map((x) => ({ ...x, _rid: nextRid() })),
    createToContact: f.createToContact,
    emailOptInField: f.emailOptInField ?? '',
    submitMessage: f.submitMessage ?? '',
    intake: f.intakeBinding
      ? { listId: f.intakeBinding.listId, titleField: f.intakeBinding.titleField, requesterField: f.intakeBinding.requesterField ?? '', notesField: f.intakeBinding.notesField ?? '' }
      : { ...EMPTY_INTAKE },
  };
}

export function FormDetailPage(): JSX.Element {
  const { t } = useTranslation('forms');
  const { formId = '' } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const access = useFeatureAccess('forms');
  // ADR 0330 §D4 — feature-access check only (no CRM client import): gates the
  // optional crm-contact destination controls.
  const crmAccess = useFeatureAccess('crm');
  // ADR 0338 §D1 — gates the email opt-in designation control.
  const emailAccess = useFeatureAccess('email');

  const [searchParams] = useSearchParams();
  const deepOrg = searchParams.get('org');
  const [orgId, setOrgId] = useState(deepOrg ?? '');
  const [orgsFailed, setOrgsFailed] = useState(false);
  /** CCDATA-1 — when the link carried no `?org=` we GUESSED the first workspace.
   *  A not-found then has two very different meanings (deleted vs. looked in the
   *  wrong place), and only this flag can tell them apart, so the copy below
   *  names the workspace actually checked instead of hedging. */
  const [guessedOrgName, setGuessedOrgName] = useState('');

  const [form, setForm] = useState<FormDef | null>(null);
  /** The form read resolved and found nothing — a deleted form or a stale link.
   *  Distinct from `null` (still loading), which must not render "not found". */
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);

  // Removing `maxLength` means a value CAN exceed its cap, so the save path is
  // what keeps the server from silently truncating. Blocking here is the half of
  // the GOV.UK pattern that makes "let them type past it" safe — without it this
  // would be the original succeeds-but-wrong bug again.
  const blockers = useMemo(() => {
    if (!draft) return [];
    const over: string[] = [];
    if (overBy(draft.title, CAPS.title)) over.push(t('titleLabel'));
    if (overBy(draft.submitMessage, CAPS.submitMessage)) over.push(t('submitMessageLabel'));
    const seenKeys = new Set<string>();
    draft.fields.forEach((f, idx) => {
      if (overBy(f.label, CAPS.label) || overBy(f.description ?? '', CAPS.description)) over.push(f.label || f.key);
      if (keyInvalid(f.key)) over.push(f.key);
      // R2 FRM2-2 — an incomplete row used to be SILENTLY DROPPED by save (and
      // every non-Latin-only label slugs to nothing) while staying on screen
      // with the dirty guard disarmed. It is a named blocker now.
      const effKey = f.key.trim() || slug(f.label);
      if (!f.label.trim() || !effKey) { over.push(t('blockerIncompleteField', { n: idx + 1 })); return; }
      // R2 FRM2-7 — duplicate keys blocked HERE with a name, not by the
      // server's raw English toast after the fact.
      if (seenKeys.has(effKey)) over.push(t('blockerDuplicateKey', { key: effKey }));
      seenKeys.add(effKey);
      // R2 FRM2-5 — a select with zero options would ship a public dropdown
      // containing only the placeholder, validating nothing.
      if (f.type === 'select' && !(f.options ?? []).some((o) => o.trim())) over.push(t('blockerSelectNoOptions', { label: f.label || effKey }));
    });
    return over;
  }, [draft, t]);
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [subsCursor, setSubsCursor] = useState<string | null>(null);
  /** ADR 0584 (FORM-UX-1) — the operator-visible abuse numbers. Before these,
   *  a form losing 100% of its leads to a false-positive honeypot looked
   *  IDENTICAL to a form nobody submits: the only trace was a backend WARN line
   *  no operator surface reads. */
  const [subsAbuse, setSubsAbuse] = useState<{ flagged: number; dropped: number }>({ flagged: 0, dropped: 0 });
  /** UX-WS-1 — the submissions read FAILED (distinct from "loaded, and empty"). */
  const [subsFailed, setSubsFailed] = useState(false);
  /** UX-WS-1 — the intake-lists read FAILED (distinct from "loaded, and empty"). */
  const [intakeListsFailed, setIntakeListsFailed] = useState(false);
  // `null` = still loading (the file's T[]|null loading convention) so the empty
  // "no lists" message never flashes before the fetch resolves.
  const [intakeLists, setIntakeLists] = useState<Array<{ id: string; name: string }> | null>(null);
  const [subsQuery, setSubsQuery] = useState('');
  /** ADR 0584 §Correction (FORM-UX-1b) — the HELD filter. A form that accrues
   *  quarantined rows buries its real leads in them, and the "Held" chip alone
   *  only tells you which row is which once you have scrolled past it. */
  const [subsHeldOnly, setSubsHeldOnly] = useState(false);
  /** ADR 0584 §Correction (FORM-CSV-1) — held rows are EXCLUDED from the export
   *  unless this is explicitly ticked. See `exportCsv`. */
  const [exportIncludeHeld, setExportIncludeHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every draft mutation goes through this, so `dirty` can never drift from the
  // edits it guards — a per-control `setDirty(true)` would be one missed call
  // away from silently dropping the unsaved-changes warning.
  const editDraft = useCallback((fn: (d: Draft) => Draft) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  }, []);
  useUnsavedChangesWarning(dirty);
  // FORM-UX-2 — the IN-APP half. `beforeunload` never fires for a react-router
  // navigation, and this page renders TWO "Back to Forms" links (plus reuses one
  // in three failure states), so one click discarded an entire form build.
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);

  /**
   * FORM-UX-5 (ADR 0584) — the same typed→localized mapping as the collection
   * page. Four of this page's failure strings were unreachable by construction.
   */
  const failureCopy = useCallback((err: unknown, fallbackKey: string): { title: string; detail?: string } => {
    if (err instanceof FormsRequestError) {
      const title = err.status === 403 ? t('failureForbidden')
        : err.status === 404 ? t('failureNotFound')
          : err.status === 400 || err.status === 422 ? t('failureRejected')
            : err.status === 429 ? t('failureRateLimited')
              : err.status >= 500 ? t('failureServer')
                : t(fallbackKey);
      return err.detail ? { title, detail: err.detail } : { title };
    }
    return { title: t('failureOffline') };
  }, [t]);
  const toastFailure = useCallback((err: unknown, fallbackKey: string): void => {
    const c = failureCopy(err, fallbackKey);
    toast.error(c.detail ? `${c.title} ${c.detail}` : c.title);
  }, [failureCopy]);

  // FORM-UX-9 — every failure state on this page had to be recovered by
  // RELOADING THE WHOLE PAGE ("Reload to try again" in prose), which §4.6 rule 7
  // forbids: a Retry button beats "try again" in prose. One attempt counter per
  // independent read, so retrying the submissions does not re-fetch the form.
  const [orgsAttempt, setOrgsAttempt] = useState(0);
  const [formAttempt, setFormAttempt] = useState(0);
  const [subsAttempt, setSubsAttempt] = useState(0);

  // Resolve the workspace only when the link didn't name one.
  useEffect(() => {
    if (!access.enabled || orgId) return;
    setOrgsFailed(false);
    void listOrgs()
      .then((o) => { setOrgId(o[0]?.orgId ?? ''); setGuessedOrgName(o[0]?.name ?? ''); setOrgsFailed(false); })
      .catch(() => setOrgsFailed(true));
  }, [access.enabled, orgId, orgsAttempt]);

  /** The submissions read, split out so FORM-UX-9's Retry can re-run it alone. */
  const loadSubs = useCallback((targetFormId: string, live: () => boolean) => {
    // FRMB-PAGE — capped page (latest 100); older history stays server-side.
    // UX-WS-1 — a FAILED read keeps `subs` null and raises its own flag; it
    // must never render as "No submissions yet".
    void listSubmissionsPage(orgId, targetFormId, 100)
      .then((r) => {
        if (!live()) return;
        // Order matters: clear the FAILED flag and set the data in the same
        // commit, so no render sees "not failed" beside stale-empty data (the
        // retry-clears-the-flag-over-stale-data trap this repo keeps hitting).
        setSubs(r.submissions); setSubsCursor(r.nextCursor);
        setSubsAbuse({ flagged: r.flaggedCount, dropped: r.droppedCount });
        setSubsFailed(false);
      })
      .catch(() => { if (live()) { setSubs(null); setSubsCursor(null); setSubsFailed(true); } });
  }, [orgId]);

  useEffect(() => {
    if (!orgId || !formId) return undefined;
    setForm(null); setNotFound(false); setLoadFailed(false); setError(null);
    setSubs(null); setSubsFailed(false); setSubsQuery('');
    let live = true; // ignore a stale resolution if the org/form changed mid-flight
    void getForm(orgId, formId)
      .then((f) => {
        if (!live) return;
        setForm(f); setDraft(toDraft(f)); setDirty(false);
        loadSubs(f.formId, () => live);
      })
      .catch((e) => {
        if (!live) return;
        // A 404 IS the answer ("no such form here"), not a failure to read.
        if (e instanceof FormsRequestError && e.status === 404) setNotFound(true);
        else { setError(failureCopy(e, 'loadFormsFailed').detail ?? null); setLoadFailed(true); }
      });
    return () => { live = false; };
  }, [orgId, formId, t, formAttempt, loadSubs, failureCopy]);

  // FORM-UX-9 — a submissions-only retry: re-enter LOADING before refetching, so
  // the re-render window shows a skeleton and never a stale empty list.
  useEffect(() => {
    if (subsAttempt === 0 || !form) return undefined;
    setSubs(null); setSubsFailed(false);
    let live = true;
    loadSubs(form.formId, () => live);
    return () => { live = false; };
  }, [subsAttempt, form, loadSubs]);

  useEffect(() => {
    if (!orgId) return undefined;
    setIntakeLists(null); setIntakeListsFailed(false);
    let live = true;
    void listIntakeLists(orgId)
      .then((l) => { if (live) { setIntakeLists(l); setIntakeListsFailed(false); } })
      .catch(() => { if (live) { setIntakeLists(null); setIntakeListsFailed(true); } });
    return () => { live = false; };
  }, [orgId]);

  const visibleSubs = useMemo(() => (subs ?? []).filter((s) => {
    if (subsHeldOnly && !s.flagged) return false;
    const q = subsQuery.trim().toLowerCase();
    return !q || Object.entries(s.values).some(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
  }), [subs, subsQuery, subsHeldOnly]);
  /** How many of the LOADED rows are held — the filter chip's count. Distinct
   *  from `subsAbuse.flagged`, which is the form's true lifetime-held total
   *  from the server counter and can exceed what one page holds; the chip must
   *  not promise to filter to rows that are not here. */
  const loadedHeld = useMemo(() => (subs ?? []).filter((s) => s.flagged).length, [subs]);

  const save = useCallback(async () => {
    if (!form || !draft) return;
    setBusy(true);
    try {
      const fields = draft.fields
        .map(({ _rid, ...f }) => ({
          ...f,
          key: (f.key.trim() || slug(f.label)),
          ...(f.type === 'select' ? { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}),
        }))
        .filter((f) => f.key && f.label.trim());
      const sm = draft.submitMessage.trim();
      // ADR 0246 — a set listId + titleField sends the binding; an empty listId
      // clears it (null). Guard: a chosen list REQUIRES a title field.
      let intakeBinding: IntakeBinding | null = null;
      if (draft.intake.listId) {
        if (!draft.intake.titleField) { toast.error(t('intakeTitleFieldRequired')); setBusy(false); return; }
        intakeBinding = {
          listId: draft.intake.listId,
          titleField: draft.intake.titleField,
          ...(draft.intake.requesterField ? { requesterField: draft.intake.requesterField } : {}),
          ...(draft.intake.notesField ? { notesField: draft.intake.notesField } : {}),
        };
      }
      const saved = await updateForm(orgId, form.formId, { title: draft.title.trim() || t('untitledForm'), fields, createToContact: draft.createToContact, emailOptInField: draft.emailOptInField || null, submitMessage: sm, intakeBinding });
      setForm(saved); setDirty(false);
      toast.success(t('saved'));
    } catch (e) { toastFailure(e, 'saveFailed'); }
    finally { setBusy(false); }
  }, [form, draft, orgId, t, toastFailure]);

  const togglePublish = useCallback(async () => {
    if (!form) return;
    // R2 FRM2-13 — publish acts on the STORED form: with unsaved edits it would
    // silently ship the stale version the user believes they replaced. Say so
    // and stop. Unpublishing kills a live shared URL — confirm it.
    if (dirty) { toast.error(t('publishSaveFirst')); return; }
    if (form.status === 'published'
      && !(await confirm({ title: t('unpublishConfirm', { name: form.title }), body: t('unpublishBody'), danger: true, confirmLabel: t('unpublish') }))) return;
    try { setForm(await setFormStatus(orgId, form.formId, form.status === 'published' ? 'draft' : 'published')); }
    catch (e) { toastFailure(e, 'publishFailed'); }
  }, [form, dirty, orgId, t, toastFailure]);

  const remove = useCallback(async () => {
    if (!form) return;
    // R2 FRM2-4 — deleting a form CASCADES every captured submission (leads,
    // permanently). Say so; when leads are loaded and present, require typing
    // the form's name (the destructive-action ladder).
    if (!(await confirm({
      title: t('deleteFormConfirm', { name: form.title }),
      body: t('deleteFormCascade'),
      danger: true,
      confirmLabel: t('common:delete'),
      ...(subs && subs.length > 0 ? { typeToConfirm: form.title } : {}),
    }))) return;
    try {
      await deleteForm(orgId, form.formId);
      setDirty(false); // the entity is gone; its unsaved edits are moot
      navigate(`/forms?org=${encodeURIComponent(orgId)}`);
    } catch (e) { toastFailure(e, 'deleteFailed'); }
  // R2R R1 — `subs` IS a dep: without it the type-to-confirm gate memoized
  // over subs===null and never armed once the leads arrived.
  }, [form, subs, orgId, navigate, t, toastFailure]);

  // R2 FRM2-10 — swap two rows; the announcement rides the shared
  // useLiveRegion hook (always-mounted polite region, repeat-safe marker).
  const [moveNotice, setMoveNotice] = useLiveRegion();
  const moveField = (i: number, delta: -1 | 1): void => {
    // R2R R6 — the updater stays PURE (StrictMode double-invokes it); the
    // announcement is derived outside and set after.
    const j = i + delta;
    if (!draft || j < 0 || j >= draft.fields.length) return;
    const moved = draft.fields[i]!;
    editDraft((d) => {
      if (j >= d.fields.length) return d;
      const fields = [...d.fields];
      const tmp = fields[i]!; fields[i] = fields[j]!; fields[j] = tmp;
      return { ...d, fields };
    });
    setMoveNotice(t('fieldMoved', { label: moved.label || moved.key || String(i + 1), n: j + 1 }));
  };

  // R2 FRM2-9 — CSV export: pages the cursor to COMPLETION (the server's own
  // cap comment presumes export tooling; exporting only the loaded page would
  // be a silent truncation). Headers are the form's field LABELS in form
  // order; attribution meta rides as its own columns.
  //
  // ADR 0584 §Correction (FORM-CSV-1) — QUARANTINED ROWS DO NOT SILENTLY RIDE
  // ALONG. Walking the cursor to completion picks up every `flagged` row too,
  // and before this the header and the row builder emitted no `flagged`
  // column — so the most likely bulk path out of Forms (into a CRM, a mail
  // tool, a spreadsheet) carried bot submissions and false-positive holds
  // byte-indistinguishable from real leads, defeating the "no CRM contact, no
  // email" property the quarantine exists to provide. Before this PR the CSV
  // was clean by construction, because honeypot trips were not stored at all;
  // quarantining them made this an export defect the moment it shipped.
  //
  // TWO changes, and both were taken (the review offered the column and asked
  // for a decision on the default):
  //   1. Held rows are EXCLUDED by default. The export is the bulk-import path,
  //      so its default must be the set an operator can safely import.
  //   2. A `Held` COLUMN always exists, naming which control held the row. So
  //      an operator who deliberately ticks "include held" — to triage false
  //      positives in a spreadsheet, the recovery this feature promises — gets
  //      them labelled rather than mixed in.
  const [exporting, setExporting] = useState(false);
  const exportCsv = useCallback(async () => {
    if (!form) return;
    setExporting(true);
    try {
      const all: Submission[] = [];
      let cursor: string | null | undefined = undefined;
      do {
        const r: { submissions: Submission[]; nextCursor: string | null } = await listSubmissionsPage(orgId, form.formId, 100, cursor ?? undefined);
        // FRMUX-3 — a `suppressed` row is excluded by default exactly like a held
        // row: importing it into a CRM is a compliance event, not a data-quality one.
        all.push(...r.submissions.filter((s) => exportIncludeHeld || (!s.flagged && s.error !== 'suppressed' && s.error !== 'erased')));
        cursor = r.nextCursor;
      } while (cursor);
      // R2R R2 — neutralize spreadsheet formula injection: every cell is
      // anonymous public input; a leading = + - @ tab or CR would execute in
      // Excel/Sheets (DDE/exfil class). Prefix with a single quote.
      const esc = (v: unknown): string => {
        let str = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
        return `"${str.replace(/"/g, '""')}"`;
      };
      // R2R R7 — the union of CURRENT keys and keys observed in the data:
      // exporting only current fields silently dropped the orphaned columns
      // the keyRenameHint warns about — the exact truncation this exists to
      // prevent. Orphans use their raw key as the header.
      const cols = form.fields.map((f) => f.key);
      for (const sub of all) for (const k of Object.keys(sub.values)) if (!cols.includes(k)) cols.push(k);
      const labelOf = (k: string): string => form.fields.find((f) => f.key === k)?.label || k;
      const header = [...cols.map(labelOf), t('csvSubmittedAt'), t('csvHeld'), t('csvDestination'), t('subMetaReferrer'), t('csvUtm'), t('csvContext')].map(esc).join(',');
      const lines = all.map((sub) => [
        ...cols.map((k) => sub.values[k] ?? ''),
        sub.createdAt,
        // Empty on a clean row — an operator scanning the column sees the held
        // ones, not a column of "no".
        sub.flagged ? t(sub.flagged === 'honeypot' ? 'submissionHeldHoneypot' : 'submissionHeldGuard') : '',
        // FRMUX-3 — the sink outcome, so a bulk export can never present a
        // suppressed subject as a routed lead.
        sub.contactId ?? (sub.error ? t(ERR_LABEL_KEY[sub.error] ?? 'forms:submissionError') : ''),
        sub.meta?.referrer ?? '',
        Object.entries(sub.meta?.utm ?? {}).map(([k, v]) => `${k}=${v}`).join(' '),
        Object.entries(sub.meta?.context ?? {}).map(([k, v]) => `${k}=${v}`).join(' '),
      ].map(esc).join(','));
      const blob = new Blob([`\ufeff${[header, ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(form.title) || 'form'}-submissions.csv`;
      a.click();
      // Deferred: an immediate revoke has raced download start in Firefox.
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch { toast.error(t('exportCsvFailed')); }
    finally { setExporting(false); }
  }, [form, orgId, t, exportIncludeHeld]);

  /**
   * ADR 0584 §Correction (FORM-BUDGET-1) — discard ONE held submission.
   *
   * The quarantine budget is an OCCUPANCY count now, so this is the operator's
   * lever for getting it back: without a delete path, an occupancy budget a
   * form has filled is no better than the lifetime tally it replaced (retention
   * is off on two independent default switches, so it cannot be the answer).
   * Offered on HELD rows only — deleting a real captured lead is a different
   * product decision, and the destructive-action ladder for it is `deleteForm`'s.
   */
  const discardHeld = useCallback(async (sub: Submission) => {
    if (!form) return;
    if (!(await confirm({ title: t('discardHeldConfirm'), body: t('discardHeldBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteSubmission(orgId, form.formId, sub.submissionId);
      setSubs((prev) => (prev ?? []).filter((s) => s.submissionId !== sub.submissionId));
      // The server's counter moved, so the banner must too — it is the number
      // the operator is acting ON, and a stale one would say the discard did
      // nothing. Floored: the banner may never claim a negative budget.
      setSubsAbuse((prev) => ({ ...prev, flagged: Math.max(0, prev.flagged - 1) }));
      toast.success(t('discardHeldDone'));
    } catch (e) { toastFailure(e, 'discardHeldFailed'); }
  }, [form, orgId, t, toastFailure]);

  const patchField = (i: number, patch: Partial<FormField>): void => {
    editDraft((d) => {
      const before = d.fields[i];
      const fields = d.fields.map((f, j) => j === i ? { ...f, ...patch } : f);
      // R2 FRM2-1 — the email opt-in designation must FOLLOW its field: a key
      // rename used to leave `emailOptInField` dangling, which bricked every
      // save (server 400) with the clearing control unrendered. Follow the
      // rename; clear when the field stops being a checkbox.
      let emailOptInField = d.emailOptInField;
      if (before && before.key === d.emailOptInField && d.emailOptInField) {
        if (patch.key !== undefined) emailOptInField = patch.key;
        if (patch.type !== undefined && patch.type !== 'checkbox') emailOptInField = '';
      }
      // A key change can orphan an intake mapping — prune it so save never emits
      // a dangling field reference (FE#1).
      return { ...d, fields, emailOptInField, intake: patch.key !== undefined ? pruneIntake(fields, d.intake) : d.intake };
    });
  };

  const backHref = orgId ? `/forms?org=${encodeURIComponent(orgId)}` : '/forms';
  /**
   * FORM-UX-2 (ADR 0584) — a GUARDED in-app exit.
   *
   * This was a plain `<Link>`. One click on "← Back to Forms" discarded an
   * entire form build — every field, key, option list, help text, number
   * constraint and destination mapping — with no confirm and no draft
   * persistence, on a page simultaneously rendering an "unsaved changes" chip
   * proving it knew. The `beforeunload` guard the page installs cannot fire for
   * a react-router navigation, and this page renders TWO of these plus reuses
   * the same link in three failure states.
   *
   * It stays a real `<Link>` (an anchor with an `href`), so middle-click,
   * cmd-click and "copy link address" keep working — the §4.5 rule 12 property
   * an onClick button would destroy. The guard intercepts only the plain-click
   * navigation it is able to take back.
   */
  const backLink = (
    <Link
      to={backHref}
      className="btn-ghost"
      onClick={(e) => {
        if (!dirty || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        void confirmDiscard().then((ok) => { if (ok) { setDirty(false); navigate(backHref); } });
      }}
    >{t('backToForms')}</Link>
  );

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  // Ordered failure-first: a failed-read branch below a loading branch never runs.
  if (orgsFailed) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('loadFailedTitle')} actions={backLink} />
        {/* FORM-UX-9 — a RETRY, not prose telling the reader to reload. */}
        <StateCard
          announce icon={<GlobeIcon size={20} />} title={t('loadFailedTitle')} body={t('loadFailedBody')}
          action={<Button variant="secondary" onClick={() => setOrgsAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
        />
      </div>
    );
  }
  if (notFound) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('formNotFoundTitle')} actions={backLink} />
        {/* The action matters as much as the copy: a link that resolved the
            WRONG workspace dead-ends here, and the way out (the workspace
            picker) lives on the collection page. Never strand a reader on a
            terminal state with no move. */}
        <StateCard announce icon={<ClipboardIcon size={20} />} title={t('formNotFoundTitle')} body={guessedOrgName ? t('formNotFoundGuessedBody', { workspace: guessedOrgName }) : t('formNotFoundBody')}
          action={<Link to={orgId ? `/forms?org=${encodeURIComponent(orgId)}` : '/forms'} className="btn-accent-solid">{t('backToForms')}</Link>} />
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('loadFormFailedTitle')} actions={backLink} />
        {/* FORM-UX-9 + FORM-UX-10 — ONE failure surface with a real Retry. The
            separate `<Notice variant="error">` that used to sit here was a
            SECOND surface for the same failure, and it passed no `announce` (the
            unproven role="alert"-on-insertion assumption `ui/Notice.tsx:18-21`
            warns about). The server's own words ride in the body as a detail. */}
        <StateCard
          announce icon={<ClipboardIcon size={20} />} title={t('loadFormFailedTitle')}
          body={error ? `${t('loadFormFailedBody')} ${error}` : t('loadFormFailedBody')}
          action={<Button variant="secondary" onClick={() => setFormAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
        />
      </div>
    );
  }
  if (!form || !draft) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('loadingForm')} actions={backLink} />
        <StateCard icon={<ClipboardIcon size={20} />} title={t('loadingForm')} loading />
      </div>
    );
  }

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="forms.detail">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={form.title}
        lede={t('detailLede')}
        actions={
          <>
            {backLink}
            <Button variant="danger" onClick={() => void remove()}><TrashIcon size={14} /> {t('common:delete')}</Button>
            <Button variant="secondary" onClick={() => void togglePublish()}>
              <SendIcon size={14} /> {form.status === 'published' ? t('unpublish') : t('publish')}
            </Button>
            {/* §4.5 rule 4 — THE action on this page. */}
            <Button variant="accent-solid" disabled={busy || blockers.length > 0} onClick={() => void save()}><SaveIcon size={14} /> {t('common:save')}</Button>
          </>
        }
      />

      <div className="surface-card u-gap-2">
        <div className="u-flex u-gap-2 u-items-center u-wrap">
          <h2 className="u-fs-16 u-m-0 u-flex-1">{t('editForm')}</h2>
          <span className={statusChipClass(form.status)}>{t(`status_${form.status}`)}</span>
          {/* DOCTPL-19 review F5 — the per-form origin renderer the client type
              promised: a form instantiated from a pack template SAYS SO, so
              seeded-vs-hand-authored is no longer invisible (ADR 0516
              §Provenance). The pack identifier is PACK-AUTHORED text, so it is
              bidi-isolated before mixing into app chrome. Absent on
              hand-authored forms — no chip, no false claim. */}
          {form.originTemplate ? (
            <span
              className="chip chip--muted"
              title={t('originTemplateTitle', { templateId: form.originTemplate.templateId })}
            >{t('originTemplateChip', { source: bidiIsolate(`${form.originTemplate.packName}@${form.originTemplate.packVersion}`) })}</span>
          ) : null}
          {dirty ? <span className="chip chip--warning">{t('unsavedChanges')}</span> : null}
        </div>
        {/* A disabled Save with no stated reason is its own defect — the user is
            left guessing which field is at fault. Names them. */}
        {blockers.length > 0 ? (
          <Notice variant="warning" announce={t('saveBlocked', { fields: blockers.join(', ') })}>
            {t('saveBlocked', { fields: blockers.join(', ') })}
          </Notice>
        ) : null}

        <label className="u-label-sm">{t('titleLabel')}
          <input value={draft.title} onChange={(e) => editDraft((d) => ({ ...d, title: e.target.value }))} />
          <CharCount value={draft.title} max={CAPS.title} />
        </label>

        <h3 className="u-fs-14 u-m-0">{t('fieldsHeading')}</h3>
        {subs && subs.length > 0 ? (
          <p className="u-label-sm muted u-m-0">{t('keyRenameHint')}</p>
        ) : null}
        <span className="sr-only" aria-live="polite">{moveNotice}</span>
        {draft.fields.map((f, i) => (
          <div key={f._rid} className="surface-inset u-grid u-gap-1">
            <div className="u-flex u-gap-1 u-items-center u-wrap">
              <input value={f.label} onChange={(e) => patchField(i, { label: e.target.value })} placeholder={t('fieldLabelPlaceholder')} aria-label={t('fieldLabelAria')} className="u-flex-1" />
              <input
                value={f.key} onChange={(e) => patchField(i, { key: e.target.value })}
                placeholder={t('fieldKeyPlaceholder')} aria-label={t('fieldKeyAria')} className="u-w-auto"
                maxLength={KEY_MAX}
                aria-invalid={keyInvalid(f.key)}
                aria-describedby={keyInvalid(f.key) ? `key-err-${f._rid}` : undefined}
              />
              <select value={f.type} onChange={(e) => patchField(i, { type: e.target.value as FieldType })} aria-label={t('fieldTypeAria')} className="u-w-auto">
                {/* R2 FRM2-11 — human labels, not raw catalog ids, x4 locales. */}
                {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(`fieldType_${ft}`)}</option>)}
              </select>
              <label className="u-label-sm u-flex u-gap-1 u-items-center"><input type="checkbox" checked={f.required} onChange={(e) => patchField(i, { required: e.target.checked })} /> {t('fieldRequired')}</label>
              {/* R2 FRM2-10 — keyboard-reachable reordering (rows are keyed by
                  _rid, so DOM identity — and focus — survives the swap). The
                  move is announced via the list-level live region below. */}
              <Button variant="quiet" disabled={i === 0} title={t('moveFieldUp')} aria-label={t('moveFieldUpAria', { label: f.label || f.key || String(i + 1) })} onClick={() => moveField(i, -1)}><ArrowUpIcon size={14} /></Button>
              <Button variant="quiet" disabled={i === draft.fields.length - 1} title={t('moveFieldDown')} aria-label={t('moveFieldDownAria', { label: f.label || f.key || String(i + 1) })} onClick={() => moveField(i, 1)}><ArrowDownIcon size={14} /></Button>
              <Button variant="quiet" title={t('removeField')} aria-label={t('removeField')} onClick={() => editDraft((d) => { const removed = d.fields[i]; const fields = d.fields.filter((_, j) => j !== i); return { ...d, fields, emailOptInField: removed && removed.key === d.emailOptInField ? '' : d.emailOptInField, intake: pruneIntake(fields, d.intake) }; })}><TrashIcon /></Button>
            </div>
            {/* R2 FRM2-5 — a select's OPTIONS are authorable at last: one per
                line. Without this, a hand-built select saved options: [] and
                shipped a public dropdown containing only "Choose…" that
                validated nothing. */}
            {f.type === 'select' ? (
              <label className="u-label-sm">{t('fieldOptionsLabel')}
                <textarea
                  rows={3}
                  value={(f.options ?? []).join('\n')}
                  onChange={(e) => patchField(i, { options: e.target.value.split('\n').map((o) => o.slice(0, 200)).slice(0, 250) })}
                  placeholder={t('fieldOptionsPlaceholder')}
                  aria-label={t('fieldOptionsAria', { label: f.label || f.key || String(i + 1) })}
                />
              </label>
            ) : null}
            {/* F9 (round 3) — number constraints, the options-editor precedent:
                authorable ONLY on number fields; empty input CLEARS (undefined
                rides the patch spread and serializes absent — the explicit
                clear, not absent-means-keep). Server sanitize drops stale
                constraints if the type later changes. */}
            {f.type === 'number' ? (
              <div className="u-flex u-gap-2 u-wrap">
                {(['min', 'max', 'step'] as const).map((c) => (
                  <label key={c} className="u-label-sm">{t(`fieldNum_${c}`)}
                    <input
                      type="number"
                      inputMode="decimal"
                      value={f[c] ?? ''}
                      {...(c === 'step' ? { min: 0 } : {})}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const num = raw === '' ? undefined : Number(raw);
                        patchField(i, { [c]: num !== undefined && Number.isFinite(num) ? num : undefined });
                      }}
                      aria-label={t(`fieldNum_${c}Aria`, { label: f.label || f.key || String(i + 1) })}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {/* Counters + the key error sit BELOW the control row, never inside
                it: the row is `u-flex … u-wrap`, so a counter appearing mid-typing
                would push the key/type/required/delete controls sideways and
                could wrap the delete button to a new line. */}
            {/* ALWAYS mounted, text toggled — never conditionally rendered. A
                live region that MOUNTS with content announces nothing, so a
                span that appears only once the key is invalid would stay silent
                at exactly the moment it matters. (This is the same trap
                `CharCount` above avoids; it was reintroduced here and caught by
                the /ux-review pass.) */}
            <span
              id={`key-err-${f._rid}`}
              className={keyInvalid(f.key) ? 'u-label-sm u-text-danger' : 'sr-only'}
              role="status"
            >{keyInvalid(f.key) ? t('fieldKeyInvalid') : ''}</span>
            <CharCount value={f.label} max={CAPS.label} />
            {/* UX_UPGRADE-forms F-G1 — optional per-field help text. Its own
                row so it can breathe at the width the guidance needs. */}
            <input
              value={f.description ?? ''}
              onChange={(e) => patchField(i, { description: e.target.value })}
              placeholder={t('fieldDescriptionPlaceholder')}
              aria-label={t('fieldDescriptionAria', { label: f.label || f.key || String(i + 1) })}
            />
            <CharCount value={f.description ?? ''} max={CAPS.description} />
          </div>
        ))}
        <div className="u-flex u-justify-start">
          <Button variant="quiet" onClick={() => editDraft((d) => ({ ...d, fields: [...d.fields, { key: '', label: '', type: 'text', required: false, _rid: nextRid() }] }))}><PlusIcon /> {t('addField')}</Button>
        </div>

        {/* ADR 0330 §D4 — the CRM destination is an OPTIONAL integration:
            the opt-in control renders only when the tenant's `crm` toggle
            is on; a form already opted in shows a passive notice instead
            (submissions keep landing; the contact sink skips). */}
        {crmAccess.enabled ? (
          <label className="u-label-sm u-flex u-gap-1 u-items-center">
            <input type="checkbox" checked={draft.createToContact} onChange={(e) => editDraft((d) => ({ ...d, createToContact: e.target.checked }))} />
            {t('createToContact')}
          </label>
        ) : draft.createToContact ? (
          <Notice variant="info">{t('crmDisabledNotice')}</Notice>
        ) : null}
        {/* ADR 0338 §D1 — designate ONE checkbox field as the explicit
            email marketing opt-in (renders only when email is enabled
            and a checkbox field exists). */}
        {emailAccess.enabled && (draft.fields.some((f) => f.type === 'checkbox' && f.key) || draft.emailOptInField) ? (
          <label className="u-label-sm">{t('emailOptInLabel')}
            <select value={draft.emailOptInField} onChange={(e) => editDraft((d) => ({ ...d, emailOptInField: e.target.value }))} className="u-w-auto">
              <option value="">{t('emailOptInNone')}</option>
              {draft.fields.filter((f) => f.type === 'checkbox' && f.key).map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
              {/* R2 FRM2-1 — a form whose stored opt-in no longer matches a
                  checkbox field (older data) keeps a visible, clearable entry
                  instead of an unrendered control the save error points at. */}
              {draft.emailOptInField && !draft.fields.some((f) => f.type === 'checkbox' && f.key === draft.emailOptInField)
                ? <option value={draft.emailOptInField}>{t('emailOptInMissing', { key: draft.emailOptInField })}</option>
                : null}
            </select>
          </label>
        ) : null}
        <label className="u-label-sm">{t('submitMessageLabel')}
          <input value={draft.submitMessage} onChange={(e) => editDraft((d) => ({ ...d, submitMessage: e.target.value }))} placeholder={t('submitMessagePlaceholder')} />
          <CharCount value={draft.submitMessage} max={CAPS.submitMessage} />
        </label>

        {/* ADR 0246 — route submissions to a priority-matrix intake list. */}
        <div className="surface-inset u-gap-2 u-flex u-flex-col">
          <div>
            <h3 className="u-fs-14 u-m-0">{t('intakeHeading')}</h3>
            <p className="u-label-sm u-m-0 muted">{t('intakeLede')}</p>
          </div>
          <label className="u-label-sm">{t('intakeListLabel')}
            <select value={draft.intake.listId} onChange={(e) => editDraft((d) => ({ ...d, intake: { ...d.intake, listId: e.target.value } }))} className="u-w-auto">
              <option value="">{t('intakeListOff')}</option>
              {(intakeLists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              {/* A saved list absent from the LOADED fetch (PM off / deleted)
                  must not silently read as "Not routed" — surface it so
                  re-saving is an explicit choice (FE#3). While still loading
                  (null), render the saved value so the select isn't blank. */}
              {draft.intake.listId && !(intakeLists ?? []).some((l) => l.id === draft.intake.listId)
                ? <option value={draft.intake.listId}>{intakeLists === null ? t('common:loading') : t('intakeListUnknown')}</option> : null}
            </select>
          </label>
          {intakeListsFailed ? <p className="u-label-sm u-m-0 muted" role="alert">{t('intakeListsFailed')}</p>
            : intakeLists === null ? <p className="u-label-sm u-m-0 muted" role="status">{t('common:loading')}</p>
            : intakeLists.length === 0 ? <p className="u-label-sm u-m-0 muted">{t('intakeNoLists')}</p> : null}
          {draft.intake.listId ? (
            draft.fields.some((f) => f.key.trim()) ? (
              // A <fieldset>/<legend> groups the 3 related mapping controls
              // for assistive tech (FORMSUX-3); an inner flex div keeps the
              // wrap layout (fieldset doesn't flex-shrink reliably).
              <fieldset className="u-border-none u-p-0 u-m-0">
                <legend className="u-label-sm muted u-p-0">{t('intakeMappingLegend')}</legend>
                <div className="u-flex u-gap-2 u-wrap">
                  {(['titleField', 'requesterField', 'notesField'] as const).map((slot) => (
                    <label key={slot} className="u-label-sm u-flex-1">{t(`intake_${slot}`)}
                      <select value={draft.intake[slot]} onChange={(e) => editDraft((d) => ({ ...d, intake: { ...d.intake, [slot]: e.target.value } }))}>
                        <option value="">{slot === 'titleField' ? t('intakePickRequired') : t('intakePickOptional')}</option>
                        {draft.fields.filter((f) => f.key.trim()).map((f) => <option key={f._rid} value={f.key}>{f.label || f.key}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              // A list is chosen but no keyed fields exist to map — say so
              // inline instead of only failing the save with a toast (FORMSUX-4).
              <p className="u-label-sm u-m-0 muted">{t('intakeNeedFields')}</p>
            )
          ) : null}
          {draft.intake.listId ? <p className="u-label-sm u-m-0 muted">{t('intakeEnableHint')}</p> : null}
        </div>

        {form.status === 'published' ? (
          <div className="surface-inset u-gap-1 u-flex u-flex-col">
            <span className="u-label-sm"><GlobeIcon /> {t('hostedUrlLabel')}</span>
            <div className="u-flex u-gap-1 u-items-center">
              <code className="u-flex-1 u-min-w-0 u-break-anywhere">{hostedFormUrl(form.formId)}</code>
              <Button variant="quiet" title={t('copyHostedUrl')} aria-label={t('copyHostedUrl')} onClick={() => copy(hostedFormUrl(form.formId))}><ClipboardIcon /></Button>
            </div>
            <span className="u-label-sm">{t('publicUrlLabel')}</span>
            <div className="u-flex u-gap-1 u-items-center">
              <code className="u-flex-1 u-min-w-0 u-break-anywhere">{publicFormUrl(form.formId)}</code>
              <Button variant="quiet" title={t('copyPublicUrl')} aria-label={t('copyPublicUrl')} onClick={() => copy(publicFormUrl(form.formId))}><ClipboardIcon /></Button>
            </div>
          </div>
        ) : <span className="u-label-sm">{t('publishToGetUrl')}</span>}
      </div>

      {/* Submissions for this form */}
      <div className="surface-card u-gap-2">
        <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
          <h2 className="u-fs-16 u-m-0 u-flex u-gap-1 u-items-center"><InboxIcon /> {t('submissionsHeading')}</h2>
          {subs && subs.length > 0 ? (
            <Button variant="quiet" size="sm" disabled={exporting} loading={exporting} onClick={() => void exportCsv()}>{t('exportCsv')}</Button>
          ) : null}
          {/* FORM-CSV-1 — the export's held-row opt-in, rendered only when there
              is something to opt into. Default OFF: the CSV is the bulk-import
              path, so its default must be the set that is safe to import. */}
          {subs && subs.length > 0 && loadedHeld > 0 ? (
            <CheckboxField
              label={t('csvIncludeHeld')}
              checked={exportIncludeHeld}
              onChange={(e) => setExportIncludeHeld(e.target.checked)}
            />
          ) : null}
          {/* FORM-UX-1b — the HELD filter. Counts the LOADED rows, so the label
              never promises to filter to history that is not on the page. */}
          {loadedHeld > 0 ? (
            <Button
              variant={subsHeldOnly ? 'secondary' : 'quiet'}
              size="sm"
              aria-pressed={subsHeldOnly}
              onClick={() => setSubsHeldOnly((v) => !v)}
            >{t('subsFilterHeld', { count: loadedHeld })}</Button>
          ) : null}
          {subs && subs.length > 3 ? (
            <input
              type="search"
              className="ui-input filterbar-search u-ml-auto"
              placeholder={t('subsFilterPlaceholder')}
              aria-label={t('subsFilterAria')}
              value={subsQuery}
              onChange={(e) => setSubsQuery(e.target.value)}
            />
          ) : null}
        </div>
        {/* ADR 0584 (FORM-UX-1) — THE OPERATOR SIGNAL. An abuse control that
            quarantines or refuses a submission used to leave nothing but a
            backend WARN line no surface reads, so a form losing 100% of its
            leads to a false-positive honeypot was indistinguishable from a form
            nobody submits. Rendered only when non-zero: a healthy form must not
            grow a permanent "0 flagged" ornament. */}
        {!subsFailed && (subsAbuse.flagged > 0 || subsAbuse.dropped > 0) ? (
          <Notice variant="warning" announce={t('subsAbuseNotice', { flagged: subsAbuse.flagged, dropped: subsAbuse.dropped })}>
            {t('subsAbuseNotice', { flagged: subsAbuse.flagged, dropped: subsAbuse.dropped })}
          </Notice>
        ) : null}
        {subsFailed ? (
          // FORM-UX-9 — a Retry that re-enters LOADING first, so the window
          // between click and settle shows a skeleton, never a stale empty list.
          <StateCard
            icon={<InboxIcon size={20} />} title={t('subsLoadFailedTitle')} body={t('subsLoadFailedBody')} announce
            action={<Button variant="secondary" onClick={() => setSubsAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
          />
        ) : !subs ? <Skeleton /> : subs.length === 0 ? <span className="u-label-sm">{t('noSubmissionsYet')}</span>
          : visibleSubs.length === 0 ? (
            <span className="u-flex u-items-center u-gap-2 u-label-sm">
              {t('subsNoMatch')}
              {/* FORM-UX-1b — clearing must undo BOTH filters, or the held chip
                  becomes its own dead end: "no match" beside a control that does
                  not reach the filter actually hiding the rows. */}
              <Button variant="quiet" size="sm" onClick={() => { setSubsQuery(''); setSubsHeldOnly(false); }}>{t('clearSearch')}</Button>
            </span>
          ) : visibleSubs.map((s) => {
            // R2 FRM2-8 — the row speaks the FORM's language, not the wire's:
            // field labels instead of machine keys, translated booleans, and an
            // expandable detail that shows full values + the attribution meta
            // the client type used to strip. R2 FRM2-14 — leads carry a TIME.
            const labelFor = (k: string): string => form.fields.find((f) => f.key === k)?.label ?? k;
            const show = (v: string | number | boolean): string =>
              typeof v === 'boolean' ? t(v ? 'valueYes' : 'valueNo') : String(v);
            const compact = Object.entries(s.values).map(([k, v]) => `${labelFor(k)}: ${show(v)}`).join(' · ');
            const metaEntries: Array<[string, string]> = [
              ...(s.meta?.referrer ? [[t('subMetaReferrer'), s.meta.referrer] as [string, string]] : []),
              ...Object.entries(s.meta?.utm ?? {}),
              ...Object.entries(s.meta?.context ?? {}),
            ];
            return (
              <details key={s.submissionId} className="surface-inset u-p-0 subs-row">
                <summary className="u-flex u-gap-2 u-items-center u-wrap subs-row__summary">
                  <span className="u-flex-1 subs-row__compact">{compact}</span>
                  {/* ADR 0584 (FORM-UX-1) — a QUARANTINED row, named. It is
                      stored so a false positive is recoverable, but no CRM
                      contact, ticket, consent write or funnel-completion EVENT
                      ran off it, so it must NOT wear the same chip as a routed
                      lead. The chip says WHICH control held it, because
                      "hidden-field trap" and "spam check" call for different
                      operator moves.

                      §Correction (FORM-FUNNEL-1) — this said "funnel
                      completion" and was HALF true: the ADR 0332 sink never
                      ran for a held row, but the funnel viewer's own advance
                      emitted `funnel.step_completed` regardless, because it
                      knew nothing about the submission it was advancing off.
                      Both emitters are now suppressed
                      (`funnels/routes.ts` — FORM-FUNNEL-1); the visitor still
                      moves to the next step on purpose, so the sentence is
                      about the EVENT, which is what inflates conversion. */}
                  {s.flagged ? (
                    <span className="chip chip--warning" title={t(s.flagged === 'honeypot' ? 'submissionHeldHoneypot' : 'submissionHeldGuard')}>
                      {t('submissionHeld')}
                    </span>
                  ) : s.contactId ? <span className="chip chip--success">{t('submissionContact')}</span> : s.error === 'suppressed' || s.error === 'erased' ? <span className="chip chip--muted" title={t('errSuppressedBody')}>{t('errSuppressed')}</span> : s.error ? <span className="chip chip--danger">{t(ERR_LABEL_KEY[s.error] ?? 'forms:submissionError')}</span> : null}
                  <span className="u-label-sm" title={s.createdAt}>{formatDateTime(s.createdAt)}</span>
                </summary>
                <dl className="subs-row__detail">
                  {Object.entries(s.values).map(([k, v]) => (
                    <div key={k}><dt>{labelFor(k)}</dt><dd>{show(v)}</dd></div>
                  ))}
                  {metaEntries.map(([k, v]) => (
                    <div key={`m:${k}`}><dt className="muted">{k}</dt><dd className="muted">{v}</dd></div>
                  ))}
                  {s.error === 'suppressed' || s.error === 'erased' ? (
                    <div key="suppressed"><dt className="muted">{t('errSuppressed')}</dt><dd className="muted">{t('errSuppressedBody')}</dd></div>
                  ) : null}
                </dl>
                {/* FORM-BUDGET-1 — the discard, on HELD rows only. The
                    quarantine budget is occupancy, so this is what gives it
                    back; without it, 1 000 held rows are permanent and the
                    only reset is deleting the form (and every real lead). */}
                {s.flagged ? (
                  <div className="u-flex u-justify-end u-p-2">
                    <Button variant="danger" size="sm" onClick={() => void discardHeld(s)}>{t('discardHeld')}</Button>
                  </div>
                ) : null}
              </details>
            );
          })}
        {/* Honest paginated search (rule 13, the Library posture): only the
            loaded page is searched — say so and keep Load-more reachable. */}
        {subsQuery.trim() && subsCursor ? <p className="u-label-sm muted u-m-0">{t('subsMoreMayMatch')}</p> : null}
        {subs && subsCursor ? (
          <Button variant="quiet" className="u-w-auto" onClick={() => { void listSubmissionsPage(orgId, form.formId, 100, subsCursor).then((r) => { setSubs((prev) => [...(prev ?? []), ...r.submissions]); setSubsCursor(r.nextCursor); }).catch(() => toast.error(t('subsLoadOlderFailed'))); }}>
            {t('loadOlderSubmissions')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
