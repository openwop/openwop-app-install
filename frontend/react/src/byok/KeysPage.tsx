/**
 * `/keys` route — API key management.
 *
 * Lists every credentialRef the user has stored on the host, lets
 * them rename/relabel via add-new-then-delete, and add new
 * credentials per-provider without going through the full BYOK
 * first-run wizard.
 *
 * Workflow nodes (chat, mock-ai) reference a credential by its
 * `credentialRef` string. Users who want different keys per node
 * (e.g., "anthropic-prod" vs "anthropic-test", or different OpenAI
 * tenants) manage that catalog here.
 *
 * The key VALUES are stored server-side (AES-256-GCM at rest in the
 * sample BE); the FE only ever sees a masked rendering after the
 * value is submitted.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { deleteKey, getActiveConfig, listStoredRefs, storeKey } from './lib/byokClient.js';
import { duplicateKeysNotice } from './lib/duplicateKeysNotice.js';
import { PROVIDERS, type ProviderConfig } from './lib/providers.js';
import { AiDefaultCard } from './AiDefaultCard.js';
import { CompatEndpointsCard } from './CompatEndpointsCard.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useHub } from '../chrome/hubContext.js';
import { RealtimeVoiceSettings } from './RealtimeVoiceSettings.js';
import { TextField } from '../ui/Field.js';
import {
  IconButton,
  Modal,
  Notice,
  SkeletonRows,
  StateCard,
  ViewToggle,
  useViewMode,
} from '../ui/index.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { GlobeIcon, KeyIcon, PlusIcon, RotateCwIcon, TrashIcon } from '../ui/icons/index.js';
import { CredentialList, type CredentialEntry } from './CredentialViews.js';
import { byokErrorMessage, deleteConflictOf, useByokWriteAccess, type DeleteConflict } from './lib/byokWriteAccess.js';
import { confirm } from '../ui/confirm.js';
import { SubscriptionCredentialCard } from './SubscriptionCredentialCard.js';
import { isCardOwnedRef, parseCredentialRef, WEB_SEARCH_REF } from './lib/credentialRef.js';
import { detectProviderByKeyPrefix } from './keyPrefix.js';

/** KEYS-REF-1 — refs are grouped by the provider they NAME, by the backend's own
 *  rule (`lib/credentialRef.ts`): `byok:google` (the wizard's shape, ADR 0517) and
 *  `google:prod` both list under Google. A ref naming no listed provider lands in
 *  the unscoped bucket — never counted and then shown nowhere. The web-search key
 *  (ADR 0101 P3) and subscription / managed refs are owned by their own cards. */
const BYOK_PROVIDER_IDS: readonly string[] = PROVIDERS.filter((p) => !p.managed && !p.hidden).map((p) => p.id);
function parseRef(ref: string): CredentialEntry {
  return parseCredentialRef(ref, BYOK_PROVIDER_IDS);
}

const LEGACY = '__legacy__';

