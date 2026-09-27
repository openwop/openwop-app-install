/**
 * ArenaPage (ADR 0123 Phase 4c — the head-to-head arena UI).
 *
 * Two models answer the SAME prompt side-by-side; the rater picks a winner and
 * the verdict moves both models' head-to-head Elo (`POST …/arena/match` — the
 * rater is session-bound server-side).
 *
 * ONE-CHAT COMPLIANCE (the ADR 0123 backend comment: "the two live model
 * dispatches are normal runs — the FE arena drives them"): each pane is a NORMAL
 * conversation run opened through the EXISTING transport with the model pinned at
 * session-open (`openConversationSession({provider, model})`) — no bespoke
 * dispatch path, no second chat runtime. Replies render read-only (the
 * CompareView pattern); no `chatSessionId` metadata is attached, so arena runs
 * are ephemeral (they never appear in the conversations rail). Model pickers are
 * the existing ADR 0124 `ModelSwitcher`. BYOK/credential failures degrade to a
 * designed error linking /keys (the embedded-panel gate is not forked).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ModelSwitcher, type ModelChoice } from '../../chat/ModelSwitcher.js';
// ONE-CHAT COMPLIANCE (a9 port): render each pane's replies with the SHARED chat
// bubble (`MessageBubble`) and drive the shared prompt with the SHARED composer
// (`ChatInput`) — no hand-rolled bubble/composer CSS lives in this feature. The
// arena stays a distinct two-pane COMPARE surface (two live model streams sharing
// one prompt + a cross-pane vote), but the rendering rides the ONE chat's
// presentation layer.
import { MessageBubble } from '../../chat/MessageBubble.js';
import { ChatInput } from '../../chat/ChatInput.js';
import type { ChatMessage } from '../../chat/types.js';
import {
  openConversationSession, sendConversationTurn, closeConversationSession, turnsToBubbles,
  type ConversationBubble,
} from '../../chat/conversationTransport.js';
import { captureArenaMatch, listOrgs, type Org } from '../../client/evalsClient.js';

const PANES: CSSProperties = { display: 'flex', gap: 'var(--space-3)', alignItems: 'stretch', minHeight: 240 };
const PANE: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', border: '1px solid var(--rule)', borderRadius: 'var(--radius)', background: 'var(--paper)', padding: 'var(--space-3)' };
// Layout-only scroll column for a pane's feed (no bubble styling — each reply is a
// shared MessageBubble, which owns its own `.msgbubble-*` treatment).
const PANE_FEED: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 };

/** Project a transport ConversationBubble onto the ChatMessage shape the shared
 *  bubble renders. Display-only: no agent attribution (the pane header already
 *  names the model), no timestamps, no interrupts — arena replies are plain turns. */
function toChatMessage(b: ConversationBubble): ChatMessage {
  return { id: b.id, role: b.role, content: b.content, createdAt: '' };
}

type PaneKey = 'A' | 'B';
interface PaneState {
  choice: ModelChoice | null;
  session: { runId: string; nodeId: string } | null;
  bubbles: ConversationBubble[];
  sinceSeq: number;
  busy: boolean;
  error: boolean;
}
const emptyPane = (): PaneState => ({ choice: null, session: null, bubbles: [], sinceSeq: 0, busy: false, error: false });

