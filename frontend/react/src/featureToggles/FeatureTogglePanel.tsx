/**
 * Feature-toggle admin screen (ADR 0001 §3.2) — modeled on myndhyve's
 * FeatureTogglePanel, extended with weighted multivariant traffic-splitting.
 *
 * Superadmin-only (the backend gates writes; a non-superadmin gets a 403 on the
 * admin list and sees the access notice). Per toggle: an Off/Beta/On control,
 * the randomization unit (user|tenant), and — when split — a variant editor
 * with per-variant weight inputs and live sum-to-100 validation. Variant→
 * behavior BINDINGS are administered here once candidate features ship
 * (Phase 4); this panel owns status + split + unit.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../i18n/format.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { confirm } from '../ui/confirm.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
// Static import is cycle-safe: chrome/features.tsx lazy-imports this panel, so
// the manifest module is fully evaluated before this one (ADR 0194 Phase 2).
import { FEATURES } from '../chrome/features.js';
import {
  listFeatureConsole,
  listToggleConfigs,
  saveToggleConfig,
  type BucketUnit,
  type FeatureConsoleEntry,
  type FeatureToggleStatus,
  type PackPresence,
  type ToggleConfig,
  type Variant,
  deleteToggleConfig,
} from '../client/featureTogglesClient.js';
import { useAllFeatureAccess } from './FeatureAccessContext.js';

/** Chip semantics for a pack's on-disk presence (status→chip canon). */
const PACK_CHIP: Record<PackPresence, string> = {
  installed: 'chip chip--success',
  mounted: 'chip chip--muted',
  missing: 'chip chip--warning',
  tombstoned: 'chip chip--danger',
};

const STATUSES: { value: FeatureToggleStatus; labelKey: 'statusOff' | 'statusBeta' | 'statusOn' }[] = [
  { value: 'off', labelKey: 'statusOff' },
  { value: 'beta', labelKey: 'statusBeta' },
  { value: 'on', labelKey: 'statusOn' },
];

/** Status→chip semantics for the list rows (§4.5 rule 7 — text carries the word). */
const STATUS_CHIP: Record<FeatureToggleStatus, string> = {
  on: 'chip chip--success',
  beta: 'chip chip--accent',
  off: 'chip chip--muted',
};

/** The band's filter vocabulary: a stored status, or the derived "needs
 *  attention" bucket (missing/tombstoned packs, recommended deps off). */
export type ToggleStatusFilter = FeatureToggleStatus | 'attention' | null;

/** Sort within a category group (§4.5 follow-up): 'default' keeps the load
 *  order, 'name' is locale-aware A–Z, 'updated' is most-recent first (ISO
 *  strings compare lexicographically; undated rows sink). Exported for tests. */
export type ToggleSort = 'default' | 'name' | 'updated';
export function sortToggles(items: ToggleConfig[], sort: ToggleSort): ToggleConfig[] {
  if (sort === 'default') return items;
  const out = [...items];
  if (sort === 'name') out.sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
  else out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return out;
}

/** Pure client filter (§4.5 rule 2 — the key-figure tiles + the filterbar both
 *  narrow THIS one list). Exported for tests. */