export function KeysPage(): JSX.Element {
  const { t } = useTranslation('byok');
  const { embedded } = useHub();
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  const [refsUnreadable, setRefsUnreadable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  // ADR 0916 (P8) — a key moved from the wrong card to the right one.
  const [carriedKey, setCarriedKey] = useState('');
  // Which provider tile is acting as the active filter (null = show all).
  const [filter, setFilter] = useState<string | null>(null);
  // Pending destructive-confirm target (credentialRef) for the <Modal>.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // ADR 0779 D7 — offer only the writes the server would accept.
  const canManage = useByokWriteAccess();
  // Most-recently-stored masked view, keyed by credentialRef. The BE's
  // POST /host/openwop-app/byok/secrets returns `{ credentialRef, masked }`
  // but the LIST endpoint only returns refs. Persisting the masked
  // value in component state lets the user visually confirm "this is
  // the sk-ant-...e4f7 I just added" until they reload the page.
  const [maskedByRef, setMaskedByRef] = useState<Record<string, string>>({});
  // ADR 0131 — a DataTable operate-surface: the per-provider tables stay the
  // default "list" view; Grid renders each provider's keys as cards alongside.
  const [viewMode, setViewMode] = useViewMode('keys', 'list');

  // ADR 0517 open question 1 — which ref is the chat actually BOUND to? Without
  // it the page can count keys but cannot say which of them matters, and
  // "you have 7 Google keys" with no indication of which is live is an
  // invitation to delete the wrong one. `null` = no binding; `'unknown'` = we
  // could not read it, which must NOT be rendered as "none are in use".
  const [activeRef, setActiveRef] = useState<string | null | 'unknown'>('unknown');

  const refresh = useCallback(async () => {
    // Read the binding alongside the refs. A failure here is isolated: the key
    // list is still worth showing, we just decline to claim which one is live.
    void getActiveConfig()
      .then((env) => setActiveRef(env.config?.credentialRef ?? null))
      .catch(() => setActiveRef('unknown'));
    try {
      setError(null);
      const list = await listStoredRefs();
      setRefsUnreadable(false);
      setRefs(list);
    } catch (err) {
      setError(byokErrorMessage(t, err));
      // The page-level error is shown, but the voice card gets the empty array
      // too — flag it so it does not read that as "your configured key is gone".
      setRefsUnreadable(true);
      setRefs([]);
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const entries = useMemo<CredentialEntry[]>(() => {
    return (refs ?? []).map((ref) => {
      const parsed = parseRef(ref);
      const masked = maskedByRef[ref];
      return masked ? { ...parsed, masked } : parsed;
    });
  }, [refs, maskedByRef]);

  // Group by provider for a clean per-provider section layout.
  const grouped = useMemo(() => {
    const byProvider = new Map<string, CredentialEntry[]>();
    for (const e of entries) {
      const key = e.providerId ?? LEGACY;
      const arr = byProvider.get(key) ?? [];
      arr.push(e);
      byProvider.set(key, arr);
    }
    return byProvider;
  }, [entries]);

  // BYOK-only providers (the managed Try-it-free entry doesn't take
  // a user-supplied key; MiniMax is hidden — its key is server-side).
  const byokProviders = useMemo(
    () => PROVIDERS.filter((p) => !p.managed && !p.hidden),
    [],
  );

  // Exclude card-owned refs from the "unscoped/legacy" warning list: the web-search
  // key (ADR 0101 P3, its own card below) and subscription / managed refs.
  const legacy = (refs !== null ? grouped.get(LEGACY) ?? [] : []).filter((e) => !isCardOwnedRef(e.ref));
  const webSearchConfigured = (refs ?? []).includes(WEB_SEARCH_REF);
  const totalKeys = entries.length;
  const loading = refs === null;
  // ADR 0779 D7 (grade-ux BYOKUX-4) — a failed read is NOT an empty store. The
  // page used to show the error AND "No API keys yet / Add your first key", the
  // web-search form as unconfigured, and the AI-default "add a key first" — an
  // invitation to overwrite keys that exist. Everything that reads `refs` waits
  // for a read that succeeded.
  const readOk = !loading && !refsUnreadable;

  // "Stats are filters": a tile per provider that has ≥1 key (plus a
  // Total tile), and clicking a tile narrows the sections below to that
  // provider. Total acts as the "clear filter" tile.
  const figures = useMemo<KeyFigureItem[]>(() => {
    const tiles: KeyFigureItem[] = [
      { key: '__all__', label: t('totalKeys'), value: totalKeys },
    ];
    for (const p of byokProviders) {
      const count = grouped.get(p.id)?.length ?? 0;
      if (count > 0) tiles.push({ key: p.id, label: p.label, value: count });
    }
    if (legacy.length > 0) {
      tiles.push({ key: LEGACY, label: t('unscoped'), value: legacy.length, tone: 'attention' });
    }
    return tiles;
  }, [byokProviders, grouped, totalKeys, legacy.length, t]);

  const onToggleFigure = useCallback((key: string) => {
    setFilter((prev) => (key === '__all__' || prev === key ? null : key));
  }, []);

  // Apply the active provider filter to which sections render.
  const visibleProviders = filter
    ? byokProviders.filter((p) => p.id === filter)
    : byokProviders;
  const showLegacy = legacy.length > 0 && (!filter || filter === LEGACY);

  function requestDelete(ref: string): void {
    setPendingDelete(ref);
  }

  function closeDelete(): void {
    if (deleting) return;
    setPendingDelete(null);
  }

  function forget(ref: string): void {
    setMaskedByRef((prev) => {
      const next = { ...prev };
      delete next[ref];
      return next;
    });
  }

  async function confirmDelete(): Promise<void> {
    const ref = pendingDelete;
    if (!ref) return;
    setDeleting(true);
    let conflict: DeleteConflict | null = null;
    try {
      await deleteKey(ref);
      forget(ref);
      await refresh();
    } catch (err) {
      conflict = deleteConflictOf(err);
      if (!conflict) setError(byokErrorMessage(t, err));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
    if (conflict) await offerForcedDelete(ref, conflict);
  }

  /** ADR 0779 D7 — the server refused the delete (live references, an index it
   *  could not check, or another lifecycle's namespace). The override is a
   *  SEPARATE danger confirmation — the shared `confirm()` the vault uses — never
   *  a button that replaces the one the user just pressed (a repeated Enter or a
   *  resting pointer would fire it unread). The dialog names what breaks. */
  async function offerForcedDelete(ref: string, c: DeleteConflict): Promise<void> {
    const forced = await confirm({
      title: deleteConflictText(c, t),
      body: (
        <>
          {c.references.length > 0 && <ul>{c.references.map((r) => <li key={r}>{r}</li>)}</ul>}
          <p className="u-mb-0">{t('deleteAnywayHint')}</p>
        </>
      ),
      danger: true,
      confirmLabel: t('deleteAnyway'),
    });
    if (!forced) return;
    try {
      await deleteKey(ref, { force: true });
      forget(ref);
      await refresh();
    } catch (err) {
      setError(byokErrorMessage(t, err));
    }
  }

  return (
    <section data-walkthrough="keys.page">
      {embedded ? null : (
        <PageHeader
          eyebrow={t('settingsEyebrow')}
          title={t('apiKeysTitle')}
          lede={t('apiKeysLede')}
        />
      )}

      <div className="action-bar u-justify-end">
        {!loading && totalKeys > 0 ? (
          <ViewToggle value={viewMode} onChange={setViewMode} labels={{ list: t('keysViewTable') }} />
        ) : null}
        <Button variant="secondary" onClick={() => { void refresh(); }}>
          <span className="u-iflex u-gap-1"><RotateCwIcon size={14} aria-hidden /> {t('common:refresh')}</span>
        </Button>
      </div>

      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      {/* Ambient state, not an event: plain text, so it is not announced on
          every visit (DESIGN §4.6 reserves announcing for failures). */}
      {!canManage && <p className="muted">{t('readOnlyNotice')}</p>}

      {!loading && totalKeys > 0 && (
        <KeyFigureBand
          figures={figures}
          activeKey={filter ?? '__all__'}
          onToggle={onToggleFigure}
          ariaLabel={t('storedKeysByProvider')}
        />
      )}

      <div className="page-stack">
        {loading && (
          <div className="surface-card" aria-busy="true">
            <span className="sr-only">{t('common:loading')}</span>
            <SkeletonRows rows={3} columns={['40%', '30%', '15%']} />
          </div>
        )}

        {/* Whole-page zero-key state — a fresh tenant lands here. Hidden once a
            provider is chosen: the provider sections below then render the add
            form (previously `adding` mounted nothing at zero keys — the
            "Add your first key" button was a visible no-op).
            One button PER provider: a single "Add your first key" opened only
            the first provider's form (Anthropic), and the other sections stay
            hidden until a key exists, so a fresh workspace could not add a
            Google or OpenAI key from this screen at all (2026-10-17). */}
        {readOk && totalKeys === 0 && adding === null && (
          <div className="surface-card">
            <StateCard
              icon={<KeyIcon size={28} />}
              title={t('noKeysTitle')}
              body={canManage ? t('noKeysBody') : t('readOnlyNotice')}
              {...(canManage ? { action: (
                <div className="u-flex u-gap-2 u-flex-wrap u-justify-center">
                  {byokProviders.map((p, i) => (
                    <Button key={p.id} variant={i === 0 ? 'primary' : 'secondary'} onClick={() => setAdding(p.id)}>
                      <span className="u-iflex u-gap-1"><PlusIcon size={15} aria-hidden /> {t('addProviderKey', { provider: p.label })}</span>
                    </Button>
                  ))}
                </div>
              ) } : {})}
            />
          </div>
        )}

        {readOk && (totalKeys > 0 || adding !== null) && visibleProviders
          .filter((p) => totalKeys > 0 || adding === p.id)
          .map((p) => {
          const list = grouped.get(p.id) ?? [];
          const isAdding = adding === p.id;
          return (
            <div key={p.id} className="surface-card">
              <div className="keys-provider-head action-bar u-justify-between">
                <div className="keys-provider-name u-iflex u-gap-2">
                  <span className="chip chip--accent">
                    <KeyIcon size={13} aria-hidden /> {p.label}
                  </span>
                  <span className="muted">{t('keyCount', { count: list.length })}</span>
                  {/* ADR 0101 Phase 4 — a provider whose native search is licensed
                      only for display can't back features that SAVE sources as
                      evidence. Shown here so the constraint is visible when
                      choosing a provider, not when a run refuses. */}
                  {p.searchSuitability === 'answer-only' && (
                    <span className="chip chip--muted" title={t('searchAnswerOnlyHint')}>
                      <span className="u-iflex u-gap-1"><GlobeIcon size={13} aria-hidden /> {t('searchAnswerOnly')}</span>
                    </span>
                  )}
                </div>
                {!isAdding && canManage && (
                  <IconButton
                    label={t('addProviderKey', { provider: p.label })}
                    className="secondary"
                    icon={<span className="u-iflex u-gap-1"><PlusIcon size={14} aria-hidden /> {t('addKey')}</span>}
                    onClick={() => setAdding(p.id)}
                  />
                )}
              </div>

              {/* ADR 0517 open question 1 — a provider with more than one stored key.
                * The reported workspace had SEVEN Google keys and no way to tell
                * which was live, so cleanup was undiscoverable and risky. Naming the
                * active one makes removing the rest obviously safe; when we could not
                * read the binding we say so rather than guessing. */}
              {(() => {
                const notice = duplicateKeysNotice(list.map((e) => e.ref), activeRef, p.label);
                return notice ? <Notice variant="info">{t(notice.key, notice.params)}</Notice> : null;
              })()}

              {isAdding && (
                <AddKeyForm
                  key={p.id}
                  provider={p}
                  providers={byokProviders}
                  initialValue={carriedKey}
                  onSwitchProvider={(id, v) => { setCarriedKey(v); setAdding(id); }}
                  existingLabels={list.map((e) => e.label ?? e.ref)}
                  onCancel={() => { setCarriedKey(''); setAdding(null); }}
                  onSaved={async (storedRef, masked) => {
                    setCarriedKey('');
                    setAdding(null);
                    setMaskedByRef((prev) => ({ ...prev, [storedRef]: masked }));
                    await refresh();
                  }}
                />
              )}

              <CredentialList
                list={list}
                viewMode={viewMode}
                caption={t('storedProviderKeys', { provider: p.label })}
                {...(canManage ? { onDelete: requestDelete } : {})}
                empty={
                  <StateCard
                    icon={<KeyIcon size={24} />}
                    title={t('noProviderKeysTitle', { provider: p.label })}
                    body={t('noProviderKeysBody')}
                    {...(isAdding || !canManage ? {} : { action: (
                      <Button variant="primary" onClick={() => setAdding(p.id)}>
                        <span className="u-iflex u-gap-1"><PlusIcon size={15} aria-hidden /> {t('addAKey')}</span>
                      </Button>
                    ) })}
                  />
                }
              />
            </div>
          );
        })}

        {/* Web search (optional) — a host-tool fallback for tiers/providers
            without native grounding (ADR 0101). Backs `resolveSecret('web-search')`. */}
        {readOk && (
          <WebSearchKeyCard configured={webSearchConfigured} onChanged={refresh} canManage={canManage} />
        )}

        {/* RFC 0121 AT-OWN-RISK subscription credential (ADR 0180). Self-hides
            when the host does NOT advertise the `subscription` mode (dark by
            default). Gated behind a mandatory risk acknowledgement. */}
        <SubscriptionCredentialCard />

        {/* Legacy refs (no `<provider>:` prefix) — surfaced separately
            so the user can clean them up. */}
        {showLegacy && (
          <div className="surface-card">
            <div className="keys-provider-head action-bar u-justify-between">
              <div className="keys-provider-name u-iflex u-gap-2">
                <span className="chip chip--muted"><KeyIcon size={13} aria-hidden /> {t('unscopedKeysChip')}</span>
                <span className="muted">{legacy.length}</span>
              </div>
            </div>
            <Notice variant="warning">
              {t('unscopedKeysNoticeBefore')} <code>provider:</code>{' '}
              {t('unscopedKeysNoticeAfter')}
            </Notice>
            <CredentialList
              list={legacy}
              viewMode={viewMode}
              caption={t('unscopedKeysCaption')}
              {...(canManage ? { onDelete: requestDelete } : {})}
              empty={null}
            />
          </div>
        )}
      </div>

      {/* Voice + self-hosted endpoints are first-class Access Hub tabs (ADR 0144);
          inside the hub they render there, not buried in the Keys tab. */}
      {embedded ? null : (
        <div className="u-mt-4">
          <RealtimeVoiceSettings storedRefs={refs ?? []} refsUnreadable={refsUnreadable} />
        </div>
      )}

      {pendingDelete && (
        <Modal label={t('deleteKeyModalLabel')} onClose={closeDelete}>
          <h2 className="u-mt-0">{t('deleteThisKeyTitle')}</h2>
          <p>
            {t('deleteThisKeyBodyBefore')} <code>{pendingDelete}</code>{' '}
            {t('deleteThisKeyBodyAfter')}
          </p>
          <div className="action-bar u-justify-end">
            <Button variant="secondary" onClick={closeDelete} disabled={deleting}>
              {t('common:cancel')}
            </Button>
            <Button variant="danger" onClick={() => { void confirmDelete(); }} disabled={deleting}>
              {deleting ? t('deleting') : t('deleteKeyModalLabel')}
            </Button>
          </div>
        </Modal>
      )}
      {readOk && refs !== null ? <AiDefaultCard refs={refs} /> : null}
      {embedded ? null : <CompatEndpointsCard />}
    </section>
  );
}

/** Optional web-search key (ADR 0101 Phase 3). A search-provider key (Brave /
 *  Tavily / etc.) is NOT an LLM provider, so it gets a dedicated card and stores
 *  under the bare ref `web-search` that the host resolves. Only needed for the
 *  host-tool fallback — providers with NATIVE grounding use their own LLM key. */
export function WebSearchKeyCard({ configured, onChanged, canManage = true }: { configured: boolean; onChanged: () => void | Promise<void>; canManage?: boolean }): JSX.Element {
  const { t } = useTranslation('byok');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // ADR 0779 D7 — a failed save/remove used to be an unhandled rejection: the
  // button re-enabled and nothing said why.
  const [err, setErr] = useState<string | null>(null);
  const showForm = canManage && (!configured || editing);
  const save = useCallback(async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true); setErr(null);
    try { await storeKey(WEB_SEARCH_REF, v); setValue(''); setEditing(false); await onChanged(); }
    catch (e) { setErr(byokErrorMessage(t, e)); }
    finally { setBusy(false); }
  }, [value, onChanged, t]);
  const remove = useCallback(async () => {
    if (!(await confirm({ title: t('webSearchRemoveTitle'), body: t('webSearchRemoveBody'), danger: true, confirmLabel: t('common:remove') }))) return;
    setBusy(true); setErr(null);
    try { await deleteKey(WEB_SEARCH_REF); await onChanged(); }
    catch (e) { setErr(byokErrorMessage(t, e)); }
    finally { setBusy(false); }
  }, [onChanged, t]);
  return (
    <div className="surface-card">
      <div className="keys-provider-head action-bar u-justify-between">
        <div className="keys-provider-name u-iflex u-gap-2">
          <span className="chip chip--accent"><span className="u-iflex u-gap-1"><GlobeIcon size={14} aria-hidden /> {t('webSearch.title')}</span></span>
          {configured && <span className="muted">{t('webSearch.configured')}</span>}
        </div>
        {configured && !editing && canManage && (
          <Button variant="secondary" onClick={() => { void remove(); }} disabled={busy}>
            <span className="u-iflex u-gap-1"><TrashIcon size={14} aria-hidden /> {t('common:remove')}</span>
          </Button>
        )}
      </div>
      <p className="muted">{t('webSearch.body')}</p>
      {err && <Notice variant="error">{err}</Notice>}
      {showForm && (
        <div className="form-row">
          <TextField
            label={t('webSearch.keyLabel')}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('webSearch.placeholder')}
            autoComplete="off"
          />
          <div className="u-flex u-gap-2 u-justify-end">
            {configured && <Button variant="secondary" onClick={() => { setEditing(false); setValue(''); }} disabled={busy}>{t('common:cancel')}</Button>}
            <Button variant="primary" onClick={() => { void save(); }} disabled={busy || !value.trim()}>{busy ? t('common:saving') : t('common:save')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddKeyForm({
  provider,
  existingLabels,
  onCancel,
  onSaved,
  providers = [],
  initialValue = '',
  onSwitchProvider,
}: {
  provider: ProviderConfig;
  existingLabels: readonly string[];
  onCancel: () => void;
  /** ADR 0916 (P8) — every BYOK card, to recognise a key pasted under the wrong one. */
  providers?: readonly ProviderConfig[];
  /** ADR 0916 (P8) — the key carried over when the user switched cards. */
  initialValue?: string;
  /** ADR 0916 (P8) — move the pasted key to the card it belongs to. */
  onSwitchProvider?: (providerId: string, value: string) => void;
  /** Called after a successful store with the persisted credentialRef
   *  + the masked rendering the BE returned, so the page can surface
   *  the masked view on the corresponding list row. */
  onSaved: (storedRef: string, masked: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('byok');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  // ADR 0916 (P8) — set once the user chose to keep a key under this card
  // although its prefix says another vendor's.
  const [keepHere, setKeepHere] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const credentialRef = useMemo(() => {
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `${provider.id}:${slug}` : '';
  }, [label, provider.id]);

  const labelTaken = existingLabels.includes(label.trim()) || existingLabels.includes(credentialRef);

  // Soft validation against the provider's apiKeyPrefix hint. The
  // wizard's first-run flow already does this; mirroring here so a
  // user adding a key from the manage page gets the same nudge when
  // they paste something that doesn't start with the expected prefix.
  // Warning only — submit isn't blocked because users with fine-tune
  // keys / org-prefixed keys are still valid.
  const prefixWarning = useMemo(() => {
    if (!provider.apiKeyPrefix) return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith(provider.apiKeyPrefix)) return null;
    return t('addKeyPrefixWarning', { provider: provider.label, prefix: provider.apiKeyPrefix });
  }, [provider.apiKeyPrefix, provider.label, value, t]);

  // ADR 0916 (P8) — the card this key's prefix actually belongs to, when it is
  // another one. A key saved under the wrong card fails at that vendor with a
  // credential error that never says why, so saving needs an explicit choice.
  const belongsTo = useMemo(() => {
    const match = detectProviderByKeyPrefix(value, providers);
    return match && match.id !== provider.id ? match : null;
  }, [value, providers, provider.id]);

  async function onSubmit() {
    setErr(null);
    if (belongsTo && !keepHere) {
      setErr(t('addKeyChooseCard', { other: belongsTo.label, provider: provider.label }));
      return;
    }
    if (!label.trim()) {
      setErr(t('labelRequired'));
      return;
    }
    if (!value.trim()) {
      setErr(t('keyValueRequired'));
      return;
    }
    if (labelTaken) {
      setErr(t('labelTakenError'));
      return;
    }
    setSaving(true);
    try {
      const stored = await storeKey(credentialRef, value.trim());
      await onSaved(stored.credentialRef, stored.masked);
    } catch (e) {
      setErr(byokErrorMessage(t, e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="keys-add-form">
      {err && <Notice variant="error">{err}</Notice>}
      <TextField
        label={<>{t('labelFieldLabel')} <span className="muted">{t('labelFieldHint')}</span></>}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('labelPlaceholder')}
        autoFocus
        {...(credentialRef ? { help: <>{t('willBeStoredAs')} <code>{credentialRef}</code></> } : {})}
      />
      <div className="form-row">
        <TextField
          label={t('apiKeyLabel')}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={provider.apiKeyPlaceholder ?? t('keyPlaceholderDefault')}
          autoComplete="off"
          {...(provider.apiKeyHelpText ? { help: provider.apiKeyHelpText } : {})}
        />
        {belongsTo ? (
          <Notice variant="warning">
            <p className="u-m-0">{t('addKeyLooksLikeOther', { other: belongsTo.label, prefix: belongsTo.apiKeyPrefix ?? '' })}</p>
            <div className="u-flex u-gap-2 u-flex-wrap u-mt-2">
              {onSwitchProvider ? (
                <Button size="sm" variant="primary" onClick={() => onSwitchProvider(belongsTo.id, value)}>
                  {t('addKeySwitchTo', { other: belongsTo.label })}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" aria-pressed={keepHere} onClick={() => setKeepHere(true)}>
                {t('addKeyKeepHere', { provider: provider.label })}
              </Button>
            </div>
          </Notice>
        ) : prefixWarning ? (
          <Notice variant="warning">{prefixWarning}</Notice>
        ) : null}
        {provider.apiKeyConsoleUrl && (
          <div className="muted builder-inspector-help">
            <a href={provider.apiKeyConsoleUrl} target="_blank" rel="noopener noreferrer">
              {t('getKeyFromProvider', { provider: provider.label })}
            </a>
          </div>
        )}
      </div>
      <div className="u-flex u-gap-2 u-justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>{t('common:cancel')}</Button>
        <Button variant="primary" onClick={() => { void onSubmit(); }} disabled={saving}>
          {saving ? t('common:saving') : t('saveKey')}
        </Button>
      </div>
    </div>
  );
}

/** ADR 0779 D7 — say which refusal it was: another lifecycle's key, an index the
 *  server could not check, or named consumers (listed under this line). */
function deleteConflictText(c: DeleteConflict, t: TFunction<'byok'>): string {
  if (c.owner) return t('deleteBlockedOwner', { owner: c.owner });
  if (!c.referencesKnown) return t('deleteBlockedUnknown');
  return t('deleteBlockedReferences');
}
