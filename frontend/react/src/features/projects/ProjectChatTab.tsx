/**
 * Project Chat tab (ADR 0054 D3 + D6) — a launch panel for the project's ONE
 * shared group conversation (people + agents) plus its multi-agent CADENCE
 * (moderator + turn policy). No second chat system: the backend binds a
 * `type:'group'` conversation to `project:<id>` (ADR 0043) and seeds the lineup
 * from the project's agent members; this deep-links into the chat surface
 * (`/chat?conversation=<id>`). The cadence reuses the advisory-board primitive (D6).
 * Always-on (graduated off the `project-collab` toggle 2026-06-16).
 *
 * `ui/` cohesion: surface-card / surface-form / SelectField / Notice / StateCard +
 * the `proj-*` tile/lineup primitives; tokens only.
 */
import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatNumber } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField } from '../../ui/Field.js';
import { MessageSquareIcon, SparklesIcon, UserIcon, ZapIcon } from '../../ui/icons/index.js';
import { listRoster, type RosterEntry } from '../../agents/rosterClient.js';
import { ensureProjectChat, updateChatCadence, type Project, type TurnPolicy } from './projectsClient.js';

export function ProjectChatTab({ project, canWrite, onSaved }: { project: Project; canWrite: boolean; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  useEffect(() => { void listRoster().then(setRoster).catch(() => undefined); }, []);

  const agentMembers = useMemo(() => (project.members ?? [])
    .filter((m) => m.ref.startsWith('agent:'))
    .map((m) => {
      const rosterId = m.ref.slice('agent:'.length);
      return { rosterId, persona: roster.find((r) => r.rosterId === rosterId)?.persona ?? rosterId };
    }), [project.members, roster]);
  const people = (project.members ?? []).filter((m) => m.ref.startsWith('user:')).length;

  const open = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const { sessionId } = await ensureProjectChat(project.id);
      navigate(`/chat?conversation=${encodeURIComponent(sessionId)}`);
    } catch (e) { setError(e instanceof Error ? e.message : t('openChatError')); setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <div className="surface-card u-flex u-flex-col u-gap-3">
        <div className="u-flex u-items-center u-gap-2"><MessageSquareIcon size={16} /> <strong className="u-fs-15">{t('projectChatHeading')}</strong></div>
        <p className="muted u-fs-13 u-m-0">
          <Trans i18nKey="chatIntro" ns="projects" values={{ name: project.name }} components={{ 0: <strong />, 1: <code />, 2: <strong /> }} />
        </p>

        {/* ── The lineup ── */}
        {agentMembers.length > 0 ? (
          <div className="u-flex u-flex-col u-gap-2">
            <span className="proj-eyebrow">{t('inTheRoom')}</span>
            <div className="proj-lineup">
              {people > 0 && (
                <span className="u-flex u-items-center u-gap-2">
                  <span className="proj-tile" aria-hidden="true"><UserIcon size={15} /></span>
                  <span className="u-fs-13">{t('peopleCount', { count: people })}</span>
                </span>
              )}
              {agentMembers.map((a) => (
                <span key={a.rosterId} className="u-flex u-items-center u-gap-2">
                  <span className="proj-tile proj-tile--agent" aria-hidden="true"><SparklesIcon size={15} /></span>
                  <span className="u-fs-13">{a.persona}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <Notice variant="info"><Trans i18nKey="noAgentsNotice" ns="projects" components={{ 0: <strong /> }} /></Notice>
        )}

        {error ? <Notice variant="error">{error}</Notice> : null}
        {/* Opening the chat reconciles the room's lineup (a write), so it's
            write-gated (ADR 0063); a read-only member sees why instead of a 403. */}
        {canWrite ? (
          <div className="action-bar u-justify-start">
            <button type="button" className="primary" disabled={busy} onClick={() => void open()}>
              <MessageSquareIcon size={14} /> {busy ? t('opening') : t('openProjectChat')}
            </button>
          </div>
        ) : (
          <Notice variant="info"><Trans i18nKey="openChatNeedsWrite" ns="projects" components={{ 0: <code /> }} /></Notice>
        )}
      </div>

      {agentMembers.length > 0 && canWrite ? <CadenceEditor project={project} agentMembers={agentMembers} onSaved={onSaved} /> : null}
    </div>
  );
}

const ORDERS: TurnPolicy['order'][] = ['declared', 'round-robin'];

/** ADR 0054 D6 — configure the convene cadence: a moderator (the chair, who frames
 *  + synthesizes) and a turn policy (rounds / order / synthesize). The moderator
 *  MUST be a project agent member (server-validated). */
function CadenceEditor({ project, agentMembers, onSaved }: { project: Project; agentMembers: { rosterId: string; persona: string }[]; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const [moderator, setModerator] = useState(project.moderatorRosterId ?? '');
  const [rounds, setRounds] = useState(project.turnPolicy?.rounds ?? 1);
  const [order, setOrder] = useState<TurnPolicy['order']>(project.turnPolicy?.order ?? 'declared');
  const [synthesize, setSynthesize] = useState(project.turnPolicy?.synthesize ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const updated = await updateChatCadence(project.id, {
        moderatorRosterId: moderator || null,
        turnPolicy: { rounds, order, synthesize },
      });
      onSaved(updated); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : t('cadenceSaveError')); }
    finally { setBusy(false); }
  };

  return (
    <div className="surface-card u-flex u-flex-col u-gap-3">
      <div className="u-flex u-items-center u-gap-2"><ZapIcon size={16} /> <strong className="u-fs-15">{t('conveneCadenceHeading')}</strong></div>
      <p className="muted u-fs-12 u-m-0">
        {t('cadenceHelp', { max: formatNumber(Math.min(8, agentMembers.length)) })}
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {saved ? <Notice variant="success">{t('cadenceSaved')}</Notice> : null}
      <div className="surface-form">
        <SelectField label={t('moderatorLabel')} value={moderator} onChange={(e) => setModerator(e.target.value)}>
          <option value="">{t('moderatorNone')}</option>
          {agentMembers.map((a) => <option key={a.rosterId} value={a.rosterId}>{a.persona}</option>)}
        </SelectField>
        <SelectField label={t('roundsLabel')} value={String(rounds)} onChange={(e) => setRounds(Number(e.target.value))}>
          {[1, 2, 3].map((n) => <option key={n} value={n}>{formatNumber(n)}</option>)}
        </SelectField>
        <SelectField label={t('orderLabel')} value={order} onChange={(e) => setOrder(e.target.value as TurnPolicy['order'])}>
          {ORDERS.map((o) => <option key={o} value={o}>{o === 'round-robin' ? t('orderRoundRobin') : t('orderDeclared')}</option>)}
        </SelectField>
        <label className="u-flex u-items-center u-gap-1 u-fs-13" style={{ alignSelf: 'flex-end', paddingBottom: 'var(--space-2)' }}>
          <input type="checkbox" checked={synthesize} onChange={(e) => setSynthesize(e.target.checked)} /> {t('closingSynthesis')}
        </label>
      </div>
      <div className="action-bar u-justify-end" style={{ borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-3)' }}>
        <button type="button" className="primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('saveCadence')}</button>
      </div>
    </div>
  );
}
