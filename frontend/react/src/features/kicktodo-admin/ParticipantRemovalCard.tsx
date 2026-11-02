/**
 * ADR 0910 D12 — "Remove from KickTodo", shown inside the Operator access panel
 * while the caller's activation is live. The lens stays aggregate-only (ADR 0438
 * A4): nothing here lists members. The operator types who to remove (a name,
 * email or member id); a dry run names the one match, a confirm dialog repeats
 * it, and only then is the person removed. A removed participant is not joined
 * again on their next sign-in (ADR 0684 §7).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { TextareaField, TextField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { readErrorDetail } from '../../client/errorEnvelope.js';
import { ApiError } from '../../client/requestJson.js';
import { removeParticipant } from '../../client/participantRemovalClient.js';

const MIN_REASON = 10;
const PROBLEMS = ['operator_activation_required', 'cannot_remove_self', 'cannot_remove_superadmin', 'not_a_participant', 'ambiguous'] as const;
type Problem = (typeof PROBLEMS)[number] | 'not_found' | 'failed';

function problemOf(err: unknown): Problem {
  if (err instanceof ApiError) {
    const code = readErrorDetail(err.body, 'code');
    if (typeof code === 'string' && (PROBLEMS as readonly string[]).includes(code)) return code as Problem;
    if (err.status === 404) return 'not_found';
  }
  return 'failed';
}

export function ParticipantRemovalCard({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [member, setMember] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ready = member.trim().length > 0 && reason.trim().length >= MIN_REASON;

  const remove = async (): Promise<void> => {
    setProblem(null);
    setDone(null);
    setBusy(true);
    try {
      const body = { member: member.trim(), reason: reason.trim() };
      const match = await removeParticipant(workspaceId, { ...body, dryRun: true });
      const ok = await confirm({
        title: t('removalConfirmTitle', { name: match.displayName }),
        body: t('removalConfirmBody'),
        confirmLabel: t('removalConfirm'),
        danger: true,
      });
      if (!ok) return;
      // Remove the row the dry run named, not whatever the text matches now.
      await removeParticipant(workspaceId, { member: match.memberId, reason: body.reason });
      setMember('');
      setReason('');
      setDone(match.displayName);
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface-form" aria-label={t('removalTitle')} role="group">
      <h3>{t('removalTitle')}</h3>
      <p className="muted u-fs-13">{t('removalHelp')}</p>
      {problem ? <Notice variant="error" announce={t(`removalProblem_${problem}`)}>{t(`removalProblem_${problem}`)}</Notice> : null}
      {done ? <Notice variant="success" announce={t('removalDone', { name: done })}>{t('removalDone', { name: done })}</Notice> : null}
      <TextField label={t('removalMember')} help={t('removalMemberHelp')} value={member} onChange={(e) => setMember(e.target.value)} />
      <TextareaField
        label={t('removalReason')}
        help={t('removalReasonHelp')}
        required
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button variant="danger" onClick={() => void remove()} disabled={!ready} loading={busy}>{t('removalSubmit')}</Button>
    </div>
  );
}
