/**
 * CSM page (host-extension product feature — ADR 0001 §6 Phase 6). Mirrors the
 * CRM page's gating shape: hidden in nav when off, disabled state on the page,
 * accounts list + add when on.
 *
 * ADR 0212 adds: a "linked company" column (Link into `/crm/companies/:id`,
 * company names batch-fetched ONE `listCrmCompanies(orgId)` call per distinct
 * org referenced — never per-row) with a link/edit/clear affordance, and a
 * `healthFactors` breakdown + "computed <relative time>" stamp when present.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';

import { confirm } from '../../ui/confirm.js';import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import { announce } from '../../ui/announce.js';
import { ActivityIcon, SparklesIcon } from '../../ui/icons/index.js';
import { stageComposerDraft } from '../../chat/composerSeed.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatCurrency, formatDate, formatNumber, formatRelativeTime } from '../../i18n/format.js';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  listOrgs,
  listCrmCompanies,
  CsmRequestError,
  type Account,
  type Org,
  type CrmCompany,
} from './csmClient.js';

/** Health is a severity signal (low = at-risk), the §5.3-sanctioned reuse of the
 *  functional tokens outside run-state. The number rides alongside, so the color
 *  is never the sole signal. */
const healthChip = (s: number): string =>
  s >= 70 ? 'chip chip--success' : s >= 40 ? 'chip chip--warning' : 'chip chip--danger';

/**
 * ADR 0582 §6 (CSM-UX-1) — the THREE health states this page must be able to
 * render, because the score is now optional on the wire and "we never measured
 * this" is not a number.
 *
 * Before this, `healthScore` was non-optional, the service defaulted a missing
 * one to 50, and the create form pre-filled `'50'` — so an unmeasured account,
 * a deliberate mid-band judgement and a form default were the same value. Worse,
 * a 100 produced by an empty or mis-scoped CRM fan-in rendered as the GREENEST
 * chip on the page while `portfolioArrAtRisk` (`< 70`) quietly dropped that
 * account's ARR out of the at-risk figure. The exec summary got quieter when
 * measurement broke; it now gets louder.
 *
 * The vocabulary is the app's own: `priority-matrix` renders an unscored row as
 * a muted "Unscored" span, and CRM renders lead-score absence as an ACTION
 * rather than a value. This does both — muted state, plus the editor is the
 * action.
 */
type HealthState =
  | { kind: 'scored'; score: number }
  | { kind: 'unscored' }
  | { kind: 'failed'; reason: string | undefined; score: number | undefined };

function healthStateOf(a: Pick<Account, 'healthScore' | 'healthMeasureFailedAt' | 'healthMeasureFailedReason'>): HealthState {
  // A recorded measurement failure OUTRANKS a stale number: any score present
  // beside it predates the failure, so presenting it as current would be the
  // same lie in a new place.
  if (a.healthMeasureFailedAt) {
    return { kind: 'failed', reason: a.healthMeasureFailedReason, score: a.healthScore };
  }
  return a.healthScore === undefined ? { kind: 'unscored' } : { kind: 'scored', score: a.healthScore };
}

/** Only a CONFIDENTLY measured score participates in the portfolio arithmetic. */
const confidentScore = (a: Account): number | undefined => {
  const s = healthStateOf(a);
  return s.kind === 'scored' ? s.score : undefined;
};

/** UX_UPGRADE-csm CSM-G2 — renewal urgency, in the SAME severity grammar the
 *  health chip already uses on the row beside it. A CSM console exists to answer
 *  "who is at risk", and a renewal 5 days out previously looked identical to one
 *  a year away. Days-to-renewal, or null when there is no date.
 *  Compared on the date-only key so a timezone can't shift the bucket. */
function parseCalendarDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  // LOCAL midnight, deliberately. `renewalDate` is a calendar date, not an
  // instant: `new Date('2026-07-29')` parses as UTC midnight, which renders as
  // the 28th in any negative-offset zone and shifts the day count by one. Both
  // bugs were live in the first cut of this change.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysToRenewal(renewalDate: string | undefined, now = new Date()): number | null {
  if (!renewalDate) return null;
  const due = parseCalendarDate(renewalDate);
  if (!due) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

/** The health-facet tiers (rule 13) — same thresholds as the chip above, plus
 *  the `unscored` facet ADR 0582 §6 makes reachable: "which accounts has nobody
 *  measured?" is the first question an operator asks once the state exists. */
type HealthTier = 'healthy' | 'at_risk' | 'critical' | 'unscored';
const healthTier = (a: Account): HealthTier => {
  const s = confidentScore(a);
  if (s === undefined) return 'unscored';
  return s >= 70 ? 'healthy' : s >= 40 ? 'at_risk' : 'critical';
};
const HEALTH_TIERS: readonly HealthTier[] = ['healthy', 'at_risk', 'critical', 'unscored'];

/** The CSM health-insights copilot (ADR 0265 lineage) — the ADR 0058/0073
 *  deep-link target ("no second chat system"). */
/** R2 CS-SP-2 — ARR with its unit when one exists; bare number otherwise
 *  (never an invented unit); invalid codes degrade rather than crash. */
function formatArr(amount: number, currency?: string): string {
  if (!currency) return formatNumber(amount);
  try { return formatCurrency(amount, currency); } catch { return `${formatNumber(amount)}\u00a0${currency}`; }
}

/** Currency-grouped ARR sum — one figure per unit, never a blind total. */
function groupedArr(rows: Array<{ arr?: number | undefined; arrCurrency?: string | undefined }>): string {
  const groups = new Map<string | null, number>();
  for (const r of rows) {
    if (r.arr === undefined) continue;
    const key = r.arrCurrency ? r.arrCurrency.toUpperCase() : null;
    groups.set(key, (groups.get(key) ?? 0) + r.arr);
  }
  if (groups.size === 0) return formatNumber(0);
  return [...groups.entries()]
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''))
    .map(([cur, sum]) => formatArr(sum, cur ?? undefined))
    .join(' + ');
}

