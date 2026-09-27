/**
 * Personas & Campaign Brief page (ADR 0156, Phase 4). Two tabs — Briefs and
 * Personas — on the shared ui/ cohesion layer. The brief detail is a wizard-style
 * editor (identity · product · audience · channels · messaging) with a Validate
 * action and a read-only Kernel panel; generating the kernel happens through the
 * one chat scoped to the Brief Strategist agent (ADR 0058 — deep-link, no second
 * chat). The messaging kernel is the foundation every channel echoes.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { scrollBehavior } from '../../ui/motion.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../../ui/Field.js';
import { Tabs, TabPanel, useUrlTab } from '../../ui/Tabs.js';
import { IntelWorkspace } from './IntelWorkspace.js';
import { toast } from '../../ui/toast.js';
import { MegaphoneIcon, PlusIcon, TrashIcon, SparklesIcon, CheckIcon, AlertIcon, ArrowLeftIcon, XIcon, PencilIcon } from '../../ui/icons/index.js';
import {
  listPersonas, createPersona, updatePersona, deletePersona,
  listBriefs, createBrief, updateBrief, deleteBrief, duplicateBrief, validateBriefById,
  listOrgs, listBrands, findCampaignForBrief, BUYER_STAGES, FeatureDisabledError, BRIEF_STRATEGIST_AGENT,
  type Persona, type CampaignBrief, type BrandRef, type OrgRef, type ValidationResult, type BuyerStage, type CampaignChannel,
  type GroundingPolicy,
} from './campaignBriefClient.js';
import { minorToMajorString, majorToMinor, isIsoCurrency } from './budgetUnits.js';
import { formatDateTime } from '../../i18n/format.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
const joinLines = (a: string[]): string => a.join('\n');

export function CampaignBriefPage(): JSX.Element {
  const { t } = useTranslation('campaign-brief');
  // CMPUX-14: shared <Tabs> + URL-bound tab (deep-linkable) — was a hand-rolled
  // roving tablist without tab↔panel wiring.
  const [tab, setTab] = useUrlTab<'briefs' | 'personas'>('tab', ['briefs', 'personas'], 'briefs');
  // CBC-11: the brief detail replaces the page (Campaign Studio parity) — hide
  // the tab strip while a detail is open.
  const [detailOpen, setDetailOpen] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [brands, setBrands] = useState<BrandRef[]>([]);
  // R2 CB-SP-6 — a FAILED orgs/brands read is not an empty one: "No organization
  // yet — create an organization first" told a user with orgs to start over.
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [brandsFailed, setBrandsFailed] = useState(false);

  useEffect(() => {
    void listOrgs().then(setOrgs).catch(() => setOrgsFailed(true));
    void listBrands().then(setBrands).catch(() => setBrandsFailed(true));
  }, []);

  // R2 CB-SP-14 (found by the CB-SP-5 test) — these were INLINE arrows, so
  // every page re-render minted a new identity, re-armed each tab's
  // refresh-effect, and the refresh's CBC-5 `onError('')` wiped an
  // action-failure banner the FRAME after it was set. Every save/delete error
  // was invisible; two extra fetches rode along each time.
  const onDisabled = useCallback(() => setDisabled(true), []);

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {disabled ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      ) : (
        <>
          {!detailOpen && (
            <Tabs
              className="u-mb-4"
              idBase="campaign-brief"
              label={t('tablistLabel')}
              items={[{ id: 'briefs', label: t('tabBriefs') }, { id: 'personas', label: t('tabPersonas') }]}
              value={tab}
              onChange={setTab}
            />
          )}
          <TabPanel idBase="campaign-brief" tabId={tab}>
            {tab === 'briefs'
              ? <BriefsTab t={t} orgs={orgs} orgsFailed={orgsFailed} brands={brands} brandsFailed={brandsFailed} onDisabled={onDisabled} onError={setError} onDetailOpen={setDetailOpen} />
              : <PersonasTab t={t} orgs={orgs} orgsFailed={orgsFailed} brands={brands} onDisabled={onDisabled} onError={setError} />}
          </TabPanel>
        </>
      )}
    </div>
  );
}

// ============================================================================
// BRIEFS
// ============================================================================

function BriefsTab({ t, orgs, orgsFailed, brands, brandsFailed, onDisabled, onError, onDetailOpen }: { t: TFn; orgs: OrgRef[]; orgsFailed: boolean; brands: BrandRef[]; brandsFailed: boolean; onDisabled: () => void; onError: (m: string) => void; onDetailOpen: (open: boolean) => void }): JSX.Element {
  const navigate = useNavigate();
  const [briefs, setBriefs] = useState<CampaignBrief[] | null>(null);
  // A DIFFERENT shape from the empty-state defects: the generic catch below never set
  // `briefs` at all, so a first-load failure left it `null` — and `null` is the LOADING
  // sentinel, so the page span forever under a skeleton while the error banner sat above
  // it. Reporting a failure and claiming to still be working on it, in the same frame.
  const [briefsFailed, setBriefsFailed] = useState(false);
  // R2 CB-SP-12 — the load failure's SPECIFIC message lives on the StateCard,
  // not the banner (two competing messages for one failure otherwise).
  const [briefsFailedMsg, setBriefsFailedMsg] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  // R2 CB-SP-6 — a failed personas read must not render the audience section's
  // "No personas in this organization yet" while the validator demands one.
  const [personasReadFailed, setPersonasReadFailed] = useState(false);
  // Deep-link spine (Phase 3): the open brief rides the URL (?brief=) instead of
  // an unshareable stateful button — the whole page swaps to the wizard, so
  // losing it on reload read as a bug. `current` derives from the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('brief');
  const setSelected = useCallback((id: string | null) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('brief', id); else n.delete('brief'); return n; }, { replace: true });
  }, [setSearchParams]);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CampaignBrief | null>(null);

  const refresh = useCallback(async () => {
    onError(''); // CBC-5: a later success clears the sticky banner
    setBriefsFailed(false); setBriefsFailedMsg(null);
    try { setBriefs(await listBriefs()); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { onDisabled(); setBriefs([]); return; }
      // Resolve the loading sentinel AND mark the failure. Setting `[]` alone would swap a
      // permanent skeleton for "No campaign briefs yet" — trading a hang for a false claim.
      // The specific message rides the StateCard (CB-SP-12), NOT the banner.
      setBriefs([]);
      setBriefsFailed(true);
      setBriefsFailedMsg(e instanceof Error ? e.message : null);
    }
  }, [onDisabled, onError]);
  useEffect(() => {
    void refresh();
    setPersonasReadFailed(false);
    void listPersonas().then(setPersonas).catch(() => setPersonasReadFailed(true));
  }, [refresh]);

  const current = useMemo(() => briefs?.find((b) => b.id === selected) ?? null, [briefs, selected]);
  useEffect(() => { onDetailOpen(current !== null); return () => onDetailOpen(false); }, [current, onDetailOpen]);

  // §4.5 collection kit (DESIGN.md rule 13): gated name/product search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | CampaignBrief['status']>('');
  const visibleBriefs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (briefs ?? []).filter((b) =>
      (!q || b.name.toLowerCase().includes(q) || (b.productName ?? '').toLowerCase().includes(q))
      && (!statusFilter || b.status === statusFilter));
  }, [briefs, query, statusFilter]);
  const clearFilters = useCallback(() => { setQuery(''); setStatusFilter(''); }, []);

  if (current) {
    return (
      <BriefDetail
        t={t} brief={current} brands={brands} brandsFailed={brandsFailed} personas={personas} personasReadFailed={personasReadFailed}
        onBack={() => { setSelected(null); void refresh(); }}
        onChanged={refresh} onError={onError}
        onOpenStrategist={() => navigate(`/?agent=${encodeURIComponent(BRIEF_STRATEGIST_AGENT)}`)}
      />
    );
  }

  return (
    <>
      {briefs === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loadingBriefs')} loading />
      ) : briefsFailed ? (
        <StateCard announce icon={<MegaphoneIcon size={22} />} title={t('common:loadFailedTitle')} body={briefsFailedMsg ?? t('common:loadFailedBody')} />
      ) : briefs.length === 0 ? (
        orgsFailed
          // R2 CB-SP-6 — a failed orgs read must not assert "No organization
          // yet"; the user may have orgs and hit a blip.
          ? <StateCard announce icon={<MegaphoneIcon size={22} />} title={t('common:loadFailedTitle')} body={t('orgsLoadFailed')} />
          : orgs.length === 0
            ? <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
            : <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyBriefsTitle')} body={t('emptyBriefsBody')} action={<Button variant="primary" size="sm" data-walkthrough="new-brief" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newBrief')}</Button>} />
      ) : (
        <>
          <DeepLinkMissNotice show={isDeepLinkMiss(selected, briefs !== null, current)} onClear={() => setSelected(null)} />
          <div className="action-bar u-flex u-justify-end u-mb-3">
            <Button variant="primary" size="sm" data-walkthrough="new-brief" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newBrief')}</Button>
          </div>
          {briefs.length > 3 ? (
            <div className="filterbar u-mb-3" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterBriefsPlaceholder')}
                aria-label={t('filterBriefsAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | CampaignBrief['status'])} aria-label={t('filterStatusLabel')}>
                <option value="">{t('allStatuses')}</option>
                <option value="draft">{t('status_draft')}</option>
                <option value="validated">{t('status_validated')}</option>
                <option value="confirmed">{t('status_confirmed')}</option>
              </select>
            </div>
          ) : null}
          {visibleBriefs.length === 0 ? (
            <StateCard icon={<MegaphoneIcon size={22} />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearFilters}>{t('clearFilters')}</Button>} />
          ) : (
          <ul className="surface-card list-view u-list-none u-m-0">
            {visibleBriefs.map((b) => (
              <li key={b.id} className="list-row">
                <button type="button" className="list-row-id" onClick={() => setSelected(b.id)}>
                  <span className="list-row-name-wrap">
                    <span className="list-row-name-line"><span className="list-row-name u-fw-600">{b.name}</span><StatusChip status={b.status} t={t} />{b.kernelStale ? <span className="chip chip--warning">{t('kernelStale')}</span> : null}</span>
                    {b.productName ? <span className="u-fs-13 muted">{b.productName}</span> : null}
                  </span>
                </button>
                <div className="list-row-name-line">
                  {b.kernel ? <span className="chip chip--success">{t('hasKernel')}</span> : <span className="chip chip--muted">{t('noKernel')}</span>}
                  <span className="chip chip--muted">{t('channelsEnabled', { count: b.channels.filter((c) => c.enabled).length })}</span>
                </div>
                <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(b)}><TrashIcon size={15} /></Button>
              </li>
            ))}
          </ul>
          )}
        </>
      )}

      {createOpen ? (
        <CreateBriefModal t={t} orgs={orgs} onClose={() => setCreateOpen(false)} onCreated={async (b) => { setCreateOpen(false); await refresh(); setSelected(b.id); }} onError={onError} />
      ) : null}
      {confirmDelete ? (
        <DeleteBriefDialog t={t} brief={confirmDelete}
          onConfirm={async () => { try { await deleteBrief(confirmDelete.id); setConfirmDelete(null); await refresh(); } catch (e) { setConfirmDelete(null); onError(e instanceof Error ? e.message : t('actionFailed')); } }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </>
  );
}

/** R2 CB-SP-1 — the delete confirm probes for a finalized campaign and, ONLY
 *  when one exists, discloses the orphan consequence (it stays, loses its
 *  brief, and can never be re-finalized). A probe failure or orchestration-OFF
 *  degrades to the base body — saying nothing extra, never asserting absence.
 *  CB-SP-8 — `busy` blocks the double-submit. */
