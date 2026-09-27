/**
 * Secrets-vault admin panel (ADR 0389 P2) — the superadmin PROJECTION over the
 * existing credential owners (raw BYOK secrets, connections, host OAuth
 * clients, developer keys). Composed into the ConnectionsPage credentials hub
 * beside `OAuthClientAdminPanel`, with the same backend-authority gate: a 403
 * on load hides the panel entirely.
 *
 * Posture mirrors the backend invariants: the list is masked (refs only);
 * reveal is one-time, offered only for raw refs, and surfaces the step-up
 * demand (fresh re-authentication) as guidance rather than a dead error;
 * delete surfaces live references and requires an explicit forced retry.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import {
  getVaultInventory,
  vaultAddSecret,
  vaultRevealSecret,
  vaultRotateSecret,
  vaultDeleteSecret,
  ForbiddenError,
  StepUpRequiredError,
  VaultReferencesError,
  type VaultInventory,
  type VaultSecretEntry,
} from './connectionsClient.js';

type Scope = 'tenant' | 'host';

export function VaultAdminPanel(): JSX.Element | null {
  const { t } = useTranslation('connections');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inv, setInv] = useState<VaultInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One revealed value at a time, keyed by ref — cleared on any list refresh.
  const [revealed, setRevealed] = useState<{ ref: string; value: string } | null>(null);
  // Auto-clear the revealed value (grade-ux UXG-3): the server shows it once;
  // the page should not park it on screen (screenshares) indefinitely either.
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  const [addRef, setAddRef] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addScope, setAddScope] = useState<Scope>('tenant');
  const [rotating, setRotating] = useState<{ ref: string; scope: Scope; value: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    setRevealed(null);
    void getVaultInventory()
      .then(setInv)
      .catch((err) => {
        if (err instanceof ForbiddenError) { setHidden(true); return; }
        setError(err instanceof Error ? err.message : t('vaultLoadFailed'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async () => {
    if (!addRef.trim() || !addValue.trim()) return;
    setBusy('add');
    try {
      await vaultAddSecret(addRef.trim(), addValue, addScope);
      toast.success(t('vaultSecretAdded'));
      setAddRef(''); setAddValue('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('vaultActionFailed'));
    } finally { setBusy(null); }
  }, [addRef, addValue, addScope, load, t]);

  const reveal = useCallback(async (entry: VaultSecretEntry, scope: Scope) => {
    setBusy(entry.credentialRef);
    setError(null);
    try {
      const value = await vaultRevealSecret(entry.credentialRef, scope);
      setRevealed({ ref: entry.credentialRef, value });
    } catch (err) {
      if (err instanceof StepUpRequiredError) setError(t('vaultStepUpRequired'));
      else setError(err instanceof Error ? err.message : t('vaultActionFailed'));
    } finally { setBusy(null); }
  }, [t]);

  const rotate = useCallback(async () => {
    if (!rotating || !rotating.value.trim()) return;
    setBusy(rotating.ref);
    try {
      await vaultRotateSecret(rotating.ref, rotating.value, rotating.scope);
      toast.success(t('vaultSecretRotated'));
      setRotating(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('vaultActionFailed'));
    } finally { setBusy(null); }
  }, [rotating, load, t]);

  const remove = useCallback(async (entry: VaultSecretEntry, scope: Scope) => {
    if (!(await confirm({ title: t('vaultDeleteConfirm', { ref: entry.credentialRef }), danger: true, confirmLabel: t('common:remove') }))) return;
    setBusy(entry.credentialRef);
    try {
      await vaultDeleteSecret(entry.credentialRef, scope);
      toast.success(t('vaultSecretDeleted'));
      load();
    } catch (err) {
      if (err instanceof VaultReferencesError) {
        const forced = await confirm({
          title: t('vaultDeleteReferencedTitle'),
          body: t('vaultDeleteReferencedBody', { refs: err.references.join(', ') }),
          danger: true,
          confirmLabel: t('vaultDeleteAnyway'),
        });
        if (forced) {
          try {
            await vaultDeleteSecret(entry.credentialRef, scope, true);
            toast.success(t('vaultSecretDeleted'));
            load();
          } catch (e2) {
            toast.error(e2 instanceof Error ? e2.message : t('vaultActionFailed'));
          }
        }
      } else {
        toast.error(err instanceof Error ? err.message : t('vaultActionFailed'));
      }
    } finally { setBusy(null); }
  }, [load, t]);

  // Non-superadmin: render nothing (backend is the authority).
  if (hidden) return null;
  // GRADE-UX (UX-3, the GOV-3 precedent): a loading placeholder instead of
  // blank→pop-in, and a REACHABLE error state for a superadmin whose load
  // failed (previously the error notice sat below an early `!inv` bail).
  if (loading) {
    return (
      <div className="surface-card u-p-4 u-grid u-gap-3" role="status" aria-label={t('vaultTitle')}>
        <Skeleton width="40%" />
        <Skeleton width="80%" />
      </div>
    );
  }
  if (!inv) {
    return error ? (
      <div className="surface-card u-p-4"><Notice variant="error">{error}</Notice></div>
    ) : null;
  }

  const copyRevealed = async (): Promise<void> => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.value);
      toast.success(t('vaultValueCopied'));
    } catch {
      setError(t('vaultCopyFailed'));
    }
  };

  const renderRows = (entries: VaultSecretEntry[], scope: Scope): JSX.Element[] =>
    entries.map((s) => (
      <li key={`${scope}:${s.credentialRef}`} className="u-grid u-gap-2">
        <div className="action-bar">
          <code>{s.credentialRef}</code>
          <span className="chip chip--muted">{s.kind === 'connection-token' ? t('vaultKindConnection') : t('vaultKindRaw')}</span>
          <span className="muted">••••••••</span>
          {s.revealable ? (
            <Button variant="quiet" disabled={busy !== null}
              aria-label={`${t('vaultReveal')} — ${s.credentialRef}`}
              onClick={() => void reveal(s, scope)}>
              {t('vaultReveal')}
            </Button>
          ) : null}
          {s.kind === 'raw' ? (
            <>
              <Button variant="quiet" disabled={busy !== null}
                aria-label={`${t('vaultRotate')} — ${s.credentialRef}`}
                onClick={() => setRotating({ ref: s.credentialRef, scope, value: '' })}>
                {t('vaultRotate')}
              </Button>
              <Button variant="quiet" disabled={busy !== null}
                aria-label={`${t('common:remove')} — ${s.credentialRef}`}
                onClick={() => void remove(s, scope)}>
                {t('common:remove')}
              </Button>
            </>
          ) : null}
        </div>
        {revealed?.ref === s.credentialRef ? (
          // GRADE-UX (UX-2): the one-time reveal deserves the BEST copy
          // affordance — a wrapping block row + explicit Copy + dismiss, not a
          // nowrap chip the user must text-select inside.
          <div className="action-bar">
            <code className="u-break-all">{revealed.value}</code>
            <Button variant="quiet" onClick={() => void copyRevealed()}>
              {t('vaultCopyValue')}
            </Button>
            <Button variant="quiet" aria-label={t('vaultDismissReveal')} onClick={() => setRevealed(null)}>
              {t('vaultDismissReveal')}
            </Button>
          </div>
        ) : null}
        {rotating?.ref === s.credentialRef ? (
          <div className="action-bar">
            <TextField label={t('vaultNewValue')} type="password" value={rotating.value}
              onChange={(e) => setRotating({ ...rotating, value: e.target.value })} />
            <Button variant="primary" disabled={busy !== null || !rotating.value.trim()} onClick={() => void rotate()}>
              {t('vaultRotateConfirm')}
            </Button>
            <Button variant="quiet" onClick={() => setRotating(null)}>{t('common:cancel')}</Button>
          </div>
        ) : null}
      </li>
    ));

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-grid u-gap-1">
        <span className="u-label-sm"><ShieldIcon /> {t('vaultTitle')}</span>
        <p className="muted">{t('vaultBlurb')}</p>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}
      {revealed ? <Notice variant="warning">{t('vaultRevealOnceNote')}</Notice> : null}

      {inv.tenantSecrets.length > 0 ? (
        <div className="u-grid u-gap-2">
          <span className="u-label-sm">{t('vaultTenantSecrets')}</span>
          <ul className="u-grid u-gap-2" aria-label={t('vaultTenantSecrets')}>{renderRows(inv.tenantSecrets, 'tenant')}</ul>
        </div>
      ) : null}
      {inv.hostSecrets.length > 0 ? (
        <div className="u-grid u-gap-2">
          <span className="u-label-sm">{t('vaultHostSecrets')}</span>
          <ul className="u-grid u-gap-2" aria-label={t('vaultHostSecrets')}>{renderRows(inv.hostSecrets, 'host')}</ul>
        </div>
      ) : null}

      <form className="action-bar" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <TextField label={t('vaultAddRefLabel')} value={addRef} onChange={(e) => setAddRef(e.target.value)}
          placeholder="my-provider-key" />
        <TextField label={t('vaultAddValueLabel')} type="password" value={addValue}
          onChange={(e) => setAddValue(e.target.value)} />
        <SelectField label={t('vaultScopeLabel')} value={addScope}
          onChange={(e) => setAddScope(e.target.value === 'host' ? 'host' : 'tenant')}>
          <option value="tenant">{t('vaultScopeTenant')}</option>
          <option value="host">{t('vaultScopeHost')}</option>
        </SelectField>
        <Button variant="primary" type="submit" disabled={busy !== null || !addRef.trim() || !addValue.trim()} aria-busy={busy === 'add' || undefined}>
          {t('vaultAdd')}
        </Button>
      </form>
    </div>
  );
}
