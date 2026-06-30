/**
 * ADR 0132 Phase 5 — the capability-scope modal body (default-exported so the chat
 * header can LAZY-load it: only the tiny gate+button lives in the entry chunk; this
 * heavier panel is fetched on first open — the EmbeddedChatPanel lazy precedent).
 *
 * Shows (1) PENDING per-tool approvals with Approve/Deny — the high-value operator
 * surface (each names a real tool the agent tried) — and (2) a scope editor: mode
 * (agent-default ↔ restricted) + the enabled / disabled / requires-approval lists.
 * Backend is authority (owner-gated); never-widen is enforced server-side, so the
 * editor is a plain narrowing control.
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { toast } from '../ui/toast.js';
import { CheckIcon, XIcon, PlusIcon } from '../ui/icons/index.js';
import {
  getCapabilityScope, setCapabilityScope, resolveToolApproval,
  type CapabilityScope, type CapabilityScopeView, type ScopeMode,
} from './capabilityScopeClient.js';

type ListKey = 'enabled' | 'disabled' | 'requireApproval';

export default function CapabilityScopePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('conversationTools');
  const [view, setView] = useState<CapabilityScopeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ScopeMode>('agent-default');
  const [lists, setLists] = useState<Record<ListKey, string[]>>({ enabled: [], disabled: [], requireApproval: [] });
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState(false);

  const hydrate = useCallback((v: CapabilityScopeView) => {
    setView(v);
    setMode(v.scope.mode);
    setLists({ enabled: v.scope.enabled ?? [], disabled: v.scope.disabled ?? [], requireApproval: v.scope.requireApproval ?? [] });
  }, []);

  const load = useCallback(async () => {
    try { hydrate(await getCapabilityScope(sessionId)); }
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load the tool scope.' })); }
  }, [sessionId, hydrate, t]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (toolName: string, decision: 'approved' | 'denied'): Promise<void> => {
    if (deciding) return;
    setDeciding(true);
    try { await resolveToolApproval(sessionId, toolName, decision); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('decisionFailed', { defaultValue: 'Failed to record your decision.' })); }
    finally { setDeciding(false); }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const scope: CapabilityScope | null = mode === 'agent-default'
        ? { mode: 'agent-default' }
        : { mode: 'restricted', enabled: lists.enabled, disabled: lists.disabled, requireApproval: lists.requireApproval };
      const next = await setCapabilityScope(sessionId, scope);
      hydrate({ scope: next, approvals: view?.approvals ?? [] });
      toast.success(t('saved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setSaving(false); }
  };

  const addTo = (key: ListKey, raw: string): void => {
    const tool = raw.trim();
    if (!tool || lists[key].includes(tool)) return;
    setLists((p) => ({ ...p, [key]: [...p[key], tool] }));
  };
  const removeFrom = (key: ListKey, tool: string): void =>
    setLists((p) => ({ ...p, [key]: p[key].filter((x) => x !== tool) }));

  const pending = (view?.approvals ?? []).filter((a) => a.status === 'pending');
  const listLabel = (key: ListKey): string => (key === 'enabled' ? t('list_enabled') : key === 'disabled' ? t('list_disabled') : t('list_requireApproval'));

  return (
    <Modal label={t('openTitle')} onClose={onClose} className="surface-card" loading={view === null} error={error ?? undefined}>
      <h2 className="u-fs-15">{t('heading')}</h2>
      <p className="muted u-fs-12">{t('blurb')}</p>

      {/* Pending approvals — the concrete operator surface */}
      <section aria-labelledby="ct-approvals-h" className="u-mt-3">
        <h3 id="ct-approvals-h" className="u-fs-13">{t('pendingHeading')}</h3>
        {pending.length === 0
          ? <p className="muted u-fs-12">{t('noPending')}</p>
          : (
            <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1">
              {pending.map((a) => (
                <li key={a.toolName} className="u-flex u-items-center u-justify-between u-gap-2">
                  <code className="u-fs-12">{a.toolName}</code>
                  <span className="u-flex u-gap-1">
                    <button type="button" className="u-fs-11" disabled={deciding} onClick={() => void decide(a.toolName, 'approved')} aria-label={t('approveAria', { tool: a.toolName })}>
                      <CheckIcon size={12} /> {t('approve')}
                    </button>
                    <button type="button" className="secondary u-fs-11" disabled={deciding} onClick={() => void decide(a.toolName, 'denied')} aria-label={t('denyAria', { tool: a.toolName })}>
                      {t('deny')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
      </section>

      {/* Scope editor */}
      <section aria-labelledby="ct-scope-h" className="u-mt-3">
        <h3 id="ct-scope-h" className="u-fs-13">{t('scopeHeading')}</h3>
        <fieldset className="u-border-0 u-p-0 u-m-0">
          <legend className="u-sr-only">{t('modeLegend')}</legend>
          <label className="u-flex u-items-center u-gap-1 u-fs-12">
            <input type="radio" name="ct-mode" checked={mode === 'agent-default'} onChange={() => setMode('agent-default')} />
            {t('modeDefault')}
          </label>
          <label className="u-flex u-items-center u-gap-1 u-fs-12">
            <input type="radio" name="ct-mode" checked={mode === 'restricted'} onChange={() => setMode('restricted')} />
            {t('modeRestricted')}
          </label>
        </fieldset>

        {mode === 'restricted' && (['enabled', 'disabled', 'requireApproval'] as ListKey[]).map((key) => (
          <ToolListEditor
            key={key}
            label={listLabel(key)}
            tools={lists[key]}
            onAdd={(v) => addTo(key, v)}
            onRemove={(v) => removeFrom(key, v)}
            addPlaceholder={t('addPlaceholder')}
            removeAria={(tool) => t('removeAria', { tool })}
          />
        ))}
      </section>

      <div className="action-bar u-mt-3">
        <button type="button" className="secondary" onClick={onClose}>{t('close')}</button>
        <button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </Modal>
  );
}

function ToolListEditor({ label, tools, onAdd, onRemove, addPlaceholder, removeAria }: {
  label: string; tools: string[]; onAdd: (v: string) => void; onRemove: (v: string) => void; addPlaceholder: string; removeAria: (tool: string) => string;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const submit = (): void => { onAdd(draft); setDraft(''); };
  return (
    <div className="u-mt-2">
      <div className="u-fs-12 u-fw-600">{label}</div>
      <div className="u-flex u-flex-wrap u-gap-1 u-mt-1">
        {tools.length === 0 && <span className="muted u-fs-11">—</span>}
        {tools.map((tool) => (
          <button key={tool} type="button" className="chip chip--accent u-fs-11" onClick={() => onRemove(tool)} aria-label={removeAria(tool)} title={removeAria(tool)}>
            {tool} <XIcon size={10} />
          </button>
        ))}
      </div>
      <div className="u-flex u-gap-1 u-mt-1">
        <input
          type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder={addPlaceholder} className="u-fs-11" aria-label={addPlaceholder}
        />
        <button type="button" className="secondary u-fs-11" onClick={submit} aria-label={addPlaceholder}><PlusIcon size={12} /></button>
      </div>
    </div>
  );
}
