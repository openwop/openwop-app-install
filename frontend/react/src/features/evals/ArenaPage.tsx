/**
 * ArenaPage (ADR 0123 Phase 4c, rebuilt by ADR 0986 D7) — a BLIND head-to-head.
 *
 * You pick two contestants above the panes. On the first send the page assigns
 * them to "Model A" and "Model B" at random and keeps which is which hidden until
 * you vote. Each pane is a NORMAL conversation run opened through the existing
 * transport, with the model pinned at session-open AND the credential you hold
 * for that provider (architect B2 — without it the host answered both panes with
 * the managed tier). The vote posts the two RUN ids; the server reads which model
 * answered each run, records the verdict once per pair, and names the models in
 * its reply — that is the reveal.
 *
 * A match is one comparison: once a pane fails, or a verdict is in, the match is
 * over and "New match" starts the next one — the server refuses a verdict on runs
 * that did not answer the same prompts, so continuing would only end in a refusal.
 *
 * ONE-CHAT COMPLIANCE: replies render through the shared `MessageBubble`, the
 * prompt through the shared `ChatInput`; no `chatSessionId` is attached, so arena
 * runs never appear in the conversations rail.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { announce } from '../../ui/announce.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ModelSwitcher, type ModelChoice } from '../../chat/ModelSwitcher.js';
import { MessageBubble } from '../../chat/MessageBubble.js';
import { ChatInput } from '../../chat/ChatInput.js';
import type { ChatMessage } from '../../chat/types.js';
import {
  openConversationSession, sendConversationTurn, closeConversationSession, turnsToBubbles,
  type ConversationBubble,
} from '../../chat/conversationTransport.js';
import { listStoredRefs } from '../../byok/lib/byokClient.js';
import { PROVIDERS } from '../../byok/lib/providers.js';
import { captureArenaMatch, listOrgs, EvalsHttpError, type ArenaMatchResult, type Org } from '../../client/evalsClient.js';
import { arenaCredentialRef } from './arenaCredential.js';

const PANES: CSSProperties = { display: 'flex', gap: 'var(--space-3)', alignItems: 'stretch', minHeight: 240, flexWrap: 'wrap' };
const PANE: CSSProperties = { flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', border: '1px solid var(--rule)', borderRadius: 'var(--radius)', background: 'var(--paper)', padding: 'var(--space-3)' };
// Layout-only scroll column; each reply is a shared MessageBubble.
const PANE_FEED: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', overflowY: 'auto', flex: 1 };

/** Display-only projection: no agent attribution, no timestamps, no interrupts —
 *  and so nothing in a bubble names the model before the reveal. */
function toChatMessage(b: ConversationBubble): ChatMessage {
  return { id: b.id, role: b.role, content: b.content, createdAt: '' };
}

type PaneKey = 'A' | 'B';
interface Contestant { choice: ModelChoice; credentialRef: string }
interface PaneState {
  contestant: Contestant | null;
  session: { runId: string; nodeId: string } | null;
  bubbles: ConversationBubble[];
  sinceSeq: number;
  busy: boolean;
  error: boolean;
}
const emptyPane = (): PaneState => ({ contestant: null, session: null, bubbles: [], sinceSeq: 0, busy: false, error: false });

/** Why the arena will not start a match with these two picks. */
type PickProblem = { kind: 'same-model' } | { kind: 'same-tier' } | { kind: 'no-key'; provider: string } | { kind: 'keys-unreadable'; provider: string };

const isManaged = (provider: string): boolean => PROVIDERS.some((p) => p.id === provider && p.managed);

/** The server's refusal reasons → the sentence that says what to do. Anything
 *  else is a transient capture failure, which a retry can fix. */
const REFUSAL_KEYS: Record<string, string> = {
  arena_same_model: 'arenaRefusedSameModel',
  arena_prompt_mismatch: 'arenaRefusedPromptMismatch',
  arena_unattributed: 'arenaRefusedUnattributed',
  arena_mixed_models: 'arenaRefusedMixedModels',
  arena_rater_cap: 'arenaRefusedRaterCap',
};

