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
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatNumber } from '../../i18n/format.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField } from '../../ui/Field.js';
import { MessageSquareIcon, SparklesIcon, UserIcon, ZapIcon } from '../../ui/icons/index.js';
import { listRoster, type RosterEntry } from '../../agents/rosterClient.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { ensureProjectChat, updateChatCadence, type Project, type TurnPolicy } from './projectsClient.js';

export function ProjectChatTab({ project, canWrite, onSaved }: { project: Project; canWrite: boolean; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  // The roster read resolves agent ids to persona NAMES. Swallowed, a failure left
  // `roster` empty and the `?? rosterId` fallback below rendered every agent as its raw
  // id — a label that looks like data. Worse, that fallback is IDENTICAL to the
  // legitimate "this agent is not in the roster" case, so nothing on screen could tell
  // "unknown agent" from "we never read the roster".
  const [rosterFailed, setRosterFailed] = useState(false);
  useEffect(() => { void listRoster().then((r) => { setRoster(r); setRosterFailed(false); }).catch(() => setRosterFailed(true)); }, []);

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
    // PROJ-UX-1 — the localized classification, never the raw dev-string
    // (`ensureProjectChat failed (403)`) this rendered in all four locales.
    } catch (e) { setError(e instanceof Error ? loadErrorMessage(t, e) : t('openChatError')); setBusy(false); }
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
            {/* Names below are raw ids, and say so rather than passing as personas. The
                chat itself still works, so this warns without blocking. */}
            {rosterFailed ? <Notice variant="warning" announce={t('rosterFailedNotice')}>{t('rosterFailedNotice')}</Notice> : null}
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
        {/* ADR 0608 D8 (`CPC-4`) — CORRECTED 2026-08-24. This used to render only
            `if (canWrite)`, with a notice telling a read-only member that "opening
            the project chat needs edit access (workspace:write) in this project's
            org". The SERVER gates `POST /:id/chat` on project READ and says so
            in-line (`projects/routes.ts:418-422`), and ADR 0054 D3 is explicit that
            a private project's chat is readable by its MEMBERS. So the copy stated
            a rule the server does not enforce, and it locked out exactly the
            population `visibility:'private'` + membership exists to serve — "the
            shared room isn't shared", which is the defect ADR 0054's own D3
            correction closed server-side, reintroduced on the client.

            The old justification ("opening reconciles the lineup, a write") was the
            frontend RE-DERIVING an authority rule, which is the one thing ADR 0063
            exists to stop (`routes.ts:127`: "the FE never re-derives the rule").
            The page the caller is already looking at required project read; so does
            this button. The CADENCE EDITOR below stays `canWrite`-gated — that one
            really is a write (`PATCH /projects/:id`). */}
        <div className="action-bar u-justify-start">
          <Button variant="primary" disabled={busy} onClick={() => void open()}>
            <MessageSquareIcon size={14} /> {busy ? t('opening') : t('openProjectChat')}
          </Button>
        </div>
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
    } catch (e) {
      // PROJ-UX-1 — the server's cadence refusals are TYPED (the client now
      // carries `status` + the parsed envelope); each gets its own localized
      // sentence instead of the raw `updateChatCadence failed (400)` that also
      // discarded the reason.
      // 422 = moderator not a project agent member (the D6 invariant);
      // 404 with `details.moderatorRosterId` = moderator gone from the roster
      //     (that detail rides ONLY the roster arm — adversarial-review F4: a
      //     bare 404 is the PROJECT arm: deleted, or access revoked, and calling
      //     that "moderator missing" sent the user hunting the wrong object);
      // 400 = the cadence patch itself was rejected as invalid.
      const err = e && typeof e === 'object' ? (e as { status?: unknown; body?: { details?: { moderatorRosterId?: unknown } } }) : undefined;
      const status = err?.status;
      setError(
        status === 422 ? t('cadenceModeratorNotMember')
          : status === 404 && err?.body?.details?.moderatorRosterId !== undefined ? t('cadenceModeratorMissing')
            : status === 404 ? t('cadenceProjectGone')
              : status === 400 ? t('cadenceRejected')
                : e instanceof Error ? loadErrorMessage(t, e) : t('cadenceSaveError'));
    }
    finally { setBusy(false); }
  };

  return (
    <div className="surface-card u-flex u-flex-col u-gap-3">
      <div className="u-flex u-items-center u-gap-2"><ZapIcon size={16} /> <strong className="u-fs-15">{t('conveneCadenceHeading')}</strong></div>
      <p className="muted u-fs-12 u-m-0">
        {t('cadenceHelp', { max: formatNumber(Math.min(8, agentMembers.length)) })}
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {saved ? <Notice variant="success" announce={t('cadenceSaved')}>{t('cadenceSaved')}</Notice> : null}
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
        <label className="u-flex u-items-center u-gap-1 u-fs-13 proj-composer-side">
          <input type="checkbox" checked={synthesize} onChange={(e) => setSynthesize(e.target.checked)} /> {t('closingSynthesis')}
        </label>
      </div>
      <div className="action-bar u-justify-end action-bar--divided">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('saveCadence')}</Button>
      </div>
    </div>
  );
}
