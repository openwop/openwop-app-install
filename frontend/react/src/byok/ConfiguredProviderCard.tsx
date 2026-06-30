/**
 * Compact "active config" card — shown in the chat header + as the
 * collapsed BYOK state. Borrowed from MyndHyve's ConfiguredProviderCard
 * pattern: provider badge + name + masked key + delete/refresh icons.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { getProvider } from './lib/providers.js';
import type { BYOKActiveConfig } from './lib/useBYOKConfig.js';
import { deleteKey } from './lib/byokClient.js';

interface Props {
  config: BYOKActiveConfig;
  onChange: () => void;
  onRemoved: () => void | Promise<void>;
  compact?: boolean;
}

export function ConfiguredProviderCard({ config, onChange, onRemoved, compact }: Props): JSX.Element {
  const { t } = useTranslation('byok');
  const provider = getProvider(config.provider);
  const model = provider.models.find((m) => m.id === config.model);
  const [removing, setRemoving] = useState(false);
  const isManaged = provider.managed === true;

  async function onDelete(): Promise<void> {
    // Managed providers don't have a user-owned key to delete — the
    // "remove" action just clears the active config (server-held key
    // stays put).
    if (!isManaged && !(await confirm({ title: t('deleteKeyConfirm', { provider: provider.label }), danger: true, confirmLabel: t('common:delete') }))) return;
    setRemoving(true);
    try {
      if (!isManaged) {
        await deleteKey(config.credentialRef);
      }
      await onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  const badge = (
    <span className="configprov-badge" style={{
      width: compact ? 20 : 32, height: compact ? 20 : 32, borderRadius: compact ? 4 : 6,
      fontSize: compact ? 11 : 14,
    }} aria-hidden>
      {provider.label.charAt(0)}
    </span>
  );

  if (compact) {
    return (
      <span className="configprov-compact">
        {badge}
        <span>
          <strong>{provider.label}</strong>
          {!isManaged && model && <> · {model.label ?? config.model}</>}
        </span>
        <button
          type="button"
          className="secondary u-pad-0x6 u-fs-10 u-minh-0"
          onClick={onChange}
          aria-label={t('changeProviderModel')}
        >{t('changeAction')}</button>
      </span>
    );
  }

  return (
    <div className="card u-flex u-items-center u-gap-3">
      {badge}
      <div className="u-flex-1 u-minw-0">
        <div className="u-fw-600 u-fs-13">{provider.label}</div>
        <div className="muted u-fs-11">
          {isManaged
            ? t('serverManagedLimit')
            : <>{t('modelKeyLabel', { model: model?.label ?? config.model })} <code>{config.credentialRef}</code></>}
        </div>
      </div>
      <div className="button-row u-m-0">
        <button type="button" className="secondary" onClick={onChange} aria-label={t('change')}>{t('change')}</button>
        <button type="button" className="secondary" disabled={removing} onClick={onDelete} aria-label={isManaged ? t('disconnect') : t('deleteKeyLabel')}>
          {removing ? '…' : (isManaged ? t('disconnectAction') : t('deleteAction'))}
        </button>
      </div>
    </div>
  );
}
