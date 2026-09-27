/**
 * Environments admin page (ADR 0387 Phase 5) — environment cards (protection,
 * pinned snapshot, drift), a snapshot list with "apply to live" (materializes a
 * prior config = restore/rollback), a promotion wizard (source→target with diff
 * preview), and the history ledger. Admin-tier; all mutations are
 * `host:members:manage`-gated by the backend. (Pointer-level rollback — re-pin
 * an env to a prior hash — is API-tested; the UI restore path is apply-to-live.)
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { ArrowUpToLineIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatRelativeTime } from '../../i18n/format.js';
import {
  applyToLive,
  ensureChain,
  listEnvironments,
  listPromotions,
  listSnapshots,
  previewPromotion,
  promote,
  setProtection,
  snapshotLive,
  type ConfigSnapshot,
  type ConfigEntryDiff,
  type DomainDiff,
  type Environment,
  type EnvironmentProtection,
  type Promotion,
} from './environmentsClient.js';

const PROTECTIONS: EnvironmentProtection[] = ['open', 'protected', 'locked'];

/** Protection strength, so a DOWNGRADE (locked→open) can be confirmed while an
 *  upgrade stays a one-click change. Promote and apply-to-live both confirm;
 *  relaxing a change-freeze is at least as consequential and used not to. */
const PROTECTION_RANK: Record<EnvironmentProtection, number> = { open: 0, protected: 1, locked: 2 };

function protectionChip(p: EnvironmentProtection): string {
  return p === 'locked' ? 'chip chip--danger' : p === 'protected' ? 'chip chip--warning' : 'chip chip--muted';
}

/** Domains whose restore is APPLY-ONLY (ADR 0479 two-register doctrine):
 *  their "removed" count means "in live but not in the snapshot — KEPT on
 *  apply", so the row says exactly that (the B4 half-truth guard). Sourced
 *  from the backend registry via the environments payload when available;
 *  this set is the fallback for older payloads. */
const APPLY_ONLY_FALLBACK = new Set(['publish-pointers', 'workflow-pins']);

/** A `type` alias, NOT an `interface` — i18next's `TOptions` needs an implicit
 *  index signature, which TS grants to object type aliases but not to interfaces. */
type DiffTotals = { added: number; changed: number; removed: number; kept: number };

/**
 * Aggregate a diff summary, splitting `removed` by what it MEANS per domain.
 *
 * For an exact-match domain, "removed" is a real clear. For an apply-only domain
 * (publish pointers, workflow pins) it means "in live but not in the snapshot —
 * KEPT on apply". The per-domain list already said this (`diffSummaryApplyOnly`);
 * the aggregate above it did not, so the headline read "3 removed" over a
 * breakdown that read "3 kept". Same data, two contradictory sentences — the
 * aggregate now carries the same distinction.
 */
function diffTotals(summary: Record<string, DomainDiff>, applyOnly?: ReadonlySet<string> | undefined): DiffTotals {
  const ao = applyOnly ?? APPLY_ONLY_FALLBACK;
  return Object.entries(summary).reduce<DiffTotals>(
    (acc, [id, d]) => ({
      added: acc.added + d.added,
      changed: acc.changed + d.changed,
      removed: acc.removed + (ao.has(id) ? 0 : d.removed),
      kept: acc.kept + (ao.has(id) ? d.removed : 0),
    }),
    { added: 0, changed: 0, removed: 0, kept: 0 },
  );
}

/**
 * The VALUE-level view behind the counts (`environments` DEF-1). Counts alone
 * ("3 changed") are not a preview of a promotion to prod — LaunchDarkly puts a
 * current-vs-proposed diff in the path of the copy, and this is our analogue.
 *
 * Two things it must not do, both learned the hard way in this file:
 *  - collapse the apply-only vocabulary. In an apply-only domain a "removed"
 *    entry is KEPT on apply, so it is labelled that way here too — #2557 had to
 *    fix an aggregate that said "removed" over a breakdown that said "kept", and
 *    a value-level view is more surface for that same half-truth, not less.
 *  - imply completeness. The server caps the list; `truncated` is rendered.
 */
