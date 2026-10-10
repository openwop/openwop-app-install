/**
 * ADR 0826 D5 — the revoke dialog: the operator's kill switch for one pack.
 *
 * Not `ui/confirm`: a revocation needs a REASON (the next operator reads it) and a
 * scope choice (this version vs every version, the compromised-publisher case), and
 * it must state its blast radius BEFORE the click — the features that pin the pack
 * stop working (/architect A6). Danger-styled; the affirmative button arms only
 * once a reason is typed.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/index.js';
import { Notice } from '../../ui/Notice.js';
import { TextareaField } from '../../ui/Field.js';
import type { Listing } from './marketplaceClient.js';

export function RevokePackDialog({ listing, busy, onConfirm, onClose }: {
  listing: Listing;
  busy: boolean;
  onConfirm: (version: string, reason: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  const [scope, setScope] = useState<'this' | 'all'>('this');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const pinnedBy = listing.requiredBy ?? [];
  return (
    <Modal onClose={onClose} label={t('revokeTitle', { pack: listing.packName })} showClose>
      <p>{t('revokeBody')}</p>
      {pinnedBy.length > 0 ? (
        <Notice variant="warning">{t('revokeBlastRadius', { features: pinnedBy.join(', ') })}</Notice>
      ) : null}
      <fieldset className="field">
        <legend className="field-label">{t('revokeScope')}</legend>
        <label className="u-iflex u-gap-2 u-items-center">
          <input type="radio" name="revoke-scope" checked={scope === 'this'} onChange={() => setScope('this')} />
          <span>{t('revokeScopeThis', { version: listing.version })}</span>
        </label>
        <label className="u-iflex u-gap-2 u-items-center">
          <input type="radio" name="revoke-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>{t('revokeScopeAll')}</span>
        </label>
      </fieldset>
      <TextareaField
        label={t('revokeReason')}
        help={t('revokeReasonHelp')}
        required
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="action-bar">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('revokeCancel')}</Button>
        <Button
          variant="danger"
          disabled={busy || trimmed.length === 0}
          onClick={() => onConfirm(scope === 'all' ? '*' : listing.version, trimmed)}
        >
          {t('revokeConfirm')}
        </Button>
      </div>
    </Modal>
  );
}
