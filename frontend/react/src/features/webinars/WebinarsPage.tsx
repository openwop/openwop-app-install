/**
 * Webinars dashboard (ADR 0404 §a) — the operator surface: list webinar marketing
 * events with registrant / attendee / no-show counts (derived on read from the
 * CRM activity stream), register an event, bind a registration form, and trigger
 * a backfill sync. Connecting Zoom + configuring its inbound webhook is the
 * Connections surface's job — this page deep-links there. Built on the shared ui/
 * design system.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { CalendarIcon, LinkIcon, RotateCwIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { listOrgs, listWebinarEvents, createWebinarEvent, bindWebinarForm, syncWebinarEvent, pushWebinarRegistrants, type MarketingEvent, type OrgRef } from './webinarsClient.js';
// WEB-G1 — the forms feature OWNS its list; read it rather than making the
// operator carry an opaque id (the ADR 0206 B4 cross-feature READ precedent this
// codebase already uses for media pickers).
import { listForms, type FormDef } from '../forms/formsClient.js';

/** R2 WB-SP-7 — map broker enums to operator copy (unknowns pass through). */
function connectorReason(t: TFnLocal, raw: string): string {
  if (raw === 'no_connection') return t('reasonNoConnection');
  if (raw.startsWith('zoom_401') || raw.startsWith('zoom_403')) return t('reasonUnauthorized');
  return raw;
}
type TFnLocal = ReturnType<typeof useTranslation>['t'];

