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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteKey, listStoredRefs, storeKey } from './lib/byokClient.js';
import { PROVIDERS, type ProviderConfig } from './lib/providers.js';
import { PageHeader } from '../ui/PageHeader.js';
import { TextField } from '../ui/Field.js';
import {
  DataTable,
  IconButton,
  Modal,
  Notice,
  SkeletonRows,
  StateCard,
  type DataColumn,
} from '../ui/index.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { KeyIcon, PlusIcon, RotateCwIcon, TrashIcon } from '../ui/icons/index.js';

interface CredentialEntry {
  ref: string;
  providerId: string | null;
  /** Trailing label after `<providerId>:` if present (e.g., "prod"). */
  label: string | null;
  /** Most-recently-stored masked rendering, if added this session. */
  masked?: string;
}

/** Split a credentialRef like `anthropic:prod` into provider+label.
 *  Refs without a colon are treated as legacy: provider unknown. */
function parseRef(ref: string): CredentialEntry {
  const colon = ref.indexOf(':');
  if (colon < 0) return { ref, providerId: null, label: null };
  return {
    ref,
    providerId: ref.slice(0, colon),
    label: ref.slice(colon + 1) || null,
  };
}

const LEGACY = '__legacy__';

export function KeysPage(): JSX.Element {
  const [refs, setRefs] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  // Which provider tile is acting as the active filter (null = show all).
  const [filter, setFilter] = useState<string | null>(null);
  // Pending destructive-confirm target (credentialRef) for the <Modal>.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Most-recently-stored masked view, keyed by credentialRef. The BE's
  // POST /v1/host/sample/byok/secrets returns `{ credentialRef, masked }`
  // but the LIST endpoint only returns refs. Persisting the masked
  // value in component state lets the user visually confirm "this is
  // the sk-ant-...e4f7 I just added" until they reload the page.
  const [maskedByRef, setMaskedByRef] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listStoredRefs();
      setRefs(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRefs([]);
    }
  }, []);

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

  const legacy = refs !== null ? grouped.get(LEGACY) ?? [] : [];
  const totalKeys = entries.length;
  const loading = refs === null;

  // "Stats are filters": a tile per provider that has ≥1 key (plus a
  // Total tile), and clicking a tile narrows the sections below to that
  // provider. Total acts as the "clear filter" tile.
  const figures = useMemo<KeyFigureItem[]>(() => {
    const tiles: KeyFigureItem[] = [
      { key: '__all__', label: 'Total keys', value: totalKeys, glyph: <KeyIcon size={13} /> },
    ];
    for (const p of byokProviders) {
      const count = grouped.get(p.id)?.length ?? 0;
      if (count > 0) tiles.push({ key: p.id, label: p.label, value: count });
    }
    if (legacy.length > 0) {
      tiles.push({ key: LEGACY, label: 'Unscoped', value: legacy.length, tone: 'attention' });
    }
    return tiles;
  }, [byokProviders, grouped, totalKeys, legacy.length]);

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

  async function confirmDelete(): Promise<void> {
    const ref = pendingDelete;
    if (!ref) return;
    setDeleting(true);
    try {
      await deleteKey(ref);
      setMaskedByRef((prev) => {
        const next = { ...prev };
        delete next[ref];
        return next;
      });
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  const keyColumns: DataColumn<CredentialEntry>[] = [
    {
      key: 'ref',
      header: 'Reference',
      sortValue: (e) => e.ref,
      render: (e) => <code className="keys-list-item-ref">{e.ref}</code>,
    },
    {
      key: 'masked',
      header: 'Masked value',
      cellClassName: 'muted',
      render: (e) =>
        e.masked ? (
          <span title="Masked rendering returned by the BE on store">{e.masked}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '64px',
      render: (e) => (
        <IconButton
          label={`Delete ${e.ref}`}
          icon={<TrashIcon size={15} />}
          onClick={() => requestDelete(e.ref)}
        />
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        eyebrow="Settings"
        title="API keys"
        lede="Manage the API keys your workflows use. Each key is stored server-side (encrypted at rest); the chat and workflow-node dispatchers reference a key by its label. Add multiple keys per provider (e.g., separate prod/test keys) and pick which one a specific workflow node uses from the builder."
      />

      <div className="action-bar u-justify-end">
        <button className="secondary" onClick={() => { void refresh(); }}>
          <span className="u-iflex u-gap-1"><RotateCwIcon size={14} aria-hidden /> Refresh</span>
        </button>
      </div>

      {error && <Notice variant="error">{error}</Notice>}

      {!loading && totalKeys > 0 && (
        <KeyFigureBand
          figures={figures}
          activeKey={filter ?? '__all__'}
          onToggle={onToggleFigure}
          ariaLabel="Stored keys by provider"
        />
      )}

      <div className="page-stack">
        {loading && (
          <div className="surface-card">
            <SkeletonRows rows={3} columns={['40%', '30%', '15%']} />
          </div>
        )}

        {/* Whole-page zero-key state — a fresh tenant lands on one CTA. */}
        {!loading && totalKeys === 0 && (
          <div className="surface-card">
            <StateCard
              icon={<KeyIcon size={28} />}
              title="No API keys yet"
              body="Add a key to let chat and workflow nodes call a provider on your behalf. Keys are encrypted at rest; nodes reference them by label."
              action={
                <button onClick={() => setAdding(byokProviders[0]?.id ?? null)}>
                  <span className="u-iflex u-gap-1"><PlusIcon size={15} aria-hidden /> Add your first key</span>
                </button>
              }
            />
          </div>
        )}

        {!loading && totalKeys > 0 && visibleProviders.map((p) => {
          const list = grouped.get(p.id) ?? [];
          const isAdding = adding === p.id;
          return (
            <div key={p.id} className="surface-card">
              <div className="keys-provider-head action-bar u-justify-between">
                <div className="keys-provider-name u-iflex u-gap-2">
                  <span className="chip chip--accent">
                    <KeyIcon size={13} aria-hidden /> {p.label}
                  </span>
                  <span className="muted">{list.length} key{list.length === 1 ? '' : 's'}</span>
                </div>
                {!isAdding && (
                  <IconButton
                    label={`Add ${p.label} key`}
                    className="secondary"
                    icon={<span className="u-iflex u-gap-1"><PlusIcon size={14} aria-hidden /> Add key</span>}
                    onClick={() => setAdding(p.id)}
                  />
                )}
              </div>

              {isAdding && (
                <AddKeyForm
                  provider={p}
                  existingLabels={list.map((e) => e.label ?? e.ref)}
                  onCancel={() => setAdding(null)}
                  onSaved={async (storedRef, masked) => {
                    setAdding(null);
                    setMaskedByRef((prev) => ({ ...prev, [storedRef]: masked }));
                    await refresh();
                  }}
                />
              )}

              <DataTable
                columns={keyColumns}
                rows={list}
                rowKey={(e) => e.ref}
                density="compact"
                caption={`Stored ${p.label} keys`}
                initialSort={{ key: 'ref', dir: 'asc' }}
                empty={
                  <StateCard
                    icon={<KeyIcon size={24} />}
                    title={`No ${p.label} keys yet`}
                    body="Add a key to let chat and workflow nodes call this provider."
                    {...(isAdding ? {} : { action: (
                      <button onClick={() => setAdding(p.id)}>
                        <span className="u-iflex u-gap-1"><PlusIcon size={15} aria-hidden /> Add a key</span>
                      </button>
                    ) })}
                  />
                }
              />
            </div>
          );
        })}

        {/* Legacy refs (no `<provider>:` prefix) — surfaced separately
            so the user can clean them up. */}
        {showLegacy && (
          <div className="surface-card">
            <div className="keys-provider-head action-bar u-justify-between">
              <div className="keys-provider-name u-iflex u-gap-2">
                <span className="chip chip--muted"><KeyIcon size={13} aria-hidden /> Unscoped keys</span>
                <span className="muted">{legacy.length}</span>
              </div>
            </div>
            <Notice variant="warning">
              These credentials don&apos;t carry a <code>provider:</code>{' '}
              prefix. They still work, but the per-node picker can&apos;t
              filter them by provider. Delete and re-add to scope them.
            </Notice>
            <DataTable
              columns={keyColumns}
              rows={legacy}
              rowKey={(e) => e.ref}
              density="compact"
              caption="Unscoped keys"
              initialSort={{ key: 'ref', dir: 'asc' }}
            />
          </div>
        )}
      </div>

      {pendingDelete && (
        <Modal label="Delete key" onClose={() => { if (!deleting) setPendingDelete(null); }}>
          <h2 className="u-mt-0">Delete this key?</h2>
          <p>
            Nodes referencing <code>{pendingDelete}</code> will fail until you
            re-add a key with the same label. This can&apos;t be undone.
          </p>
          <div className="action-bar u-justify-end">
            <button className="secondary" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </button>
            <button className="btn-danger" onClick={() => { void confirmDelete(); }} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete key'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function AddKeyForm({
  provider,
  existingLabels,
  onCancel,
  onSaved,
}: {
  provider: ProviderConfig;
  existingLabels: readonly string[];
  onCancel: () => void;
  /** Called after a successful store with the persisted credentialRef
   *  + the masked rendering the BE returned, so the page can surface
   *  the masked view on the corresponding list row. */
  onSaved: (storedRef: string, masked: string) => Promise<void>;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
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
    return `${provider.label} keys usually start with \`${provider.apiKeyPrefix}\`. Double-check this is the right provider.`;
  }, [provider.apiKeyPrefix, provider.label, value]);

  async function onSubmit() {
    setErr(null);
    if (!label.trim()) {
      setErr('Label is required.');
      return;
    }
    if (!value.trim()) {
      setErr('Key value is required.');
      return;
    }
    if (labelTaken) {
      setErr('A key with this label already exists. Pick a different label.');
      return;
    }
    setSaving(true);
    try {
      const stored = await storeKey(credentialRef, value.trim());
      await onSaved(stored.credentialRef, stored.masked);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="keys-add-form">
      {err && <Notice variant="error">{err}</Notice>}
      <TextField
        label={<>Label <span className="muted">(used to identify the key in workflow nodes)</span></>}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="prod, test, personal, …"
        autoFocus
        {...(credentialRef ? { help: <>Will be stored as <code>{credentialRef}</code></> } : {})}
      />
      <div className="form-row">
        <TextField
          label="API key"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={provider.apiKeyPlaceholder ?? 'paste your key here'}
          autoComplete="off"
          {...(provider.apiKeyHelpText ? { help: provider.apiKeyHelpText } : {})}
        />
        {prefixWarning && (
          <Notice variant="warning">{prefixWarning}</Notice>
        )}
        {provider.apiKeyConsoleUrl && (
          <div className="muted builder-inspector-help">
            <a href={provider.apiKeyConsoleUrl} target="_blank" rel="noopener noreferrer">
              Get a key from {provider.label}
            </a>
          </div>
        )}
      </div>
      <div className="u-flex u-gap-2 u-justify-end">
        <button className="secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button onClick={() => { void onSubmit(); }} disabled={saving}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </div>
  );
}
