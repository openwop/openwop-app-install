/**
 * `/event-bindings` (Settings → Platform → Event bindings) — the admin UI over
 * the host-event → workflow registry (ADR 0208 §1,
 * `GET/POST/PATCH/DELETE /host/openwop-app/host-events/bindings`), which
 * shipped API-only. Same trust tier as webhook subscriptions (RFC 0093): the
 * backend scopes every call to the caller's tenant with no superadmin gate,
 * so this page is reachable by any signed-in workspace member, not just the
 * platform console. Not a `FrontendFeature` toggle package — this is
 * host-level tenant automation config, always on wherever the host advertises
 * the registry.
 *
 * @see docs/adr/0208-crm-orchestration-wiring.md
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { TextField, SelectField } from '../ui/Field.js';
import { confirm } from '../ui/confirm.js';
import { toast } from '../ui/toast.js';
import { ZapIcon, TrashIcon, PlusIcon } from '../ui/icons/index.js';
import { formatDateTime } from '../i18n/format.js';
import {
  listHostEventBindings,
  createHostEventBinding,
  setHostEventBindingEnabled,
  deleteHostEventBinding,
  type HostEventBinding,
} from '../client/hostEventBindingsClient.js';
import { listWorkflowSummaries, type WorkflowSummaryDTO } from '../workflows/workflowsClient.js';
import { KNOWN_HOST_EVENT_TYPES } from './hostEventCatalog.js';

export function EventBindingsPage(): JSX.Element {
  const { t } = useTranslation('settings');
  const [bindings, setBindings] = useState<HostEventBinding[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummaryDTO[]>([]);
  // UX-GOV-3 — the workflow list read FAILED. Two things degrade on this page and
  // neither is self-evident: the picker would claim "No workflows yet", and
  // `workflowLabel` falls back to the raw id for EVERY existing binding — a
  // fallback designed for one edge case (see below) turned page-wide.
  const [workflowsFailed, setWorkflowsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // §4.5 collection kit — gated search + an enabled/disabled facet over the
  // bindings registry.
  const [bindQuery, setBindQuery] = useState('');
  const [bindEnabled, setBindEnabled] = useState('');

  // Resolve a bound workflowId to its owned-workflow display name (falls back
  // to the raw id when it isn't in the caller's ownership index — a chain-
  // instantiated or another-tenant-registered workflow, still runnable).
  const workflowLabel = useMemo(() => {
    const byId = new Map(workflows.map((w) => [w.workflowId, w.name]));
    return (id: string): string => byId.get(id) ?? id;
  }, [workflows]);

  const visibleBindings = useMemo(() => {
    const list = bindings ?? [];
    const q = bindQuery.trim().toLowerCase();
    return list.filter((b) =>
      (!bindEnabled || (bindEnabled === 'enabled' ? b.enabled : !b.enabled)) &&
      (!q || `${b.eventType} ${workflowLabel(b.workflowId)}`.toLowerCase().includes(q)));
  }, [bindings, bindQuery, bindEnabled, workflowLabel]);
  const clearBindingFilters = (): void => { setBindQuery(''); setBindEnabled(''); };

  const refresh = useCallback(async () => {
    setWorkflowsFailed(false);
    try {
      const [b, w] = await Promise.all([
        listHostEventBindings(),
        listWorkflowSummaries().catch(() => { setWorkflowsFailed(true); return [] as WorkflowSummaryDTO[]; }),
      ]);
      setBindings(b);
      setWorkflows(w);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBindings([]);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Default the create form's workflow select to the first available option,
  // without clobbering a choice the operator already made.
  useEffect(() => {
    setWorkflowId((cur) => (cur ? cur : workflows[0]?.workflowId ?? ''));
  }, [workflows]);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const type = eventType.trim();
    if (!type || !workflowId) return;
    setCreating(true);
    try {
      await createHostEventBinding({ eventType: type, workflowId });
      setEventType('');
      toast.success(t('bindingsCreateSuccess', { eventType: type }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bindingsCreateFailed'));
    } finally {
      setCreating(false);
    }
  };

  const onToggle = async (b: HostEventBinding): Promise<void> => {
    setBusyId(b.bindingId);
    try {
      await setHostEventBindingEnabled(b.bindingId, !b.enabled);
      toast.success(b.enabled ? t('bindingsDisabledToast', { eventType: b.eventType }) : t('bindingsEnabledToast', { eventType: b.eventType }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bindingsToggleFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (b: HostEventBinding): Promise<void> => {
    const ok = await confirm({
      title: t('bindingsDeleteConfirmTitle', { eventType: b.eventType }),
      body: t('bindingsDeleteConfirmBody'),
      danger: true,
      confirmLabel: t('common:delete'),
    });
    if (!ok) return;
    setBusyId(b.bindingId);
    try {
      await deleteHostEventBinding(b.bindingId);
      toast.success(t('bindingsDeleteSuccess', { eventType: b.eventType }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bindingsDeleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const columns: DataColumn<HostEventBinding>[] = [
    {
      key: 'eventType', header: t('bindingsColEvent'),
      render: (b) => <code className="u-fs-12">{b.eventType}</code>,
      sortValue: (b) => b.eventType,
    },
    {
      key: 'workflow', header: t('bindingsColWorkflow'),
      render: (b) => <span>{workflowLabel(b.workflowId)}</span>,
      sortValue: (b) => workflowLabel(b.workflowId),
    },
    {
      key: 'enabled', header: t('bindingsColEnabled'),
      render: (b) => (
        <button
          type="button"
          className={`chip ${b.enabled ? 'chip--success' : 'chip--muted'}`}
          aria-pressed={b.enabled}
          disabled={busyId === b.bindingId}
          onClick={() => void onToggle(b)}
          aria-label={t('bindingsToggleAria', { eventType: b.eventType, state: b.enabled ? t('bindingsEnabled') : t('bindingsDisabled') })}
        >
          {b.enabled ? t('bindingsEnabled') : t('bindingsDisabled')}
        </button>
      ),
      sortValue: (b) => (b.enabled ? 1 : 0),
    },
    {
      key: 'createdAt', header: t('bindingsColCreated'),
      render: (b) => <span className="u-fs-12">{formatDateTime(b.createdAt)}</span>,
      sortValue: (b) => b.createdAt,
    },
    {
      key: 'actions', header: '', align: 'right',
      render: (b) => (
        <Button
          variant="secondary" size="sm"
          disabled={busyId === b.bindingId}
          onClick={() => void onDelete(b)}
          aria-label={t('bindingsDeleteAria', { eventType: b.eventType })}
        >
          <TrashIcon size={13} /> {t('common:delete')}
        </Button>
      ),
    },
  ];

  return (
    <section data-walkthrough="event-bindings.page">
      <PageHeader eyebrow={t('bindingsEyebrow')} title={t('bindingsTitle')} lede={t('bindingsLede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {/* UX-GOV-3 — without this, every existing binding silently renders its raw
          workflow id (the `?? id` fallback above, designed for ONE edge case)
          and the picker would claim the tenant has no workflows. */}
      {workflowsFailed ? <Notice variant="warning" announce={t('bindingsWorkflowsReadFailed')}>{t('bindingsWorkflowsReadFailed')}</Notice> : null}

      <div className="surface-card u-mb-3">
        <h2 className="u-fs-16 u-mt-0">{t('bindingsCreateHeading')}</h2>
        <form onSubmit={(e) => void onCreate(e)} className="surface-form" aria-label={t('bindingsCreateHeading')}>
          <TextField
            label={t('bindingsEventTypeLabel')}
            help={t('bindingsEventTypeHelp')}
            list="host-event-types"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="host.crm.contact.created"
            required
          />
          <datalist id="host-event-types">
            {KNOWN_HOST_EVENT_TYPES.map((et) => <option key={et} value={et} />)}
          </datalist>
          <SelectField
            label={t('bindingsWorkflowLabel')}
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            required
            disabled={workflows.length === 0}
          >
            {workflows.length === 0 ? <option value="">{workflowsFailed ? t('bindingsWorkflowsUnavailable') : t('bindingsNoWorkflows')}</option> : null}
            {workflows.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
          </SelectField>
          <Button type="submit" variant="accent-solid" disabled={creating || !eventType.trim() || !workflowId}>
            <PlusIcon size={14} /> {creating ? t('bindingsCreating') : t('bindingsCreateAction')}
          </Button>
        </form>
      </div>

      {bindings && bindings.length > 3 ? (
        <div className="filterbar u-mb-3" role="group" aria-label={t('bindingsFilterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('bindingsSearchPlaceholder')}
            aria-label={t('bindingsSearchAria')}
            value={bindQuery}
            onChange={(e) => setBindQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" aria-label={t('bindingsStatusFacetAria')} value={bindEnabled} onChange={(e) => setBindEnabled(e.target.value)}>
            <option value="">{t('bindingsStatusAll')}</option>
            <option value="enabled">{t('bindingsEnabled')}</option>
            <option value="disabled">{t('bindingsDisabled')}</option>
          </select>
        </div>
      ) : null}
      {bindings === null ? (
        <SkeletonRows rows={3} columns={['25%', '25%', '15%', '20%', '15%']} />
      ) : bindings.length === 0 ? (
        <StateCard icon={<ZapIcon size={20} />} title={t('bindingsEmptyTitle')} body={t('bindingsEmptyBody')} />
      ) : visibleBindings.length === 0 ? (
        <StateCard icon={<ZapIcon size={20} />} title={t('bindingsNoMatchTitle')} body={t('bindingsNoMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearBindingFilters}>{t('bindingsClearFilters')}</Button>} />
      ) : (
        <DataTable columns={columns} rows={visibleBindings} rowKey={(b) => b.bindingId} stack caption={t('bindingsTableCaption')} />
      )}
    </section>
  );
}
