/**
 * ADR 0910 D11 — the "Operator access" panel on KickTodo People & access.
 *
 * Shown to a LISTED superadmin only. Activation is just-in-time and time-boxed:
 * the person re-authenticates in a popup (and enters their second factor when
 * asked), and the host then grants KickTodo authoring + publication (including
 * approving their own submission) and the workspace's AI keys until it expires.
 * The copy says exactly that, and every refusal has its own state.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField, TextareaField, TextField } from '../../ui/Field.js';
import { useEffectiveAccessState } from '../../client/useEffectiveAccess.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { formatDateTime } from '../../i18n/format.js';
import { readErrorDetail } from '../../client/errorEnvelope.js';
import { ApiError } from '../../client/requestJson.js';
import {
  activateOperatorAccess, endOperatorAccess, listOperatorActivations, type OperatorActivation,
} from '../../client/operatorAccessClient.js';
import { switchWorkspace } from '../../client/workspaceClient.js';
import { fireAuthChanged } from '../../client/config.js';
import { completeMfaSignIn, MfaRequiredError } from '../../auth/firebase.js';
import { getFreshIdToken, reauthenticateForStepUp, StepUpUnsupportedError } from '../../auth/stepUp.js';

/** The system-owned KickTodo default workspace (ADR 0684). */
export const OPERATOR_WORKSPACE = 'host-kicktodo';
const DURATIONS = [60, 120, 240, 480] as const;
const MIN_JUSTIFICATION = 10;

/** Whole minutes left before `iso`, never negative. */
export function minutesLeft(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 60_000));
}

type Phase = 'idle' | 'working' | 'code';
/** A refusal code from the host, or a client-side step-up failure. */
type Problem = 'mfa_required' | 'reauth_required' | 'not_eligible' | 'already_active' | 'unsupported' | 'failed';

function problemOf(err: unknown): Problem {
  if (err instanceof StepUpUnsupportedError) return 'unsupported';
  if (err instanceof ApiError) {
    const code = readErrorDetail(err.body, 'code');
    if (code === 'mfa_required' || code === 'reauth_required' || code === 'not_eligible' || code === 'already_active') return code;
  }
  return 'failed';
}

