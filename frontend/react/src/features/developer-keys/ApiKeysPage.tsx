/**
 * API keys — ADR 0800 D2, an Access Hub tab (`/access?tab=api-keys`).
 *
 * The key-management page ADR 0788 left to "row 103": create a key for the CLI,
 * a script or another service, see every key you hold, revoke one. Until this
 * page the only screen that minted a key was the "AI clients (MCP)" tab, whose
 * presets suit an MCP client and nothing else — a "Read & act" key starts a run
 * and is then refused reading it, because it does not declare `runs:read`.
 *
 * Honesty rules this page keeps: a preset names the scopes it declares, since
 * the server enforces exactly those; a key that declares nothing is labelled
 * unrestricted rather than left looking like a small one; the key is shown once,
 * as itself, with the two lines the CLI needs.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../chrome/hubContext.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StateCard } from '../../ui/StateCard.js';
import { SignInButton } from '../../auth/SignInButton.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { confirm } from '../../ui/confirm.js';
import { announce } from '../../ui/announce.js';
import { CopyIcon, KeyIcon, RotateCwIcon, TerminalIcon, TrashIcon } from '../../ui/icons/index.js';
import { classifyHttpError } from '../../client/classifyHttpError.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { useScopeWriteAccess, writeErrorMessage } from '../../lib/writeAccess.js';
import { KeyPolicyCard } from './KeyPolicyCard.js';
import { CliLoginCard } from './CliLoginCard.js';
import { useFormat } from '../../i18n/useFormat.js';
import {
  API_KEY_PRESETS,
  MCP_KEY_PREFIX,
  cliSetupSnippet,
  createDeveloperKey,
  daysUntilExpiry,
  lifetimeChoices,
  listDeveloperKeysWithPolicy,
  presetOfKey,
  publicApiBaseUrl,
  revokeDeveloperKey,
  rotateDeveloperKey,
  type ApiKeyPreset,
  type DeveloperKey,
  type KeyMintPolicy,
} from './apiKeysClient.js';

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; keys: DeveloperKey[]; policy: KeyMintPolicy };

const PRESET_ORDER: readonly ApiKeyPreset[] = ['run', 'read', 'cli'];
const PRESET_LABEL = { run: 'presetRun', read: 'presetRead', cli: 'presetCli' } as const;
const PRESET_HELP = { run: 'presetRunHelp', read: 'presetReadHelp', cli: 'presetCliHelp' } as const;
/** Days left at which a key is flagged in the list — the server's notice window. */
const EXPIRES_SOON_DAYS = 14;

