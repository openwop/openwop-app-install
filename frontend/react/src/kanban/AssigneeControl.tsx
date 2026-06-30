/**
 * AssigneeControl — assign a kanban card to a workspace member (ADR 0049).
 *
 * Self-contained so it can drop into the draggable board card without threading
 * a member list through KanbanBoardView. Shows the current assignee (resolved to
 * a display name) and, on expand, a native <select> of workspace members +
 * "Unassign". Choosing a member POSTs to the assign route, which notifies the
 * assignee and surfaces the card on their "My Work" mirror; the board's SSE
 * refresh then repaints this card. Pointer events are stopped so interacting
 * with the control never starts a drag.
 *
 * Members are loaded once per active workspace (module-cached) — the first card
 * that opens its picker pays the fetch; the rest reuse it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserIcon, XIcon } from '../ui/icons/index.js';
import { listMembers, type OrgMember } from '../client/accessClient.js';
import { listMyWorkspaces } from '../client/workspaceClient.js';
import { assignCard } from './kanbanClient.js';

let membersCache: { workspaceId: string; members: OrgMember[] } | null = null;

async function loadWorkspaceMembers(): Promise<OrgMember[]> {
  const active = (await listMyWorkspaces()).active;
  if (membersCache && membersCache.workspaceId === active) return membersCache.members;
  // The workspace-root org id equals the active workspace/tenant id (ADR 0015).
  const members = await listMembers(active);
  membersCache = { workspaceId: active, members };
  return members;
}

/** Drop the cache so a freshly-assigned member list reloads (e.g. after invites). */
export function invalidateMembersCache(): void {
  membersCache = null;
}

export function AssigneeControl({ cardId, assigneeId }: { cardId: string; assigneeId: string | undefined }): JSX.Element {
  const { t } = useTranslation('kanban');
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || members) return;
    void loadWorkspaceMembers().then(setMembers).catch(() => setMembers([]));
  }, [open, members]);

  const assignee = members?.find((m) => m.subject === assigneeId);
  const label = assignee?.displayName ?? (assigneeId ? assigneeId : t('unassigned'));

  const onPick = useCallback(async (value: string) => {
    setBusy(true);
    try {
      await assignCard(cardId, value ? { assigneeId: value, notifyAssignee: true } : { assigneeId: null });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [cardId]);

  // Resolve a name for an already-assigned card without opening the picker.
  useEffect(() => {
    if (assigneeId && !members) {
      void loadWorkspaceMembers().then(setMembers).catch(() => undefined);
    }
  }, [assigneeId, members]);

  if (!open) {
    return (
      <button
        type="button"
        className={assigneeId ? 'kb-person' : 'muted u-fs-12'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={t('assignCardTitle')}
      >
        <UserIcon size={12} aria-hidden /> {label}
      </button>
    );
  }

  return (
    <span
      className="u-iflex u-items-center u-gap-1"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <select
        className="u-fs-12"
        defaultValue={assigneeId ?? ''}
        disabled={busy || members === null}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => void onPick(e.target.value)}
        aria-label={t('assignTo')}
      >
        <option value="">{t('unassigned')}</option>
        {(members ?? []).map((m) => (
          <option key={m.memberId} value={m.subject ?? m.memberId}>
            {m.displayName}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-button"
        aria-label={t('closeAssigneePicker')}
        onClick={(e) => { e.stopPropagation(); setOpen(false); }}
      >
        <XIcon size={13} aria-hidden />
      </button>
    </span>
  );
}
