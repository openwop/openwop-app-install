/**
 * Governance panel (ADR 0028 / ADR 0023 §12 T7) — superadmin-only card on the
 * Connections page: the provider allowlist and the per-action-kind policy.
 * Hidden entirely when the policy read 403s (non-admin) — never surface an
 * action that would fail.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { toast } from '../../ui/toast.js';
import { listProviders } from './connectionsClient.js';
import { formatNumber } from '../../i18n/format.js';

const base = `${config.baseUrl}/v1/host/openwop-app/governance`;

type KindPolicy = 'disabled' | 'draft-only' | 'approval-required';

interface PolicyDoc {
  providerAllowlist?: string[];
  actionPolicy?: Record<string, KindPolicy>;
}

interface PolicyResponse {
  policy: PolicyDoc;
  actionKinds: string[];
}

/** ADR 0106 — media-generation budget: effective caps, env defaults, the editable
 *  per-org override, and today's usage. */
interface MediaBudgetResponse {
  date: string;
  budgets: { ttsChars: number; sttBytes: number };
  envDefaults: { ttsChars: number; sttBytes: number };
  override: { ttsChars?: number; sttBytes?: number } | null;
  usage: { ttsChars: number; sttBytes: number };
}

export function GovernancePanel(): JSX.Element | null {
  const { t } = useTranslation('connections');
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<MediaBudgetResponse | null>(null);
  // ADR 0106 editable override — the draft override (empty string ⇒ clear ⇒ env default).
  const [mediaDraft, setMediaDraft] = useState<{ ttsChars: string; sttBytes: string }>({ ttsChars: '', sttBytes: '' });
  const [mediaBusy, setMediaBusy] = useState(false);

  // Self-loads the provider catalog (the panel mounts on pages that don't
  // otherwise hold it — the page-level ConnectionsManager owns its own copy).
  useEffect(() => {
    void listProviders()
      .then((ps) => setProviderIds(ps.map((p) => p.id)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void fetch(`${base}/policy`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (!res.ok) return; // 403 — not an admin; stay hidden
        const body = (await res.json()) as PolicyResponse;
        setDoc(body.policy ?? {});
        setKinds(body.actionKinds ?? []);
        setVisible(true);
      })
      .catch(() => {});
  }, []);

  // ADR 0106 — media-budget readout + editable override (superadmin); skipped on 403.
  const loadMedia = useCallback(() => {
    void fetch(`${base}/media-budget`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as MediaBudgetResponse;
        setMedia(body);
        setMediaDraft({
          ttsChars: body.override?.ttsChars != null ? String(body.override.ttsChars) : '',
          sttBytes: body.override?.sttBytes != null ? String(body.override.sttBytes) : '',
        });
      })
      .catch(() => {});
  }, []);
  useEffect(() => { loadMedia(); }, [loadMedia]);

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
    const sttBytes = parse(mediaDraft.sttBytes);
    if (ttsChars === undefined || sttBytes === undefined) {
      toast.error(t('mediaBudgetInvalid'));
      return;
    }
    setMediaBusy(true);
    try {
      const res = await fetch(`${base}/media-budget`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ttsChars, sttBytes }),
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
          ...(doc.providerAllowlist !== undefined ? { providerAllowlist: doc.providerAllowlist } : {}),
          ...(doc.actionPolicy !== undefined ? { actionPolicy: doc.actionPolicy } : {}),
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

  if (!visible || !doc) return null;

  const allowlistActive = doc.providerAllowlist !== undefined;
  return (
    <article className="surface-card u-grid u-gap-2">
      <header>
        <h2>{t('governanceTitle')}</h2>
        <p className="muted">{t('governanceBlurb')}</p>
      </header>

      <section className="u-grid u-gap-1">
        <h3>{t('providerAllowlist')}</h3>
        <label>
          <input
            type="checkbox"
            checked={allowlistActive}
            onChange={(e) => {
              const { providerAllowlist: _drop, ...rest } = doc;
              setDoc(e.target.checked ? { ...rest, providerAllowlist: providerIds } : rest);
            }}
          />{' '}
          {t('restrictProviders')}
        </label>
        {allowlistActive ? (
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
            <div className="action-bar">
              <button type="button" className="btn-primary" disabled={mediaBusy} onClick={() => void saveMediaBudget()}>
                {t('mediaBudgetSave')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <span className="action-bar">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          {t('savePolicy')}
        </button>
      </span>
    </article>
  );
}
