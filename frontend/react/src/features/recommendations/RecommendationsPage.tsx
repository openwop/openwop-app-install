/**
 * Recommendations admin page (ADR 0273 / MERCH-A). Merchandiser surface: configure
 * full-funnel placements (slot → source, optional segment target + holdout), preview
 * what a slot resolves to, and trigger an affinity rebuild. Gated by the
 * `recommendations` toggle (hidden in nav when off; disabled state on the page).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { formatCurrency, formatDateTime } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listOrgs, listPlacements, createPlacement, deletePlacement, updatePlacement,
  rebuildAffinity, resolvePreview,
  RECO_SLOTS, RECO_SOURCES, type Org, type Placement, type RecoSlot, type RecoSource, type ResolvePreview,
} from './recommendationsClient.js';

export function RecommendationsPage(): JSX.Element {
  const { t } = useTranslation('recommendations');
  // `useFeatureAccess` returns an OBJECT, so the previous `const enabled = …`
  // + `if (!enabled)` was ALWAYS truthy: the "not enabled" branch below was dead
  // and this page rendered regardless of its toggle. (The object-ness was visible
  // one line down, where `enabled.enabled` is what the org read already used.)
  // Destructure the flag, and keep the org read gated on it so a disabled feature
  // touches no network.
  const access = useFeatureAccess('recommendations');

  // `.catch(() => setOrgs([]))` left `orgId` '' — the load below is gated on
  // it, so the table's `empty=` slot rendered its loading skeleton forever,
  // while the selector claimed there were no stores. `orgs` was declared
  // non-nullable here, so `[]` was the ONLY value a failure could take.
  //
  // CORRECTION (HG-1) — only the FAILED half of that ever landed. A SUCCESSFUL
  // read of `[]` leaves `orgId` '' just the same, so the skeleton was still
  // terminal-condition-free on the commonest first-run path of all: a tenant with
  // no store yet. Both org states now have their own branch below the form, ABOVE
  // the table, and the failed one REPLACES the table instead of hanging a banner
  // beside a skeleton that keeps spinning under it.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [placements, setPlacements] = useState<Placement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The rows read FAILED — distinct from "this store has none yet". */
  const [placementsFailed, setPlacementsFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // create form
  const [slot, setSlot] = useState<RecoSlot>('pdp');
  const [source, setSource] = useState<RecoSource>('bought_together');
  const [holdout, setHoldout] = useState(0);
  const [segmentId, setSegmentId] = useState('');

  // preview
  const [previewSlot, setPreviewSlot] = useState<RecoSlot>('pdp');
  const [previewProductId, setPreviewProductId] = useState('');
  // R2 REC2-B2 — previewing as a CONTACT is the only way to reach a segment-targeted
  // placement; without it the resolver skips every one and the page calls the slot
  // unconfigured.
  const [previewContactId, setPreviewContactId] = useState('');
  const [preview, setPreview] = useState<ResolvePreview | null>(null);


  const load = useCallback(async (org: string) => {
    if (!org) return;
    setPlacementsFailed(false);
    try { setPlacements(await listPlacements(org)); setError(null); }
    // NOT `setPlacements([])` — that renders "No placements yet…" beside the
    // error Notice.
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); setPlacementsFailed(true); }
  }, [t]);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      await createPlacement(orgId, { slot, source, ...(holdout > 0 ? { holdoutPct: holdout } : {}), ...(segmentId.trim() ? { segmentId: segmentId.trim() } : {}) });
      setSegmentId(''); setHoldout(0);
      toast.success(t('placementAdded'));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, slot, source, holdout, segmentId, load, t]);

  const toggleActive = useCallback(async (p: Placement) => {
    try { await updatePlacement(orgId, p.placementId, { active: !p.active }); await load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
  }, [orgId, load, t]);

  const remove = useCallback(async (p: Placement) => {
    if (!(await confirm({ title: t('deleteConfirm', { slot: t(`slot_${p.slot}`) }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await deletePlacement(orgId, p.placementId); await load(orgId); toast.success(t('placementDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const rebuild = useCallback(async () => {
    // Defence in depth for a real POST: `disabled={busy || !orgId}` was this
    // write's ONLY guard, so any path reaching the handler without the button
    // would rebuild affinity against an empty organization id. Its sibling
    // `add()` already early-returns; match it.
    //
    // NOT PINNED, deliberately labelled: no current test reddens when this line
    // is removed (verified by deleting exactly this guard — 12/12 still green),
    // because the only reachable zero-org path has the button disabled, and a
    // disabled button cannot be clicked. So this guards a path the suite cannot
    // reach today. Kept because the cost is one line and the failure mode is a
    // write against an empty org id — but do not read it as verified.
    if (!orgId) return;
    setBusy(true);
    try {
      const { rows, removed } = await rebuildAffinity(orgId);
      toast.success(removed > 0 ? t('affinityRebuiltWithRemovals', { rows, removed }) : t('affinityRebuilt', { rows }));
    }
    catch (e) { toast.error(e instanceof Error ? e.message : t('rebuildFailed')); }
    finally { setBusy(false); }
  }, [orgId, t]);

  const runPreview = useCallback(async () => {
    setBusy(true);
    try {
      setPreview(await resolvePreview(orgId, {
        slot: previewSlot,
        ...(previewProductId.trim() ? { productId: previewProductId.trim() } : {}),
        ...(previewContactId.trim() ? { contactId: previewContactId.trim() } : {}),
      }));
    } catch (e) {
      // R2 REC2-M6 — a failed preview left the PREVIOUS result on screen under the new
      // query, so a stale answer read as a current one.
      setPreview(null);
      toast.error(e instanceof Error ? e.message : t('previewFailed'));
    } finally { setBusy(false); }
  }, [orgId, previewSlot, previewProductId, previewContactId, t]);

  const columns = useMemo<DataColumn<Placement>[]>(() => [
    { key: 'slot', header: t('colSlot'), render: (p) => t(`slot_${p.slot}`), sortValue: (p) => p.slot },
    { key: 'source', header: t('colSource'), render: (p) => t(`source_${p.source}`), sortValue: (p) => p.source },
    { key: 'segment', header: t('colSegment'), render: (p) => p.segmentId ?? t('untargeted') },
    { key: 'holdout', header: t('colHoldout'), render: (p) => (p.holdoutPct ? `${p.holdoutPct}%` : '—') },
    { key: 'active', header: t('colActive'), render: (p) => (
      <span className={p.active ? 'chip chip--success' : 'chip chip--muted'}>{p.active ? t('active') : t('paused')}</span>
    ) },
    { key: 'actions', header: '', render: (p) => (
      <span className="action-bar">
        <Button variant="quiet" onClick={() => void toggleActive(p)} aria-label={t('toggleActiveLabel', { slot: t(`slot_${p.slot}`) })}>
          {p.active ? t('pause') : t('activate')}
        </Button>
        <Button variant="quiet" onClick={() => void remove(p)} aria-label={t('deleteRowLabel', { slot: t(`slot_${p.slot}`) })}>
          {t('common:delete')}
        </Button>
      </span>
    ) },
  ], [t, toggleActive, remove]);

  // The toggle has not resolved yet — a shape-matched skeleton UNDER the real
  // header, not a `StateCard`: the card's only text would be the page title, so
  // it reads as a terminal answer, and it unmounts `PageHeader` on the way in and
  // out. (The corpus majority — `commerce`, `commerce-ucp-buyer`, `webinars`,
  // `creative-video` — keeps the header and swaps the body.)
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="recommendations.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={3} columns={[120, 140, 120, 80, 80, 80]} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="recommendations.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="recommendations.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* HG-4 — the branch ORDER (failed → zero-orgs → children) and the NOUN
          are `OrgSelectionState`'s now. This page called the same `listOrgs`
          collection "stores" in its picker and "organizations" in its card; one
          screen does not get two nouns for one thing. Both org states still sit
          ABOVE the table, because the `empty=` slot is what BOTH of them
          rendered otherwise — a skeleton waiting on a placements read that never
          starts, i.e. a `role="status"` "Loading…" live region with no terminal
          condition.
          It wraps the FORM too (the custom-domains shape). It did not, and the
          cost was the picker: outside the wrapper the org `<select>` still
          rendered in both org states, and in both of them `orgs` has no entries
          — a labelled combobox with nothing in it, announced as "Organization,
          combo box, 0 items". A control with no options is not a control; the
          card that replaces it says what happened. With no organization the
          submit could not write anything anyway (`disabled={… || !orgId}`).
          Loading keeps a real placeholder option, because that state DOES render
          the form and an empty combobox is no better there. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<SparklesIcon />}>
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <SelectField label={t('ui:orgPickerLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
          {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <SelectField label={t('fieldSlot')} value={slot} onChange={(e) => setSlot(e.target.value as RecoSlot)}>
          {RECO_SLOTS.map((s) => <option key={s} value={s}>{t(`slot_${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldSource')} value={source} onChange={(e) => setSource(e.target.value as RecoSource)}>
          {RECO_SOURCES.map((s) => <option key={s} value={s}>{t(`source_${s}`)}</option>)}
        </SelectField>
        {/* A holdout percentage silently suppresses recommendations for that
            share of shoppers — worth a sentence now that there is a slot. */}
        <TextField className="is-narrow" label={t('fieldHoldout')} help={t('fieldHoldoutHelp')}
          type="number" min={0} max={100} value={holdout}
          onChange={(e) => setHoldout(Math.min(100, Math.max(0, Math.trunc(Number(e.target.value)) || 0)))} />
        <TextField label={t('fieldSegment')} value={segmentId} onChange={(e) => setSegmentId(e.target.value)} placeholder={t('segmentPlaceholder')} />
        <span className="action-bar">
          <Button variant="primary" type="submit" disabled={busy || !orgId}>{t('addPlacement')}</Button>
          <Button variant="quiet" disabled={busy || !orgId} onClick={() => void rebuild()}>{t('rebuildAffinity')}</Button>
        </span>
      </form>

            <DataTable
        stack
        rows={placements ?? []}
        rowKey={(p) => p.placementId}
        columns={columns}
        caption={t('captionPlacements')}
        empty={placementsFailed
          ? <StateCard announce icon={<SparklesIcon />} title={t('rowsFailedTitle')} body={t('rowsFailedBody')} action={<Button variant="secondary" onClick={() => void load(orgId)}>{t('orgsRetry')}</Button>} />
          : placements === null
          ? <SkeletonRows rows={3} columns={[120, 140, 120, 80, 80, 80]} />
          : <StateCard icon={<SparklesIcon />} title={t('noPlacementsTitle')} body={t('noPlacementsBody')} />}
      />

      {/* INSIDE the wrapper, and it was not. Taking `children` stops a caller
          rendering content ABOVE the guard, but a sibling BELOW it escapes the
          branch order just as completely: this preview console rendered in full
          over a failed organization read, with a submit that `!orgId` merely
          disabled. A slot picker and an anchor field you can fill in, under a
          card saying the organizations could not be read, invite a diagnosis of
          the wrong thing. */}
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void runPreview(); }}>
        <h2 className="u-label-sm">{t('previewTitle')}</h2>
        <SelectField label={t('fieldSlot')} value={previewSlot} onChange={(e) => { setPreview(null); setPreviewSlot(e.target.value as RecoSlot); }}>
          {RECO_SLOTS.map((s) => <option key={s} value={s}>{t(`slot_${s}`)}</option>)}
        </SelectField>
        <TextField label={t('fieldAnchor')} value={previewProductId} onChange={(e) => { setPreview(null); setPreviewProductId(e.target.value); }} placeholder={t('anchorPlaceholder')} />
        <TextField label={t('fieldPreviewContact')} help={t('fieldPreviewContactHelp')} value={previewContactId} onChange={(e) => { setPreview(null); setPreviewContactId(e.target.value); }} placeholder={t('previewContactPlaceholder')} />
        <Button variant="primary" type="submit" disabled={busy || !orgId}>{t('preview')}</Button>
        {preview ? (
          <div className="u-grid u-gap-2">
            {/* REC-G2 — three distinct outcomes used to render the same sentence.
                `placementId` is present iff a placement actually matched, which is
                what separates "you never configured this slot" from "it is
                configured and found nothing" — completely different fixes. */}
            {/* R2 REC2-M1 — a placement whose segment no longer resolves is skipped
                server-side; saying so is the difference between "no match" and "your
                targeting is broken". */}
            {preview.unresolvedSegmentIds?.length ? (
              <Notice variant="warning" announce={t('previewUnresolvedSegment', { ids: preview.unresolvedSegmentIds.join(', ') })}>
                {t('previewUnresolvedSegment', { ids: preview.unresolvedSegmentIds.join(', ') })}
              </Notice>
            ) : null}
            {/* R2 REC2-M2 — the placements table shows a holdout percentage; this says
                whether it is actually being enforced for this call. */}
            {preview.holdoutInert ? <Notice variant="warning" announce={t('previewHoldoutInert')}>{t('previewHoldoutInert')}</Notice> : null}
            {preview.products.length === 0 ? (
              !preview.placementId
                // R2 REC2-B2 — "unconfigured" is only true if no placement for this slot
                // exists at all. When one DOES exist but is segment-targeted and this
                // preview was anonymous, the honest answer names that, instead of telling
                // the operator to add the placement sitting active in the table above.
                // The RESOLVER reports this now (`segmentTargetedSkipped`) — the page
                // used to have to infer it from the placements list, which is a guess.
                ? preview.segmentTargetedSkipped
                  ? <Notice variant="info" announce={t('previewSegmentTargeted', { slot: t(`slot_${previewSlot}`) })}>{t('previewSegmentTargeted', { slot: t(`slot_${previewSlot}`) })}</Notice>
                  // Review MJ-1 — the LIKELY outcome of the new contact field: a contact
                  // who is not in the segment. Without its own branch this fell back to
                  // "add a placement above" — the lie the field exists to remove.
                  : preview.segmentNotMatched
                  ? <Notice variant="info" announce={t('previewSegmentNotMatched')}>{t('previewSegmentNotMatched')}</Notice>
                  : <Notice variant="warning" announce={t('previewNoPlacement', { slot: t(`slot_${previewSlot}`) })}>{t('previewNoPlacement', { slot: t(`slot_${previewSlot}`) })}</Notice>
                : preview.variant === 'control'
                  // R3 M10 — a Notice mounted WITH content announces nothing
                  // (the documented trap; the two branches above already opt in).
                  ? <Notice variant="info" announce={t('previewControl')}>{t('previewControl')}</Notice>
                  : <Notice variant="info" announce={t('previewEmpty')}>{t('previewEmpty')}</Notice>
            ) : (
              <>
                {/* R3 M4 — the freshness of the affinity these results consumed;
                    a store serving last quarter's frozen scores now says so. */}
                {preview?.affinityComputedAt ? (
                  <p className="muted u-fs-12 u-m-0">{t('affinityFreshness', { when: formatDateTime(preview.affinityComputedAt) })}</p>
                ) : null}
                {/* Which algorithm actually served these — the placement form lets
                    you choose a source, so confirming it is the point of a preview. */}
                <p className="u-text-sm muted u-m-0">
                  {preview.source ? t('previewServedBy', { source: t(`source_${preview.source}`) }) : null}
                  {preview.variant ? <> · {t('previewVariant', { variant: preview.variant })}</> : null}
                </p>
                <ul className="u-grid u-gap-1">
                  {/* REC-G1 — was `{p.price} {p.currency}`: a bare number and a code. */}
                  {preview.products.map((p) => <li key={p.productId}>{p.name} — {formatCurrency(p.price, p.currency)}</li>)}
                </ul>
              </>
            )}
          </div>
        ) : null}
      </form>
      </OrgSelectionState>
    </section>
  );
}
