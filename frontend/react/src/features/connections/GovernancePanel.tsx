/**
 * Governance panel (ADR 0028 / ADR 0023 §12 T7) — superadmin-only card on the
 * Connections page: the provider allowlist and the per-action-kind policy.
 * Hidden entirely when the policy read 403s (non-admin) — never surface an
 * action that would fail.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { useTranslation } from 'react-i18next';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { toast } from '../../ui/toast.js';
import { listProviders } from './connectionsClient.js';
import { formatNumber } from '../../i18n/format.js';

const base = `${config.baseUrl}/host/openwop-app/governance`;

type KindPolicy = 'disabled' | 'draft-only' | 'approval-required';

interface PolicyDoc {
  providerAllowlist?: string[];
  actionPolicy?: Record<string, KindPolicy>;
  /** ADR 0389 P4 — sessions in this workspace must have verified a second factor. */
  requireMfa?: boolean;
}

interface PolicyResponse {
  policy: PolicyDoc;
  actionKinds: string[];
}

/** ADR 0106 — media-generation budget: effective caps, env defaults, the editable
 *  per-org override, and today's usage. */
// ADR 0411 P2 — the `video` unit (daily job count) rides the same media-budget
// panel as tts/stt/images; override key is `videoJobs` (what resolveBudget reads).
interface MediaBudgetResponse {
  date: string;
  budgets: { ttsChars: number; sttBytes: number; images: number; video: number };
  envDefaults: { ttsChars: number; sttBytes: number; images: number; video: number };
  override: { ttsChars?: number; sttBytes?: number; images?: number; videoJobs?: number } | null;
  usage: { ttsChars: number; sttBytes: number; images: number; video: number };
}

/** ADR 0178 — per-org BYOK LLM chat spend budget: the effective daily token cap
 *  + soft-warning threshold, the env default, and the editable per-org override.
 *  Sibling of the media budget above (mirrors its shape). */
interface ByokChatBudgetResponse {
  date: string;
  budget: { dailyTokenCap: number; softWarningPct: number };
  envDefaults: { dailyTokenCap: number };
  override: { dailyTokenCap?: number; softWarningPct?: number } | null;
}

// ADR 0187 — the per-tenant egress firewall rule set. `mode=off` ⇒ the SSRF
// baseline is the only guard; allowlist/denylist layer on top of it.
type EgressMode = 'off' | 'allowlist' | 'denylist';
interface EgressRulesResponse {
  mode: EgressMode;
  hosts: string[];
}

