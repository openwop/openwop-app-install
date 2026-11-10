/** ADR0926 partial P2: existing-org registration only; server owns authority/defaults. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import { Button } from '../../ui/Button.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { type ClientAccount } from './campaignOpsClient.js';

export function ClientRegistrationDialog({ clients, isCurrent, onClose, onSubmit }: {
  clients: ClientAccount[]; isCurrent: () => boolean; onClose: () => void;
  onSubmit: (target: { org: Organization; name: string }) => void;
}): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const { orgs: allOrgs, orgsFailed: orgReadFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs);
  // The hook owns read/failure/retry state. Its automatic first-org selection
  // is deliberately unused: registering a client requires an explicit choice.
  const current = isCurrent();
  const orgs = current ? (allOrgs?.filter(o => o.orgId !== o.tenantId && !clients.some(c => c.orgId === o.orgId)) ?? null) : null;
  const orgsFailed = current && orgReadFailed;
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const selected = orgs?.find(o => o.orgId === orgId);
  return <Modal label={t('addClient')} onClose={onClose} showClose>
    <div className="u-grid u-gap-4">
      <p>{t('registrationHelp')}</p>
      {orgsFailed ? <StateCard announce title={t('loadFailedTitle')} body={t('registrationOrgsFailed')}
        action={<Button onClick={retryOrgs}>{t('retry')}</Button>} />
      : !orgs ? <StateCard loading title={t('loading')} />
      : orgs.length === 0 ? <StateCard title={t('registrationNoOrgs')} body={t('registrationNoOrgsHelp')} />
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
          <Button onClick={onClose}>{t('common:cancel')}</Button>
        </div>
      </>}
    </div>
  </Modal>;
}
