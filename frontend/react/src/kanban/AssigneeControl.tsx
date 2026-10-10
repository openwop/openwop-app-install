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
 * Members come from the shared org-member loader (`orgs/orgMembers.ts`, active
 * workspace root org): one cache with in-flight dedupe, a TTL, and invalidation on
 * member mutations. This file used to keep a second, never-invalidated copy of it.
 *
 * ADR 0829 P4 — picking a PERSON opens `HandoffDialog` instead of assigning at
 * once: the assigner may write a note for the new assignee, and nothing is sent
 * until they press assign. Unassign stays one step.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserIcon, XIcon } from '../ui/icons/index.js';
import type { OrgMember } from '../client/accessClient.js';
import { loadOrgMembers } from '../orgs/orgMembers.js';
import { assignCard, type HandoffNoteDraft } from './kanbanClient.js';
import { HandoffDialog } from './HandoffDialog.js';

export function AssigneeControl({ cardId, assigneeId, cardTitle }: { cardId: string; assigneeId: string | undefined; cardTitle?: string }): JSX.Element {
  const { t } = useTranslation('kanban');
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [busy, setBusy] = useState(false);
  // 'loading' disables the select, so a list that is being replaced cannot be picked
  // from (a member removed since the last open stays offered for that window
  // otherwise). 'failed' is a designed state — distinct from an empty workspace.
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('ready');
  const [pending, setPending] = useState<{ subject: string; name: string } | null>(null);

  // Re-read on EVERY open, not once per mount: a picker that latched its first list
  // kept offering a member removed since (CLNP-2(d)). The members themselves come from
  // the shared cached loader; the active-workspace lookup is one extra read.
  // On failure the PREVIOUS list is kept — wiping it would make the card fall back to
  // the raw assignee id and never recover — and the failure is said, not swallowed.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad('loading');
    loadOrgMembers()
      .then((m) => { if (live) { setMembers(m); setLoad('ready'); } })
      .catch(() => { if (live) setLoad('failed'); });
    return () => { live = false; };
  }, [open]);

  const assignee = members?.find((m) => m.subject === assigneeId);
  const label = assignee?.displayName ?? (assigneeId ? assigneeId : t('unassigned'));

  const send = useCallback(async (value: string, handoff?: HandoffNoteDraft) => {
    setBusy(true);
    try {
      await assignCard(cardId, value ? { assigneeId: value, notifyAssignee: true, ...(handoff ? { handoff } : {}) } : { assigneeId: null });
      setPending(null);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [cardId]);

  const onPick = useCallback(async (value: string) => {
    if (value) {
      const m = members?.find((x) => (x.subject ?? x.memberId) === value);
      setPending({ subject: value, name: m?.displayName ?? value });
      return;
    }
    await send(value);
  }, [members, send]);

  // Resolve a name for an already-assigned card without opening the picker.
  useEffect(() => {
    if (assigneeId && !members) {
      void loadOrgMembers().then(setMembers).catch(() => undefined);
    }
  }, [assigneeId, members]);

  if (!open) {
    return (
      <Button
        variant="quiet"
        size="sm"
        /* quiet, not primary — kb-person keeps the 12px ink-2 person
           treatment the card's other people use. */
        className="kb-person"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={t('assignCardTitle')}
      >
        <UserIcon size={12} aria-hidden /> {label}
      </Button>
    );
  }

  return (
    <span
      className="u-iflex u-items-center u-gap-1"
      onPointerDown={(e) => e.stopPropagation()}
      /* The HandoffDialog is portaled, but React events still bubble through
         this tree to the draggable card: a click would reach the card, and a
         Space/Enter typed in the dialog would reach dnd-kit's keyboard sensor. */
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <select
        className="u-fs-12"
        defaultValue={assigneeId ?? ''}
        disabled={busy || load === 'loading' || (load === 'failed' && members === null)}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => void onPick(e.target.value)}
        aria-label={t('assignTo')}
      >
        {load === 'failed' ? <option value="" disabled>{t('membersLoadFailed')}</option> : null}
        <option value="">{t('unassigned')}</option>
        {(members ?? []).map((m) => (
          <option key={m.memberId} value={m.subject ?? m.memberId}>
            {m.displayName}
          </option>
        ))}
      </select>
      {pending ? (
        <HandoffDialog
          assigneeName={pending.name}
          cardTitle={cardTitle ?? ''}
          busy={busy}
          onAssign={(draft) => void send(pending.subject, draft)}
          onClose={() => { setPending(null); setOpen(false); }}
        />
      ) : null}
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
