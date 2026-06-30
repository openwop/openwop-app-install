/**
 * Install-workflow-pack modal — the in-app marketplace (ADR 0163 follow-on).
 *
 * Lets an operator install a workflow-chain pack from the registry
 * (packs.openwop.dev) by name + version, AT RUNTIME — reusing the same
 * Ed25519/SHA-256-SRI-verified installer the boot path uses. On success the host
 * hot-reloads its chain registry, so the pack's chains appear in the gallery with
 * no restart (the caller refetches via onInstalled).
 *
 * Operator-only on the backend (superadmin gate). A non-operator caller gets a 403
 * surfaced here as a clear "operator access required" message — not a silent fail.
 * Browsing a searchable remote catalog is a later increment (it needs a registry
 * catalog API that does not yet exist); install-by-name is the production-real
 * mechanism, identical to OPENWOP_INSTALL_PACKS at boot.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { TextField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { installChainPack } from './persistence/backendStore.js';

interface Props {
  /** packNames already installed (for context — derived from the loaded chains). */
  installedPackNames: string[];
  /** Called after a successful install so the caller can refetch the gallery. */
  onInstalled(): void;
  onClose(): void;
}

export function InstallPackModal({ installedPackNames, onInstalled, onClose }: Props): JSX.Element {
  const { t } = useTranslation('builder');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit(): Promise<void> {
    if (!name.trim() || !version.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await installChainPack(name.trim(), version.trim());
      if (res.installed) {
        toast.success(t('installPackSuccess', { name: name.trim(), count: res.newChains.length }));
      } else {
        toast.info(t('installPackAlready', { name: name.trim() }));
      }
      onInstalled();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Translate the canonical status embedded by the client into a precise reason.
      if (msg.includes('_403')) setError(t('installPackForbidden'));
      else if (msg.includes('_404')) setError(t('installPackNotFound', { name: name.trim(), version: version.trim() }));
      else if (msg.includes('_422')) setError(t('installPackUnverified'));
      else setError(t('installPackError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} label={t('installPackTitle')} loading={submitting} {...(error ? { error } : {})}>
      <h2 className="u-fs-16 u-mb-2">{t('installPackTitle')}</h2>
      <p className="muted u-mb-3">{t('installPackHint')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="u-flex u-flex-col u-gap-3">
        <TextField label={t('installPackName')} help={t('installPackNameHelp')} required
          value={name} onChange={(e) => setName(e.target.value)} placeholder="core.openwop.workflows.market-intel" />
        <TextField label={t('installPackVersion')} required
          value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        {installedPackNames.length > 0 && (
          <p className="muted u-fs-12">{t('installPackInstalled', { packs: installedPackNames.join(', ') })}</p>
        )}
        <div className="u-flex u-gap-2 u-justify-end u-mt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common:cancel')}
          </button>
          <button type="submit" className="btn-accent-solid" disabled={submitting || !name.trim() || !version.trim()}>
            {t('installPackButton')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