function DeleteBriefDialog({ t, brief, onConfirm, onCancel }: { t: TFn; brief: CampaignBrief; onConfirm: () => Promise<void>; onCancel: () => void }): JSX.Element {
  const [linked, setLinked] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let live = true;
    void findCampaignForBrief(brief.orgId, brief.id).then((c) => { if (live) setLinked(c); }).catch(() => { /* degrade to the base body */ });
    return () => { live = false; };
  }, [brief.orgId, brief.id]);
  return (
    <ConfirmDialog title={t('deleteBriefTitle')}
      body={linked ? `${t('deleteBriefBody')} ${t('deleteBriefLinkedCampaign', { name: linked.name })}` : t('deleteBriefBody')}
      confirmLabel={t('common:delete')} danger busy={deleting}
      onConfirm={async () => { setDeleting(true); try { await onConfirm(); } finally { setDeleting(false); } }}
      onCancel={onCancel} />
  );
}

function StatusChip({ status, t }: { status: CampaignBrief['status']; t: TFn }): JSX.Element {
  const cls = status === 'confirmed' ? 'chip--accent' : status === 'validated' ? 'chip--success' : 'chip--muted';
  return <span className={`chip ${cls}`}>{t(`status_${status}`)}</span>;
}

function CreateBriefModal({ t, orgs, onClose, onCreated, onError }: { t: TFn; orgs: OrgRef[]; onClose: () => void; onCreated: (b: CampaignBrief) => void; onError: (m: string) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try { onCreated(await createBrief({ orgId, name, productName })); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  };
  return (
    <Modal label={t('newBrief')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{t('newBrief')}</h2>
      <form data-walkthrough="new-brief-form" onSubmit={(e) => { e.preventDefault(); if (name.trim() && orgId && !busy) void submit(); }}>
        <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <TextField label={t('fieldBriefName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label={t('fieldProductName')} value={productName} onChange={(e) => setProductName(e.target.value)} />
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" data-walkthrough="create-brief" disabled={!name.trim() || !orgId || busy}>{t('common:create')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function BriefDetail({ t, brief, brands, brandsFailed, personas, personasReadFailed, onBack, onChanged, onError, onOpenStrategist }: {
  t: TFn; brief: CampaignBrief; brands: BrandRef[]; brandsFailed: boolean; personas: Persona[]; personasReadFailed: boolean;
  onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onOpenStrategist: () => void;
}): JSX.Element {
  const [objective, setObjective] = useState(brief.objective);
  const [productName, setProductName] = useState(brief.productName);
  const [productDescription, setProductDescription] = useState(brief.productDescription);
  const [industryVertical, setIndustryVertical] = useState(brief.industryVertical);
  const [brandId, setBrandId] = useState(brief.brandId ?? '');
  const [groundingPolicy, setGroundingPolicy] = useState(brief.groundingPolicy ?? 'best-effort');
  const [competitors, setCompetitors] = useState((brief.competitors ?? []).join(', '));
  const [personaIds, setPersonaIds] = useState<string[]>(brief.personaIds);
  const [channels, setChannels] = useState(brief.channels);
  // R2 CB-SP-3 — minor⇄major derives its exponent from the brief's CURRENCY
  // (JPY→0, KWD→3), never a hard-coded /100.
  const [budgetTotal, setBudgetTotal] = useState(brief.budget?.totalMinor !== undefined ? minorToMajorString(brief.budget.totalMinor, brief.budget?.currency) : '');
  const [currency, setCurrency] = useState(brief.budget?.currency ?? '');
  const [utmSource, setUtmSource] = useState(brief.utm?.source ?? '');
  const [utmMedium, setUtmMedium] = useState(brief.utm?.medium ?? '');
  const [utmCampaign, setUtmCampaign] = useState(brief.utm?.campaign ?? '');
  // R2 CB-SP-4/11 — term/content were invisible AND wiped by any save that
  // blanked the visible trio; they are fields now.
  const [utmTerm, setUtmTerm] = useState(brief.utm?.term ?? '');
  const [utmContent, setUtmContent] = useState(brief.utm?.content ?? '');
  // R2 CB-SP-11 — toneOverride was preserved blind but invisible (agent-settable).
  const [toneOverride, setToneOverride] = useState(brief.messaging.toneOverride ?? '');
  // R2 CB-R2-2 — the handoff chip: which campaign this brief finalized into.
  const [linkedCampaign, setLinkedCampaign] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let live = true;
    void findCampaignForBrief(brief.orgId, brief.id).then((c) => { if (live) setLinkedCampaign(c); }).catch(() => { /* absent chip, never a false claim */ });
    return () => { live = false; };
  }, [brief.orgId, brief.id]);
  const [valueProp, setValueProp] = useState(brief.messaging.primaryValueProp);
  const [proofPoints, setProofPoints] = useState(joinLines(brief.messaging.proofPoints));
  const [ctaStrategy, setCtaStrategy] = useState(brief.messaging.ctaStrategy);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState(false);
  // ADR 0403 P4 — the Intel view rides the URL (?view=intel) beside the editor.
  const [view, setView] = useUrlTab<'editor' | 'intel'>('view', ['editor', 'intel'], 'editor');

  const orgPersonas = useMemo(() => personas.filter((p) => p.orgId === brief.orgId), [personas, brief.orgId]);
  const togglePersona = (id: string): void => setPersonaIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleChannel = (type: CampaignChannel): void => setChannels((prev) => prev.map((c) => c.type === type ? { ...c, enabled: !c.enabled } : c));

  const currencyClean = currency.trim().toUpperCase();
  const currencyInvalid = currencyClean !== '' && !isIsoCurrency(currencyClean);
  // R2 review fold-in (m2) — an invalid total showed a field error but Save
  // proceeded, silently clearing totalMinor through the preserve branch.
  const budgetTotalInvalid = budgetTotal.trim() !== '' && !(Number.isFinite(Number(budgetTotal)) && Number(budgetTotal) >= 0);
  const planInvalid = currencyInvalid || budgetTotalInvalid;

  // R3 CB-G3 — the un-renameable brief: `name` is create-modal-only and
  // save() never sends it, so an empty- or wrong-named brief had no control
  // to fix it. Inline rename; sends ONLY { name } (merge-preserving save
  // discipline — the big save stays untouched). The backend falls back to
  // the existing name when the cleaned value is empty, so a blank submit
  // cannot wipe it — the client still refuses locally for honest UX.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const submitRename = async (): Promise<void> => {
    const next = renameDraft.trim();
    if (!next || next === brief.name) { setRenaming(false); return; }
    setBusy(true);
    try {
      await updateBrief(brief.id, { name: next });
      await onChanged();
      setRenaming(false);
      toast.success(t('renamedToast', { name: next }));
    } catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  /** R2 CB-SP-5 — reports whether the write LANDED, so Save&Validate can abort
   *  instead of validating the stale stored document. */
  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      // R2 CB-SP-4 — never derive "clear the object" from the visible subset:
      // a cleared total keeps the perChannel allocations (and currency) the
      // editor doesn't render; UTM keeps all five fields (all visible now), so
      // empty-all → null is finally an honest clear.
      const cur = currencyClean ? { currency: currencyClean } : {};
      const perChannel = brief.budget?.perChannel ? { perChannel: brief.budget.perChannel } : {};
      const hasTotal = budgetTotal.trim() !== '' && Number.isFinite(Number(budgetTotal));
      const budget = hasTotal
        ? { totalMinor: majorToMinor(budgetTotal, currencyClean || undefined), ...cur, ...perChannel }
        : (brief.budget?.perChannel || currencyClean) ? { ...cur, ...perChannel } : null;
      const utmFields = {
        ...(utmSource.trim() ? { source: utmSource.trim() } : {}),
        ...(utmMedium.trim() ? { medium: utmMedium.trim() } : {}),
        ...(utmCampaign.trim() ? { campaign: utmCampaign.trim() } : {}),
        ...(utmTerm.trim() ? { term: utmTerm.trim() } : {}),
        ...(utmContent.trim() ? { content: utmContent.trim() } : {}),
      };
      await updateBrief(brief.id, {
        objective, productName, productDescription, industryVertical,
        groundingPolicy,
        competitors: competitors.split(',').map((c) => c.trim()).filter(Boolean),
        ...(brandId ? { brandId } : {}),
        personaIds, channels,
        messaging: { primaryValueProp: valueProp, proofPoints: splitLines(proofPoints), ctaStrategy, ...(toneOverride.trim() ? { toneOverride: toneOverride.trim() } : {}) },
        budget,
        utm: Object.keys(utmFields).length ? utmFields : null,
      });
      await onChanged();
      toast.success(t('savedToast'));
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : t('actionFailed'));
      return false;
    } finally { setBusy(false); }
  };
  const [validating, setValidating] = useState(false);

  // CB-G1 — the validator returns `{ field, message }` per issue and the page
  // used to throw `field` away, joining every message into one run-on line. On a
  // five-section editor that leaves the reader hunting for what the server
  // already told them. Each section gets a focus target so an issue can carry
  // the reader to its own control.
  const sectionRefs = {
    product: useRef<HTMLElement>(null),
    audience: useRef<HTMLElement>(null),
    channels: useRef<HTMLElement>(null),
    messaging: useRef<HTMLElement>(null),
  };
  /** Which section owns a validator field. Unknown fields simply get no jump —
   *  the message still shows, we just don't guess where it lives. */
  const SECTION_OF: Record<string, keyof typeof sectionRefs> = {
    productName: 'product',
    personaIds: 'audience',
    channels: 'channels',
    'messaging.primaryValueProp': 'messaging',
  };
  const jumpTo = (field: string): void => {
    const key = SECTION_OF[field];
    const el = key ? sectionRefs[key].current : null;
    if (!el) return;
    // Focus FIRST: moving focus is the part that has to happen (it is what
    // carries a keyboard or screen-reader user to the section). Scrolling is a
    // sighted-user nicety, and `scrollIntoView` is absent in some environments —
    // letting it run first meant a throw could swallow the focus entirely.
    el.focus();
    el.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
  };

  // CB-G2 — Validate asks the server about the SAVED brief. With unsaved edits
  // on screen that is a different document: the Review panel below reads live
  // form state ("2 personas") while Validate could answer about the stored one
  // ("At least one persona is required") — two panels on one screen disagreeing.
  // When the form is dirty the action saves first, and says so in its label, so
  // the answer is always about what the reader is looking at.
  const dirty = useMemo(() => (
    objective !== (brief.objective ?? '')
    || productName !== brief.productName
    || productDescription !== (brief.productDescription ?? '')
    || industryVertical !== (brief.industryVertical ?? '')
    || groundingPolicy !== (brief.groundingPolicy ?? 'best-effort')
    || brandId !== (brief.brandId ?? '')
    || competitors !== (brief.competitors ?? []).join(', ')
    || valueProp !== brief.messaging.primaryValueProp
    || proofPoints !== joinLines(brief.messaging.proofPoints)
    || ctaStrategy !== brief.messaging.ctaStrategy
    || personaIds.join(',') !== brief.personaIds.join(',')
    || channels.map((c) => `${c.type}:${c.enabled}`).join(',') !== brief.channels.map((c) => `${c.type}:${c.enabled}`).join(',')
    // R2 — budget/UTM/tone edits count as dirty too (they never did, so a
    // budget-only edit skipped the save-first half of CB-G2).
    || budgetTotal !== (brief.budget?.totalMinor !== undefined ? minorToMajorString(brief.budget.totalMinor, brief.budget?.currency) : '')
    || currency !== (brief.budget?.currency ?? '')
    || utmSource !== (brief.utm?.source ?? '') || utmMedium !== (brief.utm?.medium ?? '') || utmCampaign !== (brief.utm?.campaign ?? '')
    || utmTerm !== (brief.utm?.term ?? '') || utmContent !== (brief.utm?.content ?? '')
    || toneOverride !== (brief.messaging.toneOverride ?? '')
  ), [objective, productName, productDescription, industryVertical, groundingPolicy, brandId, competitors, valueProp, proofPoints, ctaStrategy, personaIds, channels, budgetTotal, currency, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, toneOverride, brief]);

  const validate = async (): Promise<void> => {
    if (validating || busy) return;
    setValidating(true);
    try {
      // R2 CB-SP-5 — if the dirty save did NOT land, validating would report on
      // the stale stored brief while the screen shows different content — the
      // exact disagreement CB-G2 exists to prevent, on the failure path.
      if (dirty && !(await save())) return;
      setValidation(await validateBriefById(brief.id));
    } catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setValidating(false); }
  };

  return (
    <div>
      <div className="action-bar u-flex u-items-center u-gap-2 u-mb-4">
        <Button variant="quiet" size="sm" onClick={onBack}><ArrowLeftIcon size={14} /> {t('backToBriefs')}</Button>
        {renaming ? (
          <form className="u-flex-1 u-flex u-gap-2 u-items-center" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
            <input
              className="ui-input u-flex-1" aria-label={t('renameLabel')} value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !renameDraft.trim()}>{t('common:save')}</Button>
            <Button type="button" variant="quiet" size="sm" onClick={() => setRenaming(false)}>{t('common:cancel')}</Button>
          </form>
        ) : (
          <h2 className="u-m-0 u-flex-1">
            {brief.name}{' '}
            <Button variant="quiet" size="sm" aria-label={t('renameLabel')} onClick={() => { setRenameDraft(brief.name); setRenaming(true); }}>
              <PencilIcon size={13} aria-hidden />
            </Button>
          </h2>
        )}
        {/* R2 CB-SP-11 — status was visible in the LIST row only, so a BRIEF-1
            demotion-to-draft was invisible at the surface where the protected
            edit happened. */}
        <StatusChip status={brief.status} t={t} />
        {brief.version !== undefined ? <span className="chip chip--muted">{t('revisionLabel', { version: brief.version })}</span> : null}
        {/* R2 CB-R2-2 — the handoff made visible on the source object. */}
        {linkedCampaign ? <Link className="chip chip--accent" to="/campaigns">{t('finalizedCampaignChip', { name: linkedCampaign.name })}</Link> : null}
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void (async () => {
          // R2 CB-SP-8 — Duplicate was disabled={busy} but never SET busy, so a
          // double-click minted two copies.
          setBusy(true);
          try { const copy = await duplicateBrief(brief.id); await onChanged(); toast.success(t('duplicatedToast', { name: copy.name })); onBack(); } catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
          finally { setBusy(false); }
        })()}><PlusIcon size={13} /> {t('duplicateAsTemplate')}</Button>
        {view === 'editor' ? (
          <>
            <Button variant="secondary" size="sm" disabled={validating || busy || (dirty && planInvalid)} onClick={() => void validate()}>
              {dirty ? t('saveAndValidate') : t('validate')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy || planInvalid} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</Button>
          </>
        ) : null}
      </div>

      {/* ADR 0403 P4 — the per-brief Editor | Intel sub-tabs (deep-linkable). */}
      <Tabs
        className="u-mb-4"
        idBase="brief-detail"
        label={t('briefViewsLabel')}
        items={[{ id: 'editor', label: t('viewEditor') }, { id: 'intel', label: t('viewIntel') }]}
        value={view}
        onChange={setView}
      />

      {view === 'intel' ? (
        <TabPanel idBase="brief-detail" tabId="intel">
          <IntelWorkspace brief={brief} onError={onError} onOpenStrategist={onOpenStrategist} />
        </TabPanel>
      ) : (
      <TabPanel idBase="brief-detail" tabId="editor">

      {validation ? (
        <div aria-label={t('validationSummaryLabel')} role="group">
          <Notice variant={validation.valid ? 'success' : 'warning'}>
            <Button variant="link" className="u-fs-11" onClick={() => setValidation(null)} aria-label={t('common:close')}><XIcon size={12} /></Button>
            {validation.valid
              ? <span><CheckIcon size={14} /> {t('validValid', { channels: validation.enabledChannels.map((c) => t(`channel_${c}`)).join(', ') })}</span>
              : (
                <div>
                  <p className="u-m-0 u-fw-600"><AlertIcon size={14} /> {t('validInvalidCount', { count: validation.issues.length })}</p>
                  {/* CB-G1 — one row per issue, each naming the section the
                      server pointed at, each a control that takes the reader
                      there. A jump is offered only for a field we can place;
                      an unrecognised field still shows its message. */}
                  <ul className="u-m-0 u-mt-1">
                    {validation.issues.map((i) => (
                      <li key={`${i.field}:${i.message}`}>
                        {SECTION_OF[i.field] ? (
                          <Button variant="link" onClick={() => jumpTo(i.field)}>
                            {t(`validSection_${SECTION_OF[i.field]!}`)}
                          </Button>
                        ) : <span className="u-fw-600">{i.field}</span>}
                        {': '}{i.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </Notice>
        </div>
      ) : null}

      {brief.kernel ? (
        <section className="surface-card u-mb-4">
          <div className="u-flex u-items-center u-gap-2 u-mb-2"><SparklesIcon size={16} /> <h3 className="u-m-0">{t('kernelTitle')}</h3>{brief.kernelStale ? <span className="chip chip--warning">{t('kernelStale')}</span> : null}</div>
          <p className="u-fw-600 u-mb-1">{brief.kernel.headline}</p>
          <p className="muted u-mt-0">{brief.kernel.supportingStatement}</p>
          {brief.kernel.proofPoints.length ? <ul>{brief.kernel.proofPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          {/* R2 CB-SP-11 — secondaryCta and generatedAt were fetched and
              discarded; generatedAt is the staleness story's missing half. */}
          <p className="u-fs-13"><strong>{t('kernelCta')}:</strong> {brief.kernel.primaryCta}{brief.kernel.secondaryCta ? ` · ${t('kernelSecondaryCta')}: ${brief.kernel.secondaryCta}` : ''} · <strong>{t('kernelTone')}:</strong> {brief.kernel.tone}{brief.kernel.sourceDocIds.length ? ` · ${t('kernelSources', { count: brief.kernel.sourceDocIds.length })}` : ''}</p>
          {brief.kernel.generatedAt ? <p className="u-fs-13 muted u-m-0">{t('kernelGeneratedAt', { when: formatDateTime(brief.kernel.generatedAt) })}</p> : null}
        </section>
      ) : (
        <Notice variant="info">{t('noKernelYet')} <Button variant="link" onClick={onOpenStrategist}>{t('generateWithStrategist')}</Button></Notice>
      )}

      <section className="surface-card u-mb-4" ref={sectionRefs.product} tabIndex={-1}>
        <h3 className="u-mt-0">{t('secProduct')}</h3>
        <TextareaField label={t('fieldObjective')} value={objective} rows={2} onChange={(e) => setObjective(e.target.value)} />
        <TextField label={t('fieldProductName')} value={productName} onChange={(e) => setProductName(e.target.value)} />
        <TextareaField label={t('fieldProductDescription')} value={productDescription} rows={2} onChange={(e) => setProductDescription(e.target.value)} />
        <TextField label={t('fieldIndustry')} value={industryVertical} onChange={(e) => setIndustryVertical(e.target.value)} />
        <SelectField label={t('fieldBrand')} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">{t('brandNone')}</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </SelectField>
        {/* ADR 0351 P2 — grounding policy: strict makes generation FAIL rather
            than draft ungrounded when the KB has no coverage. */}
        <SelectField label={t('fieldGroundingPolicy')} value={groundingPolicy} onChange={(e) => setGroundingPolicy(e.target.value as GroundingPolicy)}>
          <option value="best-effort">{t('groundingBestEffort')}</option>
          <option value="strict">{t('groundingStrict')}</option>
          <option value="off">{t('groundingOff')}</option>
        </SelectField>
        <p className="u-label-sm u-m-0">{t('groundingHint')}</p>
        {/* ADR 0355 P5 — competitor differentiation. */}
        <TextField label={t('fieldCompetitors')} value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder={t('competitorsPlaceholder')} />
      </section>

      <section className="surface-card u-mb-4" ref={sectionRefs.audience} tabIndex={-1}>
        <h3 className="u-mt-0">{t('secAudience')}</h3>
        {/* R2 CB-SP-6 — a failed personas read must not claim the org has none
            while the validator demands at least one. */}
        {personasReadFailed ? <p className="muted"><AlertIcon size={14} /> {t('personasLoadFailed')}</p>
          : orgPersonas.length === 0 ? <p className="muted">{t('noPersonasForOrg')}</p> : orgPersonas.map((p) => (
          <CheckboxField key={p.id} label={`${p.name}${p.role ? ` — ${p.role}` : ''}`} checked={personaIds.includes(p.id)} onChange={() => togglePersona(p.id)} />
        ))}
      </section>

      <section className="surface-card u-mb-4" ref={sectionRefs.channels} tabIndex={-1}>
        <h3 className="u-mt-0">{t('secChannels')}</h3>
        {channels.map((c) => (
          <CheckboxField key={c.type} label={t(`channel_${c.type}`)} checked={c.enabled} onChange={() => toggleChannel(c.type)} />
        ))}
      </section>

      <section className="surface-card u-mb-4" ref={sectionRefs.messaging} tabIndex={-1}>
        <h3 className="u-mt-0">{t('secMessaging')}</h3>
        <TextareaField label={t('fieldValueProp')} value={valueProp} rows={2} onChange={(e) => setValueProp(e.target.value)} />
        <TextareaField label={t('fieldProofPoints')} help={t('fieldProofPointsHelp')} value={proofPoints} rows={3} onChange={(e) => setProofPoints(e.target.value)} />
        <TextField label={t('fieldCtaStrategy')} value={ctaStrategy} onChange={(e) => setCtaStrategy(e.target.value)} />
        <TextField label={t('fieldToneOverride')} help={t('fieldToneOverrideHelp')} value={toneOverride} onChange={(e) => setToneOverride(e.target.value)} />
      </section>

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secPlan')}</h3>
        <p className="muted u-fs-13 u-mt-0">{t('secPlanHint')}</p>
        <TextField label={t('fieldBudgetTotal')} help={t('fieldBudgetTotalHelp')} value={budgetTotal} inputMode="decimal"
          error={budgetTotal.trim() !== '' && !(Number.isFinite(Number(budgetTotal)) && Number(budgetTotal) >= 0) ? t('fieldBudgetInvalid') : undefined}
          onChange={(e) => setBudgetTotal(e.target.value)} />
        <TextField label={t('fieldCurrency')} help={t('fieldCurrencyHelp')} value={currency} maxLength={3}
          error={currencyInvalid ? t('fieldCurrencyInvalid') : undefined}
          onChange={(e) => setCurrency(e.target.value)} />
        {brief.budget?.perChannel && Object.keys(brief.budget.perChannel).length ? (
          // R2 CB-SP-4/11 — per-channel allocations were invisible AND wiped by
          // a save that blanked the total; read-only until an editor exists.
          <p className="u-fs-13 muted">{t('budgetPerChannel', {
            lines: Object.entries(brief.budget.perChannel).map(([ch, m]) => `${t(`channel_${ch}`, { defaultValue: ch })}: ${m}`).join(' · '),
          })}</p>
        ) : null}
        <TextField label={t('fieldUtmSource')} value={utmSource} onChange={(e) => setUtmSource(e.target.value)} />
        <TextField label={t('fieldUtmMedium')} value={utmMedium} onChange={(e) => setUtmMedium(e.target.value)} />
        <TextField label={t('fieldUtmCampaign')} help={t('fieldUtmCampaignHelp')} value={utmCampaign} onChange={(e) => setUtmCampaign(e.target.value)} />
        <TextField label={t('fieldUtmTerm')} value={utmTerm} onChange={(e) => setUtmTerm(e.target.value)} />
        <TextField label={t('fieldUtmContent')} value={utmContent} onChange={(e) => setUtmContent(e.target.value)} />
      </section>

      {/* ADR 0356 P7 — the Review step: what generation will actually use.
          A summary card over the sectioned editor (the stepper variant was
          deliberately traded for this — recorded in the ADR). */}
      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secReview')}</h3>
        <div className="u-flex u-gap-2 u-wrap">
          {/* R2 CB-SP-6 — a failed brands read must not chip "No brand" as fact. */}
          <span className={`chip ${brandId ? 'chip--success' : 'chip--muted'}`}>{brandId ? t('reviewBrandBound') : brandsFailed ? t('reviewBrandUnknown') : t('reviewBrandMissing')}</span>
          <span className={`chip ${personaIds.length > 0 ? 'chip--success' : 'chip--muted'}`}>{personaIds.length > 0 ? t('reviewPersonas', { count: personaIds.length }) : t('reviewPersonasMissing')}</span>
          <span className={`chip ${brief.kbCollectionId ? 'chip--success' : 'chip--muted'}`}>{brief.kbCollectionId ? t('reviewKbBound') : t('reviewKbMissing')}</span>
          {/* CS-UX-4: the policy enum maps to its localized label — never raw. */}
          <span className="chip chip--muted">{t('reviewGrounding', { policy: t(groundingPolicy === 'strict' ? 'groundingStrict' : groundingPolicy === 'off' ? 'groundingOff' : 'groundingBestEffort') })}</span>
          {competitors.trim() ? <span className="chip chip--muted">{t('reviewCompetitors', { count: competitors.split(',').filter((c) => c.trim()).length })}</span> : null}
        </div>
        <p className="u-label-sm u-m-0">{t('reviewHint')}</p>
      </section>
      </TabPanel>
      )}
    </div>
  );
}

// ============================================================================
// PERSONAS
// ============================================================================

function PersonasTab({ t, orgs, orgsFailed, brands, onDisabled, onError }: { t: TFn; orgs: OrgRef[]; orgsFailed: boolean; brands: BrandRef[]; onDisabled: () => void; onError: (m: string) => void }): JSX.Element {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  // R2 CB-SP-2 — the R1 briefs fix, finally applied here: a load failure used
  // to leave the `null` loading sentinel forever (banner over an eternal
  // skeleton — reporting a failure and claiming to still work on it at once).
  const [personasFailed, setPersonasFailed] = useState(false);
  const [personasFailedMsg, setPersonasFailedMsg] = useState<string | null>(null);
  // Deep-link spine (ADR 0336): the persona being EDITED rides ?persona= (a
  // shareable entity view); "compose new" stays a local flag (ephemeral, no id).
  const [searchParams, setSearchParams] = useSearchParams();
  const editingId = searchParams.get('persona');
  const editingPersona = useMemo(() => personas?.find((p) => p.id === editingId) ?? null, [personas, editingId]);
  const [creating, setCreating] = useState(false);
  const selectPersona = useCallback((id: string | null) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('persona', id); else n.delete('persona'); return n; }, { replace: true });
  }, [setSearchParams]);
  const closeEditor = useCallback(() => { setCreating(false); selectPersona(null); }, [selectPersona]);
  const [confirmDelete, setConfirmDelete] = useState<Persona | null>(null);
  const [deletingPersona, setDeletingPersona] = useState(false);

  const refresh = useCallback(async () => {
    setPersonasFailed(false); setPersonasFailedMsg(null);
    try { setPersonas(await listPersonas()); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { onDisabled(); setPersonas([]); return; }
      setPersonas([]);
      setPersonasFailed(true);
      setPersonasFailedMsg(e instanceof Error ? e.message : null);
    }
  }, [onDisabled]);
  useEffect(() => { void refresh(); }, [refresh]);

  // §4.5 collection kit (DESIGN.md rule 13): gated name/role search + buyer-stage facet → separate memo.
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<'' | BuyerStage>('');
  const visiblePersonas = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (personas ?? []).filter((p) =>
      (!q || p.name.toLowerCase().includes(q) || (p.role ?? '').toLowerCase().includes(q))
      && (!stageFilter || p.buyerStage === stageFilter));
  }, [personas, query, stageFilter]);
  const clearFilters = useCallback(() => { setQuery(''); setStageFilter(''); }, []);

  return (
    <>
      {personas === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loadingPersonas')} loading />
      ) : personasFailed ? (
        <StateCard announce icon={<MegaphoneIcon size={22} />} title={t('common:loadFailedTitle')} body={personasFailedMsg ?? t('common:loadFailedBody')} />
      ) : personas.length === 0 ? (
        orgsFailed
          ? <StateCard announce icon={<MegaphoneIcon size={22} />} title={t('common:loadFailedTitle')} body={t('orgsLoadFailed')} />
          : orgs.length === 0
            ? <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
            : <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyPersonasTitle')} body={t('emptyPersonasBody')} action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><PlusIcon size={13} /> {t('newPersona')}</Button>} />
      ) : (
        <>
          <div className="action-bar u-flex u-justify-end u-mb-3"><Button variant="primary" size="sm" onClick={() => setCreating(true)}><PlusIcon size={13} /> {t('newPersona')}</Button></div>
          {personas.length > 3 ? (
            <div className="filterbar u-mb-3" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPersonasPlaceholder')}
                aria-label={t('filterPersonasAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={stageFilter} onChange={(e) => setStageFilter(e.target.value as '' | BuyerStage)} aria-label={t('filterStageLabel')}>
                <option value="">{t('allStages')}</option>
                {BUYER_STAGES.map((s) => <option key={s} value={s}>{t(`buyerStage_${s}`)}</option>)}
              </select>
            </div>
          ) : null}
          {visiblePersonas.length === 0 ? (
            <StateCard icon={<MegaphoneIcon size={22} />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearFilters}>{t('clearFilters')}</Button>} />
          ) : (
          <ul className="surface-card list-view u-list-none u-m-0">
            {visiblePersonas.map((p) => (
              <li key={p.id} className="list-row">
                <button type="button" className="list-row-id" onClick={() => selectPersona(p.id)}>
                  <span className="list-row-name-wrap">
                    <span className="list-row-name-line"><span className="list-row-name u-fw-600">{p.name}</span>{p.role ? <span className="muted u-fs-13">{p.role}</span> : null}</span>
                  </span>
                </button>
                <div className="list-row-name-line"><span className="chip chip--muted">{t(`buyerStage_${p.buyerStage}`)}</span>{p.painPoints.length ? <span className="chip chip--muted">{t('painPointsCount', { count: p.painPoints.length })}</span> : null}</div>
                <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(p)}><TrashIcon size={15} /></Button>
              </li>
            ))}
          </ul>
          )}
        </>
      )}
      {(creating || editingPersona) ? <PersonaEditor t={t} persona={creating ? null : editingPersona} orgs={orgs} brands={brands} onClose={closeEditor} onSaved={async () => { closeEditor(); await refresh(); }} onError={onError} /> : null}
      {confirmDelete ? (
        <ConfirmDialog title={t('deletePersonaTitle')} body={t('deletePersonaBody')} confirmLabel={t('common:delete')} danger busy={deletingPersona}
          onConfirm={async () => {
            setDeletingPersona(true);
            try { await deletePersona(confirmDelete.id); setConfirmDelete(null); await refresh(); }
            catch (e) { setConfirmDelete(null); onError(e instanceof Error ? e.message : t('actionFailed')); }
            finally { setDeletingPersona(false); }
          }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </>
  );
}

function PersonaEditor({ t, persona, orgs, brands, onClose, onSaved, onError }: { t: TFn; persona: Persona | null; orgs: OrgRef[]; brands: BrandRef[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(persona?.orgId ?? orgs[0]?.orgId ?? '');
  const [name, setName] = useState(persona?.name ?? '');
  const [role, setRole] = useState(persona?.role ?? '');
  const [buyerStage, setBuyerStage] = useState<BuyerStage>(persona?.buyerStage ?? 'problem_aware');
  const [painPoints, setPainPoints] = useState(joinLines(persona?.painPoints ?? []));
  const [objections, setObjections] = useState(joinLines(persona?.objections ?? []));
  const [goals, setGoals] = useState(joinLines(persona?.goals ?? []));
  const [demographics, setDemographics] = useState(persona?.demographics ?? '');
  const [brandId, setBrandId] = useState(persona?.brandId ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    const payload = { name, role, buyerStage, painPoints: splitLines(painPoints), objections: splitLines(objections), goals: splitLines(goals), demographics, ...(brandId ? { brandId } : {}) };
    try {
      if (persona) await updatePersona(persona.id, payload);
      else await createPersona({ ...payload, orgId });
      onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  };

  const canSave = name.trim().length > 0 && (persona !== null || orgId.length > 0);
  return (
    <Modal label={persona ? t('editPersona') : t('newPersona')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{persona ? t('editPersona') : t('newPersona')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); if (canSave && !busy) void save(); }}>
        {!persona ? (
          <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
        ) : null}
        <TextField label={t('fieldPersonaName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label={t('fieldRole')} value={role} onChange={(e) => setRole(e.target.value)} />
        <SelectField label={t('fieldBuyerStage')} value={buyerStage} onChange={(e) => setBuyerStage(e.target.value as BuyerStage)}>
          {BUYER_STAGES.map((s) => <option key={s} value={s}>{t(`buyerStage_${s}`)}</option>)}
        </SelectField>
        <TextareaField label={t('fieldPainPoints')} help={t('linePerItem')} value={painPoints} rows={3} onChange={(e) => setPainPoints(e.target.value)} />
        <TextareaField label={t('fieldObjections')} help={t('linePerItem')} value={objections} rows={3} onChange={(e) => setObjections(e.target.value)} />
        <TextareaField label={t('fieldGoals')} help={t('linePerItem')} value={goals} rows={2} onChange={(e) => setGoals(e.target.value)} />
        <TextareaField label={t('fieldDemographics')} value={demographics} rows={2} onChange={(e) => setDemographics(e.target.value)} />
        <SelectField label={t('fieldBrand')} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">{t('brandNone')}</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </SelectField>
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={!canSave || busy}>{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
