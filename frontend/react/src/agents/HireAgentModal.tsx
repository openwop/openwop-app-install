import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROLE_TEMPLATES, roleThemeForKey } from './roleTemplates.js';
import { IconButton } from '../ui/IconButton.js';
import { XIcon, ArrowRightIcon } from '../ui/icons/index.js';
import { Modal } from '../ui/Modal.js';

/**
 * "Hire an agent" modal (agents-workforce redesign PR 4) — the fast path IN
 * FRONT of the create wizard, never a second creation flow (architect delta).
 *
 * Pick a role template + starting autonomy here; `Continue` hands off to
 * `/agents/new?role=<key>&autonomy=<auto|review>` where the wizard prefills
 * the role, workflows, prompt, and suggested name. The copy promises exactly
 * what templates deliver — there is no AI drafting, and "Custom role" goes to
 * the blank wizard.
 */
export function HireAgentModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const [roleKey, setRoleKey] = useState<string | null>(null);
  const [autonomy, setAutonomy] = useState<'auto' | 'guided' | 'review'>('auto');

  const go = (): void => {
    const params = new URLSearchParams();
    if (roleKey && roleKey !== 'custom') params.set('role', roleKey);
    params.set('autonomy', autonomy);
    onClose();
    navigate(`/agents/new?${params.toString()}`);
  };

  return (
    <Modal onClose={onClose} label={t('hireLabel')}>
        <div className="hire-head">
          <div>
            <div className="hire-eyebrow">{t('hireEyebrow')}</div>
            <h2 className="hire-title">{t('hireTitle')}</h2>
            <p className="hire-lede">
              {t('hireLede')}
            </p>
          </div>
          <IconButton label={t('drawerClose')} icon={<XIcon size={16} />} onClick={onClose} />
        </div>

        <div className="hire-label">{t('hireRole')}</div>
        <div className="hire-roles">
          {ROLE_TEMPLATES.map((r) => {
            const RoleIcon = roleThemeForKey(r.key).Icon;
            const selected = roleKey === r.key;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={selected}
                className={selected ? 'hire-role is-selected' : 'hire-role'}
                onClick={() => setRoleKey(r.key)}
              >
                <span className="hire-role-title"><RoleIcon size={14} aria-hidden /> {r.title}</span>
                <span className="hire-role-blurb">{r.blurb}</span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={roleKey === 'custom'}
            className={roleKey === 'custom' ? 'hire-role is-selected' : 'hire-role'}
            onClick={() => setRoleKey('custom')}
          >
            <span className="hire-role-title">{t('hireCustomRole')}</span>
            <span className="hire-role-blurb">{t('hireCustomRoleBlurb')}</span>
          </button>
        </div>

        <div className="hire-label">{t('hireStartingAutonomy')}</div>
        <div className="action-bar">
          {([['review', t('hireAutonomySupervised')], ['guided', t('hireAutonomyGuided')], ['auto', t('hireAutonomyAutonomous')]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={autonomy === value ? 'primary btn-sm' : 'secondary btn-sm'}
              aria-pressed={autonomy === value}
              onClick={() => setAutonomy(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="hire-foot action-bar">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('newCancel')}</button>
          <button type="button" className="btn-accent-solid btn-sm" disabled={roleKey === null} onClick={go}>
            {t('hireContinue')} <ArrowRightIcon size={14} aria-hidden />
          </button>
        </div>
    </Modal>
  );
}