function EntryChangeList({ diff, applyOnly, t }: { diff: ConfigEntryDiff; applyOnly: boolean; t: TFunction<'environments'> }): JSX.Element {
  const render = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <>
      <ul className="u-fs-12 u-m-0 u-mt-1 u-pl-3 u-list-none">
        {diff.changes.map((c) => (
          <li key={`${c.kind}:${c.path}`}>
            <span className={`chip u-fs-12 ${c.kind === 'added' ? 'chip--success' : c.kind === 'removed' ? (applyOnly ? 'chip--muted' : 'chip--danger') : 'chip--warning'}`}>
              {c.kind === 'removed' && applyOnly ? t('entryKept') : t(`entry_${c.kind}`)}
            </span>{' '}
            <code>{c.path}</code>
            {c.kind === 'changed' ? <> — <code>{render(c.from)}</code> → <code>{render(c.to)}</code></> : null}
            {c.kind === 'added' ? <> — <code>{render(c.to)}</code></> : null}
            {c.kind === 'removed' ? <> — <code>{render(c.from)}</code></> : null}
          </li>
        ))}
      </ul>
      {diff.truncated > 0 ? (
        <p className="u-fs-12 muted u-m-0 u-mt-1">{t('entryTruncated', { count: diff.truncated })}</p>
      ) : null}
    </>
  );
}

/** The aggregate sentence — mentions "kept" only when an apply-only domain
 *  actually contributes one, so the common case stays the short line. */
function diffTotalsText(tot: DiffTotals, t: TFunction<'environments'>): string {
  return tot.kept > 0 ? t('diffSummaryWithKept', tot) : t('diffSummary', tot);
}

/** ADR 0479 — the per-domain diff breakdown (the aggregate hid WHICH kind of
 *  config a promotion touches; "3 changed" reads very differently when the
 *  domain is workflow pins vs toggle overrides). Domain labels are i18n keys
 *  (`domain_<id>`) with the raw id as honest fallback for domains registered
 *  after this build. Zero-diff domains are omitted (no noise rows). */
function DomainDiffList({ summary, applyOnly, t }: { summary: Record<string, DomainDiff>; applyOnly?: ReadonlySet<string> | undefined; t: TFunction<'environments'> }): JSX.Element | null {
  const rows = Object.entries(summary).filter(([, d]) => d.added + d.changed + d.removed > 0);
  if (rows.length === 0) return null;
  const ao = applyOnly ?? APPLY_ONLY_FALLBACK;
  return (
    <ul className="u-fs-12 u-m-0 u-mt-1 u-pl-3">
      {rows.map(([id, d]) => (
        <li key={id}>
          {t(`domain_${id.replace(/-/g, '_')}`, { defaultValue: id })}: {t(ao.has(id) && d.removed > 0 ? 'diffSummaryApplyOnly' : 'diffSummary', { added: d.added, changed: d.changed, removed: d.removed })}
        </li>
      ))}
    </ul>
  );
}

