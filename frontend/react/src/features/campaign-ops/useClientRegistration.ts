/** Parent-owned registration lifecycle survives dismissal; identity remains the inbox's. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Organization } from '../../client/accessClient.js';
import { CampaignOpsError, createClient, listClients, type ClientAccount } from './campaignOpsClient.js';
type Target = { org: Organization; name: string };
type Operation = Target & { phase: 'pending' | 'uncertain'; checking: boolean; error: string };
export function useClientRegistration({ isCurrent, onStart, onRegistered, onAuthorityLost }: {
  isCurrent: () => boolean; onStart: () => void;
  onRegistered: (client: ClientAccount, created: boolean) => void; onAuthorityLost: () => void;
}) {
  const { t } = useTranslation('campaign-ops');
  const owner = useRef<Target | null>(null);
  const checking = useRef(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const reset = useCallback(() => { owner.current = null; checking.current = false; setOperation(null); setError(''); }, []);
  useEffect(() => { const ownership = owner; return () => { ownership.current = null; }; }, []);
  const submit = (target: Target): void => {
    if (!isCurrent() || owner.current || !target.org.orgId || !target.name.trim()) return;
    owner.current = target; setError(''); setOperation({ ...target, phase: 'pending', checking: false, error: '' }); onStart();
    const current = (): boolean => owner.current === target && isCurrent();
    void createClient({ orgId: target.org.orgId, name: target.name.trim() }).then(client => {
      if (!current()) return;
      if (client.orgId !== target.org.orgId || client.tenantId !== target.org.tenantId) throw new Error(t('registrationUncertain'));
      reset(); onRegistered(client, true);
    }).catch((e: unknown) => {
      if (!current()) return;
      if (e instanceof CampaignOpsError && (e.status === 400 || e.status === 403)) {
        reset(); setError(e.message || t('registrationDenied'));
        if (e.status === 403) onAuthorityLost();
      } else setOperation({ ...target, phase: 'uncertain', checking: false, error: t('registrationUncertain') });
    });
  };
  const recheck = (): void => {
    const target = owner.current;
    if (!target || !isCurrent() || checking.current || operation?.phase !== 'uncertain') return;
    checking.current = true; setOperation(cur => cur ? { ...cur, checking: true, error: '' } : cur);
    const current = (): boolean => owner.current === target && isCurrent();
    void listClients().then(out => {
      if (!current()) return;
      if (!out.agencyAdmin) { reset(); setError(t('registrationDenied')); onAuthorityLost(); return; }
      const client = out.clients.find(c => c.orgId === target.org.orgId && c.tenantId === target.org.tenantId);
      reset();
      if (client) onRegistered(client, false);
      else setError(t('registrationNotFound'));
    }).catch(() => {
      if (current()) setOperation({ ...target, phase: 'uncertain', checking: false, error: t('registrationCheckFailed') });
    }).finally(() => {
      if (current()) { checking.current = false; setOperation(cur => cur ? { ...cur, checking: false } : cur); }
    });
  };
  return { operation, error, reset, submit, recheck, isOwned: () => owner.current !== null };
}
