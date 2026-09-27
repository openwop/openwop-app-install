/**
 * Consent (host-extension product feature — ADR 0020).
 *
 * Gates on useFeatureAccess('consent'). An org picker → the per-tenant policy
 * (regulated regions + default mode) → a data-subject (GDPR) lookup/erase →
 * the consent records. Erase cascades to downstream subject data (Analytics).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { InlineState } from '../../ui/InlineState.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, SaveIcon, ShieldIcon, TrashIcon, UnlockIcon } from '../../ui/icons/index.js';
import {
  ConsentApiError, READMIT_ATTESTATION_MIN_CHARS,
  deleteSubject, getPolicy, getSubject, listOrgs, listRecords, readmitSubject, setPolicy,
  type ConsentPolicy, type ConsentRecord, type DefaultMode, type LegalHold, type Org, type SubjectErasureResult,
} from './consentClient.js';
import { ReadmitSubjectDialog } from './ReadmitSubjectDialog.js';

function CatChips({ c }: { c: ConsentRecord['categories'] }): JSX.Element {
  const { t } = useTranslation('consent');
  // R2 CN-SP-4 — per-channel specifics render (whatsapp:true used to display
  // as "necessary only" — actively wrong on the accountability surface for
  // the ADR 0394 strict-opt-in channel).
  const channels = (['marketing.email', 'marketing.sms', 'marketing.push', 'marketing.whatsapp'] as const)
    .filter((k) => c[k] === true);
  const anyMarketing = c.marketing || channels.length > 0;
  return (
    <>
      {c.analytics ? <span className="chip chip--success">{t('categoryAnalytics')}</span> : null}
      {c.marketing ? <span className="chip chip--success">{t('categoryMarketing')}</span> : null}
      {channels.map((k) => <span key={k} className="chip chip--success">{t(`channel_${k.split('.')[1]}`)}</span>)}
      {!c.analytics && !anyMarketing ? <span className="chip chip--muted">{t('categoryNecessaryOnly')}</span> : null}
    </>
  );
}

export function ConsentPage(): JSX.Element {
  const { t } = useTranslation('consent');
  const { t: tCommon } = useTranslation('common');
  const f = useFormat();
  const access = useFeatureAccess('consent');
  // `.catch(() => setOrgs([]))` rendered the "No organizations — create one
  // first" instruction over a failed read, and left `orgId` '' so the page's
  // own read never started. Both facts, one value.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [policy, setPolicyState] = useState<ConsentPolicy | null>(null);
  const [regions, setRegions] = useState('');
  const [mode, setMode] = useState<DefaultMode>('opt-in');
  const [records, setRecords] = useState<ConsentRecord[] | null>(null);
  const [lookupKey, setLookupKey] = useState('');
  /**
   * CONS-UX-3 — the lookup result now carries the KEY IT WAS FETCHED FOR and can
   * be `failed`.
   *
   * It used to be a bare `ConsentRecord | 'none' | null`, set only on success and
   * reset only by `load()` or a completed erase, while the input's `onChange`
   * moved the key alone. Three reachable failures followed: look up alice then
   * type bob and alice's consent state stands unlabelled under bob's key; look up
   * alice (no record), then look up bob and have the read FAIL, and "No consent
   * record for that subject" persists as a confident claim about bob after a
   * transient toast; and the stale panel sits directly above an Erase button
   * enabled by the KEY FIELD, not by the lookup — so what is on screen and what
   * will be erased were unrelated by construction.
   */
  const [lookup, setLookup] = useState<{ key: string; result: ConsentRecord | 'none' | 'failed' } | null>(null);
  // NAMED for its one job. `setError` is called in exactly ONE place — the
  // getPolicy catch below — while save/lookup/erase all use `toast.error`. The
  // generic name invited the belief that this was a page-wide error channel;
  // it never was, and the StateCard below now consumes it. If a second caller
  // ever appears, the name makes the mismatch visible instead of silent.
  const [policyError, setPolicyError] = useState<string | null>(null);
  // CONS-4 / CONS-UX-2 — an active LEGAL HOLD blocks erasure server-side (409).
  // Held on the page so the operator learns it BEFORE committing to the
  // irreversible action, not from the failure of a request they already sent.
  const [legalHold, setLegalHold] = useState<LegalHold | null>(null);
  const [busy, setBusy] = useState(false);
  // CONS-G1 — the erasure outcome persists on the page as a RECEIPT. A toast is
  // not evidence, and this is the one action an operator may later have to
  // demonstrate they performed (GDPR Art. 5(2) accountability).
  // CONS-UX-1/-12 — the receipt carries its ORG rather than being cleared by
  // `load()`. `load()`'s `setReceipt(null)` meant retrying an unrelated records
  // read wiped the one artifact the operator may later have to show a regulator.
  // Scoping it by org keeps the CN-SP-5 property (org A's receipt must not show
  // under org B) without a mechanism that any reload can trip.
  // `seq` keys the receipt Notice so a retry that lands the SAME numbers still
  // remounts it and re-announces (CONS-UX-29/-30): the old receipt stays until
  // this one replaces it, and the replacement is always spoken.
  const [receipt, setReceipt] = useState<({ orgId: string; subjectKey: string; seq: number } & SubjectErasureResult) | null>(null);
  const receiptSeq = useRef(0);
  // CONS-UX-5 — the irreversible action has a pending state. Both the Erase
  // button and the receipt's Retry read it; the handler refuses re-entry on it.
  const [erasing, setErasing] = useState(false);
  // CONS-UX-29 — the receipt's Retry is the control the operator is ON when the
  // retry fires. `loading` disables it (browsers drop focus from a disabled
  // control), so remember that it held focus and hand it back once the new
  // receipt has replaced the old one.
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const refocusRetry = useRef(false);
  useEffect(() => {
    if (erasing || !refocusRetry.current) return;
    refocusRetry.current = false;
    retryRef.current?.focus();
  }, [erasing, receipt]);
  // CONS-UX-33 — a 409 `legal_hold` refusal is a DURABLE refused state on the
  // page. It used to be a toast plus a `load()` that re-read the policy — and
  // when THAT read failed the hold Notice never appeared, so the only trace of
  // the refusal was six seconds of toast. Org-scoped like the receipt; cleared
  // only by a later erasure outcome for the same org.
  const [heldRefusal, setHeldRefusal] = useState<{ orgId: string; subjectKey: string } | null>(null);
  // ADR 0657 D7 — re-admit. `readmit` is the open dialog (the subject it is
  // for); the outcome persists on the page like the receipt does, because a
  // re-admit is a governance decision the operator may have to show later.
  const [readmit, setReadmit] = useState<{ subjectKey: string } | null>(null);
  const [readmitBusy, setReadmitBusy] = useState(false);
  const [readmitError, setReadmitError] = useState<string | null>(null);
  const [readmitOutcome, setReadmitOutcome] = useState<{ orgId: string; subjectKey: string; outcome: 'readmitted' | 'not_erased' } | null>(null);
  // §4.5 collection kit — gated search + a category facet (a real enum) and a
  // region facet built from the distinct values present. `region` is free-form
  // policy text (the regulated-regions input), so its VALUES stay raw.
  const [recordQuery, setRecordQuery] = useState('');
  const [recordCategory, setRecordCategory] = useState('');
  const [recordRegion, setRecordRegion] = useState('');

  useEffect(() => {
    if (!access.enabled) return;
  }, [access.enabled]);

  // CONS-G4 — a failed records read must not render as "No consent records"
  // on the surface an operator consults for GDPR accountability. `null` +
  // `recordsFailed` = the read failed (designed error state with retry);
  // `[]` = the org genuinely has none.
  const [recordsFailed, setRecordsFailed] = useState(false);
  // R2 CN-SP-7 — sequence-stamped: a rapid org switch must never paint the
  // previous org's policy/records (or keep its erasure receipt) on screen.
  const loadSeq = useRef(0);
  const load = useCallback((org: string) => {
    const seq = ++loadSeq.current;
    const fresh = (): boolean => seq === loadSeq.current;
    setPolicyError(null); setRecords(null); setLookup(null); setRecordsFailed(false); setLegalHold(null);
    // CONS-UX-1/-12 — deliberately NOT `setReceipt(null)`. The receipt is
    // org-scoped at render, so CN-SP-5 still holds, and a Retry on the records
    // list no longer destroys the erasure evidence.
    void getPolicy(org).then(({ policy: p, legalHold: h }) => { if (!fresh()) return; setPolicyState(p); setRegions(p.regulatedRegions.join(', ')); setMode(p.defaultMode); setLegalHold(h); }).catch((e) => { if (fresh()) setPolicyError(e instanceof Error ? e.message : t('loadPolicyFailed')); });
    void listRecords(org).then((rs) => { if (fresh()) setRecords(rs); }).catch(() => { if (fresh()) setRecordsFailed(true); });
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);


  // CONS-G3 — unsaved policy edits are real state: say so (chip + Save gating)
  // and never let an org switch silently discard them.
  const dirty = policy != null && (regions !== policy.regulatedRegions.join(', ') || mode !== policy.defaultMode);
  const onPickOrg = useCallback(async (nextOrg: string) => {
    if (nextOrg === orgId) return;
    if (dirty && !(await confirm({ title: t('discardEditsTitle'), body: t('discardEditsBody'), confirmLabel: t('discardEditsConfirm') }))) return;
    setOrgId(nextOrg);
  }, [dirty, orgId, setOrgId, t]);

  const savePolicy = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const regulatedRegions = regions.split(',').map((r) => r.trim()).filter(Boolean);
      // R2 CN-SP-3 — adopt the server's answer: discarding it left the
      // "Unsaved changes" chip lit after a SUCCESSFUL save, and an org switch
      // then offered to "discard" edits that were already saved.
      const saved = await setPolicy(orgId, { regulatedRegions, defaultMode: mode });
      setPolicyState(saved);
      setRegions(saved.regulatedRegions.join(', '));
      setMode(saved.defaultMode);
      toast.success(t('policySaved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [orgId, regions, mode, t]);

  const doLookup = useCallback(async (override?: string) => {
    const key = (override ?? lookupKey).trim();
    if (!orgId || !key) return;
    // CONS-UX-3 — the result is stamped with the key it describes, and a FAILED
    // read gets its own state. It was `toast.error` only, so a transient failure
    // left the previous subject's panel (or "No consent record for that
    // subject") standing under the new key: a false-empty plus a misattribution,
    // on the surface an operator uses to answer an Art. 15 request.
    try { const r = await getSubject(orgId, key); setLookup({ key, result: r ?? 'none' }); }
    catch (e) { setLookup({ key, result: 'failed' }); toast.error(e instanceof Error ? e.message : t('lookupFailed')); }
  }, [orgId, lookupKey, t]);

  const doErase = useCallback(async (override?: string) => {
    const key = (override ?? lookupKey).trim();
    if (!orgId || !key) return;
    // CONS-4 — never open the confirm for an action the server will refuse.
    // The exit is stated in the Notice above the panel, not left to be guessed.
    if (legalHold) { toast.error(t('legalHoldEraseDisabled')); return; }
    // CONS-G2 — the confirm named the key and nothing else. This deletes the
    // consent record AND fans out to every registered feature eraser across
    // every LINKED identity key (a CDP session key and a CRM contact id for the
    // same person both get purged), and it cannot be undone. Say so at the
    // moment of decision, not in a docblock.
    // CONS-UX-5 — a second click mid-flight must not re-open the confirm.
    if (erasing) return;
    // CONS-UX-32 — the subject key is TYPED to arm the button: the blast radius
    // of this action is every feature store, across every linked identity key,
    // and it cannot be undone (SET-R2-1's threshold for type-to-confirm).
    if (!(await confirm({ title: t('eraseConfirm', { subjectKey: key }), body: t('eraseConfirmBody'), danger: true, typeToConfirm: key }))) return;
    // CONS-UX-29 — deliberately NOT `setReceipt(null)` here. The previous
    // receipt stays mounted (busy) until the new one replaces it, so a retry
    // does not blank the evidence mid-flight, and the Retry control the
    // operator is on does not vanish under their focus.
    refocusRetry.current = typeof document !== 'undefined' && document.activeElement === retryRef.current;
    setErasing(true);
    try {
      const result = await deleteSubject(orgId, key);
      setLookup(null);
      setHeldRefusal(null);
      setReadmitOutcome(null);
      // CONS-UX-1 — the field is cleared ONLY on a clean erasure. It used to be
      // cleared here unconditionally, BEFORE the `failed > 0` branch, so a
      // PARTIAL erasure disabled both Look up and Erase (`disabled={!lookupKey
      // .trim()}`) while the receipt told the operator to "run it again" — the
      // only way to obey was to re-read the key out of the receipt sentence and
      // retype it. A gate with no exit, on the irreversible action.
      if (result.erasure.failed === 0) setLookupKey('');
      load(orgId);
      // CONS-G1 — a partial erasure is NOT a success. `failed` counts feature
      // stores that still hold this subject's data.
      setReceipt({ orgId, subjectKey: key, seq: ++receiptSeq.current, ...result });
      // CONS-UX-30 — the RECEIPT is the one announcer of the outcome. The three
      // outcome toasts that used to fire here were the announcement, and their
      // text out-claimed or under-said the receipt (the `foundNothing` toast
      // never named the home-workspace step). Toast + an announced Notice is
      // the DS-8 double (`toast.tsx` speaks through the same live region), so
      // the toasts went, not the receipt's voice.
    }
    catch (e) {
      // A hold can be placed between the page load and this click, so the
      // failure must name the real cause instead of a generic "Erase failed".
      //
      // Review F10 — this branched on `/legal hold/i.test(msg)`. Two defects in
      // one line: an English substring test in a 4-locale app, AND — worse —
      // `deleteSubject` never parsed the response body, so the message was
      // always `deleteSubject returned 409` and the pattern could never match
      // in ANY locale. The hold branch was unreachable; the operator saw a raw
      // status string. It now reads the server's STABLE machine code, which
      // `ConsentApiError` carries through.
      const held = e instanceof ConsentApiError && e.code === 'legal_hold';
      const msg = e instanceof Error ? e.message : '';
      // CONS-UX-33 — a hold refusal persists on the page (announced by the
      // Notice itself, assertively — a failed action). No toast: same live
      // region, and the Notice outlives it.
      if (held) setHeldRefusal({ orgId, subjectKey: key });
      else toast.error(msg || t('eraseFailed'));
      // Re-read so the Notice appears and the control locks for the next click.
      load(orgId);
    }
    finally { setErasing(false); }
  }, [orgId, lookupKey, legalHold, erasing, load, t]);

  // ADR 0657 D7 — clear the erasure tombstone for a subject who asked to
  // return. Grants NO consent (the server writes a `governance_decision` and
  // nothing else); the outcome is a durable statement on the page.
  const doReadmit = useCallback(async (attestation: string) => {
    if (!orgId || !readmit) return;
    const key = readmit.subjectKey;
    setReadmitBusy(true);
    setReadmitError(null);
    try {
      const result = await readmitSubject(orgId, key, attestation);
      setReadmit(null);
      if (result.readmitted) {
        setReadmitOutcome({ orgId, subjectKey: key, outcome: 'readmitted' });
      } else {
        // `not_erased` is information, not a failure: there was no tombstone to
        // clear. The InlineState below carries it; the toast speaks it (the
        // `empty` kind has no live region of its own).
        setReadmitOutcome({ orgId, subjectKey: key, outcome: 'not_erased' });
        toast.info(t('readmitNotErased', { subjectKey: key }));
      }
    } catch (e) {
      // ADV-UX-3 — the failure renders INSIDE the dialog, which stays open so
      // the attestation the operator wrote is not lost. Branch on the CODE.
      const api = e instanceof ConsentApiError ? e : null;
      if (api?.status === 403) setReadmitError(t('readmitForbidden'));
      else if (api?.code === 'validation_error') setReadmitError(t('readmitAttestationTooShort', { min: READMIT_ATTESTATION_MIN_CHARS }));
      else setReadmitError((e instanceof Error && e.message) || t('readmitFailed'));
    } finally { setReadmitBusy(false); }
  }, [orgId, readmit, t]);
  const openReadmit = useCallback((subjectKey: string) => { setReadmitError(null); setReadmit({ subjectKey }); }, []);
  const readmitControl = (subjectKey: string, hintKey: 'readmitHintAfterErasure' | 'readmitHintNoRecord'): JSX.Element => (
    <>
      <span className="muted u-fs-12">{t(hintKey)}</span>
      <div className="action-bar">
        <Button variant="secondary" size="sm" onClick={() => openReadmit(subjectKey)}>
          <UnlockIcon /> {t('readmitButton')}
        </Button>
      </div>
    </>
  );

  const regionOptions = useMemo(
    () => (records ? Array.from(new Set(records.map((r) => r.region).filter((x): x is string => !!x))).sort() : []),
    [records],
  );
  const visibleRecords = useMemo(() => {
    const list = records ?? [];
    const q = recordQuery.trim().toLowerCase();
    return list.filter((r) => {
      if (recordRegion && r.region !== recordRegion) return false;
      // R2 review F4 — the facet must see channel specifics exactly like the
      // chips do: a whatsapp-only record is MARKETING, not "necessary only".
      const anyMarketing = r.categories.marketing
        || r.categories['marketing.email'] === true || r.categories['marketing.sms'] === true
        || r.categories['marketing.push'] === true || r.categories['marketing.whatsapp'] === true;
      if (recordCategory === 'analytics' && !r.categories.analytics) return false;
      if (recordCategory === 'marketing' && !anyMarketing) return false;
      if (recordCategory === 'necessary' && (r.categories.analytics || anyMarketing)) return false;
      if (q && !`${r.subjectKey} ${r.region ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, recordQuery, recordCategory, recordRegion]);
  const clearRecordFilters = (): void => { setRecordQuery(''); setRecordCategory(''); setRecordRegion(''); };

  if (access.loading) return <Skeleton />;
  /**
   * CONS-5 — the DATA-SUBJECT panel survives the toggle being off.
   *
   * This used to return the locked StateCard for the WHOLE page, so with
   * `consent` off (its default) the only DSAR erasure surface the product ships
   * was unreachable — while every other feature kept writing subject PII
   * regardless. The backend routes are now RBAC-gated but not toggle-gated for
   * exactly that reason, and ungating them without this would have left the
   * obligation reachable only by curl.
   *
   * What stays gated: the consent REGIME — the policy editor and the records
   * list. Those are the product a tenant turns on. What does not: looking a
   * subject up and erasing them.
   */
  const regimeEnabled = access.enabled;

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => void onPickOrg(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="consent.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now. This page had it inverted (the skeleton was
          checked ABOVE the zero-org branch); taking the policy form, the
          data-subject panel and the records list as the CHILD makes the right
          order unskippable. `load()` is gated on `orgId`, so with no organization
          the records read never starts and `records` stays `null` — the skeleton
          below keys on THAT sentinel, never on `orgs`. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
        <>
          {/* CN-RACE-1 — the policy form renders ONLY once the policy is known.
              Before this gate, `mode` showed its invented `'opt-in'` initial
              state (:56) while `policy` was still null, so the page asserted a
              default mode that might not be this tenant's — INVENTED data, not
              absent data, on a surface where the value is legally meaningful.
              Worse, an edit made in that window set `mode` while `dirty` stayed
              false (it requires `policy != null`), so there was no chip, Save
              stayed disabled, and the load then silently reverted the choice.
              `onPickOrg`'s discard-confirm keys off the same `dirty`, so such an
              edit could also be dropped on an org switch with no prompt.
              Gating on presence makes all three impossible by construction.
              THREE states, not two — a sabotage probe caught the first draft
              getting this wrong. Gating on presence ALONE strands a FAILED load
              behind a skeleton that will never resolve (the permanent-skeleton
              defect PR 2978 already fixed once on this page). But falling through to the FORM on error is
              worse: it renders the invented `'opt-in'` again, which is the very
              lie this gate exists to stop. So:
                  loading -> skeleton
                  failed  -> a StateCard with the reason + Retry (CN-RACE-5)
                  loaded  -> the form
              The records + data-subject panels stay OUTSIDE the gate; they own
              their own `records === null` skeleton and must keep painting. */}
          {/* CONS-5 — the consent REGIME (policy editor + records) is what the
              toggle buys. With it off, say so here instead of locking the whole
              page and taking the DSAR console down with it. */}
          {!regimeEnabled ? (
            <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
          ) : policy == null ? (policyError == null ? (
            /* /ux-review: the bare `<Skeleton />` was wrong twice. It is
               `aria-hidden` (ui/Skeleton.tsx:20), so a screen-reader user got
               SILENCE where the form had been — worse than the fiction it
               replaced, for that user. And it is a single <span>, not a
               form-shaped card, so the page jumped when the policy landed.
               Adopting `PrivacyPage.tsx:36`'s idiom: role="status" + an sr-only
               label, inside the SAME `surface-card` the form uses, with rows
               approximating the two fields + the action row. */
            <div className="surface-card u-p-4 surface-form" role="status">
              <span className="sr-only">{t('common:loading')}</span>
              <Skeleton width="40%" />
              <Skeleton />
              <Skeleton width="30%" />
              <Skeleton />
              <Skeleton width="25%" />
            </div>
          ) : (
            /* CN-RACE-5 — a failed load used to render NOTHING here, leaving a
               full page reload as the only way forward. One surface with the
               next action attached, matching `MemoryBrowser.tsx:139` and the
               failed-orgs branch this page already routes through StateCard. */
            <StateCard
              icon={<ShieldIcon />}
              title={t('policyLoadFailedTitle')}
              body={policyError ?? t('loadPolicyFailed')}
              /* StateCard's OWN announce prop, not a hand-rolled effect. The
                 <Notice variant="error"> this replaced carried role="alert" +
                 aria-live (Notice.tsx:90); StateCard deliberately has none (its
                 :38 docblock: a region mounted WITH content announces nothing),
                 so it delegates imperatively via this prop. My first cut wrote
                 its own useEffect — it worked, but `check-failure-card-announce`
                 rightly rejected it: a second mechanism for one job is how the
                 ratchet loses the ability to see whether a card announces.
                 It is a BOOLEAN: StateCard announces its own `title`, so the
                 title must carry the meaning — the detail lives in `body`. */
              announce
              action={<Button variant="secondary" size="sm" onClick={() => { if (orgId) load(orgId); }}>{t('policyLoadRetry')}</Button>}
            />
          )) : (
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('regulatedRegionsLabel')}</span>
              <input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder={t('regulatedRegionsPlaceholder')} />
              {/* R2 CN-SP-2 — this field is DECLARATIVE: no enforcement path
                  reads it (subjects carry no region to match). Saying so beats
                  letting an operator believe a region list fails anything
                  closed. Enforcement = the default mode + per-record consent. */}
              <span className="muted u-fs-12">{t('regulatedRegionsNotEnforced')}</span>
            </label>
            <label className="u-grid u-gap-1 is-narrow">
              <span className="u-label-sm">{t('defaultModeLabel')}</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as DefaultMode)}>
                <option value="opt-in">{t('defaultModeOptInLabel')}</option>
                <option value="opt-out">{t('defaultModeOptOutLabel')}</option>
              </select>
            </label>
            {dirty ? <span className="chip chip--warning">{t('unsavedChanges')}</span> : null}
            <Button variant="primary" disabled={busy || !policy || !dirty} onClick={() => void savePolicy()} title={!dirty && policy ? t('nothingToSave') : undefined}><SaveIcon /> {t('savePolicy')}</Button>
          </div>
          )}

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0 u-flex u-gap-1 u-items-center"><ShieldIcon /> {t('dataSubjectTitle')}</h2>
            {/* CONS-4 / CONS-UX-2 — the hold is a BLOCKING statement above the
                controls, with the exit named (a superadmin lifts it). Announced,
                because it changes what the operator is allowed to do and there
                is no toast on load to carry it. */}
            {legalHold ? (
              <Notice variant="warning" announce={t('legalHoldTitle')}>
                <strong>{t('legalHoldTitle')}</strong>{' '}
                {t('legalHoldBody', { reason: legalHold.reason, since: f.dateTime(legalHold.since) })}
              </Notice>
            ) : null}
            <div className="surface-form">
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('subjectKeyLabel')}</span>
                <input
                  value={lookupKey}
                  /* CONS-UX-3 — editing the key INVALIDATES the result. Without
                     this, alice's consent state stayed on screen, unlabelled,
                     under bob's key. */
                  onChange={(e) => { setLookupKey(e.target.value); setLookup(null); }}
                  placeholder={t('subjectKeyPlaceholder')}
                />
              </label>
              <div className="action-bar">
                <Button variant="quiet" disabled={!lookupKey.trim()} onClick={() => void doLookup()}>{t('lookup')}</Button>
                <Button
                  variant="danger"
                  disabled={!lookupKey.trim() || legalHold != null}
                  loading={erasing}
                  title={legalHold ? t('legalHoldEraseDisabled') : undefined}
                  onClick={() => void doErase()}
                ><TrashIcon /> {t('erase')}</Button>
              </div>
            </div>
            {/* CONS-UX-33 — the refused state outlives the request and the
                policy re-read that follows it. */}
            {heldRefusal && heldRefusal.orgId === orgId ? (
              <Notice variant="error" announce={t('eraseFailedHeld')}>
                <strong>{t('eraseRefusedHeldTitle')}</strong>{' '}
                {t('eraseRefusedHeldBody', { subjectKey: heldRefusal.subjectKey })}
              </Notice>
            ) : null}
            {/* CONS-UX-30 — the receipt ANNOUNCES (politely; a success or a
                warning). It is the one voice for the outcome now that the
                handler's toasts are gone (DS-8 — see `doErase`). The announced
                text is the receipt's own headline sentence, so the
                `foundNothing` home-workspace instruction is spoken, not just
                shown. Keyed on `seq` so an identical retry outcome remounts and
                re-announces instead of standing silently. */}
            {receipt && receipt.orgId === orgId ? (
              /* HIGH-2 — `failed === 0` alone does NOT earn the green receipt.
                 `foundNothing` (erasers reported, zero rows anywhere) is a third
                 outcome the wire has carried all along with zero frontend
                 consumers: either the subject genuinely had no data HERE, or
                 their data lives in another workspace — erasure is tenant-scoped
                 by design (the WF-TWIN-3 correction), so a DSAR run from a shared
                 workspace never reaches a person's home-workspace data. Painting
                 that green told the operator an erasure happened that reached
                 nothing. The backend records the same outcome as
                 `erasure_no_data_found`, never `erasure_complete`. */
              <Notice
                key={receipt.seq}
                variant={receipt.ok ? (receipt.erasure.foundNothing ? 'warning' : 'success') : 'warning'}
                announce={receipt.ok
                  ? (receipt.erasure.foundNothing
                      ? t('receiptFoundNothing', { subjectKey: receipt.subjectKey, keys: receipt.erasure.keysResolved, total: receipt.erasure.total })
                      : t('receiptOk', { subjectKey: receipt.subjectKey, keys: receipt.erasure.keysResolved, total: receipt.erasure.total }))
                  : t('receiptPartial', { subjectKey: receipt.subjectKey, failed: receipt.erasure.failed, total: receipt.erasure.total })}
              >
                {receipt.ok
                  ? (receipt.erasure.foundNothing
                      ? t('receiptFoundNothing', { subjectKey: receipt.subjectKey, keys: receipt.erasure.keysResolved, total: receipt.erasure.total })
                      : t('receiptOk', { subjectKey: receipt.subjectKey, keys: receipt.erasure.keysResolved, total: receipt.erasure.total }))
                  : t('receiptPartial', { subjectKey: receipt.subjectKey, failed: receipt.erasure.failed, total: receipt.erasure.total })}
                {/* R2 CN-SP-6 — the failed systems are NAMED: an anonymous
                    count gives the operator nothing to escalate with. */}
                {!receipt.ok && receipt.erasure.failedFeatures && receipt.erasure.failedFeatures.length > 0 ? (
                  <> {t('receiptFailedFeatures', { features: receipt.erasure.failedFeatures.join(', ') })}</>
                ) : null}
                {' '}
                {receipt.consentRecord ? t('receiptHadRecord') : t('receiptNoRecord')}
                {/* CONS-UX-28 — the rows actually deleted or scrubbed, when the
                    erasers reported them. */}
                {typeof receipt.erasure.rowsTouched === 'number' ? (
                  <> {t('receiptRowsTouched', { count: receipt.erasure.rowsTouched })}</>
                ) : null}
                {/* CONS-UX-27 — erasers the host EXPECTED but that never
                    registered: its own line under its own label. Not a failure
                    (nothing threw) and never folded into the failed-systems
                    sentence, which would claim a store ran and broke. */}
                {receipt.erasure.missing && receipt.erasure.missing.length > 0 ? (
                  <div className="u-mt-1">{t('receiptMissing', { features: receipt.erasure.missing.join(', ') })}</div>
                ) : null}
                {!receipt.ok ? (
                  <>
                    {' '}{t('receiptRetry')}
                    {/* CONS-UX-1 — the retry the receipt PRESCRIBES now has an
                        affordance, bound to the receipt's own subject key, so it
                        works even if the field has been changed since. This is
                        the shape PR 3378 established one feature over: keep the
                        form and relabel it "Try again". CONS-UX-29 — busy while
                        the retry runs; the receipt stays mounted around it. */}
                    <div className="action-bar u-mt-2">
                      <Button ref={retryRef} variant="danger" size="sm" loading={erasing} onClick={() => void doErase(receipt.subjectKey)}>
                        <TrashIcon /> {t('retryErasure')}
                      </Button>
                    </div>
                  </>
                ) : (
                  /* ADR 0657 D7 (CONS-UX-24) — a completed erasure (including a
                     zero-row one: the tombstone is written either way, D1)
                     is where the operator learns the door back exists. The
                     wire carries no "is tombstoned" bit on a lookup, so the
                     control keys on the two facts this page CAN know: an
                     erasure completed here this session, or a lookup found no
                     record (below). */
                  <div className="u-grid u-gap-1 u-mt-2">{readmitControl(receipt.subjectKey, 'readmitHintAfterErasure')}</div>
                )}
              </Notice>
            ) : null}
            {/* ADR 0657 D7 — the re-admit outcome persists like the receipt does. */}
            {readmitOutcome && readmitOutcome.orgId === orgId ? (
              readmitOutcome.outcome === 'readmitted' ? (
                <Notice variant="success" announce={t('readmitDone', { subjectKey: readmitOutcome.subjectKey })}>
                  {t('readmitDone', { subjectKey: readmitOutcome.subjectKey })}
                </Notice>
              ) : (
                <InlineState kind="empty" message={t('readmitNotErased', { subjectKey: readmitOutcome.subjectKey })} />
              )
            ) : null}
            {lookup?.result === 'failed' ? (
              /* CONS-UX-3 — a FAILED read is its own designed state, never the
                 'none' copy. Announced, because the operator has to know that
                 nothing is known — the opposite of "no consent record". */
              <StateCard
                announce
                icon={<ShieldIcon />}
                title={t('lookupFailedTitle')}
                body={t('lookupFailedBody', { subjectKey: lookup.key })}
                action={<Button variant="secondary" size="sm" onClick={() => void doLookup(lookup.key)}>{tCommon('retry')}</Button>}
              />
            ) : lookup?.result === 'none' ? (
              <div className="surface-inset u-grid u-gap-1">
                <span className="u-label-sm">{t('lookupResultFor', { subjectKey: lookup.key })}</span>
                <span className="u-label-sm">{t('lookupNoRecord')}</span>
                {/* ADR 0657 D7 (CONS-UX-24) — "no record" is what an ERASED
                    subject looks like on this wire (the lookup cannot tell a
                    never-seen key from a tombstoned one), so the door back is
                    offered here; `not_erased` answers the other case honestly. */}
                {readmitControl(lookup.key, 'readmitHintNoRecord')}
              </div>
            ) : lookup ? (
                <div className="surface-inset u-grid u-gap-1">
                  {/* CONS-UX-3 — the panel NAMES the subject it describes. It
                      rendered chips, region, timestamp, source, basis and
                      purposes, and never the key. */}
                  <span className="u-label-sm">{t('lookupResultFor', { subjectKey: lookup.key })}</span>
                  <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <CatChips c={lookup.result.categories} />
                  {lookup.result.region ? <span className="chip chip--muted">{lookup.result.region}</span> : null}
                  <span className="u-label-sm">{f.dateTime(lookup.result.ts)}</span>
                  {/* R2 CN-SP-4 — provenance rode the wire unseen: HOW this
                      consent was captured is the accountability question. */}
                  {lookup.result.source ? <span className="muted u-fs-12">{t('sourceLine', { source: lookup.result.source })}</span> : null}
                  {lookup.result.legalBasis ? <span className="chip chip--muted u-fs-11">{t('legalBasisLine', { basis: lookup.result.legalBasis })}</span> : null}
                  {lookup.result.purposes && lookup.result.purposes.length > 0 ? <span className="muted u-fs-12">{t('purposesLine', { purposes: lookup.result.purposes.join(', ') })}</span> : null}
                  </div>
                </div>
              ) : null}
          </div>

          {/* CONS-5 — the records list is the consent REGIME's collection; it is
              empty by construction when the regime is off. */}
          {regimeEnabled ? (
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('recordsTitle')}</h2>
            {records && records.length > 3 ? (
              <div className="filterbar" role="group" aria-label={t('recordsFilterGroup')}>
                <input
                  type="search"
                  className="ui-input filterbar-search"
                  placeholder={t('recordsSearchPlaceholder')}
                  aria-label={t('recordsSearchAria')}
                  value={recordQuery}
                  onChange={(e) => setRecordQuery(e.target.value)}
                />
                <select className="ui-input filterbar-select" aria-label={t('categoryFacetAria')} value={recordCategory} onChange={(e) => setRecordCategory(e.target.value)}>
                  <option value="">{t('categoryAll')}</option>
                  <option value="analytics">{t('categoryAnalytics')}</option>
                  <option value="marketing">{t('categoryMarketing')}</option>
                  <option value="necessary">{t('categoryNecessaryOnly')}</option>
                </select>
                {regionOptions.length > 1 ? (
                  <select className="ui-input filterbar-select" aria-label={t('regionFacetAria')} value={recordRegion} onChange={(e) => setRecordRegion(e.target.value)}>
                    <option value="">{t('regionAll')}</option>
                    {regionOptions.map((rg) => <option key={rg} value={rg}>{rg}</option>)}
                  </select>
                ) : null}
              </div>
            ) : null}
            {recordsFailed ? (
              <StateCard announce icon={<ShieldIcon />} title={t('recordsLoadFailedTitle')} body={t('recordsLoadFailedBody')} action={<Button variant="secondary" size="sm" onClick={() => orgId && load(orgId)}>{tCommon('retry')}</Button>} />
            ) : !records ? <Skeleton /> : records.length === 0 ? (
              <StateCard icon={<ShieldIcon />} title={t('noRecordsTitle')} body={t('noRecords')} />
            ) : visibleRecords.length === 0 ? (
              <StateCard icon={<ShieldIcon />} title={t('recordsNoMatchTitle')} body={t('recordsNoMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearRecordFilters}>{t('recordsClearFilters')}</Button>} />
            ) : visibleRecords.map((r) => (
              <div key={r.subjectKey} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                <code className="u-flex-1">{r.subjectKey}</code>
                <CatChips c={r.categories} />
                {/* region is free-form policy text (regulated-regions input) — value stays raw */}
                {r.region ? <span className="chip chip--muted">{r.region}</span> : null}
                <span className="u-label-sm" title={r.ts}>{f.date(r.ts)}</span>
              </div>
            ))}
          </div>
          ) : null}
        </>
      </OrgSelectionState>
      {readmit ? (
        <ReadmitSubjectDialog
          subjectKey={readmit.subjectKey}
          busy={readmitBusy}
          error={readmitError}
          errorAnnounce={readmitError ?? undefined}
          onConfirm={(attestation) => void doReadmit(attestation)}
          onCancel={() => { if (!readmitBusy) { setReadmit(null); setReadmitError(null); } }}
        />
      ) : null}
    </div>
  );
}
