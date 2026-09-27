/**
 * Email Marketing (host-extension product feature — ADR 0019).
 *
 * Gates on useFeatureAccess('email'). An org picker → templates (create/edit/
 * delete) → campaigns (pick template + audience stage → create → send) with
 * per-campaign stats + an inline send log (each recipient sent / skipped /
 * failed). Sends resolve the audience live from CRM and consent-gate marketing.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { Modal } from '../../ui/Modal.js';
import { TextField } from '../../ui/Field.js';
import { formatNumber, formatRelativeTime } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { InlineState } from '../../ui/InlineState.js';
import { SuppressionsPanel } from './SuppressionsPanel.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { getProviderStatus, type ProviderStatus } from './emailClient.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, PlusIcon, SaveIcon, SendIcon, TrashIcon, SparklesIcon } from '../../ui/icons/index.js';
import {
  createCampaign, createTemplate, deleteCampaign, listCampaigns, listOrgs, listSegments,
  listSends, listTemplates, sendCampaign, sendTestEmail, getEmailSettings, putEmailSettings, getSegmentEstimate, getEngagement, CONTACT_STAGES, type EmailBodyFormat,
  type Campaign, type ContactStage, type EmailSegment, type EmailTemplate, type Org, type SendLog,
} from './emailClient.js';
import { TemplateCard, TemplateRow } from './EmailTemplateViews.js';

type AudienceMode = 'all' | 'stage' | 'segment';

const campChip = (s: Campaign['status']): string => (s === 'sent' ? 'chip chip--success' : s === 'sending' ? 'chip chip--warning' : 'chip chip--muted');
const SKIP_REASONS = new Set(['no_email', 'consent', 'suppressed', 'frequency']);

const sendChip = (s: SendLog['status']): string => (s === 'sent' ? 'chip chip--success' : s === 'failed' ? 'chip chip--danger' : 'chip chip--muted');

export function EmailPage(): JSX.Element {
  const { t } = useTranslation('email');
  const access = useFeatureAccess('email');
  // EM-UX-6 — tri-state, not `[] | null`: `null` is "not heard back yet",
  // `'error'` is "the read FAILED" and an array is the server's answer. The old
  // catch wrote `[]`, so a failed read rendered "No templates yet · Create one
  // above" — an instruction over data the page could not see (§4.6 rule 2).
  const [templates, setTemplates] = useState<EmailTemplate[] | null | 'error'>(null);
  const [campaigns, setCampaigns] = useState<Campaign[] | null | 'error'>(null);
  const [error, setError] = useState<string | null>(null);
  // The list views of the tri-states — `[]` while loading OR failed, so
  // selection/lookups keep working; the RENDER branches below read the
  // sentinel, never these.
  const templateList = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const campaignList = useMemo(() => (Array.isArray(campaigns) ? campaigns : []), [campaigns]);
  // Per-action busy flags (UX audit finding #7) — a single shared `busy` made
  // every button on the page freeze while ANY one action ran (e.g. saving the
  // sender address disabled "New campaign" too). Send already tracks its own
  // per-row state via `sendingId`.
  const [senderBusy, setSenderBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [campaignBusy, setCampaignBusy] = useState(false);

  const [nt, setNt] = useState<{ name: string; subject: string; body: string; format: EmailBodyFormat }>({ name: '', subject: '', body: '', format: 'text' });
  // ADR 0520 — the open template is a ROUTE now (`/email/templates/:templateId`),
  // not component state mirrored to `?template=`. `?org=` survives as the
  // workspace deep link, which is a filter on this hub, not an opened entity.
  const [searchParams, setSearchParams] = useSearchParams();
  /** The shared read. EM-R2-1's local fix paired `setOrgs([])` with an
   *  `orgsFailed` flag, so the zero-org branch meant two things and needed a
   *  second question to tell them apart. The hook keeps `orgs` null on failure;
   *  `?org=` is honoured when the read confirms it exists. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, searchParams.get('org') ?? '');
  /** One-shot snapshot of the inbound `?org=` deep link (the Funnels idiom):
   *  keeps the orgs effect's dep list honest without a lint suppression. */
  const chooseOrg = useCallback((next: string) => {
    setOrgId(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set('org', next); else p.delete('org');
      return p;
    }, { replace: true });
    // `setOrgId` comes from `ui/useOrgSelection` now rather than from a local
    // `useState`, so the linter can no longer prove it stable across renders.
    // It IS — the hook returns the raw setter — but declaring it is cheaper than
    // asserting it, and a suppression here would outlive the reason for it.
  }, [setSearchParams, setOrgId]);
  const [tplView, setTplView] = useViewMode('email-templates', 'grid');
  // §4.5 picker/collection search state (shown past 3 rows).
  const [tplQuery, setTplQuery] = useState('');
  const [campQuery, setCampQuery] = useState('');
  const [campStatus, setCampStatus] = useState('');
  const [campTpl, setCampTpl] = useState('');
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('all');
  const [campStage, setCampStage] = useState<'' | ContactStage>('');
  const [campSegment, setCampSegment] = useState('');
  const [segments, setSegments] = useState<EmailSegment[] | null>(null);
  /** DESIGN.md §4.5 rule 9 — the send log is a QUICK-LOOK: reviewing a campaign
   *  should not leave the list, and a campaign has no editor to navigate to. But
   *  the rule also requires it be "deep-linkable via URL params", which it was
   *  not: an opened log could not be shared, bookmarked, or restored on reload,
   *  and Back did not close it. `?log=<campaignId>` IS the open state now. */
  const logFor = searchParams.get('log') ?? '';
  const setLogFor = useCallback((id: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (id) p.set('log', id); else p.delete('log');
      return p;
    }, { replace: true });
  }, [setSearchParams]);
  const [sends, setSends] = useState<SendLog[] | null>(null);
  // R3 EM-SP-7 — the engagement lane's FIRST consumer. Same disclosure shape
  // as the log; failed ≠ empty (a failed read must never render as "no
  // engagement").
  const [engagementFor, setEngagementFor] = useState('');
  const [engagement, setEngagement] = useState<Awaited<ReturnType<typeof getEngagement>> | null>(null);
  const [engagementFailed, setEngagementFailed] = useState(false);
  // "No sends yet" is a claim about delivery history; a failed read may not
  // make it (an operator could conclude a campaign never sent).
  const [sendsFailed, setSendsFailed] = useState(false);
  // EM-UX-8 — the sends read gets a retry like its three peers. The effect
  // keys on the URL (`?log=`), which a retry must not touch, so a bump here is
  // what re-runs it.
  const [sendsAttempt, setSendsAttempt] = useState(0);
  // ADR 0655 D10 — the Suppressions disclosure (EM-UX-5 / EM-UX-23). Closed by
  // default: the panel mounts (and reads) only when opened.
  const [suppressionsOpen, setSuppressionsOpen] = useState(false);
  // Sender identity (per-org). Campaigns can't send until configured — the
  // backend 501s honestly; this surfaces that state up front.
  const [sender, setSender] = useState('');
  const [senderConfigured, setSenderConfigured] = useState<boolean | null>(null);
  // R2 EM-SP-5 — a FAILED settings read left the sender input empty, and Save
  // would then persist '' — which the backend treats as a deliberate UNSET.
  // One click from destroying config; the save is blocked until a read lands.
  const [senderLoaded, setSenderLoaded] = useState(false);
  const [senderFailed, setSenderFailed] = useState(false);
  // Which campaign is mid-dispatch — a batched send is up to ~50 sequential
  // HTTP sends; the active button must show progress, not read as frozen.
  const [sendingId, setSendingId] = useState('');
  // R2 EM-G3 — the test-send modal target (one field on the shared Modal).
  const [testSendFor, setTestSendFor] = useState<Campaign | null>(null);

  // Saved segments (ADR 0211 §2) — tenant-scoped (no org). Fetched LAZILY
  // (CRMGAP-FE-6, not on mount) the first time either becomes true: the
  // audience picker is switched to "By segment", or a loaded campaign
  // references a segmentId and needs its name resolved for display. Loads
  // once (segments !== null guards the effect from refiring).
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  // R2 EM-SP-4 — a FAILED segments read must never render the "create one on
  // the CRM page" instruction (a false instruction over a read error).
  const [segmentsFailed, setSegmentsFailed] = useState(false);
  useEffect(() => {
    if (!access.enabled || segments !== null || segmentsLoading) return;
    const needsSegments = audienceMode === 'segment' || campaignList.some((c) => Boolean(c.audience.segmentId));
    if (!needsSegments) return;
    setSegmentsLoading(true);
    setSegmentsFailed(false);
    void listSegments().then(setSegments).catch(() => { setSegments([]); setSegmentsFailed(true); }).finally(() => setSegmentsLoading(false));
  }, [access.enabled, audienceMode, campaignList, segments, segmentsLoading]);

  // Deferred Phase B.1 (ADM-12): operator visibility — which providers the
  // caller can broker + the host default + the sender identity.
  // EM-UX-27 — tri-state: `null` loading, `'error'` a FAILED read (rendered as
  // a failed state with retry), value. The old catch wrote `null`, so a failed
  // read rendered as ABSENCE — indistinguishable from "not loaded yet".
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null | 'error'>(null);
  // R2 EM-SP-6 — the sends effect already guards stale responses; the main
  // load did not, so an org-switch race could paint cross-org templates (and
  // seed a cross-org campTpl).
  const loadSeq = useRef(0);
  const load = useCallback((org: string) => {
    const seq = ++loadSeq.current;
    const fresh = (): boolean => seq === loadSeq.current;
    // NOT `setLogFor('')` any more: the log lives in the URL, and `load` runs on
    // MOUNT, so clearing here destroyed an inbound `?log=` deep link before it
    // could open. Staleness is a property of an ORG SWITCH, so the org effect
    // below owns the clear. (Caught by `campaignLogDeepLink.test.tsx`.)
    setError(null); setSends(null);
    void listTemplates(org)
      .then((tpls) => { if (!fresh()) return; setTemplates(tpls); setCampTpl((c) => c || (tpls[0]?.templateId ?? '')); })
      .catch((e) => {
        if (!fresh()) return;
        // Terminal state on failure (never `null`, which stranded the skeleton
        // behind the error notice) — but the `'error'` SENTINEL, never `[]`:
        // `[]` rendered the "No templates yet · Create one above" instruction
        // over a read that never came back (EM-UX-6).
        setTemplates('error');
        setError(e instanceof Error ? e.message : t('loadFailed'));
      });
    void listCampaigns(org).then((cs) => { if (fresh()) setCampaigns(cs); }).catch((e) => {
      if (!fresh()) return;
      // Same shape: the page-level error notice PLUS a failed-read card in the
      // campaigns section, never "No campaigns yet." (EM-UX-6).
      setCampaigns('error');
      setError(e instanceof Error ? e.message : t('loadFailed'));
    });
    setSenderLoaded(false);
    setSenderFailed(false);
    setSender(''); // review F5 — never show the previous org's address in a form that can't save
    void getEmailSettings(org)
      .then((s) => { if (!fresh()) return; setSender(s.senderAddress); setSenderConfigured(s.configured); setSenderLoaded(true); })
      .catch(() => { if (fresh()) { setSenderConfigured(null); setSenderFailed(true); } });
    setProviderStatus(null);
    void getProviderStatus(org).then((p) => { if (fresh()) setProviderStatus(p); }).catch(() => { if (fresh()) setProviderStatus('error'); });
  }, [t]);
  // campTpl resets with the org — a stale cross-org templateId would ride into
  // createCampaign (audit CRMGAP-FE-5). No template selection to drop any more:
  // the open template is a route, and switching workspace here does not (and
  // must not) reach into another page's URL.
  useEffect(() => {
    if (!orgId) return;
    setTemplates(null); setCampaigns(null); setCampTpl('');
    setTplQuery(''); setCampQuery(''); setCampStatus('');
    load(orgId);
  }, [orgId, load]);

  const addTemplate = useCallback(async () => {
    if (!orgId || !nt.name.trim() || !nt.subject.trim() || !nt.body.trim()) return;
    setTemplateBusy(true);
    try { await createTemplate(orgId, { name: nt.name.trim(), subject: nt.subject.trim(), body: nt.body.trim(), format: nt.format }); setNt({ name: '', subject: '', body: '', format: 'text' }); load(orgId); toast.success(t('templateCreated')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setTemplateBusy(false); }
  }, [orgId, nt, load, t]);

  const addCampaign = useCallback(async () => {
    if (!orgId || !campTpl) return;
    setCampaignBusy(true);
    try {
      await createCampaign(orgId, {
        templateId: campTpl,
        ...(audienceMode === 'stage' && campStage ? { stage: campStage } : {}),
        ...(audienceMode === 'segment' && campSegment ? { segmentId: campSegment } : {}),
      });
      load(orgId); toast.success(t('campaignCreated'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setCampaignBusy(false); }
  }, [orgId, campTpl, audienceMode, campStage, campSegment, load, t]);

  const saveSender = useCallback(async () => {
    setSenderBusy(true);
    try { const s = await putEmailSettings(orgId, sender.trim()); setSender(s.senderAddress); setSenderConfigured(s.configured); toast.success(t('senderSaved')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setSenderBusy(false); }
  }, [orgId, sender, t]);

  // Hoisted above `send`: the send confirmation names the template + audience,
  // so these lookups must be declared before the callback that reads them.
  // Memoized because `send`'s confirm copy now depends on them: as plain
  // functions they were a fresh identity each render and would have re-created
  // the send callback on every keystroke elsewhere on the page.
  const tplName = useCallback((id: string): string => templateList.find((tpl) => tpl.templateId === id)?.name ?? id, [templateList]);
  const segName = useCallback((id: string): string => (segments ?? []).find((s) => s.segmentId === id)?.name ?? id, [segments]);

  /** The campaign's audience in the same words the row shows, for the confirm. */
  const audienceLabel = useCallback((c: Campaign): string => (
    c.audience.stage ? t(`stage_${c.audience.stage}`)
      : c.audience.segmentId ? segName(c.audience.segmentId)
        : t('audienceAll')
  ), [t, segName]);

  const send = useCallback(async (c: Campaign) => {
    const resend = c.status === 'sent';
    // UX_UPGRADE-email EM-G1 — the FIRST send had no gate at all; only a resend
    // asked. But the first send is the one that actually mails real people, and
    // it cannot be recalled. Confirm both, and name WHAT is going to WHOM so the
    // dialog carries information rather than just friction. (A 'sending'
    // campaign is a resumption of a send already authorized, so it goes
    // straight through — asking again would train people to click past it.)
    if (c.status !== 'sending') {
      // R2 EM-G2 (promoted) — a SEGMENT audience gets a live size read at
      // confirm-open, shown as a labelled ESTIMATE (the market convention;
      // never a guaranteed count). A failed read degrades to the countless
      // copy — a fabricated or stale number would be worse than none. Stage
      // audiences have no cheap size read; deferred with that reason.
      // Review F11 — the estimate fetch opens a double-click window; occupy
      // sendingId for the whole confirm sequence so the buttons disable.
      setSendingId(c.campaignId);
      let body = t('sendConfirmBody', { template: tplName(c.templateId), audience: audienceLabel(c) });
      if (c.audience.segmentId) {
        try {
          const est = await getSegmentEstimate(c.audience.segmentId);
          body = t('sendConfirmBodyWithCount', { template: tplName(c.templateId), audience: audienceLabel(c), count: formatNumber(est.size) });
        } catch { /* countless copy stands */ }
      }
      // EM-UX-13 — `danger`: sending is the one IRREVERSIBLE act on this page
      // (`ui/confirm.tsx`: "reserve for irreversible actions"), while the
      // recoverable delete already carried it. EM-UX-21 — the re-send dialog is
      // a short question TITLE (the dialog's accessible name) plus the
      // consequence as BODY, like the first-send path, not a 96-char paragraph
      // as the name.
      const ok = await confirm(resend
        ? { title: t('resendConfirmTitle'), body: `${t('resendConfirmBody')} ${body}`, confirmLabel: t('resend'), danger: true }
        : { title: t('sendConfirmTitle'), body, confirmLabel: t('campaignSend'), danger: true });
      if (!ok) { setSendingId(''); return; }
    }
    // Busy-guard the dispatch via sendingId itself: a double-click would fire
    // two overlapping sends (the backend also serializes per campaign — this
    // is the UX layer of it).
    setSendingId(c.campaignId);
    try {
      const r = await sendCampaign(orgId, c.campaignId, resend);
      load(orgId);
      const stats = { sent: formatNumber(r.stats?.sent ?? 0), skipped: formatNumber(r.stats?.skipped ?? 0), failed: formatNumber(r.stats?.failed ?? 0) };
      // A batched send can return 'sending' with recipients remaining (or failed
      // ones to retry) — tell the user honestly and point at "Continue sending".
      if (r.status === 'sending') toast.info(t('sendPartialResult', stats));
      else toast.success(t('sendResult', stats));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('sendFailed')); }
    finally { setSendingId(''); }
  }, [orgId, load, t, tplName, audienceLabel]);

  const removeCampaign = useCallback(async (id: string) => {
    // EM-UX-29 — the body says what the delete actually does. VERIFIED against
    // `emailService.deleteCampaign` (`campaigns.delete(campaignId)` only): the
    // send log and engagement rows are NOT deleted — they stay in the ledger,
    // unreachable from this page once the row is gone. The copy says so rather
    // than promising a cascade that does not exist.
    if (!(await confirm({ title: t('deleteCampaignConfirm'), body: t('deleteCampaignConfirmBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deleteCampaign(orgId, id); if (logFor === id) setLogFor(''); load(orgId); } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, logFor, setLogFor, load, t]);

  const toggleLog = useCallback((id: string) => {
    setLogFor(logFor === id ? '' : id);
  }, [logFor, setLogFor]);

  const toggleEngagement = useCallback((id: string) => {
    setEngagementFor((cur) => (cur === id ? '' : id));
  }, []);

  useEffect(() => {
    if (!engagementFor || !orgId) { setEngagement(null); setEngagementFailed(false); return; }
    let live = true;
    setEngagement(null);
    setEngagementFailed(false);
    getEngagement(orgId, engagementFor)
      .then((r) => { if (live) setEngagement(r); })
      .catch(() => { if (live) setEngagementFailed(true); });
    return () => { live = false; };
  }, [engagementFor, orgId]);

  // The log FOLLOWS the URL: a click and an inbound `?log=` link are the same
  // event, so fetching here rather than in the click handler is what makes a
  // deep link actually LOAD instead of opening an empty panel.
  //
  // Back does NOT close the log — `setLogFor` writes with `replace`, matching the
  // app's other quick-look params (`?doc=`, `?asset=`) and the rail decision in
  // `CCUX-2`: opening a quick-look is a view change within one surface, not a
  // navigation, and a history entry per toggle would make Back walk backwards
  // through panel states before leaving the page. The dismiss is the toggle.
  // UX-WS-1 honesty preserved: a FAILED read raises its own flag and must never
  // render as "no sends yet".
  useEffect(() => {
    if (!orgId || !logFor) { setSends(null); setSendsFailed(false); return undefined; }
    let live = true;
    setSends(null); setSendsFailed(false);
    void listSends(orgId, logFor)
      .then((r) => { if (live) setSends(r); })
      .catch(() => { if (live) { setSendsFailed(true); setSends([]); } });
    return () => { live = false; };
  }, [orgId, logFor, sendsAttempt]);


  // §4.5 collection filters — view-only memos; selection/sending always resolve
  // against the full lists.
  const visibleTemplates = useMemo(() => templateList.filter((tpl) =>
    !tplQuery.trim() || tpl.name.toLowerCase().includes(tplQuery.trim().toLowerCase()),
  ), [templateList, tplQuery]);
  const visibleCampaigns = useMemo(() => {
    const q = campQuery.trim().toLowerCase();
    return campaignList.filter((c) => {
      if (campStatus && c.status !== campStatus) return false;
      if (!q) return true;
      const label = `${tplName(c.templateId)} ${c.audience.stage ?? ''} ${c.audience.segmentId ? segName(c.audience.segmentId) : ''}`.toLowerCase();
      return label.includes(q);
    });
    // tplName/segName derive from templateList/segments state included below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignList, campQuery, campStatus, templateList, segments]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => chooseOrg(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="email.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {/* EM-UX-26 — a conditionally-mounted Notice enters the DOM with its text
          already inside and announces nothing (`ui/Notice.tsx` header); the
          LOCALIZED headline is spoken, never the raw server blob. EM-UX-7 — the
          page-level failure finally has an exit: Retry re-runs the whole load. */}
      {error ? (
        <Notice variant="error" announce={t('loadFailedTitle')}>
          {error}{' '}
          {orgId ? <Button variant="quiet" size="sm" onClick={() => load(orgId)}>{t('common:retry')}</Button> : null}
        </Notice>
      ) : null}

      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<GlobeIcon />}
      >
        <>
          {senderConfigured === false ? <Notice variant="info" announce={t('senderUnconfiguredNotice')}>{t('senderUnconfiguredNotice')}</Notice> : null}

          {/* EM-UX-27 — a FAILED provider-status read renders a failed state
              with retry, never absence: "unknown" must not look like "not
              connected" or like "still loading". Polite: it appears on load. */}
          {providerStatus === 'error' ? (
            <div className="surface-card u-p-4">
              <h2 className="u-fs-16 u-mt-0 u-mb-2">{t('providerStatusHeading')}</h2>
              <InlineState
                kind="failed"
                message={t('providerStatusFailed')}
                announce={t('providerStatusFailed')}
                announcePolite
                action={<Button variant="quiet" size="sm" type="button" onClick={() => load(orgId)}>{t('common:retry')}</Button>}
              />
            </div>
          ) : providerStatus ? (
            <div className="surface-card u-p-4">
              <h2 className="u-fs-16 u-mt-0 u-mb-2">{t('providerStatusHeading')}</h2>
              <div className="u-flex u-wrap u-gap-2 u-items-center">
                {providerStatus.providers.map((p) => (
                  <span key={p.provider} className={`chip ${p.connected ? 'chip--success' : 'chip--muted'}`}>
                    {p.provider}{p.connected ? ` — ${t('providerConnected')}` : ` — ${t('providerNotConnected')}`}
                    {providerStatus.defaultProvider === p.provider ? ` · ${t('providerDefault')}` : ''}
                  </span>
                ))}
              </div>
              <p className="muted u-fs-12 u-mb-0">
                {providerStatus.senderAddress
                  ? t('providerSenderIs', { sender: providerStatus.senderAddress })
                  : t('providerSenderMissing')}
              </p>
            </div>
          ) : null}

          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('senderLabel')}</span>
              <input type="email" value={sender} onChange={(e) => setSender(e.target.value)} placeholder={t('senderPlaceholder')} disabled={!senderLoaded} />
            </label>
            {senderFailed ? (
              // Review F5 — a FAILED read must not dress as eternal loading.
              // EM-UX-9 — and it must be HEARD: announced politely (it appears
              // on load, not in answer to something the user did).
              <InlineState
                kind="failed"
                message={t('senderReadFailed')}
                announce={t('senderReadFailed')}
                announcePolite
                action={<Button variant="quiet" size="sm" type="button" onClick={() => load(orgId)}>{t('common:retry')}</Button>}
              />
            ) : !senderLoaded ? <p className="muted u-fs-12 u-m-0">{t('senderReadPending')}</p> : null}
            <Button variant="primary" disabled={senderBusy || !senderLoaded} onClick={() => void saveSender()}><SaveIcon /> {t('senderSave')}</Button>
          </div>

          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('templateNameLabel')}</span><input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} placeholder={t('templateNamePlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('subjectLabel')}</span><input value={nt.subject} onChange={(e) => setNt({ ...nt, subject: e.target.value })} placeholder={t('subjectPlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('bodyLabel')}</span><input value={nt.body} onChange={(e) => setNt({ ...nt, body: e.target.value })} placeholder={t('bodyPlaceholder')} /></label>
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('editorFormatLabel')}</span>
              <select value={nt.format} onChange={(e) => setNt({ ...nt, format: e.target.value as EmailBodyFormat })}>
                <option value="text">{t('formatPlain')}</option>
                <option value="markdown">{t('formatMarkdown')}</option>
              </select>
            </label>
            <Button variant="primary" disabled={templateBusy || !nt.name.trim()} onClick={() => void addTemplate()}><PlusIcon /> {t('newTemplate')}</Button>
          </div>

          {/* Templates collection (ADR 0520) — real `<Link>` cells to
              `/email/templates/:templateId`. The editor and Delete live there;
              a collection cell neither opens in place nor destroys. */}
          <div className="u-flex u-flex-col u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <h2 className="u-fs-16 u-m-0">{t('templatesHeading')}</h2>
              <div className="filterbar u-ml-auto u-m-0" role="group" aria-label={t('tplFilterGroup')}>
                {/* Gated on the UNFILTERED total so the control can't vanish
                    mid-search and strand the user in a filtered list (rule 13). */}
                {templateList.length > 3 ? (
                  <input
                    type="search"
                    className="ui-input filterbar-search"
                    placeholder={t('tplFilterPlaceholder')}
                    aria-label={t('tplFilterAria')}
                    value={tplQuery}
                    onChange={(e) => setTplQuery(e.target.value)}
                  />
                ) : null}
                <ViewToggle value={tplView} onChange={setTplView} className="u-ml-auto" />
              </div>
            </div>
            {templates === 'error' ? (
              // EM-UX-6 — a FAILED read states the failure (with the exit), never
              // the "Create one above" instruction. `announce` (polite, the card's
              // title) is what `check-failure-card-announce` requires of every
              // failure card; the page-level Notice speaks the assertive headline
              // — the same pairing as `AnalyticsPage` (ANL-UX-6).
              <StateCard
                announce
                icon={<SendIcon size={20} />}
                title={t('templatesFailedTitle')}
                body={t('templatesFailedBody')}
                action={<Button variant="secondary" onClick={() => load(orgId)}>{t('common:retry')}</Button>}
              />
            ) : !templates ? <Skeleton /> : templates.length === 0 ? (
              <StateCard icon={<SendIcon size={20} />} title={t('noTemplatesTitle')} body={t('noTemplatesBody')} />
            ) : visibleTemplates.length === 0 ? (
              <StateCard
                icon={<SendIcon size={20} />}
                title={t('noMatchTemplatesTitle')}
                body={t('noMatchTemplates')}
                action={<Button variant="secondary" onClick={() => setTplQuery('')}>{t('clearSearch')}</Button>}
              />
            ) : tplView === 'grid' ? (
              <div className="card-grid">
                {visibleTemplates.map((tpl) => <TemplateCard key={tpl.templateId} template={tpl} orgId={orgId} />)}
              </div>
            ) : (
              <div className="surface-card list-view">
                {visibleTemplates.map((tpl) => <TemplateRow key={tpl.templateId} template={tpl} orgId={orgId} />)}
              </div>
            )}
          </div>

          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1"><span className="u-label-sm">{t('campaignTemplateLabel')}</span>
              <select value={campTpl} onChange={(e) => setCampTpl(e.target.value)}>{templateList.map((tpl) => <option key={tpl.templateId} value={tpl.templateId}>{tpl.name}</option>)}</select>
            </label>
            <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('audienceModeLabel')}</span>
              <select value={audienceMode} onChange={(e) => setAudienceMode(e.target.value as AudienceMode)}>
                <option value="all">{t('audienceModeAll')}</option>
                <option value="stage">{t('audienceModeStage')}</option>
                <option value="segment">{t('audienceModeSegment')}</option>
              </select>
            </label>
            {audienceMode === 'stage' ? (
              <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('audienceStageLabel')}</span>
                <select value={campStage} onChange={(e) => setCampStage(e.target.value as '' | ContactStage)} aria-label={t('audienceStageLabel')}>
                  <option value="">{t('audienceAllContacts')}</option>
                  {CONTACT_STAGES.map((s) => <option key={s} value={s}>{t(`stage_${s}`)}</option>)}
                </select>
              </label>
            ) : null}
            {audienceMode === 'segment' && segmentsFailed ? (
              // NOT inside the <label>: a button inside one inherits the label
              // text as its accessible name, burying "Retry" (the DealDetail
              // stages-retry lesson).
              <span className="u-grid u-gap-1 is-narrow">
                <span className="u-label-sm">{t('audienceSegmentLabel')}</span>
                {/* EM-UX-9 — announced politely (a load-time failure). */}
                <InlineState
                  kind="failed"
                  message={t('segmentsLoadFailed')}
                  announce={t('segmentsLoadFailed')}
                  announcePolite
                  action={<Button variant="quiet" size="sm" type="button" onClick={() => { setSegments(null); setSegmentsFailed(false); }}>{t('common:retry')}</Button>}
                />
              </span>
            ) : audienceMode === 'segment' ? (
              <label className="u-grid u-gap-1 is-narrow"><span className="u-label-sm">{t('audienceSegmentLabel')}</span>
                {segmentsLoading || segments === null ? (
                  <select disabled aria-label={t('audienceSegmentLabel')}><option>{t('loadingSegments')}</option></select>
                ) : segments.length === 0 ? (
                  <span className="u-label-sm muted">
                    <Trans i18nKey="noSegmentsCta" ns="email" components={{ 0: <Link to="/crm" className="inline-link" /> }} />
                  </span>
                ) : (
                  <select value={campSegment} onChange={(e) => setCampSegment(e.target.value)} aria-label={t('audienceSegmentLabel')}>
                    <option value="">{t('audienceSegmentPlaceholder')}</option>
                    {segments.map((s) => <option key={s.segmentId} value={s.segmentId}>{s.name}</option>)}
                  </select>
                )}
              </label>
            ) : null}
            <Button variant="primary" disabled={campaignBusy || !campTpl || (audienceMode === 'segment' && !campSegment)} onClick={() => void addCampaign()}><PlusIcon /> {t('newCampaign')}</Button>
          </div>

          <div className="surface-card u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <h2 className="u-fs-16 u-m-0">{t('campaignsHeading')}</h2>
              {campaignList.length > 3 ? (
                <div className="filterbar u-ml-auto u-m-0" role="group" aria-label={t('campFilterGroup')}>
                  <input
                    type="search"
                    className="ui-input filterbar-search"
                    placeholder={t('campFilterPlaceholder')}
                    aria-label={t('campFilterAria')}
                    value={campQuery}
                    onChange={(e) => setCampQuery(e.target.value)}
                  />
                  {/* Self-describing "All statuses" option carries the facet's label — an
                      eyebrow label would break the one-row filterbar baseline. */}
                  <select className="ui-input filterbar-select" value={campStatus} onChange={(e) => setCampStatus(e.target.value)} aria-label={t('campFilterStatus')}>
                    <option value="">{t('campFilterAllStatuses')}</option>
                    {(['draft', 'sending', 'sent'] as const).map((s) => <option key={s} value={s}>{t(`campaignStatus_${s}`)}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
            {campaigns === 'error' ? (
              // EM-UX-6 — failed ≠ "No campaigns yet." Announced politely (see
              // the templates card above for why both this and the Notice speak).
              <StateCard
                announce
                icon={<SendIcon size={20} />}
                title={t('campaignsFailedTitle')}
                body={t('campaignsFailedBody')}
                action={<Button variant="secondary" onClick={() => load(orgId)}>{t('common:retry')}</Button>}
              />
            ) : !campaigns ? <Skeleton /> : campaigns.length === 0 ? (
              // EM-UX-28 — the designed empty state, like templates, not a bare span.
              <StateCard icon={<SendIcon size={20} />} title={t('noCampaigns')} body={t('noCampaignsBody')} />
            ) : visibleCampaigns.length === 0 ? (
                <StateCard
                  icon={<SendIcon size={20} />}
                  title={t('noMatchCampaignsTitle')}
                  body={t('noMatchCampaigns')}
                  action={<Button variant="secondary" onClick={() => { setCampQuery(''); setCampStatus(''); }}>{t('clearSearch')}</Button>}
                />
              ) : visibleCampaigns.map((c) => (
              <div key={c.campaignId} className="surface-inset u-gap-1 u-flex u-flex-col">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <strong className="u-flex-1">
                    {tplName(c.templateId)}
                    {c.audience.stage ? ` · ${t(`stage_${c.audience.stage}`)}` : c.audience.segmentId ? ` · ${t('audienceSegmentPrefix', { name: segName(c.audience.segmentId) })}` : ''}
                  </strong>
                  <span className={campChip(c.status)}>{t(`campaignStatus_${c.status}`)}</span>
                  {/* R2 EM-SP-9 — Email Copywriter drafts mint `cmp:agent:*`
                      ids; without the badge an agent draft was
                      indistinguishable from a human one. */}
                  {c.campaignId.startsWith('cmp:agent:') ? <span className="chip chip--muted"><SparklesIcon size={12} /> {t('agentDraftedChip')}</span> : null}
                  <span className="muted u-fs-12">{formatRelativeTime(c.createdAt)}</span>
                  {c.stats ? <span className="u-label-sm">{t('campaignStats', { sent: formatNumber(c.stats.sent), skipped: formatNumber(c.stats.skipped), failed: formatNumber(c.stats.failed) })}</span> : null}
                  <div className="action-bar">
                    <Button variant="quiet" disabled={sendingId !== ''} aria-label={c.status === 'sent' ? t('resend') : c.status === 'sending' ? t('continueSending') : t('campaignSend')} onClick={() => void send(c)}><SendIcon /> {sendingId === c.campaignId ? t('common:loading') : c.status === 'sent' ? t('resend') : c.status === 'sending' ? t('continueSending') : t('campaignSend')}</Button>
                    <Button variant="quiet" onClick={() => setTestSendFor(c)} aria-label={t('testSendLabel', { name: tplName(c.templateId) })}>{t('testSend')}</Button>
                    {/* A DISCLOSURE, so it must say so: without `aria-expanded` a
                        screen-reader user hears "Log, button" and gets no signal
                        that content appeared below (WCAG 4.1.2). `aria-controls`
                        names the panel it owns. */}
                    <Button
                      variant="quiet"
                      aria-expanded={logFor === c.campaignId}
                      aria-controls={`campaign-log-${c.campaignId}`}
                      onClick={() => toggleLog(c.campaignId)}
                    >{t('log')}</Button>
                    <Button
                      variant="quiet"
                      aria-expanded={engagementFor === c.campaignId}
                      aria-controls={`campaign-engagement-${c.campaignId}`}
                      onClick={() => toggleEngagement(c.campaignId)}
                    >{t('engagement')}</Button>
                    {/* EM-UX-20 — Delete is disabled while ANY send is in flight:
                        `withSendLock` serializes sends against each other, not
                        against a delete, and the send pass ends with an
                        unconditional `campaigns.put` — so deleting mid-dispatch
                        removed the row and the send wrote it back. */}
                    <Button variant="quiet" disabled={sendingId !== ''} title={t('deleteCampaign')} aria-label={t('deleteCampaign')} onClick={() => void removeCampaign(c.campaignId)}><TrashIcon /></Button>
                  </div>
                </div>
                {engagementFor === c.campaignId ? (
                  <div id={`campaign-engagement-${c.campaignId}`} className="u-grid u-gap-1">
                    {engagementFailed ? (
                      // EM-UX-9 — announced politely (a load-time failure).
                      <InlineState
                        kind="failed"
                        message={t('engagementFailed')}
                        announce={t('engagementFailed')}
                        announcePolite
                        action={<Button variant="quiet" size="sm" onClick={() => { setEngagementFor(''); setTimeout(() => setEngagementFor(c.campaignId), 0); }}>{t('common:retry')}</Button>}
                      />
                    ) : !engagement ? <Skeleton /> : (
                      <>
                        <div className="action-bar u-flex-wrap u-gap-2">
                          <span className="chip">{t('engOpens', { unique: formatNumber(engagement.stats.uniqueOpens), total: formatNumber(engagement.stats.opens) })}</span>
                          <span className="chip">{t('engClicks', { unique: formatNumber(engagement.stats.uniqueClicks), total: formatNumber(engagement.stats.clicks) })}</span>
                          {/* EM-UX-1: an unsubscribe whose send-stopping writes did
                              not persist must NOT read as a clean opt-out — that
                              corroboration is what made the recipient-facing false
                              success invisible to the operator. */}
                          <span className={engagement.stats.unsubscribesUnenforced > 0 ? 'chip chip--warning' : 'chip'}>
                            {t('engUnsubs', { count: engagement.stats.unsubscribes })}
                          </span>
                        </div>
                        {engagement.stats.unsubscribesUnenforced > 0 ? (
                          <Notice variant="warning" announce={t('engUnsubsUnenforced', { count: engagement.stats.unsubscribesUnenforced })}>{t('engUnsubsUnenforced', { count: engagement.stats.unsubscribesUnenforced })}</Notice>
                        ) : null}
                        {/* Opens are pixel-based — clients that block images never
                            register, so the number UNDER-counts. Say so. */}
                        <span className="muted u-fs-12">{t('engOpensCaveat')}</span>
                        {/* EM-UX-22 — with tracking links off (no `linkBase`) no
                            token is ever minted and every figure above is a
                            permanent zero that LOOKS like a measurement. The wire
                            carries no instrumentation flag (`provider-status` has
                            no such field), so rather than invent one the caption
                            names the condition under which the zeros mean
                            "nobody", and under which they mean "not measured". */}
                        <span className="muted u-fs-12">{t('engTrackingCaveat')}</span>
                        {engagement.events.length === 0 ? (
                          <span className="u-label-sm">{t('engEmpty')}</span>
                        ) : engagement.events.slice(0, 50).map((ev) => (
                          <div key={ev.id} className="u-flex u-gap-2 u-items-center">
                            <code className="u-flex-1">{ev.contactId}</code>
                            <span className="chip chip--muted">{t(`engKind_${ev.kind}`)}{ev.url ? ` · ${ev.url}` : ''}</span>
                            <span className="muted u-fs-12">{formatRelativeTime(ev.at)}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ) : null}
                {logFor === c.campaignId ? (
                  <div id={`campaign-log-${c.campaignId}`} className="u-grid u-gap-1">
                    {!sends ? <Skeleton /> : sendsFailed ? (
                      // EM-UX-8 — a retry like its three peers (collapsing and
                      // re-expanding the disclosure was the only recovery).
                      // EM-UX-9 — announced politely.
                      <InlineState
                        kind="failed"
                        message={t('sendsFailed')}
                        announce={t('sendsFailed')}
                        announcePolite
                        action={<Button variant="quiet" size="sm" onClick={() => setSendsAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
                      />
                    ) : sends.length === 0 ? <span className="u-label-sm">{t('noSends')}</span> : sends.map((s) => (
                      <div key={s.sendId} className="u-flex u-gap-2 u-items-center">
                        <code className="u-flex-1">{s.contactId}</code>
                        {/* R2 EM-SP-10 — skip reasons rendered as raw codes
                            (`no_email`) untranslated; a known code localizes,
                            an unknown provider error stays verbatim. */}
                        <span className={sendChip(s.status)}>{t(`sendStatus_${s.status}`)}{s.error ? `: ${SKIP_REASONS.has(s.error) ? t(`skipReason_${s.error}`) : s.error}` : ''}</span>
                        <span className="muted u-fs-12">{formatRelativeTime(s.ts)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* ADR 0655 D10 — Suppressions (EM-UX-5 / EM-UX-23). The send log has
              named "suppressed (bounce/unsubscribe)" for a year with nowhere to
              see the list or release an address suppressed in error. A
              DISCLOSURE like the per-row Log/Engagement toggles (`aria-expanded`
              + `aria-controls` naming the panel it owns); the panel mounts —
              and reads — only when opened. Tenant-wide, not per workspace. */}
          <div className="surface-card u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <h2 className="u-fs-16 u-m-0">{t('suppressionsHeading')}</h2>
              <Button
                variant="quiet"
                size="sm"
                className="u-ml-auto"
                aria-expanded={suppressionsOpen}
                aria-controls="email-suppressions"
                onClick={() => setSuppressionsOpen((o) => !o)}
              >{suppressionsOpen ? t('suppressionsHide') : t('suppressionsShow')}</Button>
            </div>
            {suppressionsOpen ? <SuppressionsPanel id="email-suppressions" /> : null}
          </div>
        </>
      </OrgSelectionState>
      {testSendFor ? (
        <TestSendModal
          campaignName={tplName(testSendFor.templateId)}
          onClose={() => setTestSendFor(null)}
          onSubmit={async (to) => {
            try {
              await sendTestEmail(orgId, testSendFor.campaignId, to);
              setTestSendFor(null);
              toast.success(t('testSendOk', { to }));
            } catch (e) { toast.error(e instanceof Error ? e.message : t('testSendFailed')); }
          }}
        />
      ) : null}
    </div>
  );
}

/** R2 EM-G3 — one address field on the shared Modal; the send is marked
 *  ([Test] subject), token-honest, and never touches the campaign's ledger. */
function TestSendModal({ campaignName, onClose, onSubmit }: {
  campaignName: string; onClose: () => void; onSubmit: (to: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('email');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal label={t('testSendTitle', { name: campaignName })} onClose={() => { if (!busy) onClose(); }}>
      <form className="u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); if (busy || !to.trim()) return; setBusy(true); void Promise.resolve(onSubmit(to.trim())).finally(() => setBusy(false)); }}>
        <h2 className="u-fs-16 u-m-0">{t('testSendTitle', { name: campaignName })}</h2>
        <p className="muted u-fs-12 u-m-0">{t('testSendHint')}</p>
        <TextField label={t('testSendToLabel')} type="email" required value={to} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} placeholder={t('testSendToPlaceholder')} />
        <div className="action-bar u-justify-end">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || !to.trim()}>{t('testSendGo')}</Button>
        </div>
      </form>
    </Modal>
  );
}
