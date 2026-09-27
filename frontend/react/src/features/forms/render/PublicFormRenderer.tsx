/**
 * ADR 0331 §D1 — the ONE public form fill renderer. Fetches the published
 * render schema from the existing public JSON API, renders the fields as
 * `ui/Field` controls, validates through the shared ADR 0197 engine
 * (`deriveFields.ts`), and submits back to the same API — so every host
 * surface (CMS `form` section, the `/f/:formId` hosted page, funnel-bound
 * pages) shares one fill experience and the server's abuse controls.
 *
 * Public-surface posture: no authed clients, no feature-access hooks —
 * published-only + toggle-on is enforced server-side, and ANY failure to
 * resolve the form renders `renderUnavailable` (default: nothing), never a
 * draft-existence leak. The honeypot rides as a visually-hidden input the
 * server named in the render schema; bots fill it, people never see it.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { config, fetchOpts } from '../../../client/config.js';
import { Notice } from '../../../ui/Notice.js';
import { Skeleton } from '../../../ui/Skeleton.js';
import { CheckboxField, SelectField, TextField, TextareaField } from '../../../ui/Field.js';
import type { FieldError } from '../../../runs/inputSchemaForm.js';
import { validatePublicField, validatePublicValues, type PublicFormField } from './deriveFields.js';
import { useFormEmbed } from './embedContext.js';

interface RenderSchema {
  formId: string;
  title: string;
  fields: PublicFormField[];
  honeypotField: string;
  submitMessage?: string;
}

export interface PublicFormRendererProps {
  formId: string;
  /** ADR 0332 — opaque embed context persisted onto the submission's meta. */
  context?: Record<string, string>;
  onSubmitted?: (submissionId: string) => void;
  /** Rendered when the form is missing/unpublished/toggled off (uniform 404).
   *  FORM-UX-4: an OVERRIDE now, not the only thing standing between a visitor
   *  and blank space — see the default below. */
  renderUnavailable?: () => React.ReactNode;
  /** Hide the form title (the embedding surface already shows its own). */
  hideTitle?: boolean;
  /** Heading level for the form title — the hosted page passes 'h1' so the
   *  public document has a proper heading root (FRMX-7). */
  titleAs?: 'h1' | 'h2';
}

const ROOT = () => `${config.baseUrl}/host/openwop-app/public-forms`;

/** FORM-UX-3 — the draft-key namespace. Every key this component writes starts
 *  with it, so the legacy sweep below can find (and drop) the unscoped ones. */
const DRAFT_PREFIX = 'owp-form-draft:';
/** FORM-UX-3 — how long an unsent draft may sit on a device. Long enough to
 *  survive a genuine interruption (a phone call, a tab switch, a reload), short
 *  enough that a shared machine is not carrying a stranger's answers into the
 *  afternoon. Paired with the visit key, not a substitute for it. */
const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * FORM-UX-3 — the per-VISIT id. `sessionStorage` is scoped to one tab and dies
 * with it, so this is the closest thing a public page has to "the same person,
 * still here". Falls back to an in-memory id when storage is unavailable
 * (private mode, sandboxed iframe) — which simply means no resume, the safe
 * direction: a resume that cannot be scoped must not happen.
 */
