/**
 * UCP admin page (ADR 0178 Phase 4) — configure the Universal Commerce Protocol surface
 * for a merchant org: the public discovery/OAuth/catalog endpoints an agent operator
 * points at, and the UCP agent CLIENTS (client-credentials) the merchant provisions.
 * Gated on useFeatureAccess('commerce-ucp'). Standalone panel (the commerce admin has no
 * FE yet — ADR 0177 backend-only); composes into it when that lands.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Field } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { BotIcon, ClipboardIcon, TrashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  listOrgs, listUcpClients, provisionUcpClient, deleteUcpClient, ucpPublicEndpoints,
  UCP_SCOPES, type Org, type UcpClient, type UcpScope, type ProvisionedClient,
} from './commerceUcpClient.js';

export function CommerceUcpPage(): JSX.Element {
  const { t } = useTranslation('commerce-ucp');
  const ucp = useFeatureAccess('commerce-ucp');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [orgsError, setOrgsError] = useState<string | null>(null);

  const loadOrgs = useCallback(() => {
    // A failed read used to land in `setOrgs([])`, which rendered "No merchants
    // yet — Create an organization to expose a UCP storefront." An unreachable
    // server telling the operator to create something that may already exist.
    void listOrgs()
      .then((o) => { setOrgs(o); setOrgsError(null); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setOrgsError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!ucp.enabled) return;
    loadOrgs();
  }, [ucp.enabled, loadOrgs]);

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : null;

  if (ucp.loading) {
    return <div className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><Skeleton /></div>;
  }
  if (!ucp.enabled) {
    return <section className="u-grid u-gap-4" data-walkthrough="commerce-ucp.page"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="commerce-ucp.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {orgsError ? (
        <StateCard
          announce
          title={t('orgsFailedTitle')}
          body={`${t('orgsFailedBody')} ${orgsError}`}
          action={<Button variant="primary" onClick={loadOrgs}>{t('retry')}</Button>}
        />
      ) : !orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <EndpointsCard orgId={orgId} />
          <ClientsCard orgId={orgId} />
        </>
      )}
    </section>
  );
}

function CopyRow({ label, value }: { label: string; value: string }): JSX.Element {
  const { t } = useTranslation('commerce-ucp');
  const copy = useCallback(() => {
    void copyToClipboard(value, t('copied'));
  }, [value, t]);
  return (
    <div className="action-bar u-justify-between u-items-center u-gap-2">
      <div className="u-flex-1"><div className="u-text-sm muted">{label}</div><code className="u-text-sm u-block u-truncate">{value}</code></div>
      <button type="button" className="icon-button" aria-label={t('copy')} onClick={copy}><ClipboardIcon /></button>
    </div>
  );
}

function EndpointsCard({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce-ucp');
  const ep = ucpPublicEndpoints(orgId);
  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div><strong>{t('endpointsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('endpointsHint')}</p></div>
      <CopyRow label={t('discovery')} value={ep.discovery} />
      <CopyRow label={t('oauth')} value={ep.oauth} />
      <CopyRow label={t('catalog')} value={ep.catalog} />
    </div>
  );
}

function ClientsCard({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce-ucp');
  const [clients, setClients] = useState<UcpClient[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<ProvisionedClient | null>(null);
  // §4.5 collection kit — gated search over the client list (name or a scope);
  // feeds a separate memo over the unfiltered clients.
  const [query, setQuery] = useState('');
  const visibleClients = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (clients ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.scopes.some((s) => s.toLowerCase().includes(q)));
  }, [clients, query]);

  const [clientsError, setClientsError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void listUcpClients(orgId)
      .then((c) => { setClients(c); setClientsError(null); })
      .catch((e) => setClientsError(e instanceof Error ? e.message : String(e)));
  }, [orgId]);
  useEffect(() => { setClients(null); setClientsError(null); reload(); }, [reload]);

  const revoke = useCallback(async (c: UcpClient) => {
    if (!(await confirm({ title: t('revokeTitle', { name: c.name }), body: t('revokeBody'), danger: true, confirmLabel: t('revoke') }))) return;
    try { await deleteUcpClient(orgId, c.clientId); toast.info(t('revoked')); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
  }, [orgId, reload, t]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="action-bar u-justify-between u-items-center">
        <div><strong>{t('clientsTitle')}</strong><p className="u-m-0 u-text-sm muted">{t('clientsHint')}</p></div>
        {/* Withheld while the list is unknown: provisioning a client you cannot
            see the siblings of mints a DUPLICATE OAuth credential against the
            merchant's agent-commerce surface. Removed, not disabled — a disabled
            button still implies "you may provision here once ready". */}
        {clientsError ? null : <Button variant="primary" onClick={() => setCreating(true)}>{t('newClient')}</Button>}
      </div>

      {secret ? (
        <div className="surface-card u-p-3 u-grid u-gap-2">
          <Notice variant="warning"><strong>{t('secretOnceTitle')}</strong> {t('secretOnceBody')}</Notice>
          <CopyRow label={t('clientId')} value={secret.clientId} />
          <CopyRow label={t('clientSecret')} value={secret.clientSecret} />
          <div><Button variant="secondary" onClick={() => setSecret(null)}>{t('dismiss')}</Button></div>
        </div>
      ) : null}

      {creating ? <ClientForm orgId={orgId} onClose={() => setCreating(false)} onCreated={(c) => { setSecret(c); setCreating(false); reload(); }} /> : null}

      {clientsError ? (
        // "No agent clients yet" + a Provision CTA was previously what a FAILED
        // read rendered. Both halves are wrong then: the claim is unfounded, and
        // acting on it creates a credential the operator can't see the peers of.
        <StateCard
          announce
          icon={<BotIcon />}
          title={t('clientsFailedTitle')}
          body={`${t('clientsFailedBody')} ${clientsError}`}
          action={<Button variant="secondary" onClick={reload}>{t('retry')}</Button>}
        />
      ) : clients === null ? <Skeleton /> : clients.length === 0 ? (
        <StateCard
          icon={<BotIcon />}
          title={t('noClients')}
          body={t('noClientsBody')}
          action={<Button variant="primary" onClick={() => setCreating(true)}>{t('newClient')}</Button>}
        />
      ) : (
        <>
          {clients.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {visibleClients.length === 0 ? (
            <StateCard icon={<BotIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
          ) : (
            <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
              {visibleClients.map((c) => (
            <li key={c.clientId} className="action-bar u-justify-between u-items-center u-gap-2">
              <div className="u-flex-1">
                <div className="u-truncate"><strong>{c.name}</strong></div>
                <div className="u-text-sm muted">{c.scopes.join(' · ') || t('noScopes')}</div>
              </div>
              <button type="button" className="icon-button" aria-label={t('revoke')} onClick={() => void revoke(c)}><TrashIcon /></button>
            </li>
          ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function ClientForm({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (c: ProvisionedClient) => void }): JSX.Element {
  const { t } = useTranslation('commerce-ucp');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<UcpScope[]>([...UCP_SCOPES]);
  const [busy, setBusy] = useState(false);

  const toggle = (s: UcpScope) => setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);

  const submit = useCallback(async () => {
    if (!name.trim()) { toast.error(t('nameRequired')); return; }
    setBusy(true);
    try { onCreated(await provisionUcpClient(orgId, name.trim(), scopes)); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  }, [orgId, name, scopes, onCreated, t]);

  return (
    <div className="surface-card u-p-3 u-grid u-gap-3">
      <Field label={t('fieldName')} required>
        {(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={t('namePlaceholder')} autoFocus />}
      </Field>
      <fieldset className="u-grid u-gap-1 u-border-none u-p-0 u-m-0">
        <legend className="u-text-sm muted">{t('scopesLabel')}</legend>
        {UCP_SCOPES.map((s) => (
          <label key={s} className="action-bar u-items-center u-gap-2 u-text-sm">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> <code>{s}</code>
          </label>
        ))}
      </fieldset>
      <div className="action-bar u-gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? t('creating') : t('create')}</Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      </div>
    </div>
  );
}