export function EnvironmentsPage(): JSX.Element {
  const { t } = useTranslation('environments');
  const access = useFeatureAccess('environments');
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [snapshots, setSnapshots] = useState<ConfigSnapshot[] | null>(null);
  const [promotions, setPromotions] = useState<Promotion[] | null>(null);
  // Per-section read errors. A failed HISTORY read used to blank the whole page
  // (one `Promise.all` reject took the environment cards down with it); each
  // section now reports its own failure and the others still render.
  const [envError, setEnvError] = useState<string | null>(null);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [promotionsError, setPromotionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Promotion wizard
  const [fromEnv, setFromEnv] = useState('');
  const [toEnv, setToEnv] = useState('');
  const [preview, setPreview] = useState<{ target: string; summary: Record<string, DomainDiff>; entries?: Record<string, ConfigEntryDiff> } | null>(null);
  const [applyOnlyDomains, setApplyOnlyDomains] = useState<ReadonlySet<string> | undefined>(undefined);
  /** The per-domain result of the last apply-to-live, kept on screen. A toast
   *  cannot carry "2 of 3 domains restored, publish-pointers failed: <why>". */
  const [applyReport, setApplyReport] = useState<
    { hash: string; ok: string[]; failed: Array<{ id: string; error?: string }> } | null
  >(null);
  /** Set when a promotion was intercepted by the H2 approval gate — nothing moved. */
  const [pendingApproval, setPendingApproval] = useState<{ toEnv: string; approvalId: string | null } | null>(null);

  const refresh = useCallback(async () => {
    const [envRes, snaps, proms] = await Promise.allSettled([listEnvironments(true), listSnapshots(), listPromotions()]);

    if (envRes.status === 'fulfilled') {
      if (envRes.value.domains) {
        setApplyOnlyDomains(new Set(envRes.value.domains.filter((d) => d.restore === 'apply-only').map((d) => d.id)));
      }
      setEnvironments(envRes.value.environments);
      setAppVersion(envRes.value.appVersion);
      setEnvError(null);
    } else {
      // Do NOT fall back to `[]`. An empty array renders "Set up your environment
      // chain" over a button that CREATES a dev/staging/prod chain — a write
      // offered on the strength of a read that failed, asserting "you have no
      // environments" when the server never answered.
      setEnvError(envRes.reason instanceof Error ? envRes.reason.message : String(envRes.reason));
    }

    if (snaps.status === 'fulfilled') { setSnapshots(snaps.value); setSnapshotsError(null); }
    else setSnapshotsError(snaps.reason instanceof Error ? snaps.reason.message : String(snaps.reason));

    if (proms.status === 'fulfilled') { setPromotions(proms.value); setPromotionsError(null); }
    else setPromotionsError(proms.reason instanceof Error ? proms.reason.message : String(proms.reason));
  }, []);

  useEffect(() => {
    if (access.enabled) void refresh();
  }, [access.enabled, refresh]);

  /** Run a mutation whose only outcomes are "threw" or "worked". Handlers whose
   *  server answer has MORE than two outcomes (promote, apply) don't use this —
   *  they narrow the result themselves. */
  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setBusy(true);
      try {
        await fn();
        toast.success(okMsg);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /** The target this promotion would actually hit — an explicit choice, or the
   *  backend's next-in-chain rule, which is strictly `order + 1`
   *  (`environmentsService.ts` promote()), NOT "the next greater order". */
  const resolveTarget = useCallback(
    (source: Environment | undefined): string | null => {
      if (toEnv) return toEnv;
      if (!source) return null;
      return environments?.find((e) => e.order === source.order + 1)?.name ?? null;
    },
    [toEnv, environments],
  );

  const onPreview = useCallback(async () => {
    const source = environments?.find((e) => e.name === fromEnv);
    if (!source?.currentSnapshot) {
      toast.error(t('sourceNoSnapshot'));
      return;
    }
    // Previously this returned silently unless an explicit target was picked,
    // so on the DEFAULT "Next in chain" path the one safety affordance on the
    // page did nothing at all — while Promote happily accepted the same blank
    // target. You could promote to prod but not preview it.
    const target = resolveTarget(source);
    if (!target) {
      toast.error(t('noNextEnv', { from: source.name }));
      return;
    }
    try {
      const { diffSummary, entryDiff } = await previewPromotion(target, source.currentSnapshot);
      setPreview({ target, summary: diffSummary, ...(entryDiff ? { entries: entryDiff } : {}) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [fromEnv, environments, resolveTarget, t]);

  /** Promote — THREE distinct server outcomes, not one.
   *  201 moved · 201 `noop` (target already at this hash) · 202 gated (nothing
   *  moved, a review is queued). All three used to toast "Promotion recorded." */
  const onPromote = useCallback(async () => {
    setBusy(true);
    setPendingApproval(null);
    try {
      const outcome = await promote(fromEnv, toEnv || undefined);
      if (outcome.status === 'pending_approval') {
        const target = resolveTarget(environments?.find((e) => e.name === fromEnv)) ?? toEnv;
        setPendingApproval({ toEnv: target, approvalId: outcome.approvalId });
        toast.info(t('promoteQueued'));
      } else if (outcome.noop) {
        toast.info(t('promotedNoop', { to: outcome.environment.name }));
      } else {
        toast.success(t('promoted'));
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [fromEnv, toEnv, environments, resolveTarget, refresh, t]);

  /** Apply to live — the service applies each config domain independently and
   *  returns `{ id, ok, error }` PER DOMAIN without throwing when some fail
   *  (`environmentsService.ts` applySnapshot). Discarding that array meant a
   *  half-restored live config reported as "Config applied to live." */
  const onApply = useCallback(
    async (hash: string) => {
      setBusy(true);
      setApplyReport(null);
      try {
        const { domains } = await applyToLive(hash);
        const failed = domains.filter((d) => !d.ok).map((d) => ({ id: d.id, ...(d.error ? { error: d.error } : {}) }));
        const ok = domains.filter((d) => d.ok).map((d) => d.id);
        if (failed.length > 0) {
          setApplyReport({ hash, ok, failed });
          if (ok.length === 0) toast.error(t('applyAllFailed'));
          else toast.warning(t('appliedPartial', { ok: ok.length, total: domains.length }));
        } else {
          toast.success(t('applied'));
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  /** Relaxing a change-freeze is confirmed; tightening one is not. */
  const onProtectionChange = useCallback(
    async (env: Environment, next: EnvironmentProtection) => {
      if (PROTECTION_RANK[next] < PROTECTION_RANK[env.protection]) {
        const ok = await confirm({
          title: t('confirmRelaxTitle', { name: env.name }),
          body: t('confirmRelaxBody', { from: t(`protection_${env.protection}`), to: t(`protection_${next}`) }),
          danger: true,
        });
        if (!ok) return;
      }
      await run(() => setProtection(env.name, next), t('protectionSet'));
    },
    [run, t],
  );

  const snapshotColumns = useMemo<DataColumn<ConfigSnapshot>[]>(
    () => [
      { key: 'hash', header: t('colHash'), render: (s) => <code>{s.hash.slice(0, 12)}</code> },
      { key: 'sourceEnv', header: t('colSource'), render: (s) => s.sourceEnv ?? <span className="muted">—</span> },
      { key: 'createdAt', header: t('colCreated'), render: (s) => formatRelativeTime(s.createdAt) },
      {
        key: 'actions',
        header: t('colActions'),
        render: (s) => (
          <span className="action-bar">
            <Button
              variant="quiet" size="sm"
              disabled={busy}
              onClick={() =>
                void confirm({
                  title: t('confirmApplyTitle'),
                  body: t('confirmApplyBody', { hash: s.hash.slice(0, 12) }),
                  danger: true,
                }).then((ok) => {
                  if (ok) return onApply(s.hash);
                })
              }
            >
              {t('applyToLive')}
            </Button>
          </span>
        ),
      },
    ],
    [t, busy, onApply],
  );

  const promotionColumns = useMemo<DataColumn<Promotion>[]>(
    () => [
      { key: 'when', header: t('colWhen'), render: (p) => formatRelativeTime(p.createdAt) },
      {
        key: 'move',
        header: t('colMove'),
        render: (p) => (p.fromEnv ? `${p.fromEnv} → ${p.toEnv}` : `${t('rollbackLabel')} → ${p.toEnv}`),
      },
      { key: 'hash', header: t('colHash'), render: (p) => <code>{p.snapshotHash.slice(0, 12)}</code> },
      {
        key: 'diff',
        header: t('colDiff'),
        // ADR 0479 (ux #3) — the ledger answers "what did that promotion
        // touch?"; the per-domain data is already in the row.
        render: (p) => (
          <details>
            <summary className="u-cursor-pointer">{diffTotalsText(diffTotals(p.diffSummary, applyOnlyDomains), t)}</summary>
            <DomainDiffList summary={p.diffSummary} applyOnly={applyOnlyDomains} t={t} />
          </details>
        ),
      },
      { key: 'actor', header: t('colActor'), render: (p) => p.actor },
    ],
    [t, applyOnlyDomains],
  );

  if (!access.enabled) {
    return (
      <div className="u-p-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ArrowUpToLineIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="environments.page" className="u-p-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {appVersion ? <p className="u-fs-12 muted">{t('deployedVersion', { version: appVersion })}</p> : null}

      {envError && environments === null ? (
        // The read failed and we have nothing to show. Deliberately NO "create
        // the chain" action here: that button asserts "you have no environments",
        // which is precisely the claim a failed read cannot make. Retry instead.
        <StateCard
          announce
          icon={<ArrowUpToLineIcon />}
          title={t('loadFailedTitle')}
          body={`${t('loadFailedBody')} ${envError}`}
          action={
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void refresh()}>
              {t('retry')}
            </Button>
          }
        />
      ) : environments === null ? (
        <SkeletonRows rows={3} columns={['60%']} />
      ) : environments.length === 0 ? (
        <StateCard
          icon={<ArrowUpToLineIcon />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(ensureChain, t('chainSeeded'))}>
              {t('seedChain')}
            </Button>
          }
        />
      ) : (
        <>
          {/* A refresh failed after a good first load — the cards below are the
              last known state, not the current one. Say so rather than showing
              stale data as if it were live. */}
          {envError ? <Notice variant="warning" announce={t('staleAfterRefreshAnnounce')}>{t('staleAfterRefresh', { error: envError })}</Notice> : null}

          {/* Environment cards */}
          <div className="card-grid u-mb-4">
            {environments.map((e) => (
              <div key={e.environmentId} className="surface-card u-p-3">
                <div className="u-flex u-items-center u-gap-2 u-mb-1">
                  <strong className="u-fs-15">{e.name}</strong>
                  <span className={protectionChip(e.protection)}>{t(`protection_${e.protection}`)}</span>
                  {e.drift?.drifted ? <span className="chip chip--warning">{t('drifted')}</span> : null}
                </div>
                <p className="u-fs-12 muted u-m-0">
                  {e.currentSnapshot ? <code>{e.currentSnapshot.slice(0, 12)}</code> : t('noSnapshot')}
                </p>
                <div className="action-bar u-mt-2">
                  <select
                    className="ui-input"
                    aria-label={t('setProtection')}
                    value={e.protection}
                    disabled={busy}
                    onChange={(ev) => void onProtectionChange(e, ev.target.value as EnvironmentProtection)}
                  >
                    {PROTECTIONS.map((p) => (
                      <option key={p} value={p}>{t(`protection_${p}`)}</option>
                    ))}
                  </select>
                  {e.drift?.drifted ? (
                    <Button
                      variant="quiet" size="sm"
                      disabled={busy}
                      onClick={() => void run(() => snapshotLive(e.name), t('snapshotTaken'))}
                    >
                      {t('snapshotCurrent')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {/* Promotion wizard */}
          <section className="surface-card u-p-3 u-mb-4">
            <h2 className="u-fs-15 u-fw-600 u-mt-0">{t('promoteHeading')}</h2>
            <div className="action-bar">
              <select className="ui-input" aria-label={t('fromEnv')} value={fromEnv} onChange={(e) => { setFromEnv(e.target.value); setPreview(null); }}>
                <option value="">{t('fromEnv')}</option>
                {environments.map((e) => (
                  <option key={e.environmentId} value={e.name}>{e.name}</option>
                ))}
              </select>
              <span aria-hidden="true">→</span>
              <select className="ui-input" aria-label={t('toEnv')} value={toEnv} onChange={(e) => { setToEnv(e.target.value); setPreview(null); }}>
                <option value="">{t('toEnvOptional')}</option>
                {environments.map((e) => (
                  <option key={e.environmentId} value={e.name}>{e.name}</option>
                ))}
              </select>
              <Button variant="quiet" size="sm" disabled={!fromEnv || busy} onClick={() => void onPreview()}>
                {t('preview')}
              </Button>
              <Button
                variant="primary" size="sm"
                disabled={!fromEnv || busy}
                onClick={() =>
                  void confirm({ title: t('confirmPromoteTitle'), body: t('confirmPromoteBody', { from: fromEnv, to: toEnv || t('nextInChain') }) }).then((ok) => {
                    if (ok) return onPromote();
                  })
                }
              >
                {t('promote')}
              </Button>
            </div>
            {preview ? (
              <div className="u-mt-2" role="status">
                {/* Name the resolved target — on the "Next in chain" default the
                    user never saw WHICH environment this diff was against. */}
                <p className="u-fs-12 u-m-0 muted">{t('previewAgainst', { from: fromEnv, to: preview.target })}</p>
                {(() => { const tot = diffTotals(preview.summary, applyOnlyDomains); return tot.added + tot.changed + tot.removed + tot.kept === 0
                  ? <p className="u-fs-12 u-m-0">{t('previewNoChanges')}</p>
                  : <p className="u-fs-12 u-m-0">{diffTotalsText(tot, t)}</p>; })()}
                <DomainDiffList summary={preview.summary} applyOnly={applyOnlyDomains} t={t} />
                {/* The values behind the counts. Absent when the backend predates
                    this field — counts-only is the honest degradation, and is
                    NOT rendered as an empty change list. */}
                {preview.entries && Object.keys(preview.entries).length > 0 ? (
                  <details className="u-mt-2">
                    <summary className="u-cursor-pointer u-fs-12">{t('entryDiffToggle')}</summary>
                    {Object.entries(preview.entries).map(([domainId, d]) => (
                      <div key={domainId} className="u-mt-1">
                        <strong className="u-fs-12">
                          {t(`domain_${domainId.replace(/-/g, '_')}`, { defaultValue: domainId })}
                        </strong>
                        <EntryChangeList
                          diff={d}
                          applyOnly={(applyOnlyDomains ?? APPLY_ONLY_FALLBACK).has(domainId)}
                          t={t}
                        />
                      </div>
                    ))}
                  </details>
                ) : null}
              </div>
            ) : null}
            {/* The H2 approval gate intercepted: the pointer did NOT move. */}
            {pendingApproval ? (
              <Notice variant="warning">
                <div>
                  <p className="u-m-0">{t('pendingApprovalBody', { to: pendingApproval.toEnv })}</p>
                  {pendingApproval.approvalId ? (
                    <p className="u-fs-12 muted u-m-0 u-mt-1">
                      <code>{pendingApproval.approvalId}</code>
                    </p>
                  ) : null}
                  <p className="u-fs-12 u-m-0 u-mt-1">
                    <Link to="/inbox">{t('pendingApprovalLink')}</Link>
                  </p>
                </div>
              </Notice>
            ) : null}
          </section>

          {/* Snapshots */}
          <section className="u-mb-4">
            <div className="u-flex u-items-center u-justify-between u-mb-2">
              <h2 className="u-fs-15 u-fw-600 u-m-0">{t('snapshotsHeading')}</h2>
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void run(() => snapshotLive(), t('snapshotTaken'))}>
                {t('snapshotCurrent')}
              </Button>
            </div>
            {/* The per-domain outcome of the last apply. The service restores each
                config domain independently and reports failures without throwing,
                so "some restored, some didn't" is a real, reachable state. */}
            {applyReport ? (
              <Notice variant={applyReport.ok.length === 0 ? 'error' : 'warning'}>
                <div>
                  <p className="u-m-0">
                    {applyReport.ok.length === 0
                      ? t('applyReportAllFailed', { hash: applyReport.hash.slice(0, 12) })
                      : t('applyReportPartial', { hash: applyReport.hash.slice(0, 12), ok: applyReport.ok.length, failed: applyReport.failed.length })}
                  </p>
                  <ul className="u-fs-12 u-m-0 u-mt-1 u-pl-3">
                    {applyReport.failed.map((d) => (
                      <li key={d.id}>
                        {t(`domain_${d.id.replace(/-/g, '_')}`, { defaultValue: d.id })}
                        {d.error ? `: ${d.error}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="u-fs-12 u-m-0 u-mt-1">{t('applyReportHint')}</p>
                </div>
              </Notice>
            ) : null}
            {snapshotsError ? (
              <Notice variant="error">{t('snapshotsFailed', { error: snapshotsError })}</Notice>
            ) : snapshots === null ? (
              <SkeletonRows rows={3} columns={['60%']} />
            ) : snapshots.length === 0 ? (
              <StateCard icon={<ArrowUpToLineIcon />} title={t('noSnapshotsTitle')} body={t('noSnapshotsBody')} />
            ) : (
              <DataTable caption={t('snapshotsHeading')} columns={snapshotColumns} rows={snapshots} rowKey={(s) => s.snapshotId} />
            )}
          </section>

          {/* History ledger */}
          <section>
            <h2 className="u-fs-15 u-fw-600 u-mb-2">{t('historyHeading')}</h2>
            {promotionsError ? (
              // "No promotions yet." is a claim about the audit ledger. A failed
              // read must not make it.
              <Notice variant="error">{t('historyFailed', { error: promotionsError })}</Notice>
            ) : promotions === null ? (
              <SkeletonRows rows={3} columns={['60%']} />
            ) : promotions.length === 0 ? (
              <p className="u-fs-12 muted">{t('noHistory')}</p>
            ) : (
              <DataTable caption={t('historyHeading')} columns={promotionColumns} rows={promotions} rowKey={(p) => p.promotionId} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
