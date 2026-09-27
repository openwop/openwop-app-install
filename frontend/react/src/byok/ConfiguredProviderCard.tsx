/**
 * Compact "active config" card — shown in the chat header + as the
 * collapsed BYOK state. Borrowed from MyndHyve's ConfiguredProviderCard
 * pattern: provider badge + name + masked key + delete/refresh icons.
 */

import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { getProvider } from './lib/providers.js';
import type { BYOKActiveConfig } from './lib/useBYOKConfig.js';
import { clearActiveConfig, deleteKey } from './lib/byokClient.js';

interface Props {
  config: BYOKActiveConfig;
  onChange: () => void;
  onRemoved: () => void | Promise<void>;
  compact?: boolean;
  /** ADR 0711 OQ1 — false when this is the effective managed DEFAULT, not a choice.
   *  Presenting a fallback with no signal reads as "somebody picked this".
   *
   *  REQUIRED, deliberately. It shipped optional-with-a-default and `tabDeck/TabSession`
   *  — the multi-tab render of this same card — simply never passed it, so behind the
   *  `multi-tab-chat` toggle the fallback was presented as a choice again: exactly the
   *  laundering this flag exists to prevent, surviving in the one place nobody looked.
   *  A required prop makes a new render site ANSWER the question instead of inheriting
   *  the comfortable answer. */
  stored: boolean;
}

export function ConfiguredProviderCard({ config, onChange, onRemoved, compact, stored }: Props): JSX.Element {
  const { t } = useTranslation('byok');
  const provider = getProvider(config.provider);
  const model = provider.models.find((m) => m.id === config.model);
  const [removing, setRemoving] = useState(false);
  const isManaged = provider.managed === true;
  // ADR 0757 follow-up — a subscription binding is removed by UNBINDING only: the
  // Copilot connection itself is the user's to Disconnect on the keys page.
  const isSubscription = provider.subscription === true;

  async function onDelete(): Promise<void> {
    // Managed providers don't have a user-owned key to delete — the
    // "remove" action just clears the active config (server-held key
    // stays put).
    if (!isManaged && !isSubscription && !(await confirm({ title: t('deleteKeyConfirm', { provider: provider.label }), danger: true, confirmLabel: t('common:delete') }))) return;
    setRemoving(true);
    try {
      if (isSubscription) {
        await clearActiveConfig();
      } else if (!isManaged) {
        // UNBIND, then delete (ADR 0517 + ADR 0499). The active chat binding is a
        // registered credentialRef consumer, so `deleteKey` on a bound ref now
        // 409s — correctly, since that guard is what stops a key being pulled out
        // from under a live surface. Deleting with `?force=true` instead would
        // bypass EVERY consumer, including a realtime-voice binding on the same
        // key, which is the orphaning ADR 0499 exists to prevent. So the honest
        // order is: stop using it, then remove it.
        await clearActiveConfig();
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
        {/* ADR 0711 OQ1 — its OWN slot, NOT inside the span above. That span carries
            `max-width: 22ch; text-overflow: ellipsis` (added to stop a model name
            wrapping to five lines), so a marker placed inside it shared the budget and
            the parenthetical — the load-bearing half, the part saying nobody chose this —
            was the first thing truncated, worst in es. `title` also gives hover recovery
            the clamped version could not. */}
        {!stored && (
          <span className="configprov-default u-fs-10 u-text-muted" title={t('chat:byokManagedDefaultHint')}>
            {t('chat:byokManagedDefault')}
          </span>
        )}
        <Button
          variant="secondary" className="u-pad-0x6 u-fs-10 u-minh-0"
          onClick={onChange}
          aria-label={t('changeProviderModel')}
        >{t('changeAction')}</Button>
      </span>
    );
  }

  return (
    <div className="card u-flex u-items-center u-gap-3">
      {badge}
      <div className="u-flex-1 u-minw-0">
        <h3 className="u-fw-600 u-fs-13 u-m-0">{provider.label}</h3>
        <div className="muted u-fs-11">
          {isManaged
            ? t('serverManagedLimit')
            : isSubscription
              ? t('subscriptionModelLabel', { model: model?.label ?? config.model })
              : <>{t('modelKeyLabel', { model: model?.label ?? config.model })} <code>{config.credentialRef}</code></>}
        </div>
      </div>
      <div className="button-row u-m-0">
        <Button variant="secondary" onClick={onChange} aria-label={t('change')}>{t('change')}</Button>
        <Button variant="secondary" disabled={removing} onClick={onDelete} aria-label={isManaged ? t('disconnect') : isSubscription ? t('stopUsingLabel', { provider: provider.label }) : t('deleteKeyLabel')}>
          {removing ? '…' : (isManaged ? t('disconnectAction') : isSubscription ? t('stopUsingAction') : t('deleteAction'))}
        </Button>
      </div>
    </div>
  );
}
