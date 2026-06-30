import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RosterEntry } from '../agents/rosterClient.js';
import { ALL_WORKFLOW_OPTIONS } from '../agents/roleTemplates.js';
import { IconButton } from '../ui/IconButton.js';
import { XIcon, ZapIcon } from '../ui/icons/index.js';
import { Modal } from '../ui/Modal.js';

/**
 * "Create a board" modal (boards redesign) — replaces the inline create form.
 * Mirrors the Hire-agent modal pattern: eyebrow/title/lede, the three fields
 * from the design (name · optional trigger workflow · optional owning agent),
 * Cancel + solid-accent Create. The trigger select offers the host's KNOWN
 * workflow catalog (the role-template portfolio ids) — no free-text ids to
 * typo. Binding an owner attributes triggered runs to that agent (RFC 0086).
 */
export function CreateBoardModal({ roster, onClose, onCreate }: {
  roster: RosterEntry[];
  onClose: () => void;
  onCreate: (input: { name: string; triggerWorkflowId?: string; rosterId?: string }) => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const [name, setName] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [rosterId, setRosterId] = useState('');

  // The known workflow catalog, deduped (roles can share a workflow).
  const workflowOptions = useMemo(() => {
    const seen = new Set<string>();
    return ALL_WORKFLOW_OPTIONS.filter((w) => {
      if (seen.has(w.workflowId)) return false;
      seen.add(w.workflowId);
      return true;
    });
  }, []);

  return (
    <Modal onClose={onClose} label={t('createBoardLabel')}>
        <div className="hire-head">
          <div>
            <div className="hire-eyebrow">{t('newBoardEyebrow')}</div>
            <h2 className="hire-title">{t('createBoardTitle')}</h2>
            <p className="hire-lede">
              {t('createBoardLedeBefore')} <ZapIcon size={12} aria-hidden /> {t('createBoardLedeAfter')}
            </p>
          </div>
          <IconButton label={t('common:close')} icon={<XIcon size={16} />} onClick={onClose} />
        </div>

        <label className="hire-label" htmlFor="cb-name">{t('boardNameLabel')}</label>
        <input
          id="cb-name"
          autoFocus
          className="ui-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('boardNamePlaceholder')}
        />

        <label className="hire-label" htmlFor="cb-workflow">{t('triggerWorkflowLabel')} <span className="hire-label-optional">{t('optionalSuffix')}</span></label>
        <select id="cb-workflow" className="ui-input" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">{t('noWorkflowOption')}</option>
          {workflowOptions.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
        </select>

        <label className="hire-label" htmlFor="cb-owner">{t('owningAgentLabel')} <span className="hire-label-optional">{t('optionalSuffix')}</span></label>
        <select id="cb-owner" className="ui-input" value={rosterId} onChange={(e) => setRosterId(e.target.value)}>
          <option value="">{t('noOwnerOption')}</option>
          {roster.map((r) => <option key={r.rosterId} value={r.rosterId}>{r.persona}{r.label ? ` — ${r.label}` : ''}</option>)}
        </select>

        <div className="hire-foot action-bar">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button
            type="button"
            className="btn-accent-solid btn-sm"
            disabled={name.trim().length === 0}
            onClick={() => onCreate({
              name: name.trim(),
              ...(workflowId ? { triggerWorkflowId: workflowId } : {}),
              ...(rosterId ? { rosterId } : {}),
            })}
          >
            {t('createBoardButton')}
          </button>
        </div>
    </Modal>
  );
}
