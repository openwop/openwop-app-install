/**
 * Two-way GitHub sync modal (ADR 0393 Lane A). Shows the canvas's repo binding
 * (owner/repo/branch/target), lets an admin bind or unbind — the bind response
 * carries the webhook HMAC secret exactly ONCE, surfaced here with the webhook
 * URL so the admin can finish the GitHub-side wiring — and offers "Sync now"
 * (one atomic [openwop-sync] commit; `noop` and `ref_conflict` outcomes are
 * reported honestly). A non-admin sees the binding read-only; the backend's
 * `host:code-sync:manage` 403 is the real gate and surfaces in-modal.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice, StateCard } from '../../ui/index.js';
import { toast } from '../../ui/toast.js';
import { config } from '../../client/config.js';
import {
  bindSyncRepo, getSyncBinding, syncCanvasNow, unbindSyncRepo,
  EXPORT_TARGETS, type ExportTarget, type SyncBindingView,
} from './canvasEditorClient.js';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export function SyncModal({ orgId, canvasId, onClose }: {
  orgId: string;
  canvasId: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('app-builder');
  const [loading, setLoading] = useState(true);
  const [binding, setBinding] = useState<SyncBindingView | null>(null);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [target, setTarget] = useState<ExportTarget>('react-tailwind');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AB-G4 — a push that SUCCEEDED with warnings is not an error. The sibling
  // PublishModal already keeps the two apart; this one flattened both into the
  // error Notice, so "pushed, but 2 components had no target equivalent" read
  // as "the sync failed".
  const [warnings, setWarnings] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  // AB-G1 — `getSyncBinding` returns null for NOT BOUND and throws when the read
  // fails, so `binding === null` alone cannot tell the two apart. It has to,
  // because the not-bound branch renders the bind form and binding again mints a
  // NEW webhook secret — silently breaking the webhook of the binding we simply
  // failed to read.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getSyncBinding(orgId, canvasId)
      .then((b) => { if (alive) { setBinding(b); setLoadFailed(false); setLoading(false); } })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoadFailed(true);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [orgId, canvasId, reloadNonce]);

  const valid = OWNER_RE.test(owner) && REPO_RE.test(repo) && BRANCH_RE.test(branch) && !branch.includes('..');

  const onBind = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true); setError(null); setWarnings([]);
    try {
      const res = await bindSyncRepo(orgId, canvasId, { owner, repo, branch, target });
      setBinding(res.binding);
      setSecret(res.webhookSecret);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('syncBindFailed'));
    } finally { setBusy(false); }
  };

  const onUnbind = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await unbindSyncRepo(orgId, canvasId);
      setBinding(null); setSecret(null);
      toast.success(t('syncUnbound'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('syncUnbindFailed'));
    } finally { setBusy(false); }
  };

  const onSyncNow = async (): Promise<void> => {
    setBusy(true); setError(null); setWarnings([]);
    try {
      const res = await syncCanvasNow(orgId, canvasId);
      if (res.outcome === 'pushed') toast.success(t('syncPushed', { url: res.repoUrl, branch: res.branch }));
      else if (res.outcome === 'noop') toast.info(t('syncNoop'));
      else toast.warning(t('syncRefConflict'));
      if (res.warnings.length) setWarnings(res.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('syncFailed'));
    } finally { setBusy(false); }
  };

  const webhookUrl = binding
    ? `${config.baseUrl}/host/openwop-app/app-builder-sync/webhook/${binding.webhookId}`
    : '';

  return (
    <Modal onClose={onClose} label={t('syncTitle')} showClose>
      <h2 className="cv-editor__panel-title">{t('syncTitle')}</h2>
      <p className="cv-editor__empty">{t('syncHint')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {warnings.length ? <Notice variant="warning">{warnings.join(' ')}</Notice> : null}
      {loading ? <StateCard loading title={t('syncLoading')} /> : null}

      {/* AB-G1 — a failed read offers a RETRY, never the bind form. Rebinding
          here would rotate the webhook secret of a binding that may well exist,
          and the GitHub side would keep signing with the old one. */}
      {!loading && loadFailed ? (
        <StateCard announce
          title={t('syncLoadFailedTitle')}
          body={t('syncLoadFailedBody')}
          action={<Button variant="secondary" size="sm" onClick={() => { setError(null); setReloadNonce((n) => n + 1); }}>{t('syncRetry')}</Button>}
        />
      ) : null}

      {!loading && !loadFailed && binding ? (
        <>
          <dl className="cv-editor__prop-form">
            <div className="cv-editor__field"><dt className="cv-editor__field-label">{t('syncRepo')}</dt><dd>{binding.owner}/{binding.repo}</dd></div>
            <div className="cv-editor__field"><dt className="cv-editor__field-label">{t('syncBranch')}</dt><dd>{binding.branch}</dd></div>
            <div className="cv-editor__field"><dt className="cv-editor__field-label">{t('exportTarget')}</dt><dd>{t(`target_${binding.target}`)}</dd></div>
          </dl>
          {secret ? (
            <Notice variant="warning">
              {t('syncSecretOnce')} <code>{secret}</code>{' '}
              <Button
                variant="secondary" size="sm"
                onClick={() => {
                  // GRADE-UX 2026-07-17 — a denied clipboard permission must
                  // not silently drop the ONE chance to copy the secret.
                  void navigator.clipboard.writeText(secret)
                    .then(() => toast.success(t('syncSecretCopied')))
                    .catch(() => toast.error(t('syncSecretCopyFailed')));
                }}
              >
                {t('syncCopySecret')}
              </Button>{' '}
              {t('syncWebhookHint', { url: webhookUrl })}
            </Notice>
          ) : null}
          <span className="action-bar">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void onSyncNow()}>{busy ? t('syncing') : t('syncNow')}</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onUnbind()}>{t('syncUnbind')}</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>{t('publishClose')}</Button>
          </span>
        </>
      ) : null}

      {!loading && !loadFailed && !binding ? (
        <form className="cv-editor__prop-form" onSubmit={(e) => { e.preventDefault(); void onBind(); }}>
          {/* Field errors: associated + announced (the PublishModal grade-pass F6 pattern). */}
          <div className="cv-editor__field">
            <label htmlFor="sync-owner" className="cv-editor__field-label">{t('syncOwnerLabel')}</label>
            <input id="sync-owner" type="text" className="cv-editor__input" value={owner} aria-invalid={owner.length > 0 && !OWNER_RE.test(owner)} aria-describedby="sync-owner-err" onChange={(e) => setOwner(e.target.value)} />
            <span id="sync-owner-err" role="alert" className="cv-editor__field-error">{owner && !OWNER_RE.test(owner) ? t('syncOwnerInvalid') : ''}</span>
          </div>
          <div className="cv-editor__field">
            <label htmlFor="sync-repo" className="cv-editor__field-label">{t('publishRepoLabel')}</label>
            <input id="sync-repo" type="text" className="cv-editor__input" value={repo} aria-invalid={repo.length > 0 && !REPO_RE.test(repo)} aria-describedby="sync-repo-err" onChange={(e) => setRepo(e.target.value)} />
            <span id="sync-repo-err" role="alert" className="cv-editor__field-error">{repo && !REPO_RE.test(repo) ? t('publishRepoInvalid') : ''}</span>
          </div>
          <div className="cv-editor__field">
            <label htmlFor="sync-branch" className="cv-editor__field-label">{t('syncBranchLabel')}</label>
            <input id="sync-branch" type="text" className="cv-editor__input" value={branch} aria-invalid={branch.length > 0 && !(BRANCH_RE.test(branch) && !branch.includes('..'))} aria-describedby="sync-branch-err" onChange={(e) => setBranch(e.target.value)} />
            <span id="sync-branch-err" role="alert" className="cv-editor__field-error">{branch && !(BRANCH_RE.test(branch) && !branch.includes('..')) ? t('syncBranchInvalid') : ''}</span>
          </div>
          <div className="cv-editor__field">
            <label htmlFor="sync-target" className="cv-editor__field-label">{t('exportTarget')}</label>
            <select id="sync-target" className="cv-editor__input" value={target} onChange={(e) => setTarget(e.target.value as ExportTarget)}>
              {EXPORT_TARGETS.map((tg) => <option key={tg} value={tg}>{t(`target_${tg}`)}</option>)}
            </select>
          </div>
          <p className="cv-editor__empty">{t('syncBindAdminHint')}</p>
          <span className="action-bar">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !valid}>{busy ? t('syncBinding') : t('syncBind')}</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>{t('publishClose')}</Button>
          </span>
        </form>
      ) : null}
    </Modal>
  );
}
