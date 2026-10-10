/**
 * AI clients (MCP) — ADR 0788 D6, an Access Hub tab (`/access?tab=mcp`).
 *
 * Replaces the read-only tool list that sat at the bottom of `/capabilities`.
 * Everything a person needs to point an external AI client at this workspace,
 * in the order they need it:
 *
 *   1. Status + endpoint — whether this deployment serves MCP at all, and the
 *      URL the BACKEND says to use (not one the SPA assembles: the SPA's `/api`
 *      base runs through a proxy whose timeout would cut a long tool call).
 *   2. A key for the client — minted here with one of two presets, shown ONCE,
 *      with a ready-to-paste config; the client's keys listed and revocable.
 *   3. The tools — what a client signed in as you reaches, each with its gate
 *      facts, and (for an admin) a switch that turns a tool off for every client
 *      in the workspace.
 *
 * Honesty rules this page keeps: a network failure is never shown as "turned
 * off"; the config snippet does not claim a named client works (this host has
 * not been driven by one); and the tool list is described as YOUR view, since a
 * read-only key sees less.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHub } from '../chrome/hubContext.js';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StateCard } from '../ui/StateCard.js';
import { SignInButton } from '../auth/SignInButton.js';
import { copyToClipboard } from '../ui/copyToClipboard.js';
import { confirm } from '../ui/confirm.js';
import { announce } from '../ui/announce.js';
import { CopyIcon, KeyIcon, PlugIcon, RotateCwIcon, ShieldIcon, TrashIcon, WrenchIcon } from '../ui/icons/index.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { loadErrorMessage } from '../client/loadErrorMessage.js';
import { useScopeWriteAccess, writeErrorMessage } from '../lib/writeAccess.js';
import { useFormat } from '../i18n/useFormat.js';
import {
  MCP_KEY_PREFIX,
  PRESET_SCOPES,
  clientConfigSnippet,
  createMcpKey,
  getMcpExposure,
  listMcpKeys,
  revokeMcpKey,
  setMcpToolDisabled,
  type DeveloperKey,
  type KeyPreset,
  type McpExposureView,
  type McpToolEntry,
} from './mcpAccessClient.js';

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; view: McpExposureView };

export function McpAccessPage(): JSX.Element {
  const { embedded } = useHub();
  const { t } = useTranslation('mcp');
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  const refresh = useCallback(() => {
    setLoad({ status: 'loading' });
    getMcpExposure().then(
      (view) => setLoad({ status: 'ready', view }),
      (error: unknown) => setLoad({ status: 'error', error }),
    );
  }, []);
  useEffect(refresh, [refresh]);

  // Hub-tab-only surface (ADR 0144): a direct visit bounces into the hub.
  if (!embedded) return <Navigate to="/access?tab=mcp" replace />;

  if (load.status === 'loading') {
    return (
      <section className="u-grid u-gap-4" aria-busy="true">
        <div className="surface-card" role="status" aria-label={t('loading')}>
          <Skeleton width="40%" /><Skeleton width="85%" /><Skeleton width="70%" />
        </div>
      </section>
    );
  }
  if (load.status === 'error') {
    const kind = classifyHttpError(load.error).kind;
    if (kind === 'auth') {
      return <StateCard icon={<PlugIcon size={20} />} title={t('signedOutTitle')} body={t('signedOutBody')} action={<SignInButton />} />;
    }
    if (kind === 'forbidden') {
      return <StateCard icon={<ShieldIcon size={20} />} title={t('forbiddenTitle')} body={t('forbiddenBody')} />;
    }
    return (
      <StateCard
        icon={<PlugIcon size={20} />}
        title={t('loadFailedTitle')}
        body={loadErrorMessage(t, load.error)}
        announce
        action={<Button variant="secondary" onClick={refresh}><RotateCwIcon size={16} /> {t('retry')}</Button>}
      />
    );
  }

  const { view } = load;
  return (
    <section className="u-grid u-gap-4 mcp-access">
      <EndpointCard view={view} />
      {view.enabled && <KeysCard endpoint={view.endpoint.url} />}
      <ToolsCard view={view} onChanged={(next) => setLoad({ status: 'ready', view: next })} />
    </section>
  );
}

function EndpointCard({ view }: { view: McpExposureView }): JSX.Element {
  const { t } = useTranslation('mcp');
  return (
    <div className="surface-card">
      <h2 className="u-flex u-items-center u-gap-2"><PlugIcon size={18} /> {t('endpointTitle')}</h2>
      {!view.enabled ? (
        <Notice variant="info">{t('mountOff')}</Notice>
      ) : (
        <>
          <p className="muted">{t('endpointHelp')}</p>
          <div className="mcp-endpoint">
            <code className="u-break-all">{view.endpoint.url}</code>
            <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(view.endpoint.url, t('urlCopied'))} aria-label={t('copyUrl')}>
              <CopyIcon size={14} /> {t('copy')}
            </Button>
          </div>
          <p className="muted u-fs-13">{t('protocols', { versions: view.protocolVersions.join(', ') })}</p>
          {view.endpoint.viaProxy && <Notice variant="warning">{t('viaProxy')}</Notice>}
        </>
      )}
    </div>
  );
}

/** Friendly names for the scopes a tool or key needs (grade-ux MCPUX-8). An
 *  unknown scope falls back to its id rather than disappearing. */
