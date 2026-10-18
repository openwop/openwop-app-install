/**
 * CompareView (ADR 0117 Phase 3) — view two conversations side-by-side, read-only.
 * The branch affordance (Phase 2c) forks a conversation; compare lets you read a
 * conversation against another (e.g. a branch vs its parent, or two model runs).
 *
 * Read-only by design: it FETCHES each conversation's settled transcript
 * (`listChatSessionMessages`) and renders two columns — it does NOT spin up two live
 * sessions (no second chat runtime; the run event log stays the authoritative
 * transcript, per the ADR). Lazy-loaded, so zero entry-budget impact. Structural
 * styles are inline (layout props + design-token color references) to stay
 * self-contained + token-compliant (no raw hex).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { StateCard } from '../ui/index.js';
import { Button } from '../ui/Button.js';
import { listChatSessions, listChatSessionMessages, type ChatSessionHeader, type ChatMessagePersisted } from '../client/chatSessionsClient.js';

const PANE: CSSProperties = { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 12, minHeight: 0 };
const MSG_BASE: CSSProperties = { maxWidth: '90%', padding: '6px 10px', borderRadius: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

function Pane({ messages }: { messages: readonly ChatMessagePersisted[] }): JSX.Element {
  return (
    <div style={PANE}>
      {messages.length === 0
        ? <p className="muted u-fs-12">—</p>
        : messages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <div key={m.messageId} style={{ ...MSG_BASE, alignSelf: isUser ? 'flex-end' : 'flex-start', background: isUser ? 'var(--clay-text)' : 'var(--paper-2)', color: isUser ? 'var(--color-on-scrim)' : 'var(--ink)' }}>
                <span className="u-fs-11 u-o-70">{m.role}</span>
                <div className="u-fs-12">{m.content}</div>
              </div>
            );
          })}
    </div>
  );
}

export function CompareView({ currentSessionId, onClose }: { currentSessionId: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [sessions, setSessions] = useState<ChatSessionHeader[]>([]);
  const [left, setLeft] = useState<ChatMessagePersisted[] | null>(null);
  const [rightId, setRightId] = useState<string>('');
  const [right, setRight] = useState<ChatMessagePersisted[] | null>(null);
  // EMPTY-ON-FAIL-2 (ADR 0779 D7) — a failed transcript read is NOT an empty
  // conversation. Each pane used to set its messages to [] on failure and render the
  // empty-transcript "—". Each pane now keeps its own failed flag (checked first)
  // and a retry counter that re-runs only that pane's read.
  const [leftFailed, setLeftFailed] = useState(false);
  const [rightFailed, setRightFailed] = useState(false);
  const [leftAttempt, setLeftAttempt] = useState(0);
  const [rightAttempt, setRightAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void listChatSessions().then((s) => { if (live) setSessions(s); }).catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, [currentSessionId]);

  useEffect(() => {
    let live = true;
    setLeft(null);
    setLeftFailed(false);
    void listChatSessionMessages(currentSessionId).then((m) => { if (live) setLeft(m); }).catch(() => { if (live) setLeftFailed(true); });
    return () => { live = false; };
  }, [currentSessionId, leftAttempt]);

  useEffect(() => {
    setRightFailed(false);
    if (!rightId) { setRight(null); return undefined; }
    let live = true;
    setRight(null);
    void listChatSessionMessages(rightId).then((m) => { if (live) setRight(m); }).catch(() => { if (live) setRightFailed(true); });
    return () => { live = false; };
  }, [rightId, rightAttempt]);

  const failedPane = (retry: () => void): JSX.Element => (
    <StateCard
      announce
      title={tc('loadFailedTitle')}
      body={tc('loadFailedBody')}
      action={<Button variant="secondary" size="sm" onClick={retry}>{tc('retry')}</Button>}
    />
  );

  const others = useMemo(() => sessions.filter((s) => s.sessionId !== currentSessionId), [sessions, currentSessionId]);
  const col: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--rule)' };

  return (
    <Modal label={t('compareTitle')} onClose={onClose} className="surface-card">
      <div className="compareview-body">
        <div style={col}>
          <h3 className="u-fs-12 u-fw-600 u-p-2">{t('compareThis')}</h3>
          {leftFailed ? failedPane(() => setLeftAttempt((n) => n + 1)) : left === null ? <StateCard loading title={t('artifactLoading')} /> : <Pane messages={left} />}
        </div>
        <div style={{ ...col, borderRight: 'none' }}>
          <select className="u-m-2" value={rightId} onChange={(e) => setRightId(e.target.value)} aria-label={t('compareWith')}>
            <option value="">{t('comparePick')}</option>
            {others.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.title}</option>)}
          </select>
          {rightId && rightFailed ? failedPane(() => setRightAttempt((n) => n + 1)) : rightId && right === null ? <StateCard loading title={t('artifactLoading')} /> : right ? <Pane messages={right} /> : null}
        </div>
      </div>
    </Modal>
  );
}