export function WebinarsPage(): JSX.Element {
  const { t } = useTranslation('webinars');
  const { t: tc } = useTranslation('common');
  const access = useFeatureAccess('webinars');
  const navigate = useNavigate();
  // HG-4 — this page hand-rolled the org read and its catch wrote BOTH the empty
  // sentinel (`setOrgs([])`) and an error, so a failed read selected the zero-org
  // branch below and rendered "No workspace yet" — the wrong COLLECTION
  // (`listOrgs`, not `listMyWorkspaces`) making a claim about a list nobody had
  // read. The hook keeps `orgs` null on failure; `OrgSelectionState` owns the
  // noun and the order (failed → zero-orgs → children).
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<OrgRef>(listOrgs, access.enabled);
  const [events, setEvents] = useState<MarketingEvent[] | null>(null);
  // Distinguish "read failed" from "read succeeded and returned nothing". Without it
  // a failed read falls to `[]` and the empty state instructs "Add a Zoom webinar ID
  // above to start tracking" — telling the operator nothing is tracked when we simply
  // could not find out, and inviting a duplicate of a webinar that may already exist.
  const [eventsFailed, setEventsFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState('');

  const [providerEventId, setProviderEventId] = useState('');
  const [title, setTitle] = useState('');
  const [bindingFor, setBindingFor] = useState('');
  const [bindFormId, setBindFormId] = useState('');
  // The org's forms, for the binding picker + for naming an already-bound form.
  // A failed read degrades to "no forms" rather than blocking the dashboard.
  const [forms, setForms] = useState<FormDef[] | null>(null);

  // R2 WB-SP-6 — latest-wins (the forms effect beside this one already had a
  // guard): a slow OLD-org response could overwrite the new org's list, and
  // `events` wasn't reset on switch so stale rows rendered as the new org's.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!orgId) return;
    const seq = ++loadSeq.current;
    setError('');
    setEventsFailed(false);
    try { const rows = await listWebinarEvents(orgId); if (seq === loadSeq.current) setEvents(rows); }
    catch (e) { if (seq === loadSeq.current) { setEvents([]); setEventsFailed(true); setError(e instanceof Error ? e.message : String(e)); } }
  }, [orgId]);

  useEffect(() => { setEvents(null); void load(); }, [load]);
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void listForms(orgId).then((f) => { if (live) setForms(f); }).catch(() => { if (live) setForms([]); });
    return () => { live = false; };
  }, [orgId]);
  const formTitle = (formId: string): string | undefined => forms?.find((f) => f.formId === formId)?.title;

  const create = async (): Promise<void> => {
    if (!providerEventId.trim()) return;
    setBusy(true);
    try {
      const ev = await createWebinarEvent(orgId, { providerEventId: providerEventId.trim(), ...(title.trim() ? { title: title.trim() } : {}) });
      toast.success(t('eventCreated'));
      setProviderEventId(''); setTitle('');
      setEvents((cur) => (cur ? [{ ...ev, counts: ev.counts ?? { registrantCount: 0, attendeeCount: 0, noShowCount: 0 } }, ...cur.filter((e) => e.eventId !== ev.eventId)] : [ev]));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const submitBind = async (event: MarketingEvent): Promise<void> => {
    if (!bindFormId.trim()) return;
    try { await bindWebinarForm(orgId, event.eventId, bindFormId.trim()); toast.success(t('formBound')); setBindingFor(''); setBindFormId(''); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
  };

  const sync = async (event: MarketingEvent): Promise<void> => {
    setSyncing(event.eventId);
    try {
      const out = await syncWebinarEvent(orgId, event.eventId);
      // R2 WB-SP-8 — "Synced: 0 attended" right after a webinar is Zoom's
      // report LAG, not a result; say so instead of claiming success.
      if (out.outcome === 'synced' && (out.attendees ?? 0) === 0) toast.info(t('syncEmptyReport'));
      // review Minor 3 — a PARTIAL walk is not a full success: "0 no-shows" is
      // a claim the incomplete data cannot support.
      else if (out.outcome === 'synced' && out.partial) toast.info(t('syncPartial', { attendees: out.attendees ?? 0 }));
      else if (out.outcome === 'synced') toast.success(t('syncDone', { attendees: out.attendees ?? 0, noShows: out.noShows ?? 0 }));
      else if (out.outcome === 'cooldown') toast.info(t('syncCooldown'));
      // R2 WB-SP-7 — a raw broker enum ("no_connection", "zoom_401: …") is a
      // code, not an action; the known shapes get real copy.
      else toast.error(t('syncError', { reason: connectorReason(t, out.reason ?? '') }));
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setSyncing(''); }
  };

  const [pushing, setPushing] = useState('');
  const pushRegistrants = async (event: MarketingEvent): Promise<void> => {
    setPushing(event.eventId);
    try {
      const out = await pushWebinarRegistrants(orgId, event.eventId);
      // sent 0 with failures is NOT a success (the CC-SP-6/M2 lesson).
      if (out.pushed > 0 && out.failed === 0) toast.success(t('pushDone', { count: out.pushed }));
      else if (out.pushed > 0) toast.info(t('pushPartial', { pushed: out.pushed, failed: out.failed }));
      else toast.error(t('pushFailed', { reason: connectorReason(t, out.failures[0]?.reason ?? '') }));
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setPushing(''); }
  };

  if (access.loading) return <SkeletonRows rows={3} columns={[200, 90, 90, 90]} />;
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="webinars.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  // HG-4 — the local zero-org early return is gone: it sat BELOW nothing and
  // above everything, so `orgs === []` won whether the server had answered
  // "none" or the read had failed to `[]`. `OrgSelectionState` decides now.
  const orgPicker = orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <section className="u-grid u-gap-4" data-walkthrough="webinars.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={<span className="action-bar">{orgPicker}<Button variant="secondary" onClick={() => navigate('/connections')}>{t('connectZoom')}</Button></span>}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* The register form is inside as well as the list: with no organization
          there is nothing a submit could write to (`createWebinarEvent` takes
          `orgId`), and the form's disabled button said nothing about why. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<CalendarIcon />}>
      <form className="surface-card u-p-4 surface-form u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="u-flex u-items-center u-gap-2"><CalendarIcon size={16} /><strong>{t('registerEventTitle')}</strong></div>
        <p className="u-m-0 u-fs-12 u-text-muted">{t('registerEventHint')}</p>
        <div className="u-flex u-gap-3 u-flex-wrap">
          {/* The webinar id is the provider's own — say where to find it now that
              there is a help slot. */}
          <TextField label={t('fieldWebinarId')} help={t('fieldWebinarIdHelp')} value={providerEventId}
            onChange={(e) => setProviderEventId(e.target.value)} placeholder={t('webinarIdPlaceholder')} required />
          <TextField className="u-flex-1" label={t('fieldTitle')} value={title}
            onChange={(e) => setTitle(e.target.value)} placeholder={t('titlePlaceholder')} />
        </div>
        <div><Button variant="primary" type="submit" disabled={busy || !providerEventId.trim() || !orgId}>{t('registerEvent')}</Button></div>
      </form>

      {events === null ? <SkeletonRows rows={3} columns={[200, 90, 90, 90]} /> : eventsFailed ? (
        // Ordered ABOVE the empty branch: below it, `[]` selects the instruction first
        // and this is decorative.
        <StateCard announce icon={<CalendarIcon />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
      ) : events.length === 0 ? (
        <StateCard icon={<CalendarIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {events.map((ev) => (
            <li key={ev.eventId} className="surface-card u-p-4 u-grid u-gap-2">
              <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                <strong className="u-fs-16">{ev.title}</strong>
                <span className="chip chip--muted">{ev.provider}</span>
                {/* R2 WB-R2-3 — upcoming/past from startsAt (no invented "live"
                    state: we hold no duration to know it). WB-R2-5 — the time
                    carries the viewer's zone name, never a naked timestamp. */}
                {ev.startsAt ? (
                  <>
                    <span className={`chip ${new Date(ev.startsAt).getTime() > Date.now() ? 'chip--accent' : 'chip--muted'}`}>{new Date(ev.startsAt).getTime() > Date.now() ? t('upcoming') : t('past')}</span>
                    <span className="u-fs-12 u-text-muted">{formatDateTime(ev.startsAt, { timeZoneName: 'short' })}</span>
                  </>
                ) : null}
              </div>
              <div className="action-bar u-flex-wrap">
                <span className="chip chip--accent">{t('registrants', { n: ev.counts.registrantCount })}</span>
                <span className="chip chip--success">{t('attendees', { n: ev.counts.attendeeCount })}</span>
                <span className="chip chip--warning">{t('noShows', { n: ev.counts.noShowCount })}</span>
                {/* WEB-G2 — `formId` was in the payload and the chip said only
                    "Form bound". WHICH form is the whole point of the binding. */}
                {ev.formId ? (
                  <span className="chip chip--muted">
                    <LinkIcon size={12} />{' '}
                    {formTitle(ev.formId) ?? t('formBoundUnknown', { formId: ev.formId })}
                  </span>
                ) : null}
                {/* R2 WB-SP-9 — journeyId was settable and invisible. */}
                {ev.journeyId ? <span className="chip chip--muted">{t('journeyLinked')}</span> : null}
                {/* R3 WB-SP-9 remainder — connectionId was fetched and never
                    shown: which Zoom connection this event syncs through is a
                    routing fact the operator needs when several exist. Absent
                    = the org's default connection (say so, don't fabricate). */}
                {ev.connectionId ? (
                  <span className="chip chip--muted" title={ev.connectionId}>{t('connectionVia', { id: ev.connectionId.slice(0, 8) })}</span>
                ) : null}
                {/* R3 WB-SP-9 remainder — connectionId was fetched and never
                    shown: which Zoom connection this event syncs through is a
                    routing fact the operator needs when several exist. Absent
                    = the org's default connection (say so, don't fabricate). */}

                {/* R2 WB-SP-2 — registrations the sink could not push to Zoom:
                    these people have NO join link until an operator acts. */}
                {(ev.pendingPushCount ?? 0) > 0 ? <span className="chip chip--warning">{t('pendingPush', { count: ev.pendingPushCount ?? 0 })}</span> : null}
              </div>
              <div className="action-bar">
                <Button variant="quiet" onClick={() => { setBindingFor(bindingFor === ev.eventId ? '' : ev.eventId); setBindFormId(''); }} aria-expanded={bindingFor === ev.eventId}>{ev.formId ? t('rebindForm') : t('bindForm')}</Button>
                <Button variant="secondary" disabled={syncing === ev.eventId} aria-busy={syncing === ev.eventId} onClick={() => void sync(ev)}>
                  <RotateCwIcon size={14} /> {syncing === ev.eventId ? t('syncing') : t('syncAttendance')}
                </Button>
                {(ev.pendingPushCount ?? 0) > 0 ? (
                  <Button variant="secondary" disabled={pushing === ev.eventId} aria-busy={pushing === ev.eventId} onClick={() => void pushRegistrants(ev)}>
                    {pushing === ev.eventId ? t('pushing') : t('pushRegistrantsCta')}
                  </Button>
                ) : null}
              </div>
              {bindingFor === ev.eventId ? (
                <form className="u-flex u-gap-2 u-flex-wrap u-items-center" onSubmit={(e) => { e.preventDefault(); void submitBind(ev); }}>
                  {/* WEB-G1 — was a free-text id. Any string bound cleanly and the
                      dashboard then claimed a binding that could never deliver a
                      registrant. A picker makes an invalid id unreachable here,
                      and the route now refuses one anyway. */}
                  {forms === null ? (
                    <span className="u-fs-13 u-text-muted">{t('formsLoading')}</span>
                  ) : forms.length === 0 ? (
                    <span className="u-fs-13 u-text-muted">{t('noFormsAvailable')}</span>
                  ) : (
                    <>
                      <select value={bindFormId} onChange={(e) => setBindFormId(e.target.value)} aria-label={t('bindFormLabel')}>
                        <option value="">{t('bindFormChoose')}</option>
                        {forms.map((f) => <option key={f.formId} value={f.formId}>{f.title}</option>)}
                      </select>
                      <Button type="submit" variant="secondary" disabled={!bindFormId.trim()}>{t('bindFormSave')}</Button>
                    </>
                  )}
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      </OrgSelectionState>
    </section>
  );
}