let memoryVisitKey: string | null = null;
function visitKey(): string {
  const mint = (): string => `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = sessionStorage.getItem('owp-form-visit');
    if (existing) return existing;
    const next = mint();
    sessionStorage.setItem('owp-form-visit', next);
    return next;
  } catch {
    memoryVisitKey = memoryVisitKey ?? mint();
    return memoryVisitKey;
  }
}

/**
 * FORM-UX-3 — drop every draft that is not THIS VISIT's, plus anything past the
 * TTL. Runs on mount, so a device that already carries a previous visitor's
 * unscoped draft is cleaned the first time any form renders on it — the
 * migration half, without which this fix would not reach the devices that
 * actually have the problem.
 *
 * ADR 0584 §Correction (FORM-DRAFT-1) — THIS VISIT'S, not THIS FORM'S. The
 * first cut spared only the exact `currentKey`, so every OTHER form's draft
 * from the same live visit was deleted on mount. A funnel with a form on step 1
 * and a different form on step 2: the visitor part-fills step 1, clicks
 * Continue, step 2 mounts under a new `formId`, this effect re-runs and wipes
 * step 1 — so the in-page Back showed an empty form that had resumed correctly
 * BEFORE the fix. Same on a CMS page rendering two forms, or on either one
 * re-mounting through the new Retry. The visit id, not the form id, is what
 * scoping is about; sparing one key made the migration a data-loss bug.
 */
function pruneStaleDrafts(visit: string): void {
  try {
    const now = Date.now();
    const doomed: string[] = [];
    const mine: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      // A form id may itself contain ':' (`form:<uuid>`), so the visit is the
      // SUFFIX, never a positional segment.
      (k.endsWith(`:${visit}`) ? mine : doomed).push(k);
    }
    // Another visit's (or a legacy unscoped) key goes unconditionally; every one
    // of THIS visit's is judged on age.
    for (const k of doomed) localStorage.removeItem(k);
    for (const k of mine) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { savedAt?: number };
        if (typeof parsed?.savedAt !== 'number' || now - parsed.savedAt > DRAFT_TTL_MS) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); /* a non-JSON legacy blob cannot be aged — drop it */ }
    }
  } catch { /* private mode / quota — best-effort by design */ }
}

/** GC-FRM-6 (grade pass 2026-07-10) — in-flight fetch dedupe: a CMS page can
 *  render the SAME form in several sections; concurrent mounts share ONE
 *  request. Deliberately NOT a TTL cache (definitions change — only the
 *  in-flight promise is shared; it clears on settle). */
const inFlightForms = new Map<string, Promise<RenderSchema>>();
function fetchPublicForm(formId: string): Promise<RenderSchema> {
  const existing = inFlightForms.get(formId);
  if (existing) return existing;
  const p = fetch(`${ROOT()}/${encodeURIComponent(formId)}`, fetchOpts({}))
    .then(async (r) => {
      if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
      return (await r.json()) as RenderSchema;
    })
    .finally(() => { inFlightForms.delete(formId); });
  inFlightForms.set(formId, p);
  return p;
}

export function PublicFormRenderer({ formId, context, onSubmitted, renderUnavailable, hideTitle, titleAs }: PublicFormRendererProps): JSX.Element | null {
  const { t } = useTranslation('forms');
  // ADR 0339 §D2 — an embedding surface (funnel viewer) can supply context +
  // an onSubmitted hook via the provider; explicit props win on key conflicts.
  const embed = useFormEmbed();
  // R2 F2 — 'unavailable' means the SERVER answered 404 (missing/unpublished,
  // the uniform-404 posture); 'loadFailed' means the READ failed (5xx/network)
  // — a different fact that must never claim "the link is out of date".
  const [schema, setSchema] = useState<RenderSchema | null | 'unavailable' | 'loadFailed'>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [honeypot, setHoneypot] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'failed'>('idle');
  const [submitFailure, setSubmitFailure] = useState<'transient' | 'capacity' | 'rejected' | 'tooLarge'>('transient');
  // FRMB-IDEM — one at-most-once key per fill session: a network retry or
  // double-click replays the same submission server-side (no duplicate lead).
  // Guarded: this is a PUBLIC surface that can render inside http:// embeds,
  // where non-secure contexts lack crypto.randomUUID (unlike the auth-walled
  // app, which is always https). Fallback stays unique-enough for dedupe.
  const mintClientKey = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `fk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const [clientKey, setClientKey] = useState(mintClientKey);
  const successRef = useRef<HTMLDivElement | null>(null);
  // F-G2 — "validate late, revalidate early": a field is only judged once the
  // visitor has LEFT it (blur), and thereafter re-judged as they type, so we
  // never shout at someone mid-word but do clear the error the moment it's fixed.
  const [touched, setTouched] = useState<Record<string, true>>({});
  const summaryId = useId();
  // F-G3 — the summary needs to move focus to a control, and `ui/Field` mints
  // its own ids, so hold the elements directly. (A `[name="…"]` selector was
  // the first cut and was WRONG: it needs `CSS.escape`, which is absent in
  // jsdom and in older embedded webviews — exactly where a public form runs.)
  const controlRefs = useRef<Record<string, HTMLElement | null>>({});

  // R2 F-G5 — save-and-resume, the Tally model: unsent answers persist in THIS
  // BROWSER only (localStorage; they never leave the device, so no server-side
  // partial-capture privacy decision is needed). Restored on return with a
  // visible notice + a start-over control; cleared on successful submit.
  //
  // FORM-UX-3 (ADR 0584) — WHAT THIS GOT WRONG, and why it was a Blocker. The
  // key was `owp-form-draft:<formId>` — the FORM id alone. No TTL, no expiry, no
  // visitor scoping, and cleared only on a SUCCESSFUL submit or an explicit
  // "Start over". So on any shared device — a public terminal, a lent tablet, the
  // "kiosk/table-top" use the "Submit another response" button below was
  // explicitly built for — an abandoned half-filled form was restored to the
  // NEXT PERSON, under copy asserting it was theirs: "We restored *your*
  // in-progress answers". A stranger's name, email and free text.
  //
  // Two changes close it, and both are needed:
  //   1. VISIT SCOPING. The key carries a per-visit id held in `sessionStorage`,
  //      which the browser scopes to ONE TAB and discards when that tab closes.
  //      A different person on the same device is, by construction, a different
  //      visit — so the bleed cannot happen rather than being unlikely to.
  //   2. A TTL. A visit that stays open for hours (a kiosk tab nobody closes) is
  //      the case scoping alone does not cover, so a draft older than
  //      `DRAFT_TTL_MS` is dropped rather than restored.
  // Plus a MIGRATION: legacy unscoped keys already on real devices are PURGED on
  // mount, never read. Leaving them readable would have made this fix cosmetic
  // for exactly the devices that already carry someone else's answers.
  const [resumed, setResumed] = useState(false);
  const visit = visitKey();
  const draftKey = `${DRAFT_PREFIX}${formId}:${visit}`;
  useEffect(() => {
    let active = true;
    setSchema(null); setValues({}); setErrors([]); setTouched({}); setState('idle'); setResumed(false);
    // FORM-UX-3 — BEFORE any read: drop other VISITS' drafts (incl. the legacy
    // unscoped keys) and anything past the TTL. Scoped by visit, never by form
    // — see `pruneStaleDrafts` (FORM-DRAFT-1).
    pruneStaleDrafts(visit);
    void fetchPublicForm(formId)
      // A schema whose `fields` isn't an array renders the unavailable state
      // rather than crashing every `schema.fields.map` below (pricing-'*' class).
      .then((s) => {
        if (!active) return;
        if (!Array.isArray(s?.fields)) { setSchema('unavailable'); return; }
        setSchema(s);
        try {
          const raw = localStorage.getItem(draftKey);
          if (raw) {
            // FORM-UX-3 — a TIMESTAMPED envelope. A blob with no `savedAt` is a
            // pre-ADR-0584 draft (or a tampered one) and is refused, not read:
            // the whole point is that an un-ageable draft is exactly the one
            // that outlives its visitor.
            const env = JSON.parse(raw) as { savedAt?: number; values?: Record<string, unknown> };
            if (typeof env?.savedAt !== 'number' || Date.now() - env.savedAt > DRAFT_TTL_MS || !env.values) {
              localStorage.removeItem(draftKey);
              return;
            }
            const draft = env.values;
            // R2R R3 — restore only TYPE-compatible values: a field whose type
            // changed since the draft was saved (string into a now-checkbox, or
            // vice versa) would pass client validation and then 400 server-side
            // with nothing visibly wrong — or worse, record a consent the UI
            // never showed as checked.
            const typeOf = new Map(s.fields.map((f) => [f.key, f.type]));
            const entries = Object.entries(draft).filter(([k, v]) => {
              const ft = typeOf.get(k);
              if (!ft) return false;
              return ft === 'checkbox' ? typeof v === 'boolean' : typeof v === 'string';
            });
            if (entries.length > 0) { setValues(Object.fromEntries(entries) as Record<string, string | boolean>); setResumed(true); }
          }
        } catch { /* private mode / quota — resume is best-effort by design */ }
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status = (err as { status?: number }).status;
        setSchema(status === 404 || status === 410 ? 'unavailable' : 'loadFailed');
      });
    return () => { active = false; };
  }, [formId, draftKey, visit, loadAttempt]);

  if (schema === 'unavailable') {
    // FORM-UX-4 (ADR 0584) — this used to be `renderUnavailable?.() ?? null`,
    // i.e. RENDER NOTHING unless the embedder remembered to pass a state. Only
    // the hosted `/f/:formId` page ever did. So a deleted, unpublished or
    // toggled-off form VANISHED from a public marketing page while its own
    // eyebrow and heading stayed on screen — the visitor read "Get in touch"
    // over blank space — and on a funnel step, where advance only fires on
    // submit, it became a DEAD END WITH NO EXIT. The default is now a designed
    // state; `renderUnavailable` remains the per-surface override, and an
    // embedding surface can supply one through the provider (the funnel does,
    // and its version carries the way forward).
    const supplied = renderUnavailable ?? embed?.renderUnavailable;
    if (supplied) return <>{supplied()}</>;
    return (
      <div className="u-grid u-gap-2 u-justify-start">
        <Notice variant="info">{t('fillUnavailable')}</Notice>
      </div>
    );
  }
  if (schema === 'loadFailed') {
    // Rendered on EVERY surface incl. embeds — a funnel step that silently
    // showed nothing on a network blip dead-ended the visitor (R2 F2).
    return (
      <div role="alert" className="u-grid u-gap-2 u-justify-start">
        <p className="u-m-0">{t('fillLoadFailed')}</p>
        <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setLoadAttempt((n) => n + 1)}>{t('common:retry')}</button>
      </div>
    );
  }
  // RUX-1 (grade pass 2026-07-10) — a designed loading state (the full-page
  // canon), not a bare muted line; role=status so SR users hear the wait.
  if (schema === null) return <div className="u-p-2" role="status" aria-label={t('common:loading', { defaultValue: 'Loading…' })}><Skeleton /></div>;

  const errFor = (key: string): string | undefined => {
    const e = errors.find((x) => x.name === key);
    return e ? t(`runs:${e.key}`, e.values ?? {}) : undefined;
  };

  /** Re-judge ONE field through the same engine submit uses, and splice its
   *  result into the error list (never touching the other fields' errors). */
  const revalidate = (key: string, nextValues: Record<string, string | boolean>): void => {
    const found = validatePublicField(schema.fields, key, nextValues);
    setErrors((prev) => [...prev.filter((e) => e.name !== key), ...(found ? [found] : [])]);
  };

  /** Change handler: record the value, and re-judge only a field the visitor
   *  has already left (so typing into a fresh field stays quiet). */
  const onValue = (key: string, v: string | boolean): void => {
    setValues((prevValues) => {
      const nextValues = { ...prevValues, [key]: v };
      if (touched[key]) revalidate(key, nextValues);
      // FORM-UX-3 — stamped, so the draft can be AGED. An unstamped bag cannot
      // expire, and a draft that cannot expire is the shared-device defect.
      try { localStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), values: nextValues })); } catch { /* best-effort */ }
      return nextValues;
    });
  };

  /** Blur handler: the field has been left, so it's now fair to judge it. */
  const onBlurField = (key: string): void => {
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    revalidate(key, values);
  };

  /** F-G3 — the error summary's ordered problem list, in FIELD order (not the
   *  order the engine happened to emit), each linking to its control. */
  const summary = schema.fields
    .filter((f) => errors.some((e) => e.name === f.key))
    .map((f) => ({ key: f.key, label: f.label, message: errFor(f.key) ?? '' }));

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    const found = validatePublicValues(schema.fields, values);
    setErrors(found);
    // Everything has now been judged, so every field is "touched" — typing a
    // fix clears its error immediately instead of waiting for another submit.
    setTouched(Object.fromEntries(schema.fields.map((f) => [f.key, true as const])));
    if (found.length > 0) {
      // RUX-1 — move focus to the first invalid control so keyboard/SR users
      // land on the problem, not on the submit button. ui/Field stamps
      // aria-invalid on the control once the error state commits; rAF fires
      // after that commit.
      const formEl = ev.currentTarget as HTMLFormElement;
      requestAnimationFrame(() => {
        formEl.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setState('submitting');
    try {
      const body: Record<string, unknown> = { values: { ...values, [schema.honeypotField]: honeypot }, clientKey };
      const mergedContext = { ...(embed?.context ?? {}), ...(context ?? {}) };
      if (Object.keys(mergedContext).length > 0) body.context = mergedContext;
      // R2 F5 — the submit API has accepted referrer + UTM attribution since
      // ADR 0226 and no first-party surface ever sent them: the marketing
      // attribution this feature exists to capture was dark end-to-end. Page
      // metadata only (where the visitor came from) — never form content;
      // the server bounds both. sessionKey (the identity-link lane) stays
      // deliberately unsent pending its consent wiring.
      if (typeof document !== 'undefined' && document.referrer) body.referrer = document.referrer;
      if (typeof window !== 'undefined') {
        const utm: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(window.location.search)) {
          if (k.startsWith('utm_') && v) utm[k] = v;
        }
        if (Object.keys(utm).length > 0) body.utm = utm;
      }
      const r = await fetch(`${ROOT()}/${encodeURIComponent(formId)}/submit`, fetchOpts({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
      const res = (await r.json()) as { submissionId?: string };
      // FORM-UX-1 (ADR 0584) — THE INVARIANT: a submission id is the only proof
      // the server stored anything, so nothing downstream of "we received this"
      // may happen without one. A 2xx carrying no id gets the REJECTED failure
      // state, not a thank-you.
      //
      // What this replaces (R2 F8): "Both callbacks now fire on any 2xx", chosen
      // because gating on the id left a funnel showing "Thanks" while never
      // advancing — "an observable inconsistency that leaked more than advancing
      // does". The reasoning was sound and the premise was wrong: the fix for
      // "thanks without an advance" is not "advance without a submission", it is
      // to stop saying thanks. The server no longer produces an id-less 2xx at
      // all (a tripped abuse control now quarantines and returns a real id), so
      // this branch should be unreachable in practice — which is exactly why it
      // must be honest rather than optimistic: a client that trusts an id-less
      // 2xx re-opens the whole defect the moment any surface produces one.
      const submissionId = typeof res.submissionId === 'string' ? res.submissionId : '';
      if (!submissionId) {
        setSubmitFailure('rejected');
        setState('failed');
        return;
      }
      setState('done');
      try { localStorage.removeItem(draftKey); } catch { /* best-effort */ }
      onSubmitted?.(submissionId); embed?.onSubmitted?.(submissionId);
    } catch (err) {
      // R2 F3 — differentiate what retrying can and cannot fix: 429 = the form
      // is not taking submissions (retrying now is futile); 413/400 = the
      // server rejected the CONTENT (retrying unchanged answers is futile);
      // everything else = transient, retry is honest. Typed answers are
      // preserved in all cases and clientKey makes retry safe.
      //
      // ADR 0584 §Correction (FORM-429-1) — `capacity` COVERS TWO SERVER FACTS
      // and the copy used to assert one of them. A 429 means either the form
      // hit its 50 000-lead ceiling (permanent) or its quarantine budget is
      // full, and the second is reached by a FALSE POSITIVE more often than by
      // a bot — a real person whose password manager filled the decoy was told
      // "this form is at capacity", which is not true of the form and not true
      // for anyone else submitting it. The copy is now true of both, and it
      // deliberately does NOT distinguish them: telling this respondent
      // "your submission was flagged" is the spam oracle the honeypot exists
      // to deny, so the honest sentence is the one that fits both without
      // naming which. `fillErrorCapacity` carries the recovery that actually
      // exists (contact the sender) instead of "try again", which is futile in
      // the first case and unreliable in the second.
      const status = (err as { status?: number }).status;
      // FRMUX-4 — 413 is a THIRD fact, not a 400. A 400 means a field failed
      // validation ("review your answers" is actionable); a 413 means the
      // answers TOGETHER exceed the 20 000-character total, which every field
      // passed individually and which the respondent cannot see anywhere. Telling
      // them to "review" was futile in exactly the way the comment above says a
      // retry prompt must not be. Name the bound, so shortening is possible.
      setSubmitFailure(status === 429 ? 'capacity' : status === 413 ? 'tooLarge' : status === 400 ? 'rejected' : 'transient');
      setState('failed');
    }
  };

  if (state === 'done') {
    // FRMX-2 — the form unmounts on success; land focus on the confirmation
    // so keyboard/SR users aren't dropped to <body> (Notice also announces).
    // R2 F7 — "submit another": kiosk/table-top and multi-entry embeds needed a
    // remount before. Resets everything INCLUDING the idempotency key (reusing
    // it would dedupe the second submission into the first).
    return <div ref={(el) => { if (el && successRef.current !== el) { successRef.current = el; el.focus(); } }} tabIndex={-1} className="u-grid u-gap-2">
      <Notice variant="success" announce={schema.submitMessage || t('fillSuccessDefault')}>{schema.submitMessage || t('fillSuccessDefault')}</Notice>
      <button
        type="button" className="fp-btn fp-btn--ghost u-w-auto"
        onClick={() => {
          // R2R R4/R5 — reset EVERYTHING the last fill set (incl. the resumed
          // notice, or a blank form claims restored answers) and land focus on
          // the first control instead of <body> (the kiosk flow this serves).
          setValues({}); setErrors([]); setTouched({}); setHoneypot(''); setResumed(false); setSubmitFailure('transient'); setClientKey(mintClientKey()); setState('idle');
          const first = schema.fields[0]?.key;
          if (first) requestAnimationFrame(() => controlRefs.current[first]?.focus());
        }}
      >{t('fillSubmitAnother')}</button>
    </div>;
  }

  return (
    <form className="u-grid u-gap-2" onSubmit={(e) => { void submit(e); }} noValidate>
      {hideTitle ? null : titleAs === 'h1' ? <h1 className="u-fs-16 u-m-0">{schema.title}</h1> : <h2 className="u-fs-16 u-m-0">{schema.title}</h2>}
      {/* F-G3 — the error SUMMARY. Focus still lands on the first invalid control
          (FRMX-2/RUX-1, unchanged), so this is announced via role="alert" rather
          than stealing focus; each entry links to its control for pointer users
          and for anyone who tabs back up. Listed in FIELD order so it reads as
          the form does. */}
      {resumed ? (
        <p className="u-label-sm muted u-m-0 u-flex u-gap-2 u-items-center">
          {t('fillResumedNotice')}
          <button type="button" className="fp-btn fp-btn--ghost" onClick={() => { setValues({}); setErrors([]); setTouched({}); setResumed(false); try { localStorage.removeItem(draftKey); } catch { /* best-effort */ } }}>{t('fillStartOver')}</button>
        </p>
      ) : null}
      {summary.length > 0 ? (
        <div className="form-error-summary" role="alert" aria-labelledby={summaryId}>
          <p className="form-error-summary__title" id={summaryId}>{t('fillErrorSummaryTitle', { count: summary.length })}</p>
          <ul className="form-error-summary__list">
            {summary.map((p2) => (
              <li key={p2.key}>
                {/* A BUTTON, not a link: this moves focus within the page, it
                    does not navigate — and `ui/Field`'s generated ids give us no
                    stable fragment to honestly point an href at. */}
                <button type="button" className="form-error-summary__jump" onClick={() => controlRefs.current[p2.key]?.focus()}>
                  {p2.label}
                </button>{': '}{p2.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {schema.fields.map((f) => {
        const err = errFor(f.key);
        // F-G1 — authored help text, wired by ui/Field through aria-describedby.
        const common = {
          label: f.label,
          required: f.required,
          ...(f.description ? { help: f.description } : {}),
          ...(err ? { error: err } : {}),
        };
        const onBlur = (): void => onBlurField(f.key);
        const ref = (el: HTMLElement | null): void => { controlRefs.current[f.key] = el; };
        if (f.type === 'checkbox') {
          return <CheckboxField key={f.key} ref={ref} {...common} name={f.key} checked={values[f.key] === true} onBlur={onBlur} onChange={(e) => onValue(f.key, e.target.checked)} />;
        }
        if (f.type === 'select') {
          return (
            <SelectField key={f.key} ref={ref} {...common} name={f.key} value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''} onBlur={onBlur} onChange={(e) => onValue(f.key, e.target.value)}>
              <option value="">{t('fillSelectPlaceholder')}</option>
              {(Array.isArray(f.options) ? f.options : []).map((o) => <option key={o} value={o}>{o}</option>)}
            </SelectField>
          );
        }
        if (f.type === 'textarea') {
          return <TextareaField key={f.key} ref={ref} {...common} name={f.key} rows={4} value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''} onBlur={onBlur} onChange={(e) => onValue(f.key, e.target.value)} />;
        }
        return (
          <TextField
            key={f.key}
            ref={ref}
            {...common}
            type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : 'text'}
            // F9 — native constraint attrs on number fields: the browser's own
            // spinner/scrubbing respects them, and they document the bounds to
            // AT before our validation copy fires. The authored values are the
            // SAME ones both validators enforce — one source, three surfaces.
            {...(f.type === 'number' && f.min !== undefined ? { min: f.min } : {})}
            {...(f.type === 'number' && f.max !== undefined ? { max: f.max } : {})}
            {...(f.type === 'number' && f.step !== undefined ? { step: f.step } : {})}
            value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
            onBlur={onBlur}
            onChange={(e) => onValue(f.key, e.target.value)}
          />
        );
      })}
      {/* Honeypot — named by the server, invisible to people (ADR 0017 abuse controls). */}
      <div className="visually-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" name={schema.honeypotField} value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>
      {/* FORM-UX-10 (ADR 0584) — this Notice passed NO `announce`, so it relied
          on `role="alert"` announcing on insertion. `ui/Notice.tsx:18-21` says in
          terms that this is "widely reported" but "NOT verified here and MUST NOT
          be treated as established", citing PR 2615 as the bug that shipped from
          exactly that assumption. This is the highest-stakes of the three error
          Notices in the feature: if the assumption is wrong, a respondent using a
          screen reader presses Submit on the app's ONLY internet-facing form and
          is told nothing — while the success path beside it routes correctly
          through `GlobalLiveRegion`. Routed through the same region now, which
          also REPLACES the component's own role (never both — the DS-8
          double-announce). */}
      {state === 'failed' ? (
        <Notice
          variant="error"
          announce={t(submitFailure === 'capacity' ? 'fillErrorCapacity' : submitFailure === 'tooLarge' ? 'fillErrorTooLarge' : submitFailure === 'rejected' ? 'fillErrorRejected' : 'fillErrorGeneric')}
        >
          {t(submitFailure === 'capacity' ? 'fillErrorCapacity' : submitFailure === 'tooLarge' ? 'fillErrorTooLarge' : submitFailure === 'rejected' ? 'fillErrorRejected' : 'fillErrorGeneric')}
        </Notice>
      ) : null}
      <div>
        <button type="submit" className="fp-btn fp-btn--primary" disabled={state === 'submitting'}>
          {state === 'submitting' ? t('fillSubmitting') : t('fillSubmit')}
        </button>
      </div>
    </form>
  );
}