function useScopeLabel(): (scope: string) => string {
  const { t } = useTranslation('mcp');
  return (scope) => {
    switch (scope) {
      case 'workspace:read': return t('scopeRead');
      case 'workspace:write': return t('scopeWrite');
      case 'runs:create': return t('scopeRun');
      default: return scope;
    }
  };
}

function KeysCard({ endpoint }: { endpoint: string }): JSX.Element {
  const { t } = useTranslation('mcp');
  const fmt = useFormat();
  const scopeLabel = useScopeLabel();
  const labelId = useId();
  const labelErrorId = useId();
  const canAct = useScopeWriteAccess('workspace:write');
  const labelRef = useRef<HTMLInputElement>(null);
  const copyConfigRef = useRef<HTMLButtonElement>(null);
  const keysHeadingRef = useRef<HTMLHeadingElement>(null);
  const [keys, setKeys] = useState<DeveloperKey[] | null>(null);
  const [keysError, setKeysError] = useState<unknown>(null);
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState(false);
  const [preset, setPreset] = useState<KeyPreset>('read');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; name: string; keyId: string } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setKeysError(null);
    listMcpKeys().then(setKeys, (err: unknown) => { setKeys(null); setKeysError(err); });
  }, []);
  useEffect(reload, [reload]);

  // MCPUX-2 — the key is shown ONCE: take the keyboard to it the moment it
  // appears, so a keyboard or screen-reader user lands on "Copy configuration"
  // rather than on a page body the disabled Create button dropped them onto.
  useEffect(() => {
    if (issued) copyConfigRef.current?.focus();
  }, [issued]);

  const create = async (): Promise<void> => {
    const name = label.trim();
    if (!name) {
      setLabelError(true);
      labelRef.current?.focus();
      return;
    }
    setBusy(true);
    setWriteError(null);
    try {
      const out = await createMcpKey(name, preset === 'act' && !canAct ? 'read' : preset);
      setIssued({ token: out.token, name, keyId: out.key.keyId });
      setLabel('');
      announce(`${t('keyCreated', { name })}. ${t('issuedOnce', { name })}`, { assertive: true });
      reload();
    } catch (err) {
      setWriteError(writeErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const dismissIssued = (): void => {
    setIssued(null);
    labelRef.current?.focus(); // MCPUX-2 — Done removes itself; return the keyboard to the form.
  };

  const revoke = async (k: DeveloperKey): Promise<void> => {
    const shown = k.name.slice(MCP_KEY_PREFIX.length);
    if (!(await confirm({ title: t('revokeConfirmTitle', { name: shown }), body: t('revokeConfirmBody'), confirmLabel: t('revoke'), danger: true }))) return;
    setWriteError(null);
    try {
      await revokeMcpKey(k.keyId);
      if (issued?.keyId === k.keyId) setIssued(null); // MCPUX-12 — by id, never by display name
      announce(t('keyRevoked', { name: shown }));
      reload();
      keysHeadingRef.current?.focus(); // MCPUX-6 — the row is gone; keep the keyboard in the list
    } catch (err) {
      setWriteError(writeErrorMessage(t, err));
    }
  };

  const presetOf = (k: DeveloperKey): string =>
    k.scopes.includes('runs:create') && k.scopes.includes('workspace:write') ? t('presetAct') : t('presetRead');
  const someoneElses = (keys ?? []).some((k) => k.mine === false);

  return (
    <div className="surface-card">
      <h2 className="u-flex u-items-center u-gap-2"><KeyIcon size={18} /> {t('keysTitle')}</h2>
      <p className="muted">{t('keysHelp')}</p>

      {issued && (
        <div className="mcp-issued" role="region" aria-label={t('issuedRegion')}>
          <Notice variant="warning">{t('issuedOnce', { name: issued.name })}</Notice>
          {/* MCPUX-10 — a named group: `aria-label` on a bare <pre> is ignored. */}
          <div role="group" aria-label={t('snippetLabel')}>
            <pre className="mcp-snippet" tabIndex={0}>{clientConfigSnippet(endpoint, issued.token)}</pre>
          </div>
          <div className="action-bar">
            <Button ref={copyConfigRef} variant="primary" size="sm" onClick={() => void copyToClipboard(clientConfigSnippet(endpoint, issued.token), t('configCopied'))}>
              <CopyIcon size={14} /> {t('copyConfig')}
            </Button>
            <Button variant="quiet" size="sm" onClick={dismissIssued}>{t('done')}</Button>
          </div>
          <p className="muted u-fs-13">{t('snippetCaveat')}</p>
        </div>
      )}

      <form className="mcp-key-form" noValidate onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="field">
          <label htmlFor={labelId}>{t('keyLabel')}</label>
          <input
            id={labelId}
            ref={labelRef}
            value={label}
            maxLength={100}
            placeholder={t('keyLabelPlaceholder')}
            aria-invalid={labelError || undefined}
            aria-describedby={labelError ? labelErrorId : undefined}
            onChange={(e) => { setLabel(e.target.value); if (labelError) setLabelError(false); }}
          />
          {labelError && <p id={labelErrorId} className="field-error" role="alert">{t('keyLabelRequired')}</p>}
        </div>
        <fieldset className="mcp-presets">
          <legend>{t('presetLegend')}</legend>
          {(['read', 'act'] as const).map((p) => {
            // MCPUX-7 — a member without edit access would get a "Read & act" key
            // that can only read; say so instead of minting a mislabelled key.
            const unavailable = p === 'act' && !canAct;
            return (
              <label key={p} className={unavailable ? 'mcp-preset mcp-preset--unavailable' : 'mcp-preset'}>
                <input type="radio" name="mcp-preset" value={p} checked={preset === p} disabled={unavailable} onChange={() => setPreset(p)} />
                <span className="mcp-preset-text">
                  {p === 'read' ? t('presetRead') : t('presetAct')}
                  <span className="muted u-fs-13 u-block">
                    {unavailable ? t('presetActUnavailable') : p === 'read' ? t('presetReadHelp') : t('presetActHelp')}
                  </span>
                  <span className="muted u-fs-12 u-block">{PRESET_SCOPES[p].map(scopeLabel).join(' · ')}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="action-bar">
          <Button type="submit" variant="primary" loading={busy}>{t('createKey')}</Button>
        </div>
      </form>

      {writeError && <Notice variant="error" announce={writeError}>{writeError}</Notice>}

      <h3 className="u-fs-14" ref={keysHeadingRef} tabIndex={-1}>{t('yourKeys')}</h3>
      {keysError ? (
        <Notice variant="error" announce={loadErrorMessage(t, keysError)}>
          {loadErrorMessage(t, keysError)}{' '}
          <Button variant="link" size="sm" onClick={reload}>{t('retry')}</Button>
        </Notice>
      ) : keys === null ? (
        <Skeleton width="60%" />
      ) : keys.length === 0 ? (
        <p className="muted u-fs-13">{t('noKeys')}</p>
      ) : (
        <ul className="mcp-key-list">
          {keys.map((k) => {
            const shown = k.name.slice(MCP_KEY_PREFIX.length);
            return (
              <li key={k.keyId} className="mcp-key">
                <div>
                  <strong>{shown}</strong>{' '}
                  <span className="chip chip--muted">{presetOf(k)}</span>{' '}
                  {k.mine === false && <span className="chip chip--accent">{t('keyNotYours')}</span>}
                  <span className="muted u-fs-12 u-block">
                    {t('createdOn', { date: fmt.date(k.createdAt) })}
                    {k.lastUsedAt ? ` · ${t('lastUsed', { date: fmt.date(k.lastUsedAt) })}` : ` · ${t('neverUsed')}`}
                  </span>
                </div>
                <Button variant="quiet" size="sm" onClick={() => void revoke(k)} aria-label={t('revokeNamed', { name: shown })}>
                  <TrashIcon size={14} /> {t('revoke')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {someoneElses && <p className="muted u-fs-12">{t('keysAdminNote')}</p>}
    </div>
  );
}

function ToolsCard({ view, onChanged }: { view: McpExposureView; onChanged: (v: McpExposureView) => void }): JSX.Element {
  const { t } = useTranslation('mcp');
  const scopeLabel = useScopeLabel();
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);

  const toggle = async (tool: McpToolEntry): Promise<void> => {
    // MCPUX-4 — guarded, not natively disabled: a disabled control drops focus.
    if (pending !== null) return;
    setPending(tool.key);
    setFailed(null);
    try {
      const { disabled } = await setMcpToolDisabled(tool.key, !tool.disabled);
      const off = new Set(disabled);
      // The SERVER's resulting set, not a local recomputation (MCPCD-3).
      onChanged({ ...view, tools: view.tools.map((x) => ({ ...x, disabled: off.has(x.key) })) });
      announce(off.has(tool.key) ? t('toolTurnedOff', { name: tool.name }) : t('toolTurnedOn', { name: tool.name }));
    } catch (err) {
      // Shown beside the switch that failed, not at the top of the card.
      setFailed({ key: tool.key, message: writeErrorMessage(t, err) });
    } finally {
      setPending(null);
    }
  };

  const help = !view.enabled ? t('toolsHelpMountOff') : view.canManage ? t('toolsHelpAdmin') : t('toolsHelp');
  return (
    <div className="surface-card">
      <h2 className="u-flex u-items-center u-gap-2"><WrenchIcon size={18} /> {t('toolsTitle')}</h2>
      <p className="muted">{help}</p>
      {view.tools.length === 0 ? (
        <StateCard icon={<WrenchIcon size={20} />} title={t('noToolsTitle')} body={t('noToolsBody')} />
      ) : (
        <ul className="mcp-tool-list">
          {view.tools.map((tool) => (
            <li key={tool.key} className={tool.disabled ? 'mcp-tool mcp-tool--off' : 'mcp-tool'}>
              <div className="mcp-tool-head">
                <code className="mcp-tool-name">{tool.name}</code>
                <span className="chip chip--muted">{tool.source === 'host' ? t('sourceHost') : t('sourceWorkspace')}</span>
                <span className={tool.safetyTier === 'write' ? 'chip chip--warning' : 'chip chip--muted'}>
                  {tool.safetyTier === 'write' ? t('tierWrite') : t('tierRead')}
                </span>
                {tool.approval === 'always' && <span className="chip chip--accent">{t('asksApproval')}</span>}
                {tool.approval === 'conditional' && <span className="chip chip--accent">{t('mayAskApproval')}</span>}
                {tool.disabled && !view.canManage && <span className="chip chip--danger">{t('turnedOff')}</span>}
                {view.canManage && (
                  <label className="mcp-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={!tool.disabled}
                      aria-disabled={pending !== null || undefined}
                      aria-busy={pending === tool.key || undefined}
                      aria-label={t('switchLabel', { name: tool.name })}
                      onChange={() => void toggle(tool)}
                    />
                    <span aria-hidden="true">{tool.disabled ? t('off') : t('on')}</span>
                  </label>
                )}
              </div>
              {tool.description && <p className="mcp-tool-desc muted">{tool.description}</p>}
              {tool.requiredScopes.length > 0 && (
                <p className="muted u-fs-12">{t('needs', { scopes: tool.requiredScopes.map(scopeLabel).join(', ') })}</p>
              )}
              {failed?.key === tool.key && <Notice variant="error" announce={failed.message}>{failed.message}</Notice>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