export function GovernancePanel(): JSX.Element | null {
  const { t } = useTranslation('connections');
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [visible, setVisible] = useState(false);
  /** The policy read failed for a reason OTHER than 403. The panel is shown (so
   *  its absence never implies "not permitted") but says it could not load. */
  const [policyError, setPolicyError] = useState<string | null>(null);
  /** Sub-readouts whose own read failed (media budget / BYOK budget / egress
   *  rules). Each is superadmin-gated, so 403 still hides them silently. */
  const [sectionsUnavailable, setSectionsUnavailable] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<MediaBudgetResponse | null>(null);
  // ADR 0106 editable override — the draft override (empty string ⇒ clear ⇒ env default).
  const [mediaDraft, setMediaDraft] = useState<{ ttsChars: string; sttBytes: string; images: string; videoJobs: string }>({ ttsChars: '', sttBytes: '', images: '', videoJobs: '' });
  const [mediaBusy, setMediaBusy] = useState(false);
  const [byok, setByok] = useState<ByokChatBudgetResponse | null>(null);
  // ADR 0178 editable override — blank ⇒ clear ⇒ env default (0 ⇒ uncapped for the cap).
  const [byokDraft, setByokDraft] = useState<{ dailyTokenCap: string; softWarningPct: string }>({ dailyTokenCap: '', softWarningPct: '' });
  const [byokBusy, setByokBusy] = useState(false);
  const [egress, setEgress] = useState<EgressRulesResponse | null>(null);
  // ADR 0187 editable draft — hosts is one-per-line free text; parsed on save.
  const [egressDraft, setEgressDraft] = useState<{ mode: EgressMode; hosts: string }>({ mode: 'off', hosts: '' });
  const [egressBusy, setEgressBusy] = useState(false);

  // Self-loads the provider catalog (the panel mounts on pages that don't
  // otherwise hold it — the page-level ConnectionsManager owns its own copy).
  // DEF-1 (UX_UPGRADE-access-data P4): this catch was the last bare swallow in
  // the panel, and it was NOT a harmless companion read — with providerIds
  // stuck at [], ticking "Restrict providers" writes an EMPTY allowlist (a
  // block-everything policy built from a failed read). Failure now joins the
  // sections-unavailable warning and the allowlist controls disable.
  useEffect(() => {
    void listProviders()
      .then((ps) => setProviderIds(ps.map((p) => p.id)))
      .catch(() => setSectionsUnavailable((p) => (p.includes('providers') ? p : [...p, 'providers'])));
  }, []);

  useEffect(() => {
    void fetch(`${base}/policy`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        // 403 is the ONLY status that means "not an admin" — stay hidden, which
        // is correct and unchanged. Every other failure used to hide the panel
        // too, so an admin whose read merely failed saw exactly what a non-admin
        // sees: no governance panel at all, which reads as "you lack permission".
        if (res.status === 403) return;
        if (!res.ok) throw new Error(`policy returned ${res.status}`);
        const body = (await res.json()) as PolicyResponse;
        setDoc(body.policy ?? {});
        setKinds(body.actionKinds ?? []);
        setVisible(true);
      })
      .catch((e) => { setVisible(true); setPolicyError(e instanceof Error ? e.message : String(e)); });
  }, []);

  // ADR 0106 — media-budget readout + editable override (superadmin); skipped on 403.
  const loadMedia = useCallback(() => {
    void fetch(`${base}/media-budget`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (res.status === 403) return; // genuinely not permitted — stay hidden
        if (!res.ok) throw new Error(`media-budget returned ${res.status}`);
        const body = (await res.json()) as MediaBudgetResponse;
        setMedia(body);
        setMediaDraft({
          ttsChars: body.override?.ttsChars != null ? String(body.override.ttsChars) : '',
          images: body.override?.images != null ? String(body.override.images) : '',
          sttBytes: body.override?.sttBytes != null ? String(body.override.sttBytes) : '',
          videoJobs: body.override?.videoJobs != null ? String(body.override.videoJobs) : '',
        });
      })
      .catch(() => setSectionsUnavailable((p) => (p.includes('media') ? p : [...p, 'media'])));
  }, []);
  useEffect(() => { loadMedia(); }, [loadMedia]);

  // ADR 0178 — BYOK chat-budget readout + editable override (superadmin); skipped on 403.
  const loadByok = useCallback(() => {
    void fetch(`${base}/byok-chat-budget`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (res.status === 403) return; // genuinely not permitted — stay hidden
        if (!res.ok) throw new Error(`byok-chat-budget returned ${res.status}`);
        const body = (await res.json()) as ByokChatBudgetResponse;
        setByok(body);
        setByokDraft({
          dailyTokenCap: body.override?.dailyTokenCap != null ? String(body.override.dailyTokenCap) : '',
          softWarningPct: body.override?.softWarningPct != null ? String(body.override.softWarningPct) : '',
        });
      })
      .catch(() => setSectionsUnavailable((p) => (p.includes('byok') ? p : [...p, 'byok'])));
  }, []);
  useEffect(() => { loadByok(); }, [loadByok]);

  // ADR 0187 — egress-firewall rules readout + editable draft (superadmin); skipped on 403.
  const loadEgress = useCallback(() => {
    void fetch(`${base}/egress-rules`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (res.status === 403) return; // genuinely not permitted — stay hidden
        if (!res.ok) throw new Error(`egress-rules returned ${res.status}`);
        const body = (await res.json()) as EgressRulesResponse;
        setEgress(body);
        setEgressDraft({ mode: body.mode, hosts: body.hosts.join('\n') });
      })
      .catch(() => setSectionsUnavailable((p) => (p.includes('egress') ? p : [...p, 'egress'])));
  }, []);
  useEffect(() => { loadEgress(); }, [loadEgress]);

  const saveByokChatBudget = useCallback(async () => {
    // Empty ⇒ null (clear ⇒ fall back to the env/host default). A cap must be a
    // non-negative integer (0 ⇒ uncapped for this org); a pct must be in [0, 100].
    const parseCap = (s: string): number | null | undefined => {
      const trimmed = s.trim();
      if (trimmed === '') return null;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined; // undefined ⇒ invalid
    };
    const parsePct = (s: string): number | null | undefined => {
      const trimmed = s.trim();
      if (trimmed === '') return null;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined; // undefined ⇒ invalid
    };
    const dailyTokenCap = parseCap(byokDraft.dailyTokenCap);
    const softWarningPct = parsePct(byokDraft.softWarningPct);
    if (dailyTokenCap === undefined || softWarningPct === undefined) {
      toast.error(t('byokBudgetInvalid'));
      return;
    }
    setByokBusy(true);
    try {
      const res = await fetch(`${base}/byok-chat-budget`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ dailyTokenCap, softWarningPct }),
      }));
      if (!res.ok) throw new Error(`save returned ${res.status}`);
      toast.success(t('byokBudgetSaved'));
      loadByok();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setByokBusy(false);
    }
  }, [byokDraft, t, loadByok]);

  const saveEgress = useCallback(async () => {
    // Split one-per-line/comma; trim + drop blanks. The backend normalizes +
    // de-dupes hosts and re-applies the SSRF baseline, so no client validation
    // beyond stripping empties is required.
    const hosts = egressDraft.hosts
      .split(/[\n,]/)
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    setEgressBusy(true);
    try {
      const res = await fetch(`${base}/egress-rules`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ mode: egressDraft.mode, hosts }),
      }));
      if (!res.ok) throw new Error(`save returned ${res.status}`);
      toast.success(t('egressSaved'));
      loadEgress();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setEgressBusy(false);
    }
  }, [egressDraft, t, loadEgress]);

  const saveMediaBudget = useCallback(async () => {
    // Empty ⇒ null (clear the override → fall back to the env default). A value
    // must be a non-negative integer; 0 means "uncapped for this org".
    const parse = (s: string): number | null | undefined => {
      const trimmed = s.trim();
      if (trimmed === '') return null;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined; // undefined ⇒ invalid
    };
    const ttsChars = parse(mediaDraft.ttsChars);
    const images = parse(mediaDraft.images);
    const sttBytes = parse(mediaDraft.sttBytes);
    const videoJobs = parse(mediaDraft.videoJobs);
    if (ttsChars === undefined || sttBytes === undefined || images === undefined || videoJobs === undefined) {
      toast.error(t('mediaBudgetInvalid'));
      return;
    }
    setMediaBusy(true);
    try {
      const res = await fetch(`${base}/media-budget`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ttsChars, sttBytes, images, videoJobs }),
      }));
      if (!res.ok) throw new Error(`save returned ${res.status}`);
      toast.success(t('mediaBudgetSaved'));
      loadMedia();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setMediaBusy(false);
    }
  }, [mediaDraft, t, loadMedia]);

  const save = useCallback(async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const res = await fetch(`${base}/policy`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          // Explicit clear: absent on the doc ⇒ null (the API's clear contract —
          // the server now PRESERVES omitted fields, grade-pass SEC-C12).
          providerAllowlist: doc.providerAllowlist ?? null,
          ...(doc.actionPolicy !== undefined ? { actionPolicy: doc.actionPolicy } : {}),
          requireMfa: doc.requireMfa ?? null,
        }),
      }));
      if (!res.ok) throw new Error(`save returned ${res.status}`);
      toast.success(t('governanceSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [doc, t]);

  if (!visible) return null;

  // A failed policy read must not sit in the loading placeholder below forever —
  // that reports a request which already failed as still in flight.
  if (policyError) {
    return (
      <article className="surface-card u-grid u-gap-2">
        <Notice variant="error">{t('policyLoadFailed', { error: policyError })}</Notice>
      </article>
    );
  }

  // GOV-3: superadmin sees a loading placeholder instead of blank -> pop-in.
  if (!doc) {
    return (
      <article className="surface-card u-grid u-gap-2" role="status">
        <Skeleton width="40%" />
        <Skeleton width="90%" />
      </article>
    );
  }

  const allowlistActive = doc.providerAllowlist !== undefined;
  return (
    <article className="surface-card u-grid u-gap-2">
      <header>
        <h2>{t('governanceTitle')}</h2>
        <p className="muted">{t('governanceBlurb')}</p>
      </header>
      {/* A superadmin-gated readout that 403s stays silently hidden; one whose
          read FAILED says so, so its absence is never mistaken for "not
          permitted" or for "no limits configured". */}
      {sectionsUnavailable.length > 0 ? (
        <Notice variant="warning">{t('sectionsUnavailable', { count: sectionsUnavailable.length })}</Notice>
      ) : null}

      <section className="u-grid u-gap-1">
        <h3>{t('requireMfaTitle')}</h3>
        <label>
          <input
            type="checkbox"
            checked={doc.requireMfa === true}
            onChange={(e) => {
              const { requireMfa: _drop, ...rest } = doc;
              setDoc(e.target.checked ? { ...rest, requireMfa: true } : rest);
            }}
          />{' '}
          {t('requireMfaLabel')}
        </label>
        <p className="muted">{t('requireMfaHint')}</p>
      </section>

      <section className="u-grid u-gap-1">
        <h3>{t('providerAllowlist')}</h3>
        <label title={sectionsUnavailable.includes('providers') ? t('providersUnavailableHint') : undefined}>
          <input
            type="checkbox"
            checked={allowlistActive}
            disabled={sectionsUnavailable.includes('providers')}
            onChange={(e) => {
              const { providerAllowlist: _drop, ...rest } = doc;
              setDoc(e.target.checked ? { ...rest, providerAllowlist: providerIds } : rest);
            }}
          />{' '}
          {t('restrictProviders')}
        </label>
        {sectionsUnavailable.includes('providers') ? (
          <p className="muted u-fs-12 u-m-0">{t('providersUnavailableHint')}</p>
        ) : null}
        {allowlistActive && !sectionsUnavailable.includes('providers') ? (
          <div className="u-flex u-gap-2">
            {providerIds.map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  checked={doc.providerAllowlist?.includes(p) ?? false}
                  onChange={(e) => {
                    const cur = new Set(doc.providerAllowlist ?? []);
                    if (e.target.checked) cur.add(p);
                    else cur.delete(p);
                    setDoc({ ...doc, providerAllowlist: [...cur] });
                  }}
                />{' '}
                {p}
              </label>
            ))}
          </div>
        ) : null}
      </section>

      <section className="u-grid u-gap-1">
        <h3>{t('actionPolicy')}</h3>
        {kinds.map((kind) => (
          <label key={kind} className="u-flex u-gap-2">
            <span className="chip">{kind}</span>
            <select
              aria-label={`${t('actionPolicy')} — ${kind}`}
              value={doc.actionPolicy?.[kind] ?? 'approval-required'}
              onChange={(e) =>
                setDoc({ ...doc, actionPolicy: { ...(doc.actionPolicy ?? {}), [kind]: e.target.value as KindPolicy } })
              }
            >
              <option value="approval-required">{t('policyApprovalRequired')}</option>
              <option value="draft-only">{t('policyDraftOnly')}</option>
              <option value="disabled">{t('policyDisabled')}</option>
            </select>
          </label>
        ))}
      </section>

      {media ? (
        <section className="u-grid u-gap-2">
          <div className="u-grid u-gap-1">
            <h3>{t('mediaBudgetTitle')}</h3>
            <p className="muted">{t('mediaBudgetBlurbEditable')}</p>
          </div>
          {/* Today's usage against the EFFECTIVE caps. */}
          <div className="u-grid u-gap-1">
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('mediaBudgetTts')}</span>
              <span>
                {media.budgets.ttsChars > 0
                  ? t('mediaBudgetUsage', { used: formatNumber(media.usage.ttsChars), cap: formatNumber(media.budgets.ttsChars), unit: t('mediaUnitChars') })
                  : t('mediaBudgetUncapped', { used: formatNumber(media.usage.ttsChars), unit: t('mediaUnitChars') })}
              </span>
            </div>
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('mediaBudgetStt')}</span>
              <span>
                {media.budgets.sttBytes > 0
                  ? t('mediaBudgetUsage', { used: formatNumber(media.usage.sttBytes), cap: formatNumber(media.budgets.sttBytes), unit: t('mediaUnitBytes') })
                  : t('mediaBudgetUncapped', { used: formatNumber(media.usage.sttBytes), unit: t('mediaUnitBytes') })}
              </span>
            </div>
            {/* ADR 0401 P4 — the images unit reports + edits in the SAME panel. */}
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('mediaBudgetImages')}</span>
              <span>
                {media.budgets.images > 0
                  ? t('mediaBudgetUsage', { used: formatNumber(media.usage.images), cap: formatNumber(media.budgets.images), unit: t('mediaUnitImages') })
                  : t('mediaBudgetUncapped', { used: formatNumber(media.usage.images), unit: t('mediaUnitImages') })}
              </span>
            </div>
            {/* ADR 0411 P2 — the video unit (daily jobs) reports + edits in the SAME panel. */}
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('mediaBudgetVideo')}</span>
              <span>
                {media.budgets.video > 0
                  ? t('mediaBudgetUsage', { used: formatNumber(media.usage.video), cap: formatNumber(media.budgets.video), unit: t('mediaUnitVideo') })
                  : t('mediaBudgetUncapped', { used: formatNumber(media.usage.video), unit: t('mediaUnitVideo') })}
              </span>
            </div>
          </div>
          {/* Editable per-org override (blank ⇒ env default; 0 ⇒ uncapped). */}
          <div className="u-grid u-gap-2">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('mediaBudgetTtsOverride')}</span>
              <input
                type="number" min={0} inputMode="numeric"
                value={mediaDraft.ttsChars}
                onChange={(e) => setMediaDraft((d) => ({ ...d, ttsChars: e.target.value }))}
                placeholder={t('mediaBudgetEnvPlaceholder', { value: media.envDefaults.ttsChars > 0 ? formatNumber(media.envDefaults.ttsChars) : t('mediaBudgetNoDefault') })}
              />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('mediaBudgetSttOverride')}</span>
              <input
                type="number" min={0} inputMode="numeric"
                value={mediaDraft.sttBytes}
                onChange={(e) => setMediaDraft((d) => ({ ...d, sttBytes: e.target.value }))}
                placeholder={t('mediaBudgetEnvPlaceholder', { value: media.envDefaults.sttBytes > 0 ? formatNumber(media.envDefaults.sttBytes) : t('mediaBudgetNoDefault') })}
              />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('mediaBudgetImagesOverride')}</span>
              <input
                type="number" min={0} inputMode="numeric"
                value={mediaDraft.images}
                onChange={(e) => setMediaDraft((d) => ({ ...d, images: e.target.value }))}
                placeholder={t('mediaBudgetEnvPlaceholder', { value: media.envDefaults.images > 0 ? formatNumber(media.envDefaults.images) : t('mediaBudgetNoDefault') })}
              />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('mediaBudgetVideoOverride')}</span>
              <input
                type="number" min={0} inputMode="numeric"
                value={mediaDraft.videoJobs}
                onChange={(e) => setMediaDraft((d) => ({ ...d, videoJobs: e.target.value }))}
                placeholder={t('mediaBudgetEnvPlaceholder', { value: media.envDefaults.video > 0 ? formatNumber(media.envDefaults.video) : t('mediaBudgetNoDefault') })}
              />
            </label>
            <div className="action-bar">
              <Button variant="primary" disabled={mediaBusy} onClick={() => void saveMediaBudget()}>
                {t('mediaBudgetSave')}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {byok?.budget ? (
        <section className="u-grid u-gap-2">
          <div className="u-grid u-gap-1">
            <h3>{t('byokBudgetTitle')}</h3>
            <p className="muted">{t('byokBudgetBlurb')}</p>
          </div>
          {/* The EFFECTIVE cap + soft-warning threshold actually enforced. */}
          <div className="u-grid u-gap-1">
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('byokBudgetCapChip')}</span>
              <span>
                {byok.budget.dailyTokenCap > 0
                  ? t('byokBudgetCapValue', { cap: formatNumber(byok.budget.dailyTokenCap) })
                  : t('byokBudgetUncapped')}
              </span>
            </div>
            <div className="u-flex u-gap-2 u-items-center">
              <span className="chip">{t('byokBudgetWarnChip')}</span>
              <span>{t('byokBudgetWarnValue', { pct: formatNumber(byok.budget.softWarningPct) })}</span>
            </div>
          </div>
          {/* Editable per-org override (blank ⇒ env/host default; cap 0 ⇒ uncapped). */}
          <div className="u-grid u-gap-2">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('byokBudgetCapOverride')}</span>
              <input
                type="number" min={0} inputMode="numeric"
                value={byokDraft.dailyTokenCap}
                onChange={(e) => setByokDraft((d) => ({ ...d, dailyTokenCap: e.target.value }))}
                placeholder={t('mediaBudgetEnvPlaceholder', { value: byok.envDefaults.dailyTokenCap > 0 ? formatNumber(byok.envDefaults.dailyTokenCap) : t('mediaBudgetNoDefault') })}
              />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('byokBudgetPctOverride')}</span>
              <input
                type="number" min={0} max={100} inputMode="numeric"
                value={byokDraft.softWarningPct}
                onChange={(e) => setByokDraft((d) => ({ ...d, softWarningPct: e.target.value }))}
                placeholder={t('byokBudgetPctPlaceholder')}
              />
            </label>
            <div className="action-bar">
              <Button variant="primary" disabled={byokBusy} onClick={() => void saveByokChatBudget()}>
                {t('byokBudgetSave')}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {egress ? (
        <section className="u-grid u-gap-2">
          <div className="u-grid u-gap-1">
            <h3>{t('egressTitle')}</h3>
            <p className="muted">{t('egressBlurb')}</p>
          </div>
          {/* Mode selector — the SSRF baseline holds regardless of the choice. */}
          <div className="u-flex u-gap-2 u-items-center">
            <span className="chip">{t('egressModeChip')}</span>
            <div className="u-flex u-gap-1">
              {(['off', 'allowlist', 'denylist'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  aria-pressed={egressDraft.mode === m}
                  onClick={() => setEgressDraft((d) => ({ ...d, mode: m }))}
                >
                  {{ off: t('egressModeOff'), allowlist: t('egressModeAllowlist'), denylist: t('egressModeDenylist') }[m]}
                </button>
              ))}
            </div>
          </div>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('egressHostsLabel')}</span>
            <textarea
              rows={4}
              value={egressDraft.hosts}
              onChange={(e) => setEgressDraft((d) => ({ ...d, hosts: e.target.value }))}
              placeholder={t('egressHostsPlaceholder')}
            />
          </label>
          <p className="muted u-label-sm">{t('egressSsrfNote')}</p>
          <div className="action-bar">
            <Button variant="primary" disabled={egressBusy} onClick={() => void saveEgress()}>
              {t('egressSave')}
            </Button>
          </div>
        </section>
      ) : null}

      <span className="action-bar">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {t('savePolicy')}
        </Button>
      </span>
    </article>
  );
}