export function ApiKeysPage(): JSX.Element {
  const { embedded } = useHub();
  const { t } = useTranslation('developer-keys');
  const fmt = useFormat();
  const labelId = useId();
  const labelErrorId = useId();
  const lifetimeId = useId();
  // The policy card is OFFERED to someone who manages the workspace; the server decides.
  const canManagePolicy = useScopeWriteAccess('host:members:manage');
  const labelRef = useRef<HTMLInputElement>(null);
  const copyKeyRef = useRef<HTMLButtonElement>(null);
  const keysHeadingRef = useRef<HTMLHeadingElement>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState(false);
  const [preset, setPreset] = useState<ApiKeyPreset>('run');
  // `undefined` = the deployment's default (whatever the server says it is).
  const [lifetime, setLifetime] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; name: string; keyId: string } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Newest request wins: a revoke followed quickly by a create must not let the
  // older list response land last and bring a revoked key back.
  const loadSeq = useRef(0);
  const reload = useCallback((showLoading: boolean) => {
    const seq = ++loadSeq.current;
    if (showLoading) setLoad({ status: 'loading' });
    listDeveloperKeysWithPolicy().then(
      ({ keys, policy }) => { if (seq === loadSeq.current) setLoad({ status: 'ready', keys, policy }); },
      (error: unknown) => {
        if (seq !== loadSeq.current) return;
        // A background refresh that fails must not replace the page: a key
        // issued a moment ago is on it, shown once. Keep what is rendered and
        // say the list could not be refreshed.
        setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error', error }));
        if (!showLoading) setWriteError(loadErrorMessage(t, error));
      },
    );
  }, [t]);
  useEffect(() => reload(true), [reload]);

  // The key is shown ONCE: take the keyboard to it the moment it appears.
  useEffect(() => {
    if (issued) copyKeyRef.current?.focus();
  }, [issued]);

  // Hub-tab-only surface (ADR 0144): a direct visit bounces into the hub.
  if (!embedded) return <Navigate to="/access?tab=api-keys" replace />;

  if (load.status === 'loading') {
    return (
      <section className="u-grid u-gap-4" aria-busy="true">
        <div className="surface-card" role="status" aria-label={t('loading')}>
          <Skeleton width="40%" />
          <Skeleton width="70%" />
        </div>
      </section>
    );
  }
  if (load.status === 'error') {
    if (classifyHttpError(load.error).kind === 'auth') {
      return <StateCard icon={<KeyIcon size={20} />} title={t('signedOutTitle')} body={t('signedOutBody')} action={<SignInButton />} />;
    }
    return (
      <StateCard
        icon={<KeyIcon size={20} />}
        title={t('loadFailedTitle')}
        body={loadErrorMessage(t, load.error)}
        announce
        action={<Button variant="secondary" onClick={() => reload(true)}><RotateCwIcon size={16} /> {t('retry')}</Button>}
      />
    );
  }

  const { keys } = load;
  const { policy } = load;
  const chosenLifetime = lifetime === undefined ? policy.defaultLifetimeDays : lifetime;
  const baseUrl = publicApiBaseUrl();

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
      const out = await createDeveloperKey(name, API_KEY_PRESETS[preset], chosenLifetime);
      setIssued({ token: out.token, name, keyId: out.key.keyId });
      setLabel('');
      announce(`${t('keyCreated', { name })}. ${t('issuedOnce', { name })}`, { assertive: true });
      reload(false);
    } catch (err) {
      setWriteError(writeErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const dismissIssued = (): void => {
    setIssued(null);
    labelRef.current?.focus(); // Done removes itself; return the keyboard to the form.
  };

  const revoke = async (k: DeveloperKey): Promise<void> => {
    if (!(await confirm({ title: t('revokeConfirmTitle', { name: k.name }), body: t('revokeConfirmBody'), confirmLabel: t('revoke'), danger: true }))) return;
    setWriteError(null);
    try {
      await revokeDeveloperKey(k.keyId);
      if (issued?.keyId === k.keyId) setIssued(null); // by id, never by display name
      announce(t('keyRevoked', { name: k.name }));
      reload(false);
      keysHeadingRef.current?.focus(); // the row is gone; keep the keyboard in the list
    } catch (err) {
      setWriteError(writeErrorMessage(t, err));
    }
  };

  const rotate = async (k: DeveloperKey): Promise<void> => {
    if (!(await confirm({ title: t('rotateConfirmTitle', { name: k.name }), body: t('rotateConfirmBody'), confirmLabel: t('rotate') }))) return;
    setWriteError(null);
    try {
      const out = await rotateDeveloperKey(k.keyId);
      setIssued({ token: out.token, name: k.name, keyId: out.key.keyId });
      announce(`${t('keyRotated', { name: k.name })}. ${t('issuedOnce', { name: k.name })}`, { assertive: true });
      reload(false);
    } catch (err) {
      setWriteError(writeErrorMessage(t, err));
    }
  };

  const chipOf = (k: DeveloperKey): { text: string; className: string } => {
    const kind = presetOfKey(k);
    if (kind === 'unrestricted') return { text: t('chipUnrestricted'), className: 'chip chip--warning' };
    // An AI-client key carries that tab's own scopes; "custom" would say nothing.
    // Read from the SCOPES as well as the name: the name is whatever a person
    // typed, and must not relabel a key that holds API scopes.
    if (kind === 'custom' && k.name.startsWith(MCP_KEY_PREFIX) && k.scopes.every((sc) => sc.startsWith('workspace:') || sc === 'runs:create')) {
      return { text: t('chipMcp'), className: 'chip chip--muted' };
    }
    if (kind === 'custom') return { text: t('chipCustom'), className: 'chip chip--muted' };
    return { text: t(PRESET_LABEL[kind]), className: 'chip chip--muted' };
  };
  const someoneElses = keys.some((k) => k.mine === false);
  const anyUnrestricted = keys.some((k) => presetOfKey(k) === 'unrestricted');

  return (
    <section className="u-grid u-gap-4">
      <div className="surface-card">
        <h2 className="u-flex u-items-center u-gap-2"><KeyIcon size={18} /> {t('title')}</h2>
        <p className="muted">{t('help')}</p>

        {issued && (
          <div className="mcp-issued" role="region" aria-label={t('issuedRegion')}>
            <Notice variant="warning">{t('issuedOnce', { name: issued.name })}</Notice>
            {/* A named group: `aria-label` on a bare <pre> is ignored. */}
            <div role="group" aria-label={t('tokenLabel')}>
              <pre className="mcp-snippet" tabIndex={0}>{issued.token}</pre>
            </div>
            <div className="action-bar">
              <Button ref={copyKeyRef} variant="primary" size="sm" onClick={() => void copyToClipboard(issued.token, t('keyCopied'))}>
                <CopyIcon size={14} /> {t('copyKey')}
              </Button>
            </div>
            <h3 className="u-fs-14 u-flex u-items-center u-gap-2"><TerminalIcon size={14} /> {t('cliTitle')}</h3>
            <div role="group" aria-label={t('cliLabel')}>
              <pre className="mcp-snippet" tabIndex={0}>{cliSetupSnippet(baseUrl, issued.token)}</pre>
            </div>
            <div className="action-bar">
              <Button variant="secondary" size="sm" onClick={() => void copyToClipboard(cliSetupSnippet(baseUrl, issued.token), t('cliCopied'))}>
                <CopyIcon size={14} /> {t('copyCli')}
              </Button>
              <Button variant="quiet" size="sm" onClick={dismissIssued}>{t('done')}</Button>
            </div>
            <p className="muted u-fs-13">{t('cliCaveat')}</p>
          </div>
        )}

        {policy.disabled && <Notice variant="warning">{t('disabledNotice')}</Notice>}

        <form className="mcp-key-form" hidden={policy.disabled === true} noValidate onSubmit={(e) => { e.preventDefault(); void create(); }}>
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
            {PRESET_ORDER.map((p) => (
              <label key={p} className="mcp-preset">
                <input type="radio" name="api-key-preset" value={p} checked={preset === p} onChange={() => setPreset(p)} />
                <span className="mcp-preset-text">
                  {t(PRESET_LABEL[p])}
                  <span className="muted u-fs-13 u-block">{t(PRESET_HELP[p])}</span>
                  <code className="muted u-fs-12 u-block">{API_KEY_PRESETS[p].join(' · ')}</code>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={lifetimeId}>{t('lifetimeLabel')}</label>
            <select
              id={lifetimeId}
              value={chosenLifetime === null ? 'never' : String(chosenLifetime)}
              onChange={(e) => setLifetime(e.target.value === 'never' ? null : Number(e.target.value))}
            >
              {lifetimeChoices(policy).map((d) => (
                <option key={d} value={d}>{t('lifetimeDays', { count: d })}</option>
              ))}
              {policy.allowNoExpiry && <option value="never">{t('lifetimeNever')}</option>}
            </select>
            <p className="muted u-fs-12">{t('lifetimeHelp')}</p>
          </div>
          <div className="action-bar">
            <Button type="submit" variant="primary" loading={busy}>{t('createKey')}</Button>
          </div>
        </form>

        {writeError && <Notice variant="error" announce={writeError}>{writeError}</Notice>}

        <h3 className="u-fs-14" ref={keysHeadingRef} tabIndex={-1}>{t('yourKeys')}</h3>
        {keys.length === 0 ? (
          <p className="muted u-fs-13">{t('noKeys')}</p>
        ) : (
          <ul className="mcp-key-list">
            {keys.map((k) => {
              const chip = chipOf(k);
              return (
                <li key={k.keyId} className="mcp-key">
                  <div>
                    <strong>{k.name}</strong>{' '}
                    {k.hint && <code className="muted u-fs-12">{k.hint}</code>}{' '}
                    <span className={chip.className}>{chip.text}</span>{' '}
                    {k.mine === false && <span className="chip chip--accent">{t('keyNotYours')}</span>}
                    {(() => {
                      const left = daysUntilExpiry(k);
                      return left !== null && left <= EXPIRES_SOON_DAYS
                        ? <span className="chip chip--warning">{t('expiresSoon', { count: left })}</span>
                        : null;
                    })()}
                    <span className="muted u-fs-12 u-block">
                      {t('createdOn', { date: fmt.date(k.createdAt) })}
                      {k.lastUsedAt ? ` · ${t('lastUsed', { date: fmt.date(k.lastUsedAt) })}` : ` · ${t('neverUsed')}`}
                      {k.lastUsedIp ? ` · ${t('usedFrom', { ip: k.lastUsedIp })}` : ''}
                      {k.expiresAt ? ` · ${t('expiresOn', { date: fmt.date(k.expiresAt) })}` : ` · ${t('noExpiry')}`}
                    </span>
                    {k.rotatedTo && <span className="muted u-fs-12 u-block">{t('replacedNote')}</span>}
                  </div>
                  <div className="u-flex u-gap-2">
                    {!k.rotatedTo && !policy.disabled && (
                      <Button variant="quiet" size="sm" onClick={() => void rotate(k)} aria-label={t('rotateNamed', { name: k.name })}>
                        <RotateCwIcon size={14} /> {t('rotate')}
                      </Button>
                    )}
                    <Button variant="quiet" size="sm" onClick={() => void revoke(k)} aria-label={t('revokeNamed', { name: k.name })}>
                      <TrashIcon size={14} /> {t('revoke')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {anyUnrestricted && <p className="muted u-fs-12">{t('unrestrictedNote')}</p>}
        {someoneElses && <p className="muted u-fs-12">{t('keysAdminNote')}</p>}
      </div>
      {!policy.disabled && <CliLoginCard onApproved={() => reload(false)} />}
      {canManagePolicy && <KeyPolicyCard key={`${policy.disabled === true}-${policy.maxLifetimeDays}`} policy={policy} onChanged={() => reload(false)} />}
    </section>
  );
}
