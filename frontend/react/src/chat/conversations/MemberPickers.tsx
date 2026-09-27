/**
 * Member + agent pickers (ADR 0192 D8) — the searchable, name-resolving
 * selection controls that replace the raw-ID text inputs in the channel
 * create/manage dialogs (gap #2: "raw identifiers render as UI"). Shared by
 * both dialogs so their behavior can't drift.
 *
 * Data sources: `features/users` listUsers() for people (the identity owner —
 * chat→features import per the MessageComments precedent) and the tenant
 * agent-mention entries for agents. Selection echoes as removable chips above
 * a bounded, scrollable checklist.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../../ui/Avatar.js';
import { XIcon } from '../../ui/icons/index.js';
import { listUsers, type User } from '../../features/users/usersClient.js';
import { useAgentMentions } from '../lib/agentMentions.js';

interface PickerRow { id: string; label: string; sublabel?: string; kind: 'user' | 'agent' }

function PickerList({
  idPrefix,
  label,
  rows,
  loading,
  error,
  selected,
  onToggle,
}: {
  idPrefix: string;
  label: string;
  rows: readonly PickerRow[];
  loading: boolean;
  /** Load failure — rendered as an error line, NEVER as the empty state (a
   *  5xx must not read as "your workspace has no teammates"). */
  error: boolean;
  selected: ReadonlyMap<string, PickerRow>;
  onToggle: (row: PickerRow) => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(q) || (r.sublabel ?? '').toLowerCase().includes(q));
  }, [rows, query]);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {selected.size > 0 && (
        <div className="u-flex u-wrap u-gap-1 u-mb-1">
          {[...selected.values()].map((r) => (
            <span key={r.id} className="chip">
              {r.label}
              <button type="button" className="chip-remove" onClick={() => onToggle(r)} aria-label={t('removeMemberAria', { member: r.label })}>
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('channelPickerSearchPlaceholder')}
        aria-label={label}
      />
      <ul className="chanpicker-list" aria-busy={loading}>
        {loading ? (
          <li className="muted u-fs-12 u-pad-1-2">{tc('loading')}</li>
        ) : error ? (
          <li className="u-fs-12 u-pad-1-2 chanpicker-error">{t('channelPickerError')}</li>
        ) : matches.length === 0 ? (
          <li className="muted u-fs-12 u-pad-1-2">{t('channelPickerEmpty')}</li>
        ) : matches.map((r) => (
          <li key={r.id}>
            <label className="chanpicker-row">
              {/* The wrapping <label> provides the accessible name (name +
                  sublabel), richer than an aria-label override would be. */}
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => onToggle(r)}
              />
              <Avatar name={r.label} size={20} kind={r.kind} />
              <span className="u-truncate u-fs-13">{r.label}</span>
              {r.sublabel && <span className="chip chip--muted u-fs-10">{r.sublabel}</span>}
            </label>
          </li>
        ))}
      </ul>
      <span className="sr-only" id={`${idPrefix}-count`} aria-live="polite">{t('channelPickerSelectedCount', { count: selected.size })}</span>
    </div>
  );
}

/** People picker — resolves the tenant's users (names, never ids). */
export function MemberPicker({
  selectedIds,
  onChange,
  excludeUserIds,
}: {
  selectedIds: readonly string[];
  onChange: (userIds: string[]) => void;
  /** Already-member ids to hide (manage dialog). */
  excludeUserIds?: readonly string[];
}): JSX.Element {
  const { t } = useTranslation('chat');
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void listUsers()
      .then((u) => { if (!cancelled) { setUsers(u); setLoadFailed(false); } })
      .catch(() => { if (!cancelled) { setUsers([]); setLoadFailed(true); } });
    return () => { cancelled = true; };
  }, []);
  const rows = useMemo<PickerRow[]>(() => {
    const excluded = new Set(excludeUserIds ?? []);
    return (users ?? [])
      .filter((u) => !excluded.has(u.userId))
      .map((u) => ({ id: u.userId, label: u.displayName ?? u.email ?? u.userId, ...(u.email && u.displayName ? { sublabel: u.email } : {}), kind: 'user' as const }));
  }, [users, excludeUserIds]);
  const selected = useMemo(() => new Map(rows.filter((r) => selectedIds.includes(r.id)).map((r) => [r.id, r])), [rows, selectedIds]);
  return (
    <PickerList
      idPrefix="member-picker"
      label={t('channelMembersPickerLabel')}
      rows={rows}
      loading={users === null}
      error={loadFailed}
      selected={selected}
      onToggle={(r) => onChange(selectedIds.includes(r.id) ? selectedIds.filter((id) => id !== r.id) : [...selectedIds, r.id])}
    />
  );
}

/** Agent picker — the tenant's agents (same source as the `@` autocomplete). */
export function AgentPicker({
  selectedIds,
  onChange,
  excludeAgentIds,
}: {
  selectedIds: readonly string[];
  onChange: (agentIds: string[]) => void;
  excludeAgentIds?: readonly string[];
}): JSX.Element {
  const { t } = useTranslation('chat');
  const { entries, isLoading, error: agentsError } = useAgentMentions();
  const rows = useMemo<PickerRow[]>(() => {
    const excluded = new Set(excludeAgentIds ?? []);
    return entries
      .filter((e) => !excluded.has(e.agentId))
      .map((e) => ({ id: e.agentId, label: e.displayName, sublabel: `@${e.slug}`, kind: 'agent' as const }));
  }, [entries, excludeAgentIds]);
  const selected = useMemo(() => new Map(rows.filter((r) => selectedIds.includes(r.id)).map((r) => [r.id, r])), [rows, selectedIds]);
  return (
    <PickerList
      idPrefix="agent-picker"
      label={t('channelAgentsPickerLabel')}
      rows={rows}
      loading={isLoading}
      error={agentsError !== null}
      selected={selected}
      onToggle={(r) => onChange(selectedIds.includes(r.id) ? selectedIds.filter((id) => id !== r.id) : [...selectedIds, r.id])}
    />
  );
}
