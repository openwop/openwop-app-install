/**
 * Add a client, in one of two modes (ADR 0926 P2; the house-client ADR D3):
 *  - **New client** (the default): a name only. The server creates a new
 *    organization for the client, so nobody has to detour through Access.
 *  - **Existing organization**: today's chooser. The workspace root and orgs that
 *    are already clients are never offered.
 * The server owns authority and defaults in both.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import { Button } from '../../ui/Button.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { type ClientAccount } from './campaignOpsClient.js';
import type { RegistrationTarget } from './useClientRegistration.js';

export type RegistrationMode = 'new' | 'existing';

export function ClientRegistrationDialog({ clients, isCurrent, onClose, onSubmit }: {
  clients: ClientAccount[]; isCurrent: () => boolean; onClose: () => void;
  onSubmit: (target: RegistrationTarget) => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const { orgs: allOrgs, orgsFailed: orgReadFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs);
  // The hook owns read/failure/retry state. Its automatic first-org selection
  // is deliberately unused: registering a client requires an explicit choice.
  const current = isCurrent();
  const orgs = current ? (allOrgs?.filter(o => o.orgId !== o.tenantId && !clients.some(c => c.orgId === o.orgId)) ?? null) : null;
  const orgsFailed = current && orgReadFailed;
  const [mode, setMode] = useState<RegistrationMode>('new');
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const selected = orgs?.find(o => o.orgId === orgId);
  const cancel = <Button onClick={onClose}>{t('common:cancel')}</Button>;
  return <Modal label={t('addClient')} onClose={onClose} showClose>
    <div className="u-grid u-gap-4">
      <div className="segmented" role="group" aria-label={t('registrationModeLabel')}>
        <Button variant="primary" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>{t('registrationModeNew')}</Button>
        <Button variant="primary" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>{t('registrationModeExisting')}</Button>
      </div>
      {mode === 'new' ? <>
        <p>{t('registrationNewHelp')}</p>
        {!current ? <StateCard loading title={t('loading')} /> : <>
          <TextField label={t('registrationName')} value={newName} maxLength={120} onChange={e => setNewName(e.target.value)} />
          <div className="action-bar">
            <Button variant="primary" disabled={!newName.trim()} onClick={() => { if (isCurrent()) onSubmit({ name: newName }); }}>{t('addClient')}</Button>
            {cancel}
          </div>
        </>}
      </> : <>
        <p>{t('registrationHelp')}</p>
        {orgsFailed ? <StateCard announce title={t('loadFailedTitle')} body={t('registrationOrgsFailed')}
          action={<Button onClick={retryOrgs}>{t('retry')}</Button>} />
        : !orgs ? <StateCard loading title={t('loading')} />
        : orgs.length === 0 ? <StateCard title={t('registrationNoOrgs')} body={t('registrationNoOrgsHelp')}
          action={<Button onClick={() => setMode('new')}>{t('registrationModeNew')}</Button>} />
        : <>
          <SelectField label={t('registrationOrg')} value={orgId} onChange={e => {
            setOrgId(e.target.value); setName(orgs.find(o => o.orgId === e.target.value)?.name ?? '');
          }}>
            <option value="">{t('registrationChooseOrg')}</option>
            {orgs.map(o => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
          <TextField label={t('registrationName')} value={name} maxLength={120} onChange={e => setName(e.target.value)} />
          <div className="action-bar">
            <Button variant="primary" disabled={!selected || !name.trim()} onClick={() => { if (isCurrent() && selected) onSubmit({ org: selected, name }); }}>{t('addClient')}</Button>
            {cancel}
          </div>
        </>}
      </>}
    </div>
  </Modal>;
}