function Pane({ label, pane, onPick, locked }: { label: string; pane: PaneState; onPick: (c: ModelChoice | null) => void; locked: boolean }): JSX.Element {
  const { t } = useTranslation('evals');
  return (
    <section style={PANE} aria-label={label}>
      <header className="u-flex u-items-center u-gap-2">
        <strong className="u-fs-12">{label}</strong>
        {locked
          ? <span className="chip">{pane.choice?.model ?? '—'}</span>
          : <ModelSwitcher value={pane.choice} onChange={onPick} />}
      </header>
      <div style={PANE_FEED}>
        {pane.bubbles.map((b) => (
          <MessageBubble key={b.id} message={toChatMessage(b)} />
        ))}
        {pane.busy ? <Skeleton height={40} /> : null}
        {pane.error ? (
          <p className="muted u-fs-12">
            {t('arenaPaneError')} <Link to="/keys">{t('arenaKeysLink')}</Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ArenaPage(): JSX.Element {
  const { t } = useTranslation('evals');
  const access = useFeatureAccess('evals');
  const [orgId, setOrgId] = useState('');
  const [a, setA] = useState<PaneState>(emptyPane());
  const [b, setB] = useState<PaneState>(emptyPane());
  const [result, setResult] = useState<{ ratingA: number; ratingB: number; winner: 'A' | 'B' | 'tie' } | null>(null);
  const [voting, setVoting] = useState(false);
  const [orgsUnavailable, setOrgsUnavailable] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    // `orgId` gates `vote()` (`if (!orgId …) return`), so an empty one makes the
    // three winner buttons SILENTLY DO NOTHING — the user rates a pair and the
    // result is discarded with no sign. Track the failure so the buttons can say
    // why instead of no-op'ing.
    void listOrgs()
      .then((o: Org[]) => { setOrgId(o[0]?.orgId ?? ''); setOrgsUnavailable(o.length === 0); })
      .catch(() => { setOrgId(''); setOrgsUnavailable(true); });
  }, [access.enabled]);

  // Best-effort close of both runs when leaving the page.
  useEffect(() => () => {
    for (const p of [a, b]) {
      if (p.session) void closeConversationSession(p.session.runId, p.session.nodeId).catch(() => { /* best-effort */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only close of the final sessions
  }, []);

  const locked = a.session !== null || b.session !== null; // models pin at the first send
  // Both sides need a model before a prompt can be fanned out; the prompt text
  // itself lives in the shared composer (ChatInput), which won't fire onSend empty.
  const modelsPicked = a.choice !== null && b.choice !== null;
  const busy = a.busy || b.busy;
  const bothSettled = !a.busy && !b.busy && a.bubbles.length > 0 && b.bubbles.length > 0 && !a.error && !b.error;

  const sendTo = useCallback(async (key: PaneKey, text: string): Promise<void> => {
    const [pane, setPane] = key === 'A' ? [a, setA] as const : [b, setB] as const;
    if (!pane.choice) return;
    setPane((p) => ({ ...p, busy: true, error: false }));
    try {
      let session = pane.session;
      if (!session) {
        // Model pinned at session-open — one conversation = one model identity
        // (the Elo verdict must be attributable). No chatSessionId ⇒ ephemeral.
        session = await openConversationSession({ provider: pane.choice.provider, model: pane.choice.model });
      }
      const res = await sendConversationTurn(session.runId, session.nodeId, { content: text }, pane.sinceSeq);
      const bubbles = turnsToBubbles(res.turns);
      setPane((p) => ({ ...p, session, bubbles: [...p.bubbles, ...bubbles], sinceSeq: res.lastSeq, busy: false }));
    } catch {
      setPane((p) => ({ ...p, busy: false, error: true }));
    }
  }, [a, b]);

  // The shared composer hands us the (trimmed) prompt; fan the SAME text to both
  // panes. No-op until both models are chosen (a hint above the composer says so).
  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || !modelsPicked) return;
    setResult(null);
    void sendTo('A', trimmed);
    void sendTo('B', trimmed);
  };

  const vote = async (winner: 'A' | 'B' | 'tie'): Promise<void> => {
    if (!orgId || !a.choice || !b.choice || voting) return;
    setVoting(true);
    try {
      const r = await captureArenaMatch(orgId, { modelA: a.choice.model, modelB: b.choice.model, winner });
      setResult({ ...r, winner });
    } catch {
      // EV-G1 — a failed capture was fully silent: the user voted, the match
      // never reached the leaderboard, and nothing said so.
      setResult(null);
      toast.error(t('voteCaptureFailed'));
    } finally {
      setVoting(false);
    }
  };

  const reset = (): void => {
    for (const p of [a, b]) {
      if (p.session) void closeConversationSession(p.session.runId, p.session.nodeId).catch(() => { /* best-effort */ });
    }
    setA(emptyPane());
    setB(emptyPane());
    setResult(null);
  };

  if (access.loading) return <div className="u-p-4"><Skeleton height={120} /></div>;
  if (!access.enabled) {
    return <StateCard icon={<ActivityIcon size={20} />} title={t('arenaDisabledTitle')} body={t('arenaDisabledBody')} />;
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('arenaEyebrow')}
        title={t('arenaTitle')}
        lede={t('arenaLede')}
        actions={
          <>
            {locked ? <Button variant="quiet" size="sm" onClick={reset}>{t('arenaNewMatch')}</Button> : null}
            {/* ADR 0718 D1 — the console tab, not `/leaderboard`: that path resolves to
                `kicktodo-engagement`'s gamification board (site-tier pre-emption in
                App.tsx), so this BACK button used to leave the feature entirely. */}
            <Link className="btn-ghost btn-sm" to="/models?tab=leaderboard">{t('arenaBackToLeaderboard')}</Link>
          </>
        }
      />

      <div style={PANES}>
        <Pane label={t('arenaModelA')} pane={a} onPick={(c) => setA((p) => ({ ...p, choice: c }))} locked={locked} />
        <Pane label={t('arenaModelB')} pane={b} onPick={(c) => setB((p) => ({ ...p, choice: c }))} locked={locked} />
      </div>

      <div className="u-mt-3">
        {!modelsPicked ? <p className="muted u-fs-12 u-mb-1-5">{t('arenaChooseModels')}</p> : null}
        {/* SHARED composer — one prompt fanned to both panes. supports*Input=false
            keeps the model-agnostic arena text-only (no attachment/voice affordances). */}
        <ChatInput
          onSend={submit}
          onCancel={null}
          disabled={busy}
          placeholder={t('arenaPromptPlaceholder')}
          supportsAudioInput={false}
          supportsImageInput={false}
          supportsPdfInput={false}
        />
      </div>

      {bothSettled && !result ? (
        <div className="u-flex u-gap-2 u-mt-3" role="group" aria-label={t('arenaVoteGroup')}>
          {orgsUnavailable ? <Notice variant="warning" announce={t('voteUnavailable')}>{t('voteUnavailable')}</Notice> : null}
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('A')}>{t('arenaVoteA')}</Button>
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('tie')}>{t('arenaVoteTie')}</Button>
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('B')}>{t('arenaVoteB')}</Button>
        </div>
      ) : null}

      {result ? (
        <p className="u-mt-3" role="status">
          {t('arenaResult', {
            winner: result.winner === 'tie' ? t('arenaVoteTie') : (result.winner === 'A' ? a.choice?.model : b.choice?.model),
            a: a.choice?.model, ratingA: Math.round(result.ratingA),
            b: b.choice?.model, ratingB: Math.round(result.ratingB),
          })}
        </p>
      ) : null}
    </div>
  );
}