function Pane({ label, pane, revealed }: { label: string; pane: PaneState; revealed: string | null }): JSX.Element {
  const { t } = useTranslation('evals');
  return (
    <section style={PANE} aria-label={label}>
      <header className="u-flex u-items-center u-gap-2">
        <strong className="u-fs-12">{label}</strong>
        <span className="chip chip--muted">{revealed ?? t('arenaHidden')}</span>
      </header>
      <div style={PANE_FEED}>
        {pane.bubbles.map((b) => <MessageBubble key={b.id} message={toChatMessage(b)} />)}
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
  const f = useFormat();
  const access = useFeatureAccess('evals');
  const [orgId, setOrgId] = useState('');
  const [orgsUnavailable, setOrgsUnavailable] = useState(false);
  // `null` until the read settles: a send before then would wrongly say "no key".
  const [storedRefs, setStoredRefs] = useState<readonly string[] | null>(null);
  const [refsFailed, setRefsFailed] = useState(false);
  const [picks, setPicks] = useState<[ModelChoice | null, ModelChoice | null]>([null, null]);
  const [problem, setProblem] = useState<PickProblem | null>(null);
  const [a, setA] = useState<PaneState>(emptyPane());
  const [b, setB] = useState<PaneState>(emptyPane());
  // A pane failed during this match: its prompts no longer match the other's, so
  // no verdict can count. Sticky until "New match".
  const [matchBroken, setMatchBroken] = useState(false);
  const [result, setResult] = useState<ArenaMatchResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  // The live sessions, for the unmount close (state read in an unmount effect is
  // the first render's — empty — so the old close ran on nothing).
  const sessionsRef = useRef<Array<{ runId: string; nodeId: string }>>([]);

  useEffect(() => {
    if (!access.enabled) return;
    // An empty `orgId` would make the vote buttons do nothing; say why instead.
    void listOrgs()
      .then((o: Org[]) => { setOrgId(o[0]?.orgId ?? ''); setOrgsUnavailable(o.length === 0); })
      .catch(() => { setOrgId(''); setOrgsUnavailable(true); });
    // A failed read is its own state: a BYOK contestant is then refused with a
    // "could not read your keys" notice — never told it has no key, and never
    // silently answered by the managed tier.
    void listStoredRefs()
      .then((refs) => { setStoredRefs(refs); setRefsFailed(false); })
      .catch(() => { setRefsFailed(true); setStoredRefs([]); });
  }, [access.enabled]);

  useEffect(() => () => {
    for (const s of sessionsRef.current) void closeConversationSession(s.runId, s.nodeId).catch(() => { /* best-effort */ });
  }, []);

  const started = a.contestant !== null; // sides are assigned at the first send
  const picked = picks[0] !== null && picks[1] !== null;
  const busy = a.busy || b.busy;
  const over = result !== null || matchBroken;
  const bothSettled = !a.busy && !b.busy && a.bubbles.length > 0 && b.bubbles.length > 0 && !matchBroken;

  const pick = (i: 0 | 1, c: ModelChoice | null): void => {
    setProblem(null);
    setPicks((p) => (i === 0 ? [c, p[1]] : [p[0], c]));
  };

  const sendTo = useCallback(async (key: PaneKey, contestant: Contestant, text: string): Promise<void> => {
    const [pane, setPane] = key === 'A' ? [a, setA] as const : [b, setB] as const;
    setPane((p) => ({ ...p, contestant, busy: true, error: false }));
    try {
      let session = pane.session;
      if (!session) {
        // One run = one model identity, so the server can attribute the verdict.
        session = await openConversationSession({ provider: contestant.choice.provider, model: contestant.choice.model, credentialRef: contestant.credentialRef });
        sessionsRef.current.push(session);
      }
      const res = await sendConversationTurn(session.runId, session.nodeId, { content: text }, pane.sinceSeq);
      setPane((p) => ({ ...p, session, bubbles: [...p.bubbles, ...turnsToBubbles(res.turns)], sinceSeq: res.lastSeq, busy: false }));
    } catch {
      setMatchBroken(true);
      setPane((p) => ({ ...p, busy: false, error: true }));
    }
  }, [a, b]);

  /** The two contestants with their credentials, or why there are none. */
  const contestantsFor = (p1: ModelChoice, p2: ModelChoice): Contestant[] | PickProblem => {
    if (p1.provider === p2.provider && p1.model === p2.model) return { kind: 'same-model' };
    // A managed tier picks its own model, so two picks under one tier are one contestant.
    if (p1.provider === p2.provider && isManaged(p1.provider)) return { kind: 'same-tier' };
    const out: Contestant[] = [];
    for (const choice of [p1, p2]) {
      const credentialRef = arenaCredentialRef(choice.provider, storedRefs ?? []);
      if (!credentialRef) return { kind: refsFailed ? 'keys-unreadable' : 'no-key', provider: choice.provider };
      out.push({ choice, credentialRef });
    }
    return out;
  };

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || !picks[0] || !picks[1] || storedRefs === null || over) return;
    let sides: [Contestant, Contestant];
    if (a.contestant && b.contestant) {
      sides = [a.contestant, b.contestant];
    } else {
      const c = contestantsFor(picks[0], picks[1]);
      if (!Array.isArray(c)) { setProblem(c); return; }
      setProblem(null);
      // Blind: which contestant is "Model A" is decided here, at random, and not shown.
      sides = Math.random() < 0.5 ? [c[0]!, c[1]!] : [c[1]!, c[0]!];
    }
    void sendTo('A', sides[0], trimmed);
    void sendTo('B', sides[1], trimmed);
  };

  const winnerLabel = (r: ArenaMatchResult): string =>
    r.match.winner === 'tie' ? t('arenaVoteTie') : r.match.winner === 'A' ? r.match.modelA : r.match.modelB;
  const resultText = (r: ArenaMatchResult): string => t(r.replayed ? 'arenaReplayedResult' : 'arenaResult', {
    winner: winnerLabel(r),
    a: r.match.modelA, ratingA: f.number(Math.round(r.ratingA)),
    b: r.match.modelB, ratingB: f.number(Math.round(r.ratingB)),
  });

  const vote = async (winner: 'A' | 'B' | 'tie'): Promise<void> => {
    if (!orgId || !a.session || !b.session || voting) return;
    setVoting(true);
    setRefusal(null);
    try {
      const r = await captureArenaMatch(orgId, { runIdA: a.session.runId, runIdB: b.session.runId, winner });
      setResult(r);
      announce(resultText(r));
    } catch (err) {
      // EV-G1 — a failed capture must say so. A refusal names its reason (a retry
      // cannot fix it); anything else is transient and worth one more try.
      const key = err instanceof EvalsHttpError && err.reason ? REFUSAL_KEYS[err.reason] : undefined;
      setRefusal(key ? t(key) : t('voteCaptureFailed'));
      // A refusal is permanent for this pair: end the match so the buttons can't repeat it.
      if (key) setMatchBroken(true);
    } finally {
      setVoting(false);
    }
  };

  const reset = (): void => {
    for (const s of sessionsRef.current) void closeConversationSession(s.runId, s.nodeId).catch(() => { /* best-effort */ });
    sessionsRef.current = [];
    setA(emptyPane());
    setB(emptyPane());
    setResult(null);
    setRefusal(null);
    setMatchBroken(false);
  };

  if (access.loading) return <div className="u-p-4"><Skeleton height={120} /></div>;
  if (!access.enabled) {
    return <StateCard icon={<ActivityIcon size={20} />} title={t('arenaDisabledTitle')} body={t('arenaDisabledBody')} />;
  }

  const problemText = (p: PickProblem): string =>
    p.kind === 'same-model' ? t('arenaSameModel')
      : p.kind === 'same-tier' ? t('arenaSameTier')
      : p.kind === 'keys-unreadable' ? t('arenaKeysUnreadable', { provider: p.provider })
      : t('arenaMissingKey', { provider: p.provider });

  return (
    <div>
      <PageHeader
        eyebrow={t('arenaEyebrow')}
        title={t('arenaTitle')}
        lede={t('arenaLede')}
        actions={
          <>
            {started ? <Button variant="quiet" size="sm" onClick={reset}>{t('arenaNewMatch')}</Button> : null}
            {/* ADR 0718 D1 — the console tab: `/leaderboard` belongs to kicktodo-engagement. */}
            <Link className="btn-ghost btn-sm" to="/models?tab=leaderboard">{t('arenaBackToLeaderboard')}</Link>
          </>
        }
      />

      <fieldset className="u-flex u-gap-3 u-items-center u-mb-3 u-flex-wrap u-border-none u-p-0" disabled={started} aria-describedby="arena-contestants-hint">
        <legend className="u-fs-12">{t('arenaContestants')}</legend>
        <ModelSwitcher label={t('arenaContestant1')} emptyOptionLabel={t('arenaChooseModel')} value={picks[0]} onChange={(c) => pick(0, c)} />
        <ModelSwitcher label={t('arenaContestant2')} emptyOptionLabel={t('arenaChooseModel')} value={picks[1]} onChange={(c) => pick(1, c)} />
        <p id="arena-contestants-hint" className="muted u-fs-12">{t('arenaBlindHint')}</p>
      </fieldset>
      {problem ? (
        <Notice variant="warning">
          {problemText(problem)}
          {problem.kind === 'no-key' || problem.kind === 'keys-unreadable' ? <> <Link to="/keys">{t('arenaKeysLink')}</Link></> : null}
        </Notice>
      ) : null}

      <div style={PANES}>
        <Pane label={t('arenaModelA')} pane={a} revealed={result ? result.match.modelA : null} />
        <Pane label={t('arenaModelB')} pane={b} revealed={result ? result.match.modelB : null} />
      </div>

      <div className="u-mt-3">
        {!picked ? <p className="muted u-fs-12 u-mb-1-5">{t('arenaChooseModels')}</p> : null}
        {over ? <p className="muted u-fs-12 u-mb-1-5">{matchBroken && !result ? t('arenaMatchBroken') : t('arenaMatchOver')}</p> : null}
        <ChatInput
          onSend={submit}
          onCancel={null}
          disabled={busy || over || storedRefs === null}
          placeholder={t('arenaPromptPlaceholder')}
          supportsAudioInput={false}
          supportsImageInput={false}
          supportsPdfInput={false}
        />
      </div>

      {bothSettled && !result ? (
        <div className="u-flex u-gap-2 u-mt-3 u-flex-wrap" role="group" aria-label={t('arenaVoteGroup')}>
          {orgsUnavailable ? <Notice variant="warning" announce={t('voteUnavailable')}>{t('voteUnavailable')}</Notice> : null}
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('A')}>{t('arenaVoteA')}</Button>
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('tie')}>{t('arenaVoteTie')}</Button>
          <Button variant="secondary" size="sm" disabled={voting || !orgId} title={!orgId ? t('voteUnavailable') : undefined} onClick={() => void vote('B')}>{t('arenaVoteB')}</Button>
        </div>
      ) : null}
      {refusal ? <div className="u-mt-3"><Notice variant="error">{refusal}</Notice></div> : null}
      {result ? <p className="u-mt-3">{resultText(result)}</p> : null}
    </div>
  );
}