export function filterToggles(
  configs: ToggleConfig[],
  f: { status: ToggleStatusFilter; query: string; category: string },
  attentionIds: ReadonlySet<string>,
  generalLabel: string,
): ToggleConfig[] {
  const q = f.query.trim().toLowerCase();
  return configs.filter((c) => {
    if (f.status === 'attention' ? !attentionIds.has(c.id) : (f.status && c.status !== f.status)) return false;
    if (f.category && (c.category ?? generalLabel) !== f.category) return false;
    if (q && !`${c.id} ${c.label ?? ''} ${c.description ?? ''} ${c.category ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function variantsSum(variants: Variant[] | undefined): number {
  return (variants ?? []).reduce((s, v) => s + (Number.isFinite(v.weight) ? v.weight : 0), 0);
}

function ToggleCard({
  config,
  lockedBy,
  entry,
  openPath,
  labelOf,
  onSaved,
}: {
  config: ToggleConfig;
  /** Labels of enabled features that depend on this one (ADR 0194). Non-empty ⇒
   *  the Off control is locked (disabling would orphan them). */
  lockedBy: string[];
  /** This feature's console projection row (deps + packs), when loaded. */
  entry: FeatureConsoleEntry | null;
  /** The feature's page route when it resolves enabled for the caller. */
  openPath: string | null;
  /** id → display label (for dependency chips). */
  labelOf: (id: string) => string;
  onSaved: (next: ToggleConfig) => void;
}): JSX.Element {
  const { t } = useTranslation('featureToggles');
  const [draft, setDraft] = useState<ToggleConfig>(config);
  const disableLocked = lockedBy.length > 0;
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(config), [config]);

  const split = (draft.variants?.length ?? 0) > 0;
  const sum = variantsSum(draft.variants);
  const sumOk = !split || sum === 100;
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const setStatus = (status: FeatureToggleStatus) => setDraft((d) => ({ ...d, status }));
  const setBucketUnit = (bucketUnit: BucketUnit) => setDraft((d) => ({ ...d, bucketUnit }));

  const setVariants = (variants: Variant[] | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (variants && variants.length > 0) next.variants = variants;
      else delete next.variants;
      return next;
    });

  const enableSplit = () => setVariants([{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }]);
  const disableSplit = () => setVariants(undefined);
  const addVariant = () =>
    setVariants([...(draft.variants ?? []), { key: `V${(draft.variants?.length ?? 0) + 1}`, weight: 0 }]);
  const removeVariant = (i: number) => setVariants((draft.variants ?? []).filter((_, j) => j !== i));
  const editVariant = (i: number, patch: Partial<Variant>) =>
    setVariants((draft.variants ?? []).map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const save = useCallback(async () => {
    if (!sumOk) {
      toast.error(t('weightsMustSum'));
      return;
    }
    setSaving(true);
    try {
      const { id, updatedAt: _at, updatedBy: _by, overridden: _ov, defaultDrift: _dd, ...body } = draft;
      const next = await saveToggleConfig(id, body);
      onSaved(next);
      toast.success(t('saved', { label: draft.label ?? draft.id }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [draft, sumOk, onSaved, t]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-flex u-justify-between u-gap-3 u-items-baseline">
        <div>
          <strong>{draft.label ?? draft.id}</strong>
          <code className="ftoggle-id">{draft.id}</code>
          {draft.description ? (
            <p className="ftoggle-desc">{draft.description}</p>
          ) : null}
        </div>
        {openPath ? (
          <Link
            className="btn-ghost btn-sm ftoggle-open"
            to={openPath}
            aria-label={t('openFeatureAria', { label: draft.label ?? draft.id })}
          >
            {t('openFeature')}
          </Link>
        ) : null}
      </div>

      {/* Plugins-console metadata (ADR 0194 Phase 2): dependency + pack chips.
          Text carries the meaning (status word in each pack chip) — color is
          reinforcement, never the only signal. */}
      {entry && (entry.dependsOn.length > 0 || entry.recommends.length > 0 || entry.packs.length > 0) ? (
        <div className="ftoggle-meta u-flex u-gap-3 u-wrap u-items-center u-fs-11">
          {entry.dependsOn.length > 0 ? (
            <span className="u-iflex u-gap-2 u-items-center u-wrap">
              <span className="muted">{t('dependsOnLabel')}</span>
              {entry.dependsOn.map((id) => (
                <span key={id} className="chip chip--muted">{labelOf(id)}</span>
              ))}
            </span>
          ) : null}
          {/* Soft deps (ADR 0194 Phase 5): advisory suggestions, never a lock. A
              recommend that's currently OFF is highlighted as actionable. */}
          {entry.recommends.length > 0 ? (
            <span className="u-iflex u-gap-2 u-items-center u-wrap">
              <span className="muted">{t('recommendsLabel')}</span>
              {entry.recommends.map((id) => {
                const off = entry.recommendedOff.includes(id);
                return (
                  <span
                    key={id}
                    className={off ? 'chip chip--warning' : 'chip chip--muted'}
                    title={off ? t('recommendOffHint', { feature: labelOf(id) }) : undefined}
                  >
                    {labelOf(id)}{off ? ` · ${t('recommendOffSuffix')}` : ''}
                  </span>
                );
              })}
            </span>
          ) : null}
          {entry.packs.length > 0 ? (
            <span className="u-iflex u-gap-2 u-items-center u-wrap">
              <span className="muted">{t('packsLabel')}</span>
              {entry.packs.map((p) => (
                <span key={p.name} className={PACK_CHIP[p.status]}>
                  {p.name}@{p.version} · {t(`packStatus_${p.status}`)}
                  {p.onDiskVersion ? ` · ${t('packOnDisk', { version: p.onDiskVersion })}` : ''}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Status segmented control */}
      <div className="segmented" role="group" aria-label={t('statusForAria', { id: draft.id })}>
        {STATUSES.map((s) => {
          // ADR 0194 disable-lock: the Off option is locked while an enabled feature
          // depends on this one (the backend also enforces this with a 409).
          const locked = s.value === 'off' && disableLocked;
          return (
            <button
              key={s.value}
              type="button"
              className={draft.status === s.value ? 'is-active' : ''}
              aria-pressed={draft.status === s.value}
              disabled={locked}
              title={locked ? t('offLockedTitle', { features: lockedBy.join(', ') }) : undefined}
              onClick={() => setStatus(s.value)}
            >
              {t(s.labelKey)}
            </button>
          );
        })}
      </div>
      {disableLocked ? (
        <p className="muted u-fs-11 u-mt-0 u-mb-0">
          {t('requiredByNote', { features: lockedBy.join(', ') })}
        </p>
      ) : null}

      {/* Randomization unit + split toggle */}
      <div className="u-flex u-gap-4 u-wrap u-items-center">
        <label className="u-iflex u-gap-2 u-items-center">
          <span className="u-ink-3">{t('randomizeBy')}</span>
          <select value={draft.bucketUnit} onChange={(e) => setBucketUnit(e.target.value as BucketUnit)}>
            <option value="user">{t('unitUser')}</option>
            <option value="tenant">{t('unitTenant')}</option>
          </select>
        </label>
        <label className="u-iflex u-gap-2 u-items-center">
          <input type="checkbox" checked={split} onChange={(e) => (e.target.checked ? enableSplit() : disableSplit())} />
          <span>{t('multivariantSplit')}</span>
        </label>
      </div>
      <p className="muted u-fs-11 u-mt-0 u-mb-0">{t('randomizeByHelp')}</p>

      {/* Variant editor */}
      {split ? (
        <div className="u-grid u-gap-2">
          {(draft.variants ?? []).map((v, i) => (
            <div key={i} className="u-flex u-gap-2 u-items-center">
              <input
                aria-label={t('variantKeyAria', { n: i + 1 })}
                value={v.key}
                placeholder={t('variantKeyPlaceholder')}
                className="ftoggle-key-input"
                onChange={(e) => editVariant(i, { key: e.target.value })}
              />
              <input
                aria-label={t('variantWeightAria', { n: i + 1 })}
                type="number"
                min={0}
                max={100}
                value={v.weight}
                className="ftoggle-weight-input"
                onChange={(e) => editVariant(i, { weight: Math.trunc(Number(e.target.value)) || 0 })}
              />
              <span className="u-ink-3">%</span>
              {v.bindings?.length ? (
                <span className="u-label-sm">
                  → {v.bindings.map((b) => `${b.slot}=${b.ref.name}@${b.ref.version}`).join(', ')}
                </span>
              ) : null}
              <Button variant="quiet" onClick={() => removeVariant(i)} aria-label={t('removeVariantAria', { n: i + 1 })}>
                {t('removeVariant')}
              </Button>
            </div>
          ))}
          <div className="u-flex u-gap-3 u-items-center">
            <Button variant="quiet" onClick={addVariant}>
              {t('addVariant')}
            </Button>
            <span className={sumOk ? 'u-ink-3' : 'u-text-danger'}>
              {t('variantSum', { sum: formatNumber(sum) })}{sumOk ? '' : t('variantSumMustBe100')}
            </span>
          </div>
          <div className="u-flex u-gap-2 u-items-center u-wrap u-fs-11">
            <span className="muted">{t('presetsLabel')}</span>
            <Button variant="quiet" size="sm" onClick={() => setVariants([{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }])}>{t('preset5050')}</Button>
            <Button variant="quiet" size="sm" onClick={() => setVariants([{ key: 'stable', weight: 90 }, { key: 'beta', weight: 10 }])}>{t('presetBeta')}</Button>
            <Button variant="quiet" size="sm" onClick={() => setVariants([{ key: 'stable', weight: 95 }, { key: 'canary', weight: 5 }])}>{t('presetCanary')}</Button>
          </div>
        </div>
      ) : null}

      <div className="action-bar u-flex u-justify-end u-gap-2">
        {draft.updatedAt ? (
          <span className="ftoggle-updated">
            {t('updatedAt', { when: formatDateTime(draft.updatedAt) })}
          </span>
        ) : null}
        {/* Architect finding 2 follow-up: one-click revert to the code
            default (the DELETE API + client fn landed with PR 1804). Rendered
            only while a stored row pins the toggle; the backend re-checks the
            ADR 0194 disable-lock and 409s with the dependent list. */}
        {draft.overridden ? (
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => {
              void (async () => {
                if (!(await confirm({ title: t('revertTitle', { label: draft.label ?? draft.id }), body: t('revertBody'), confirmLabel: t('revertConfirm') }))) return;
                setSaving(true);
                try {
                  const next = await deleteToggleConfig(draft.id);
                  onSaved(next);
                  toast.success(t('reverted', { label: draft.label ?? draft.id }));
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : t('saveFailed'));
                } finally {
                  setSaving(false);
                }
              })();
            }}
          >
            {t('revertConfirm')}
          </Button>
        ) : null}
        <Button variant="primary" disabled={!dirty || !sumOk || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}

/** The dense List half of the §4.5 collection canon (rule 6 — rows at fleet
 *  scale): identity · status/attention chips · an INSTANT-save Off/Beta/On
 *  segmented. Split/unit/variant editing stays on the Grid card — the row is
 *  for scanning and fast status flips. */
function ToggleRow({
  config,
  lockedBy,
  attention,
  openPath,
  onSaved,
}: {
  config: ToggleConfig;
  lockedBy: string[];
  attention: boolean;
  openPath: string | null;
  onSaved: (next: ToggleConfig) => void;
}): JSX.Element {
  const { t } = useTranslation('featureToggles');
  const [saving, setSaving] = useState(false);
  const setStatusNow = useCallback(async (status: FeatureToggleStatus) => {
    if (status === config.status) return;
    setSaving(true);
    try {
      // updatedAt/updatedBy are server-managed — never echo them back.
      const { id, updatedAt: _at, updatedBy: _by, overridden: _ov, defaultDrift: _dd, ...body } = config;
      const next = await saveToggleConfig(id, { ...body, status });
      onSaved(next);
      toast.success(t('saved', { label: config.label ?? config.id }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [config, onSaved, t]);
  const statusLabelKey = STATUSES.find((s) => s.value === config.status)?.labelKey ?? 'statusOff';
  return (
    <div className="list-row">
      {/* No leading glyph — a decorative type icon on every row is noise (§4.5 rule 12).
          The identity cell is NOT a link here, so it drops .list-row-id's pointer/hover
          affordance, and the description rides the visible sub-line (title-attr-only
          disclosure is unreachable by keyboard/AT — grade pass FT-U3). */}
      <span className="list-row-id list-row-id--static">
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{config.label ?? config.id}</span>
          </span>
          <span className="list-row-sub">{config.id}{config.description ? ` — ${config.description}` : ''}</span>
        </span>
      </span>
      <div className="list-row-meta">
        <span className={STATUS_CHIP[config.status]}>{t(statusLabelKey)}</span>
        {/* Provenance + drift (architect 2026-07-13): a stored row pins the
            toggle; a pinned toggle whose CODE default has since changed would
            silently ignore a GA default-flip — surface both. */}
        {config.overridden ? <span className="chip chip--muted" title={t('overriddenTitle')}>{t('overriddenChip')}</span> : null}
        {config.defaultDrift ? <span className="chip chip--warning" title={t('defaultDriftTitle')}>{t('defaultDriftChip')}</span> : null}
        {attention ? <span className="chip chip--warning">{t('rowNeedsAttention')}</span> : null}
        {config.updatedAt ? <span>{formatDateTime(config.updatedAt)}</span> : null}
      </div>
      <div className="list-row-actions action-bar">
        <div className="segmented" role="group" aria-label={t('statusForAria', { id: config.id })}>
          {STATUSES.map((s) => {
            const locked = s.value === 'off' && lockedBy.length > 0;
            return (
              <button
                key={s.value}
                type="button"
                className={config.status === s.value ? 'is-active' : ''}
                aria-pressed={config.status === s.value}
                disabled={saving || locked}
                title={locked ? t('offLockedTitle', { features: lockedBy.join(', ') }) : undefined}
                onClick={() => void setStatusNow(s.value)}
              >
                {t(s.labelKey)}
              </button>
            );
          })}
        </div>
        {openPath ? <Link className="btn-ghost btn-sm" to={openPath} aria-label={t('openFeatureAria', { label: config.label ?? config.id })}>{t('openFeature')}</Link> : null}
      </div>
    </div>
  );
}

export function FeatureTogglePanel(): JSX.Element {
  const { t } = useTranslation('featureToggles');
  const [configs, setConfigs] = useState<ToggleConfig[] | null>(null);
  const [consoleEntries, setConsole] = useState<FeatureConsoleEntry[]>([]);
  /** FT-G1 — the console projection FAILED, as distinct from a genuinely empty
   *  one. Without it, "no feature depends on this" and "we could not check" are
   *  the same empty array. */
  const [consoleFailed, setConsoleFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-resolve the caller's assignments after a save so the nav (Sidebar/admin
  // rail/⌘K) reflects the new on/off/beta state immediately — no hard reload.
  // `byId` also gates each card's "Open" link (only an enabled feature opens).
  const { byId, reload } = useAllFeatureAccess();

  const load = useCallback(() => {
    setError(null);
    setConsoleFailed(false);
    // Configs + the console projection (ADR 0194 P2) load together — it gates the
    // Off control. A projection failure must not blank the panel; degrade to [].
    // FT-G1 — the projection failing must not blank the panel (right), but `[]`
    // is also what "nothing depends on this feature" looks like: `lockedByById`
    // is built ONLY from these entries, so a failed read empties every
    // `lockedBy`, unlocks the Off control and REMOVES the "required by X" note.
    // The server is the authority and still refuses the disable
    // (`routes/featureToggles.ts:173` — "Backend is the authority"), so nothing
    // breaks; what is lost is the ADVANCE WARNING. The operator clicks Off and
    // learns by rejection instead of by disclosure. Say the information is
    // missing rather than let its absence read as "no dependents".
    void Promise.all([
      listToggleConfigs(),
      listFeatureConsole().then((e) => ({ ok: true as const, e })).catch(() => ({ ok: false as const, e: [] as FeatureConsoleEntry[] })),
    ])
      .then(([cfgs, con]) => { setConfigs(cfgs); setConsole(con.e); setConsoleFailed(!con.ok); })
      .catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [t]);
  useEffect(() => load(), [load]);

  // id → display label, for rendering dependency chips / "required by <label>".
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of configs ?? []) m.set(c.id, c.label ?? c.id);
    return m;
  }, [configs]);
  const labelOf = useCallback((id: string) => labelById.get(id) ?? id, [labelById]);
  const entryById = useMemo(() => new Map(consoleEntries.map((e) => [e.id, e])), [consoleEntries]);
  // id → labels of its currently-enabled dependents (the Off-lock reason).
  const lockedByById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of consoleEntries) m.set(d.id, d.blockedByDependents.map((id) => labelById.get(id) ?? id));
    return m;
  }, [consoleEntries, labelById]);
  // featureId → its page path, PROJECTED from the one FEATURES manifest (no
  // second registry). Param-less nav routes only; first declaration wins.
  const pathByFeatureId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of FEATURES) {
      const fid = r.nav?.featureId;
      if (fid && !r.path.includes(':') && !m.has(fid)) m.set(fid, r.path);
    }
    return m;
  }, []);

  const onSaved = useCallback((next: ToggleConfig) => {
    // The PUT response is truth for the saved toggle; refresh ONLY the console
    // projection (the Off-lock graph). Re-pulling every config here replaced
    // every row object, which reset SIBLING cards' unsaved drafts (grade pass
    // FT-C2 — silent data loss) and doubled the round-trips per status flip.
    setConfigs((prev) => (prev ?? []).map((c) => (c.id === next.id ? next : c)));
    reload();
    void listFeatureConsole().then(setConsole).catch(() => { /* off-lock refresh is advisory */ });
  }, [reload]);

  // §4.5 filtering — the key-figure tiles ARE the status filter (rule 2), the
  // filterbar carries free-text search + category/sort selects (rule 5), and
  // the shared <ViewToggle> switches editor cards ↔ dense rows (rule 11).
  // Filter state MIRRORS to search params (rule 12 — a filtered view is a
  // shareable URL: ?status=beta&q=export&category=Studio&sort=updated); writes
  // use `replace` so typing never spams history. View stays in localStorage —
  // it's a per-person preference, not part of the shared view.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get('status');
  const statusFilter: ToggleStatusFilter =
    rawStatus === 'on' || rawStatus === 'beta' || rawStatus === 'off' || rawStatus === 'attention' ? rawStatus : null;
  const query = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  const rawSort = searchParams.get('sort');
  const sortKey: ToggleSort = rawSort === 'name' || rawSort === 'updated' ? rawSort : 'default';
  const setParam = useCallback((key: string, value: string) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (value) p.set(key, value); else p.delete(key);
      return p;
    }, { replace: true });
  }, [setSearchParams]);
  const [view, setView] = useViewMode('feature-toggles', 'grid');

  // "Needs attention" = a pack problem (missing/tombstoned) or a recommended
  // dependency currently off — the same signals the card renders as chips.
  const attentionIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of consoleEntries) {
      if (e.recommendedOff.length > 0 || e.packs.some((p) => p.status === 'missing' || p.status === 'tombstoned')) s.add(e.id);
    }
    return s;
  }, [consoleEntries]);
  const generalLabel = t('generalCategory');
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const c of configs ?? []) {
      const cat = c.category ?? generalLabel;
      if (!seen.includes(cat)) seen.push(cat);
    }
    return seen;
  }, [configs, generalLabel]);
  const figures = useMemo(() => {
    const all = configs ?? [];
    const count = (s: FeatureToggleStatus) => all.filter((c) => c.status === s).length;
    return [
      { key: 'on', label: t('statusOn'), value: count('on') },
      { key: 'beta', label: t('statusBeta'), value: count('beta') },
      { key: 'off', label: t('statusOff'), value: count('off') },
      { key: 'attention', label: t('figureAttention'), value: all.filter((c) => attentionIds.has(c.id)).length, tone: 'attention' as const },
    ];
  }, [configs, attentionIds, t]);

  const filtered = useMemo(
    () => filterToggles(configs ?? [], { status: statusFilter, query, category }, attentionIds, generalLabel),
    [configs, statusFilter, query, category, attentionIds, generalLabel],
  );
  const byCategory = useMemo(() => {
    const groups = new Map<string, ToggleConfig[]>();
    for (const c of filtered) {
      const cat = c.category ?? generalLabel;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return [...groups.entries()].map(([cat, items]): [string, ToggleConfig[]] => [cat, sortToggles(items, sortKey)]);
  }, [filtered, generalLabel, sortKey]);

  return (
    <section data-walkthrough="feature-toggles.page" className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
      />
      {error ? (
        <Notice variant="error">
          {t('superadminRequired')}
        </Notice>
      ) : null}
      {/* FT-G1 — the panel still works; what is missing is the dependency
          information, and saying so is the difference between "nothing depends
          on this" and "we could not check what does". */}
      {consoleFailed && !error ? (
        <Notice variant="warning">
          {t('consoleFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={load}>{t('consoleRetry')}</Button>
        </Notice>
      ) : null}
      {configs === null && !error ? <Skeleton /> : null}
      {configs !== null && configs.length === 0 ? (
        <StateCard title={t('noTogglesTitle')} body={t('noTogglesBody')} />
      ) : null}
      {configs !== null && configs.length > 0 ? (
        <>
          <KeyFigureBand
            figures={figures}
            activeKey={statusFilter}
            onToggle={(key) => setParam('status', statusFilter === key ? '' : key)}
            ariaLabel={t('figuresLabel')}
          />
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            {/* Gated on the UNFILTERED total so it can't vanish mid-search (rule 13). */}
            {configs.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setParam('q', e.target.value)}
              />
            ) : null}
            {/* Facet selects self-describe ("All categories" / "Sort: …") — an eyebrow
                label would break the one-row filterbar baseline. */}
            {categories.length > 1 ? (
              <select className="ui-input filterbar-select" value={category} onChange={(e) => setParam('category', e.target.value)} aria-label={t('categoryLabel')}>
                <option value="">{t('categoryAll')}</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : null}
            <select className="ui-input filterbar-select" value={sortKey} onChange={(e) => setParam('sort', e.target.value === 'default' ? '' : e.target.value)} aria-label={t('sortLabel')}>
              <option value="default">{t('sortDefault')}</option>
              <option value="name">{t('sortName')}</option>
              <option value="updated">{t('sortUpdated')}</option>
            </select>
            <ViewToggle value={view} onChange={setView} className="u-ml-auto" />
          </div>
        </>
      ) : null}
      {configs !== null && configs.length > 0 && filtered.length === 0 ? (
        <StateCard
          title={t('noMatchTitle')}
          body={t('noMatchBody')}
          action={
            <Button
              variant="secondary"
              onClick={() => setSearchParams((prev) => {
                const p = new URLSearchParams(prev);
                for (const k of ['status', 'q', 'category']) p.delete(k);
                return p;
              }, { replace: true })}
            >
              {t('clearFilters')}
            </Button>
          }
        />
      ) : null}
      {byCategory.map(([cat, items]) => (
        <div key={cat} className="u-grid u-gap-3">
          <h2 className="ftoggle-cat-heading">{cat}</h2>
          {view === 'grid' ? (
            <div className="card-grid">
              {items.map((c) => (
                <ToggleCard
                  key={c.id}
                  config={c}
                  lockedBy={lockedByById.get(c.id) ?? []}
                  entry={entryById.get(c.id) ?? null}
                  openPath={byId[c.id]?.enabled ? pathByFeatureId.get(c.id) ?? null : null}
                  labelOf={labelOf}
                  onSaved={onSaved}
                />
              ))}
            </div>
          ) : (
            <div className="surface-card list-view">
              {items.map((c) => (
                <ToggleRow
                  key={c.id}
                  config={c}
                  lockedBy={lockedByById.get(c.id) ?? []}
                  attention={attentionIds.has(c.id)}
                  openPath={byId[c.id]?.enabled ? pathByFeatureId.get(c.id) ?? null : null}
                  onSaved={onSaved}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