const HEALTH_INSIGHTS_AGENT = 'feature.csm.agents.health-insights';

/** The seven PATCHable fields, and the six that had no editor at all (CSM-UX-5). */
interface AccountDraft {
  name: string;
  scoreText: string;
  renewal: string;
  arr: string;
  arrCurrency: string;
  owner: string;
}
const draftOf = (a: Account): AccountDraft => ({
  name: a.name,
  scoreText: a.healthScore === undefined ? '' : String(a.healthScore),
  renewal: a.renewalDate ?? '',
  arr: a.arr === undefined ? '' : String(a.arr),
  arrCurrency: a.arrCurrency ?? '',
  owner: a.owner ?? '',
});

export function CsmPage(): JSX.Element {
  const { t } = useTranslation('csm');
  const navigate = useNavigate();
  const csm = useFeatureAccess('csm');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  // ADR 0582 §6 (CSM-UX-2) — a failed read used to leave `accounts` null, which
  // is the SAME state as "still loading", so `DataTable` rendered skeleton rows
  // with no terminal condition: a permanent loading state that never resolved
  // and never said anything. The three states are now distinct, and the failed
  // one carries a Retry (the house `StateCard announce … action` pattern).
  const [loadError, setLoadError] = useState<{ title: string; detail?: string } | null>(null);
  const [name, setName] = useState('');
  // ADR 0582 §4 — NOT pre-filled. `'50'` made the form default and a deliberate
  // mid-band score the same value; empty means "leave it unscored", which is the
  // honest default for an account nobody has measured yet.
  const [scoreText, setScoreText] = useState('');
  const [renewal, setRenewal] = useState('');
  const [arr, setArr] = useState('');
  const [arrCurrency, setArrCurrency] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  // Collection kit (§4.5 rule 13) + the grid⇄table view (rule 11).
  const [query, setQuery] = useState('');
  // ADR 0582 §14 — seed the facet from `?health=`. The dashboard's
  // `CsmHealthTile` deep-links `/csm?health=unscored` ("N accounts nobody has
  // measured"); until this read existed the click landed on an UNFILTERED list,
  // so the tile promised a filtered view it did not deliver. Only a value in
  // the known tier union is honoured — an unrecognised param is ignored rather
  // than producing a filter that matches nothing.
  const [searchParams] = useSearchParams();
  const [healthFilter, setHealthFilter] = useState<'' | HealthTier>(() => {
    const h = searchParams.get('health');
    return h !== null && (HEALTH_TIERS as readonly string[]).includes(h) ? (h as HealthTier) : '';
  });
  // R2 CSM-G3 (remaining half) — the "renewing soon" facet, converged across
  // all 6 comparators (ChurnZero Renewal Hub, Vitally segments, Planhat
  // watchlist…). 90 days = the Planhat pre-renewal risk band.
  const [renewalFilter, setRenewalFilter] = useState<'' | 'soon' | 'past'>('');
  const [viewMode, setViewMode] = useViewMode('csm-accounts', 'list');
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const visibleAccounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? []).filter((a) => {
      if (q && !(a.name.toLowerCase().includes(q) || (a.owner ?? '').toLowerCase().includes(q))) return false;
      if (healthFilter && healthTier(a) !== healthFilter) return false;
      if (renewalFilter) {
        const days = daysToRenewal(a.renewalDate);
        if (renewalFilter === 'past' && !(days !== null && days < 0)) return false;
        if (renewalFilter === 'soon' && !(days !== null && days >= 0 && days <= 90)) return false;
      }
      return true;
    });
  }, [accounts, query, healthFilter, renewalFilter]);

  // ADR 0212 §4 — the linked-company affordance.
  // FIRST org-edge instance where `orgs` gates NO read: `listAccounts()` is
  // ungated, and this list feeds only the link dropdown + its default. So a
  // failed read does not hang the page — it leaves the CRM-link form with an
  // empty picker that cannot be submitted, and says nothing about why.
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, csm.enabled);
  // R2 CS-SP-1 — three-state per org: rows | 'failed'. The old shape cached a
  // FAILED read as [] and the `id in` presence check made that permanent —
  // company cells silently degraded to raw ids and the link editor's picker
  // went inert with no error and no retry (the exact shape round 1 fixed for
  // the ORG picker one field above).
  const [companiesByOrg, setCompaniesByOrg] = useState<Record<string, CrmCompany[] | 'failed'>>({});
  const [companiesRetryTick, setCompaniesRetryTick] = useState(0);
  const retryCompanies = useCallback(() => {
    setCompaniesByOrg((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== 'failed')));
    setCompaniesRetryTick((n) => n + 1);
  }, []);
  const [linkingAccountId, setLinkingAccountId] = useState<string | null>(null);
  const [linkOrgId, setLinkOrgId] = useState('');
  const [linkCompanyId, setLinkCompanyId] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);

  // R2 CS-SP-9 — sequence-stamp: two loads triggered by rapid mutations could
  // land out of order (org switch is safe — it full-reloads — but this isn't).
  const loadSeq = useRef(0);
  /**
   * ADR 0582 §6 (CSM-UX-3) — map a TYPED failure to LOCALIZED copy.
   *
   * The idiom this replaces — `err instanceof Error ? err.message : t(…)` —
   * could never select `t`, because `csmClient` always threw an `Error`. So the
   * four localized failure strings (× four locales = sixteen translations) were
   * dead by construction and every failure rendered raw English server text.
   * The server's own words are kept as a DETAIL, never as the whole message.
   */
  const failureCopy = useCallback((err: unknown, fallbackKey: string): { title: string; detail?: string } => {
    if (err instanceof CsmRequestError) {
      const title =
        err.status === 403 ? t('failureForbidden')
          : err.status === 404 ? t('failureNotFound')
            : err.status === 400 || err.status === 422 ? t('failureRejected')
              : err.status === 429 ? t('failureRateLimited')
                : err.status >= 500 ? t('failureServer')
                  : t(fallbackKey);
      return err.detail ? { title, detail: err.detail } : { title };
    }
    return { title: t('failureOffline') };
  }, [t]);

  const load = useCallback(() => {
    setLoadError(null);
    const seq = ++loadSeq.current;
    void listAccounts()
      .then((rows) => { if (seq === loadSeq.current) { setAccounts(rows); setLoadError(null); } })
      .catch((err) => {
        if (seq !== loadSeq.current) return;
        // §4.6 rule 2 — the failed StateCard / stale Notice each carry
        // `announce` with the TITLE, so the announcement happens exactly once,
        // where the copy lives. The raw server sentence stays a DETAIL on the
        // card rather than the whole thing shouted at a screen reader.
        setLoadError(failureCopy(err, 'loadAccountsFailed'));
      });
  }, [failureCopy]);

  useEffect(() => {
    if (csm.enabled) load();
  }, [csm.enabled, load]);


  // Batch company-name lookups: ONE listCrmCompanies(orgId) per distinct org
  // referenced by accounts' crmRef — never one fetch per row.
  useEffect(() => {
    if (!accounts) return;
    const orgIds = Array.from(new Set(accounts.map((a) => a.crmRef?.orgId).filter((v): v is string => Boolean(v))));
    // 'failed' entries are NOT treated as present — a retry refetches them.
    const missing = orgIds.filter((id) => !(id in companiesByOrg) || companiesByOrg[id] === 'failed');
    if (missing.length === 0) return;
    void Promise.all(missing.map((id) => listCrmCompanies(id).then((cs) => [id, cs] as const).catch(() => [id, 'failed'] as const)))
      .then((pairs) => {
        setCompaniesByOrg((prev) => {
          // Review F6 — announce only a NEW failure: under a persistent CRM
          // outage every account mutation refetches failed orgs, and
          // re-announcing the same message interrupts SR users repeatedly.
          if (pairs.some(([id, v]) => v === 'failed' && prev[id] !== 'failed')) {
            announce(t('companiesLoadFailed'), { assertive: true });
          }
          return { ...prev, ...Object.fromEntries(pairs) };
        });
      });
    // companiesByOrg deliberately NOT a dep: with 'failed' now refetchable, it
    // would loop on a persistent outage. `retryCompanies` bumps the tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, companiesRetryTick, t]);

  // The link editor's own org picker MAY select an org no account references
  // yet — fetch its companies on demand too.
  useEffect(() => {
    if (!linkingAccountId || !linkOrgId) return;
    const cur = companiesByOrg[linkOrgId];
    if (cur !== undefined && cur !== 'failed') return;
    void listCrmCompanies(linkOrgId)
      .then((cs) => setCompaniesByOrg((prev) => ({ ...prev, [linkOrgId]: cs })))
      .catch(() => {
        setCompaniesByOrg((prev) => ({ ...prev, [linkOrgId]: 'failed' }));
        announce(t('companiesLoadFailed'), { assertive: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only on picker open / org change / retry
  }, [linkingAccountId, linkOrgId, companiesRetryTick, t]);

  const companyName = useCallback((orgId: string, companyId: string): string => {
    const entry = companiesByOrg[orgId];
    if (entry === 'failed') return t('companyNameUnavailable');
    return entry?.find((c) => c.companyId === companyId)?.name ?? companyId;
  }, [companiesByOrg, t]);

  // CSMUX-3 — did the company READ succeed and simply not contain this id? The
  // CRM list read filters merge tombstones, so "loaded, and absent" means the
  // company was merged away or deleted. That is materially different from "we
  // could not read companies", and rendering it as a live <Link> to a raw
  // opaque id sent the operator to a detail page that still renders the
  // tombstone as a live company — from the very row that just refused to score
  // BECAUSE the company is gone. `undefined` = still loading / unknown.
  const companyResolved = useCallback((orgId: string, companyId: string): boolean | undefined => {
    const entry = companiesByOrg[orgId];
    if (entry === undefined || entry === 'failed') return undefined;
    return entry.some((c) => c.companyId === companyId);
  }, [companiesByOrg]);

  // CSMUX-1 — the link panel's first control lives inside `OrgSelectionState`,
  // so `autoFocus` is not reachable from here. Focus the panel itself instead:
  // it mounts far above the button that opened it, so without this a keyboard
  // user is left on a trigger whose panel is off-screen behind them, with
  // nothing announced. `tabIndex={-1}` makes the form programmatically
  // focusable without adding a tab stop.
  const linkFormRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (linkingAccountId !== null) linkFormRef.current?.focus();
  }, [linkingAccountId]);

  const openLinkEditor = useCallback((a: Account) => {
    setEditingAccountId(null);
    setDraft(null);
    setLinkingAccountId(a.accountId);
    setLinkOrgId(a.crmRef?.orgId ?? orgs?.[0]?.orgId ?? '');
    setLinkCompanyId(a.crmRef?.companyId ?? '');
  }, [orgs]);

  const closeLinkEditor = useCallback(() => setLinkingAccountId(null), []);

  const saveLink = useCallback(async () => {
    if (!linkingAccountId || !linkOrgId || !linkCompanyId) return;
    setLinkBusy(true);
    try {
      await updateAccount(linkingAccountId, { crmRef: { orgId: linkOrgId, companyId: linkCompanyId } });
      setLinkingAccountId(null);
      load();
      toast.success(t('linkSaved'));
    } catch (err) {
      toast.error(failureCopy(err, 'linkFailed').title);
    } finally {
      setLinkBusy(false);
    }
  }, [linkingAccountId, linkOrgId, linkCompanyId, load, t, failureCopy]);

  const clearLink = useCallback(async (accountId: string) => {
    setLinkBusy(true);
    try {
      await updateAccount(accountId, { crmRef: null });
      setLinkingAccountId(null);
      load();
      toast.success(t('linkCleared'));
    } catch (err) {
      toast.error(failureCopy(err, 'linkFailed').title);
    } finally {
      setLinkBusy(false);
    }
  }, [load, t, failureCopy]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const arrNum = arr.trim() ? Number(arr) : undefined;
      // ADR 0582 §4 — an EMPTY score field is now a legitimate answer: the
      // account is created UNSCORED. Only a non-empty value has to be in range.
      const scoreNum = scoreText.trim() === '' ? undefined : Number(scoreText);
      if (scoreNum !== undefined && (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 100)) {
        toast.error(t('scoreOutOfRange')); setBusy(false); return;
      }
      await createAccount({
        name: name.trim(),
        ...(scoreNum !== undefined ? { healthScore: Math.trunc(scoreNum) } : {}),
        ...(renewal.trim() ? { renewalDate: renewal.trim() } : {}),
        ...(arrNum !== undefined && Number.isFinite(arrNum) ? { arr: arrNum } : {}),
        ...(arrNum !== undefined && Number.isFinite(arrNum) && arrCurrency.trim() ? { arrCurrency: arrCurrency.trim().toUpperCase() } : {}),
        ...(owner.trim() ? { owner: owner.trim() } : {}),
      });
      setName(''); setScoreText(''); setRenewal(''); setArr(''); setArrCurrency(''); setOwner('');
      load();
      toast.success(t('accountAdded'));
    } catch (err) {
      toast.error(failureCopy(err, 'addFailed').title);
    } finally {
      setBusy(false);
    }
  }, [name, scoreText, renewal, arr, arrCurrency, owner, load, t, failureCopy]);

  const remove = useCallback(async (id: string, name: string) => {
    if (!(await confirm({ title: t('deleteAccountConfirm', { name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteAccount(id);
      load();
      // CSM-UX-8 — delete was the one mutation with no confirmation at all, and
      // the focused button unmounts, so without this the outcome was silent AND
      // keyboard focus dropped to <body>.
      toast.success(t('accountDeleted', { name }));
      announce(t('accountDeleted', { name }));
    } catch (err) {
      toast.error(failureCopy(err, 'deleteFailed').title);
    }
  }, [load, t, failureCopy]);

  // ── CSM-UX-5: the account editor ──────────────────────────────────────
  //
  // Six of the seven PATCHable fields (`name`, `healthScore`, `renewalDate`,
  // `arr`, `arrCurrency`, `owner`) had NO editor: only `crmRef` was ever
  // PATCHed. So the remedy for a typo, an ARR change or a CSM handover was
  // delete-and-recreate — which mints a new accountId and destroys the CRM link
  // and the whole health history with it. This reuses the shape already on the
  // page (the link editor: an inline `surface-form` keyed by an id).
  const openEditor = useCallback((a: Account) => {
    setLinkingAccountId(null);
    setEditingAccountId(a.accountId);
    setDraft(draftOf(a));
  }, []);
  const closeEditor = useCallback(() => { setEditingAccountId(null); setDraft(null); }, []);

  const saveEdit = useCallback(async () => {
    if (!editingAccountId || !draft || !draft.name.trim()) return;
    const scoreNum = draft.scoreText.trim() === '' ? null : Number(draft.scoreText);
    if (scoreNum !== null && (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 100)) {
      toast.error(t('scoreOutOfRange'));
      return;
    }
    const arrNum = draft.arr.trim() === '' ? null : Number(draft.arr);
    if (arrNum !== null && (!Number.isFinite(arrNum) || arrNum < 0)) {
      toast.error(t('arrInvalid'));
      return;
    }
    setEditBusy(true);
    try {
      await updateAccount(editingAccountId, {
        name: draft.name.trim(),
        // `null` CLEARS the score back to unscored — the affordance that lets an
        // operator un-assert a number they no longer trust without deleting the
        // account (and its CRM link and history) to do it.
        healthScore: scoreNum === null ? null : Math.trunc(scoreNum),
        renewalDate: draft.renewal.trim() || null,
        arr: arrNum,
        arrCurrency: arrNum === null ? null : (draft.arrCurrency.trim().toUpperCase() || null),
        owner: draft.owner.trim() || null,
      });
      closeEditor();
      load();
      toast.success(t('accountUpdated'));
      announce(t('accountUpdated'));
    } catch (err) {
      toast.error(failureCopy(err, 'updateFailed').title);
    } finally {
      setEditBusy(false);
    }
  }, [editingAccountId, draft, closeEditor, load, t, failureCopy]);

  // CFP D1 — the health-insights copilot had no surface entry point. Hand the
  // ONE chat a seeded prompt scoped to the health-insights agent (its tools read
  // the account book), rather than a bespoke panel. No second chat system.
  const askHealthInsights = useCallback(() => {
    stageComposerDraft(t('healthInsightsSeed'));
    navigate(`/?agent=${encodeURIComponent(HEALTH_INSIGHTS_AGENT)}`);
  }, [navigate, t]);

  /**
   * ADR 0582 §6 — the health cell, for BOTH views (the grid used to render its
   * own copy of a chip and so skipped every state fix the table got).
   *
   * The tier WORD rides beside the number (CSM-UX-10: the tier's meaning was
   * colour-only, and the grid chip had no accessible label at all), and the two
   * unmeasured states are visibly different from every score.
   */
  const renderHealth = useCallback((a: Account, opts?: { compact?: boolean }): JSX.Element => {
    const state = healthStateOf(a);
    if (state.kind === 'unscored') {
      return (
        <span className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="chip chip--neutral">{t('healthUnscored')}</span>
          {!opts?.compact ? <span className="muted u-fs-12">{t('healthUnscoredHint')}</span> : null}
        </span>
      );
    }
    if (state.kind === 'failed') {
      // CSMUX-2 — the failed state used to be a dead end: no WHEN, no route to
      // the remedy that lives on this very page, and — because the reason was
      // gated on `!compact` — completely blank in grid view. ADR 0645 D2 makes
      // this state MORE common (a merged CRM company now records a refusal
      // instead of silently scoring a fabricated 100), so it had to stop being
      // the least-finished cell on the page. The reason now renders in BOTH
      // densities, `failedAt` answers "since when", and the fix is one click.
      return (
        <span className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="chip chip--warning">{t('healthMeasureFailed')}</span>
          {state.score !== undefined ? (
            <span className="muted u-fs-12">{t('healthStalePrevious', { score: formatNumber(state.score) })}</span>
          ) : null}
          {a.healthMeasureFailedAt ? (
            <span className="muted u-fs-12" title={a.healthMeasureFailedAt}>
              {t('healthFailedSince', { date: formatDate(a.healthMeasureFailedAt) })}
            </span>
          ) : null}
          {state.reason ? <span className="muted u-fs-12">{state.reason}</span> : null}
          <Button variant="quiet" onClick={() => openLinkEditor(a)}>{t('healthFailedRelink')}</Button>
        </span>
      );
    }
    return (
      <span className="u-flex u-items-center u-gap-2 u-wrap">
        <span className={healthChip(state.score)}>{state.score}</span>
        <span className="muted u-fs-12">{t(`health_${healthTier(a)}`)}</span>
      </span>
    );
  }, [t, openLinkEditor]);

  const accountColumns = useMemo<DataColumn<Account>[]>(() => [
    { key: 'name', header: t('colAccount'), render: (a) => a.name, sortValue: (a) => a.name },
    // Sort on the CONFIDENT score only, so unmeasured rows sink (DataTable
    // nulls-last) instead of masquerading as the healthiest or the sickest.
    { key: 'health', header: t('colHealth'), render: (a) => renderHealth(a), sortValue: (a) => confidentScore(a) ?? null },
    { key: 'arr', header: t('colArr'), render: (a) => a.arr !== undefined ? formatArr(a.arr, a.arrCurrency) : <span className="muted">—</span>, sortValue: (a) => a.arr ?? null },
    // R2 CS-SP-3 — `owner` was captured, searchable (the aria copy even
    // promised it), PATCHable — and rendered NOWHERE.
    { key: 'owner', header: t('colOwner'), render: (a) => a.owner ?? <span className="muted">—</span>, sortValue: (a) => a.owner ?? null },
    {
      key: 'renewal',
      header: t('colRenewal'),
      // CSM-G1 — this rendered the RAW stored string, so a non-en operator read
      // an ISO date while every other date in the app is locale-formatted.
      render: (a) => {
        if (!a.renewalDate) return <span className="muted">—</span>;
        const days = daysToRenewal(a.renewalDate);
        const asDate = parseCalendarDate(a.renewalDate);
        const urgent = days !== null && days <= 30;
        return (
          <span className="u-flex u-items-center u-gap-2">
            <time dateTime={a.renewalDate}>{asDate ? formatDate(asDate) : a.renewalDate}</time>
            {days !== null && days < 0 ? (
              <span className="chip chip--danger">{t('renewalPast')}</span>
            ) : urgent ? (
              <span className="chip chip--warning">{t('renewalSoon', { count: days as number })}</span>
            ) : null}
          </span>
        );
      },
      // Sort on the raw ISO key: it is lexicographically ordered, and sorting on
      // the LOCALIZED string would order by whatever the locale prints first.
      // R2 — undated rows SINK in the ASCENDING (triage) direction ('' sorted
      // them FIRST, ahead of every real renewal). Descending flips them to the
      // top — a DataTable-level nulls-last would need a table change; recorded.
      // Undated sinks LAST in BOTH directions (DataTable nulls-last) — the
      // old '9999-12-31' sentinel floated undated rows FIRST on descending.
      sortValue: (a) => a.renewalDate ?? null,
    },
    {
      key: 'crmRef',
      header: t('colLinkedCompany'),
      render: (a) => {
        if (!a.crmRef) return <span className="muted">{t('notLinked')}</span>;
        const { orgId, companyId } = a.crmRef;
        // CSMUX-3 — only link to a company the CRM list actually returned.
        if (companyResolved(orgId, companyId) === false) {
          return (
            <span className="u-flex u-gap-1 u-items-center u-wrap">
              <span className="chip chip--warning">{t('companyGone')}</span>
              <span className="u-label-sm">{t('companyGoneHint')}</span>
            </span>
          );
        }
        return (
          <Link to={`/crm/companies/${encodeURIComponent(companyId)}?org=${encodeURIComponent(orgId)}`}>
            {companyName(orgId, companyId)}
          </Link>
        );
      },
    },
    {
      key: 'factors',
      header: t('colFactors'),
      // ADR 0582 §5 (CSM-UX-4) — the breakdown was three raw columns with no
      // formula, no units and no direction, and its arithmetic CONTRADICTED
      // itself between the two in-tree producers under identical headers: the
      // node computes `100 − Σ(weight × count)` (higher value = worse) while the
      // demo seed computes a weighted MEAN of 0–100 sub-scores (higher value =
      // better). `healthMethod` now rides with the numbers and the formula is
      // stated in words; the PROVENANCE stamp is hoisted OUT of the collapsed
      // <details> and up beside the score, where the number is actually used.
      render: (a) => a.healthFactors && a.healthFactors.length > 0 ? (
        <span className="u-grid u-gap-1">
          {a.healthComputedAt ? (
            <span className="muted u-fs-12">{t('computedStamp', { time: formatRelativeTime(a.healthComputedAt) })}</span>
          ) : null}
          <details>
            <summary>{t('factorsCount', { count: a.healthFactors.length })}</summary>
            <span className="muted u-fs-12">
              {a.healthMethod ? t(`formula_${a.healthMethod}` as const) : t('formulaUnstated')}
            </span>
            {/* ADR 0582 §16 — the attribution-coverage rows ride the same table
                but are denominators, not inputs. Say so, or a `weight: 0` row
                reads as a scored factor the formula silently ignored. */}
            {a.healthFactors.some((f) => f.weight === 0) ? (
              <span className="muted u-fs-12">{t('contextRowsNote')}</span>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th>{t('factorHeaderFactor')}</th>
                  <th>{t('factorHeaderWeight')}</th>
                  <th>{a.healthMethod === 'penalty-sum' ? t('factorHeaderCount') : t('factorHeaderValue')}</th>
                </tr>
              </thead>
              <tbody>
                {a.healthFactors.map((f, i) => (
                  <tr key={`${a.accountId}-${i}`}>
                    <td>{f.factor}</td>
                    <td>{formatNumber(f.weight)}</td>
                    <td>{formatNumber(f.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </span>
      ) : <span className="muted">{t('noBreakdown')}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <span className="action-bar">
          <Button variant="quiet" onClick={() => openEditor(a)} aria-label={t('editRowLabel', { name: a.name })}>
            {t('common:edit')}
          </Button>
          <Button
            variant="quiet"
            onClick={() => openLinkEditor(a)}
            aria-label={a.crmRef ? t('editLinkLabel', { name: a.name }) : t('linkLabel', { name: a.name })}
          >
            {a.crmRef ? t('editLink') : t('linkCompany')}
          </Button>
          <Button variant="quiet" onClick={() => void remove(a.accountId, a.name)} aria-label={t('deleteRowLabel', { name: a.name })}>{t('common:delete')}</Button>
        </span>
      ),
    },
  ], [remove, t, companyName, companyResolved, openLinkEditor, openEditor, renderHealth]);

  const linkingAccount = accounts?.find((a) => a.accountId === linkingAccountId) ?? null;
  const editingAccount = accounts?.find((a) => a.accountId === editingAccountId) ?? null;
  /** ADR 0582 §6 — the accounts whose health is NOT confidently known. */
  const unmeasured = useMemo(() => (accounts ?? []).filter((a) => confidentScore(a) === undefined), [accounts]);

  if (csm.loading) return <Skeleton />;
  if (!csm.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="csm.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="csm.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={
          <Button variant="secondary" size="sm" onClick={askHealthInsights}>
            <SparklesIcon size={13} /> {t('askHealthInsights')}
          </Button>
        }
      />
      {/* ADR 0582 §6 (CSM-UX-2 + CSM-UX-9) — a failed read is a DESIGNED state
          with a consequence clause and a Retry, not a silent skeleton. When a
          refresh fails after a good load the rows stay on screen but are marked
          STALE (§4.6) instead of reading as live. */}
      {loadError && accounts !== null ? (
        <Notice variant="warning" announce={loadError.title}>
          <span className="u-grid u-gap-1">
            <strong>{loadError.title}</strong>
            <span>{t('staleClause')}</span>
            {loadError.detail ? <span className="muted u-fs-12">{loadError.detail}</span> : null}
            <span className="action-bar">
              <Button variant="secondary" size="sm" onClick={load}>{t('common:retry')}</Button>
            </span>
          </span>
        </Notice>
      ) : null}

      {/* R2 CSM-R2-3 — the portfolio summary band (Totango exec dashboard /
          ChurnZero Renewal Hub convention): the book of business at a glance.
          ARR figures are currency-GROUPED — never a blind cross-unit total. */}
      {accounts !== null && accounts.length > 0 ? (
        <div className="surface-card u-p-4 u-flex u-gap-4 u-flex-wrap" role="group" aria-label={t('portfolioBandLabel')}>
          <span className="u-grid u-gap-1">
            <span className="u-label-sm">{t('portfolioTotalArr')}</span>
            <strong className="tabular-nums">{groupedArr(accounts)}</strong>
          </span>
          <span className="u-grid u-gap-1">
            <span className="u-label-sm">{t('portfolioArrAtRisk')}</span>
            <strong className="tabular-nums">{groupedArr(accounts.filter((a) => {
              // Review F4 — "at risk" must mean what the page's OWN tier
              // taxonomy calls at-risk: below the healthy threshold (<70),
              // plus past-due renewals. The first cut counted only <40
              // (critical), contradicting the "At risk" facet beside it.
              //
              // ADR 0582 §6 — only a CONFIDENT score participates. This figure
              // is precisely where the measurement defect did its damage: an
              // unmeasured account scored 100, which is `>= 70`, so a fan-in
              // failure REMOVED that account's ARR from "at risk" and the exec
              // summary got QUIETER exactly when it should have got louder.
              // Unmeasured ARR is now counted OUT here and counted IN, visibly,
              // in the tile beside it.
              const days = daysToRenewal(a.renewalDate);
              const score = confidentScore(a);
              return (score !== undefined && score < 70) || (days !== null && days < 0);
            }))}</strong>
          </span>
          {unmeasured.length > 0 ? (
            <span className="u-grid u-gap-1">
              <span className="u-label-sm">{t('portfolioUnmeasured')}</span>
              <strong className="tabular-nums">
                <span className="chip chip--warning">{t('portfolioUnmeasuredCount', { count: unmeasured.length })}</span>
              </strong>
              <span className="muted u-fs-12">{t('portfolioUnmeasuredArr', { arr: groupedArr(unmeasured) })}</span>
            </span>
          ) : null}
          <span className="u-grid u-gap-1">
            <span className="u-label-sm">{t('portfolioRenewals90')}</span>
            <strong className="tabular-nums">{formatNumber(accounts.filter((a) => {
              const days = daysToRenewal(a.renewalDate);
              return days !== null && days >= 0 && days <= 90;
            }).length)}</strong>
          </span>
        </div>
      ) : null}

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldAccount')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('accountNamePlaceholder')} />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('fieldHealth')}</span>
          {/* R2 CS-SP-7 — `|| 0` snapped an EMPTY field to zero (the PR-3049
              number-field family): deleting the value to retype it recorded a
              0 health score. Keep the raw string; parse at submit.
              ADR 0582 §4 — and EMPTY is now a real answer, not a missing one:
              it creates the account unscored. The old `'50'` prefill made the
              default indistinguishable from a deliberate mid-band judgement. */}
          {/* CSMUX-1 — the edit/link panels mount ABOVE the add-form, the
              filterbar and the table, so the button that opened them is 10+ tab
              stops FORWARD of the panel. Without this, focus stayed on that
              button, nothing was announced, and a keyboard user was left with
              an open form behind them. `autoFocus` is the house idiom (13+
              features use it for exactly this). */}
          <input autoFocus type="number" min={0} max={100} value={scoreText} onChange={(e) => setScoreText(e.target.value)} className="csm-score-input" placeholder={t('healthOptionalPlaceholder')} />
          <span className="muted u-fs-12">{t('fieldHealthHint')}</span>
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('fieldArr')}</span>
          <input type="number" min={0} value={arr} onChange={(e) => setArr(e.target.value)} placeholder={t('arrPlaceholder')} />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('fieldArrCurrency')}</span>
          <input value={arrCurrency} onChange={(e) => setArrCurrency(e.target.value)} maxLength={3} placeholder={t('arrCurrencyPlaceholder')} />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('fieldRenewal')}</span>
          <input type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldOwner')}</span>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('ownerPlaceholder')} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
          {t('addAccount')}
        </Button>
      </form>

      {/* CSM-UX-5 — the account editor. Same inline `surface-form` shape as the
          link editor below, keyed by `editingAccountId`. Before this, six of the
          seven PATCHable fields had no editor at all and the only remedy for a
          typo or an ARR change was delete-and-recreate, which mints a new
          accountId and destroys the CRM link and the health history. */}
      {editingAccountId && draft ? (
        <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
          <span className="u-label-sm">{t('editPanelTitle', { name: editingAccount?.name ?? '' })}</span>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fieldAccount')}</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="u-grid u-gap-1 is-narrow">
            <span className="u-label-sm">{t('fieldHealth')}</span>
            <input type="number" min={0} max={100} value={draft.scoreText} onChange={(e) => setDraft({ ...draft, scoreText: e.target.value })} className="csm-score-input" placeholder={t('healthOptionalPlaceholder')} />
            {/* The honest override: clearing the field un-asserts the score
                (and its computed breakdown) rather than replacing one number
                you don't trust with another you also made up. */}
            <span className="muted u-fs-12">{t('fieldHealthEditHint')}</span>
          </label>
          <label className="u-grid u-gap-1 is-narrow">
            <span className="u-label-sm">{t('fieldArr')}</span>
            <input type="number" min={0} value={draft.arr} onChange={(e) => setDraft({ ...draft, arr: e.target.value })} placeholder={t('arrPlaceholder')} />
          </label>
          <label className="u-grid u-gap-1 is-narrow">
            <span className="u-label-sm">{t('fieldArrCurrency')}</span>
            <input value={draft.arrCurrency} onChange={(e) => setDraft({ ...draft, arrCurrency: e.target.value })} maxLength={3} placeholder={t('arrCurrencyPlaceholder')} />
          </label>
          <label className="u-grid u-gap-1 is-narrow">
            <span className="u-label-sm">{t('fieldRenewal')}</span>
            <input type="date" value={draft.renewal} onChange={(e) => setDraft({ ...draft, renewal: e.target.value })} />
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fieldOwner')}</span>
            <input value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} placeholder={t('ownerPlaceholder')} />
          </label>
          <span className="action-bar">
            <Button variant="primary" type="submit" disabled={editBusy || !draft.name.trim()}>{t('common:save')}</Button>
            <Button variant="quiet" type="button" disabled={editBusy} onClick={closeEditor}>{t('common:cancel')}</Button>
          </span>
        </form>
      ) : null}

      {linkingAccountId ? (
        <form ref={linkFormRef} tabIndex={-1} className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void saveLink(); }}>
          <span className="u-label-sm">{t('linkPanelTitle', { name: linkingAccount?.name ?? '' })}</span>
          {/* HG-4 — the picker being empty is the ONLY symptom a failed org read
              produces here (`listAccounts()` is ungated, so nothing hangs): the
              form simply cannot be submitted. `OrgSelectionState` says it out
              loud with a retry, and REPLACES the picker — a select with nothing
              in it is not a control, it is a dead end. `variant="inline"`
              because this is a field inside a form, not a page.

              It WRAPS the <label> rather than sitting inside it, deliberately
              (grade-ux DS-CSM-1): nested, the select's accessible name absorbed
              the whole error sentence AND the retry's label (WCAG 4.1.2), so a
              screen-reader user heard the failure as part of the field's name
              and could not reach the button by its own label.

              The zero-org state is new here and was the quiet half: with no
              organizations the picker held only its placeholder and the form
              could never be submitted, with nothing saying why. */}
          <OrgSelectionState variant="inline" orgs={orgs} orgsFailed={orgsFailed}
            retry={retryOrgs} emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('ui:orgPickerLabel')}</span>
              <select value={linkOrgId} onChange={(e) => { setLinkOrgId(e.target.value); setLinkCompanyId(''); }}>
                <option value="">{t('selectOrgPlaceholder')}</option>
                {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
              </select>
            </label>
          </OrgSelectionState>
          {companiesByOrg[linkOrgId] === 'failed' ? (
            <span className="u-grid u-gap-1">
              <span className="u-label-sm">{t('fieldCompany')}</span>
              <span className="action-bar">
                <span className="chip chip--danger">{t('companiesLoadFailed')}</span>
                <Button variant="quiet" size="sm" type="button" onClick={retryCompanies} aria-label={t('retryCompaniesLabel')}>{t('common:retry')}</Button>
              </span>
            </span>
          ) : (
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('fieldCompany')}</span>
              <select value={linkCompanyId} onChange={(e) => setLinkCompanyId(e.target.value)} disabled={!linkOrgId}>
                <option value="">{t('selectCompanyPlaceholder')}</option>
                {(companiesByOrg[linkOrgId] ?? []).map((c) => <option key={c.companyId} value={c.companyId}>{c.name}</option>)}
              </select>
            </label>
          )}
          <span className="action-bar">
            <Button variant="primary" type="submit" disabled={linkBusy || !linkOrgId || !linkCompanyId}>{t('common:save')}</Button>
            {linkingAccount?.crmRef ? (
              <Button variant="quiet" disabled={linkBusy} onClick={() => void clearLink(linkingAccount.accountId)}>{t('clearLink')}</Button>
            ) : null}
            <Button variant="quiet" disabled={linkBusy} onClick={closeLinkEditor}>{t('common:cancel')}</Button>
          </span>
        </form>
      ) : null}

      {/* One filterbar row (§4.5 rules 5+11+13): gated search + health facet +
          the shared grid⇄table toggle (table stays the operate default). */}
      {accounts !== null && accounts.length > 0 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          {/* CSMUX-5 — the `> 3` threshold hides these controls on a small
              tenant, but `?health=` seeds a filter from the URL (the dashboard
              tile links straight here). Below the threshold that produced a
              silently-filtered account book with no visible control and no way
              to clear it — on the page whose whole job is telling the truth
              about measurement. An ACTIVE filter now forces the controls to
              render regardless of size. */}
          {accounts.length > 3 || healthFilter !== '' || renewalFilter !== '' || query !== '' ? (
            <>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterAccountsPlaceholder')}
                aria-label={t('filterAccountsAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as '' | HealthTier)} aria-label={t('filterHealthLabel')}>
                <option value="">{t('allHealth')}</option>
                {HEALTH_TIERS.map((tier) => <option key={tier} value={tier}>{t(`health_${tier}`)}</option>)}
              </select>
              <select className="ui-input filterbar-select" value={renewalFilter} onChange={(e) => setRenewalFilter(e.target.value as '' | 'soon' | 'past')} aria-label={t('filterRenewalLabel')}>
                <option value="">{t('allRenewals')}</option>
                <option value="soon">{t('renewalFacetSoon')}</option>
                <option value="past">{t('renewalFacetPast')}</option>
              </select>
            </>
          ) : null}
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('viewTable') }} />
        </div>
      ) : null}
      {(() => {
        const emptyState = accounts === null && loadError !== null
          // CSM-UX-2 — the terminal condition the skeleton never had. Before
          // this, a failed read left `accounts` null forever and `DataTable`
          // rendered SkeletonRows in its `empty` slot with nothing to end them:
          // a permanent loading state, and no retry control anywhere on the page
          // for its primary read.
          ? (
            <StateCard
              icon={<ActivityIcon />}
              title={loadError.title}
              announce
              body={`${t('loadFailedConsequence')}${loadError.detail ? ` ${loadError.detail}` : ''}`}
              action={<Button variant="secondary" onClick={load}>{t('common:retry')}</Button>}
            />
          )
          : accounts === null
            ? <SkeletonRows rows={3} columns={[200, 90, 140, 90, 100]} />
            : (query.trim() || healthFilter || renewalFilter) && accounts.length > 0 ? (
            <StateCard
              icon={<ActivityIcon />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<Button variant="secondary" onClick={() => { setQuery(''); setHealthFilter(''); setRenewalFilter(''); }}>{t('clearFilters')}</Button>}
            />
          ) : (
            <StateCard icon={<ActivityIcon />} title={t('noAccountsTitle')} body={t('noAccountsBody')} />
          );
        if (viewMode === 'grid' && accounts !== null && accounts.length > 0) {
          return visibleAccounts.length === 0 ? emptyState : (
            <div className="card-grid">
              {visibleAccounts.map((a) => (
                <div key={a.accountId} className="surface-card u-gap-2">
                  <div className="u-flex u-items-center u-gap-2 u-wrap">
                    <strong className="u-fs-15">{a.name}</strong>
                    {/* ADR 0582 §6 — the SAME renderer as the table. The grid
                        used to hold its own bare chip, which is why every health
                        fix the table got (the unscored state, the tier word, an
                        accessible label) skipped it. */}
                    {renderHealth(a, { compact: true })}
                  </div>
                  {a.healthComputedAt ? (
                    <span className="muted u-fs-12">{t('computedStamp', { time: formatRelativeTime(a.healthComputedAt) })}</span>
                  ) : null}
                  {a.arr !== undefined ? <span className="u-label-sm">{formatArr(a.arr, a.arrCurrency)}</span> : null}
                  {/* R2 CS-SP-5 — the grid rendered the RAW ISO date with no
                      urgency chip; round 1 fixed only the table. Same cell logic. */}
                  {a.renewalDate ? (() => {
                    const days = daysToRenewal(a.renewalDate);
                    const asDate = parseCalendarDate(a.renewalDate);
                    return (
                      <span className="u-flex u-items-center u-gap-2 u-label-sm">
                        <time dateTime={a.renewalDate}>{asDate ? formatDate(asDate) : a.renewalDate}</time>
                        {days !== null && days < 0 ? (
                          <span className="chip chip--danger">{t('renewalPast')}</span>
                        ) : days !== null && days <= 30 ? (
                          <span className="chip chip--warning">{t('renewalSoon', { count: days })}</span>
                        ) : null}
                      </span>
                    );
                  })() : null}
                  {a.crmRef ? (
                    <Link to={`/crm/companies/${encodeURIComponent(a.crmRef.companyId)}?org=${encodeURIComponent(a.crmRef.orgId)}`} className="u-fs-13">
                      {companyName(a.crmRef.orgId, a.crmRef.companyId)}
                    </Link>
                  ) : null}
                  <span className="action-bar">
                    <Button variant="quiet" onClick={() => openEditor(a)} aria-label={t('editRowLabel', { name: a.name })}>{t('common:edit')}</Button>
                    <Button variant="quiet" onClick={() => openLinkEditor(a)} aria-label={a.crmRef ? t('editLinkLabel', { name: a.name }) : t('linkLabel', { name: a.name })}>
                      {a.crmRef ? t('editLink') : t('linkCompany')}
                    </Button>
                    <Button variant="quiet" onClick={() => void remove(a.accountId, a.name)} aria-label={t('deleteRowLabel', { name: a.name })}>{t('common:delete')}</Button>
                  </span>
                </div>
              ))}
            </div>
          );
        }
        return (
          <DataTable
            stack
            rows={visibleAccounts}
            rowKey={(a) => a.accountId}
            columns={accountColumns}
            caption={t('captionAccounts')}
            empty={emptyState}
          />
        );
      })()}
    </section>
  );
}
