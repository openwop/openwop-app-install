import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RosterEntry } from '../agents/rosterClient.js';
import type { WorkflowSummaryDTO } from '../workflows/workflowsClient.js';
import { IconButton } from '../ui/IconButton.js';
import { XIcon, ZapIcon } from '../ui/icons/index.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';

/**
 * "Create a board" modal (boards redesign) — replaces the inline create form.
 * Mirrors the Hire-agent modal pattern: eyebrow/title/lede, the three fields
 * from the design (name · optional trigger workflow · optional owning agent),
 * Cancel + solid-accent Create. The trigger select receives the caller's owned,
 * Builder-editable workflows — never a static role-template catalog. Binding an
 * owner attributes triggered runs to that agent (RFC 0086).
 */
export function CreateBoardModal({ roster, workflowOptions, workflowOptionsLoading, workflowOptionsFailed, onClose, onCreate }: {
  roster: RosterEntry[];
  workflowOptions: readonly WorkflowSummaryDTO[];
  workflowOptionsLoading: boolean;
  workflowOptionsFailed: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; triggerWorkflowId?: string; rosterId?: string }) => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const [name, setName] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [rosterId, setRosterId] = useState('');

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

        {/* BLD-9: a real <form> so Enter in the name field submits (parity with RenameBoardModal). */}
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim().length > 0) onCreate({ name: name.trim(), ...(workflowId ? { triggerWorkflowId: workflowId } : {}), ...(rosterId ? { rosterId } : {}) }); }}>
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
        <select id="cb-workflow" className="ui-input" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} disabled={workflowOptionsLoading}>
          <option value="">{workflowOptionsLoading ? t('workflowOptionsLoading') : t('noWorkflowOption')}</option>
          {workflowOptions.map((workflow) => <option key={workflow.workflowId} value={workflow.workflowId}>{workflow.name}</option>)}
        </select>
        {workflowOptionsFailed ? <Notice variant="warning" announce={t('workflowOptionsUnavailable')}>{t('workflowOptionsUnavailable')}</Notice> : null}

        <label className="hire-label" htmlFor="cb-owner">{t('owningAgentLabel')} <span className="hire-label-optional">{t('optionalSuffix')}</span></label>
        <select id="cb-owner" className="ui-input" value={rosterId} onChange={(e) => setRosterId(e.target.value)}>
          <option value="">{t('noOwnerOption')}</option>
          {roster.map((r) => <option key={r.rosterId} value={r.rosterId}>{r.persona}{r.label ? ` — ${r.label}` : ''}</option>)}
        </select>

        <div className="hire-foot action-bar">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          <Button
            type="submit"
            variant="accent-solid" size="sm"
            disabled={name.trim().length === 0}
          >
            {t('createBoardButton')}
          </Button>
        </div>
        </form>
    </Modal>
  );
}
