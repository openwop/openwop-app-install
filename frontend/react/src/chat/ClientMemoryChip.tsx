/**
 * ADR 0944 D2 — says which client's shared agent memory this conversation uses.
 * The binding is set once when the conversation is created (a `?client=` link),
 * so this is read-only: there is nothing to switch.
 */
import { useTranslation } from 'react-i18next';
import { BuildingIcon } from '../ui/icons/index.js';

export function ClientMemoryChip({ client }: { client: { orgId: string; name: string } }): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div className="u-flex u-items-center u-wrap u-gap-2 u-pad-2-4 u-fs-12 muted">
      <span className="chip chip--muted u-flex u-items-center u-gap-1">
        <BuildingIcon size={12} /> {t('clientMemoryChip', { name: client.name })}
      </span>
      <span>{t('clientMemoryHelp')}</span>
    </div>
  );
}
