/**
 * Credential Card + List for the /keys page (ADR 0131 Phase 4). `/keys` is a
 * per-provider `<DataTable>` operate-surface, so per the canon's scoping rule the
 * table stays the default and the Card is the opt-in Grid presentation ALONGSIDE
 * it. The toggle only changes how a provider's credential LIST renders — the
 * per-provider sections, headers, add-flow, and delete path are untouched.
 *
 * SECURITY: a card shows ONLY what the table column already shows — the
 * `credentialRef` (a label, never a secret) and the session-masked rendering the
 * BE returned. No key value is ever displayed.
 */

import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { DataTable, IconButton, type DataColumn } from '../ui/index.js';
import { TrashIcon } from '../ui/icons/index.js';

export interface CredentialEntry {
  ref: string;
  providerId: string | null;
  /** Trailing label after `<providerId>:` if present (e.g., "prod"). */
  label: string | null;
  /** Most-recently-stored masked rendering, if added this session. */
  masked?: string;
}

export function CredentialCard({ entry: e, onDelete }: { entry: CredentialEntry; onDelete: (ref: string) => void }): JSX.Element {
  const { t } = useTranslation('byok');
  return (
    <div className="surface-card u-flex u-flex-col u-gap-2">
      <div className="u-flex u-items-start u-justify-between u-gap-2">
        <code className="keys-list-item-ref">{e.ref}</code>
        <IconButton label={t('deleteRefLabel', { ref: e.ref })} icon={<TrashIcon size={15} />} onClick={() => onDelete(e.ref)} />
      </div>
      {e.masked ? (
        <span className="muted u-fs-12" title={t('maskedRenderingTitle')}>{e.masked}</span>
      ) : (
        <span className="muted u-fs-12">—</span>
      )}
    </div>
  );
}

/** Renders a provider's credentials as a card grid (Grid) or the sortable
 *  DataTable (List/Table) — the two views of the same rows, sharing the same
 *  ref/masked/delete shape so they never diverge. */
export function CredentialList({ list, viewMode, caption, onDelete, empty }: {
  list: CredentialEntry[];
  viewMode: 'grid' | 'list';
  caption: string;
  onDelete: (ref: string) => void;
  empty: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('byok');
  if (viewMode === 'grid') {
    return list.length === 0 ? <>{empty}</> : (
      <div className="card-grid">
        {list.map((e) => <CredentialCard key={e.ref} entry={e} onDelete={onDelete} />)}
      </div>
    );
  }
  const columns: DataColumn<CredentialEntry>[] = [
    { key: 'ref', header: t('referenceColumn'), sortValue: (e) => e.ref, render: (e) => <code className="keys-list-item-ref">{e.ref}</code> },
    {
      key: 'masked', header: t('maskedValueColumn'), cellClassName: 'muted',
      render: (e) => e.masked ? <span title={t('maskedRenderingTitle')}>{e.masked}</span> : <span className="muted">—</span>,
    },
    {
      key: 'actions', header: '', align: 'right', width: '64px',
      render: (e) => <IconButton label={t('deleteRefLabel', { ref: e.ref })} icon={<TrashIcon size={15} />} onClick={() => onDelete(e.ref)} />,
    },
  ];
  return <DataTable columns={columns} rows={list} rowKey={(e) => e.ref} density="compact" caption={caption} initialSort={{ key: 'ref', dir: 'asc' }} empty={empty} />;
}