export function OperatorAccessPanel(): JSX.Element | null {
  const { t } = useTranslation('kicktodo-admin');
  const { access, resolved } = useEffectiveAccessState();
  const callerSubject = useBackendSession().user?.userId;
  const eligible = resolved && access.superadmin === true;

  const [rows, setRows] = useState<OperatorActivation[] | null | undefined>(undefined);
  const [justification, setJustification] = useState('');
  const [minutes, setMinutes] = useState<number>(480);
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Announce the activation once, when THIS person just completed it — not on
  // every mount of a page that merely shows a live activation (state, not action).
  const [justActivated, setJustActivated] = useState(false);

  const reload = useCallback(() => {
    setRows(undefined);
    listOperatorActivations(OPERATOR_WORKSPACE).then(setRows, () => setRows(null));
  }, []);
  useEffect(() => { if (eligible) { setJustActivated(false); reload(); } }, [eligible, callerSubject, reload]);

  // The workspace history includes OTHER operators. Only this canonical
  // subject's activation controls this person's activation/revocation actions.
  const live = (rows ?? []).find((a) => a.subject === callerSubject && !a.revokedAt && Date.parse(a.expiresAt) > now);
  // Tick only while an activation is live; stop once it lapses.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [live]);

  if (!eligible) return null;

  const activateWith = async (token: string): Promise<void> => {
    await activateOperatorAccess(OPERATOR_WORKSPACE, { justification: justification.trim(), durationMinutes: minutes }, token);
    setJustification('');
    setCode('');
    setPhase('idle');
    setNow(Date.now());
    setJustActivated(true);
    reload();
  };

  const start = async (): Promise<void> => {
    setProblem(null);
    setPhase('working');
    try {
      await activateWith(await reauthenticateForStepUp());
    } catch (err) {
      if (err instanceof MfaRequiredError) { setPhase('code'); return; }
      setProblem(problemOf(err));
      setPhase('idle');
    }
  };

  const finishWithCode = async (): Promise<void> => {
    setProblem(null);
    setPhase('working');
    let mfaCompleted = false;
    try {
      await completeMfaSignIn(code.trim());
      mfaCompleted = true;
      const token = await getFreshIdToken();
      if (!token) throw new Error('signed out');
      await activateWith(token);
    } catch (err) {
      setProblem(problemOf(err));
      // A successful MFA step consumes its resolver, even if the later token
      // refresh or activation request fails. Restart step-up in that case.
      if (mfaCompleted) setCode('');
      setPhase(mfaCompleted ? 'idle' : 'code');
    }
  };

  const endNow = async (): Promise<void> => {
    setProblem(null);
    try {
      await endOperatorAccess(OPERATOR_WORKSPACE);
      reload();
    } catch (err) {
      setProblem(problemOf(err));
    }
  };

  const switchIn = async (): Promise<void> => {
    await switchWorkspace(OPERATOR_WORKSPACE);
    fireAuthChanged();
    window.location.reload();
  };

  const tooShort = justification.trim().length < MIN_JUSTIFICATION;

  return (
    <section className="surface-card" aria-label={t('operatorTitle')}>
      <h2 className="kt-eyebrow">{t('operatorTitle')}</h2>
      <p>{t('operatorGrants')}</p>

      {problem ? <Notice variant="error" announce={t(`operatorProblem_${problem}`)}>{t(`operatorProblem_${problem}`)}</Notice> : null}

      {rows === undefined ? <p>{t('operatorLoading')}</p> : null}
      {rows === null ? (
        <Notice variant="error" announce={t('operatorLoadError')}>
          {t('operatorLoadError')} <Button variant="secondary" size="sm" onClick={reload}>{t('operatorRetry')}</Button>
        </Notice>
      ) : null}

      {rows && live ? (
        <div>
          <Notice variant="success" {...(justActivated ? { announce: t('operatorActivated') } : {})}>{t('operatorLive', { count: minutesLeft(live.expiresAt, now) })}</Notice>
          <div className="action-bar">
            <Button onClick={() => void switchIn()}>{t('operatorSwitch')}</Button>
            <Button variant="secondary" onClick={() => void endNow()}>{t('operatorEnd')}</Button>
          </div>
        </div>
      ) : null}

      {rows && !live && phase !== 'code' ? (
        <div className="surface-form">
          <TextareaField
            label={t('operatorJustification')}
            help={t('operatorJustificationHelp')}
            required
            value={justification}
            maxLength={500}
            onChange={(e) => setJustification(e.target.value)}
          />
          <SelectField label={t('operatorDuration')} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((m) => <option key={m} value={m}>{t('operatorHours', { count: m / 60 })}</option>)}
          </SelectField>
          <Button onClick={() => void start()} disabled={tooShort} loading={phase === 'working'}>{t('operatorActivate')}</Button>
        </div>
      ) : null}

      {phase === 'code' || (phase === 'working' && code) ? (
        <div className="surface-form">
          <TextField
            label={t('operatorCode')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button onClick={() => void finishWithCode()} disabled={code.trim().length < 6} loading={phase === 'working'}>{t('operatorConfirm')}</Button>
        </div>
      ) : null}

      {rows && rows.length > 0 ? (
        <>
          <h3>{t('operatorHistory')}</h3>
          <ul>
            {rows.map((a) => (
              <li key={a.activationId}>
                {t(a.revokedAt ? 'operatorRowEnded' : Date.parse(a.expiresAt) > now ? 'operatorRowLive' : 'operatorRowExpired', {
                  when: formatDateTime(a.activatedAt), reason: a.justification,
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
