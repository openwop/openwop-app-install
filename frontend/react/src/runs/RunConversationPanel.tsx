/**
 * Per-run multi-turn conversation view.
 *
 * Consumes `conversation.opened` / `conversation.exchanged` /
 * `conversation.closed` events (RFC 0005, `schemas/conversation-event.schema.json`)
 * and renders one card per active `conversationId` with the turn history in
 * order: `initialTurn` (turnIndex 0) → exchanged (turnIndex 1+) → finalTurn.
 *
 * When the run's active interrupt is `kind: 'conversation.exchange'`, the
 * panel surfaces an inline resume form (text input when `outcomeSchema` is
 * absent or a single-string scalar; raw JSON otherwise so the user can
 * compose to the contract). `kind: 'conversation.close'` exposes a
 * confirm-close button. Resolution routes through the existing token-scoped
 * interrupt endpoint (`POST /v1/interrupts/{token}`) — RFC 0005 §B.
 *
 * Render contract — the panel returns `null` when no `conversation.*`
 * events have arrived (graceful when the host doesn't advertise
 * `capabilities.conversationPrimitive: true`, which today is every
 * reference host; the panel is forward-compatible). The conversation
 * primitive is shipped on the wire but no reference host advertises
 * it yet; this panel is ready when one does.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunEventDoc } from '@openwop/openwop';
import { resolveByToken, type OpenInterrupt } from '../client/interruptsClient.js';
import i18n from '../i18n/index.js';

interface ConversationTurn {
  messageId: string;
  from: string;
  to?: string | undefined;
  role: 'user' | 'agent' | 'system';
  turnIndex: number;
  content: unknown;
  ts: number;
}

interface ConversationView {
  conversationId: string;
  agentId?: string | undefined;
  capabilities: readonly string[];
  schema?: Record<string, unknown> | undefined;
  turns: ConversationTurn[];
  closed: boolean;
  outcome?: unknown;
}

interface Props {
  events: readonly RunEventDoc[];
  activeInterrupt: OpenInterrupt | null;
  onResolved(): void;
}

/** Maps a conversation turn role to its display key. */
const TURN_ROLE_KEYS: Record<ConversationTurn['role'], string> = {
  user: 'turnRoleUser',
  agent: 'turnRoleAgent',
  system: 'turnRoleSystem',
};

export function RunConversationPanel({ events, activeInterrupt, onResolved }: Props) {
  const { t } = useTranslation('runs');
  const conversations = useMemo(() => groupConversations(events), [events]);
  // Suppress the panel entirely when the host hasn't surfaced any
  // conversation events. Keeps RunDetailPage uncluttered for the common
  // case (reference hosts don't advertise the primitive today).
  if (conversations.length === 0) return null;
  return (
    <section className="card" aria-label={t('conversationsAria')}>
      <h2>{t('conversationsHeading')}</h2>
      <p className="muted runconv-subhead">
        {t('conversationsSubheadPre')}<code>core.conversationGate</code>{t('conversationsSubheadPost')}
      </p>
      {conversations.map((c) => (
        <ConversationCard
          key={c.conversationId}
          conversation={c}
          activeInterrupt={activeInterrupt}
          onResolved={onResolved}
        />
      ))}
    </section>
  );
}

function ConversationCard({
  conversation,
  activeInterrupt,
  onResolved,
}: {
  conversation: ConversationView;
  activeInterrupt: OpenInterrupt | null;
  onResolved(): void;
}) {
  const { t } = useTranslation('runs');
  const { conversationId, agentId, capabilities, turns, closed, outcome } = conversation;
  // The active interrupt belongs to this conversation only when its
  // payload carries a matching `conversationId`. Open interrupts of
  // other kinds (approval / clarification / etc.) don't apply here.
  const interruptForThis = matchInterrupt(activeInterrupt, conversationId);
  return (
    <div className="conversation-card">
      <div className="conversation-card__head">
        <strong className="conversation-card__id">{conversationId}</strong>
        {agentId && <span className="muted u-fs-12">{t('conversationAgentLabel')} <code>{agentId}</code></span>}
        {capabilities.length > 0 && (
          <span className="muted u-fs-12">
            {t('conversationCapsLabel')} {capabilities.map((c) => <code key={c} className="u-mr-1">{c}</code>)}
          </span>
        )}
        {closed && <span className="badge runconv-closed-badge">{t('conversationClosedBadge')}</span>}
      </div>
      <ol className="conversation-turn-list">
        {turns.map((turn) => (
          <li key={turn.messageId} className={`conversation-turn conversation-turn--${turn.role}`}>
            <span className="conversation-turn__role">
              {t(TURN_ROLE_KEYS[turn.role])}
              <span className="muted u-fs-11"> #{turn.turnIndex}</span>
            </span>
            <span className="conversation-turn__content">
              {renderContent(turn.content)}
            </span>
          </li>
        ))}
      </ol>
      {closed && outcome !== undefined && (
        <details className="u-mb-2">
          <summary className="muted u-fs-12">{t('finalOutcome')}</summary>
          <pre className="runconv-outcome-pre">
            {JSON.stringify(outcome, null, 2)}
          </pre>
        </details>
      )}
      {interruptForThis && !closed && (
        <ResumeForm interrupt={interruptForThis} onResolved={onResolved} />
      )}
    </div>
  );
}

function ResumeForm({
  interrupt,
  onResolved,
}: {
  interrupt: OpenInterrupt;
  onResolved(): void;
}) {
  const { t } = useTranslation('runs');
  const kind = interrupt.kind;
  // `conversation.exchange` resume shape is constrained by the
  // optional `outcomeSchema` on the suspend's data; absent the
  // schema the host treats the resume as opaque, so we offer a
  // simple text input that round-trips as a string. When the
  // schema IS present, fall back to a JSON textarea so the user
  // can compose to the contract.
  const data = interrupt.data as
    | { conversationId?: string; prompt?: string; outcomeSchema?: Record<string, unknown> }
    | undefined;
  const prompt = data?.prompt;
  const hasSchema = Boolean(data?.outcomeSchema);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(payload: unknown): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      await resolveByToken(interrupt.token, payload);
      setText('');
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (kind === 'conversation.close') {
    return (
      <div className="alert conversation-close-banner">
        <strong className="u-fs-13">{t('confirmClose')}</strong>
        <p className="muted runconv-close-copy">
          {t('confirmCloseBodyPre')}<code>conversation.closed</code>{t('confirmCloseBodyPost')}
        </p>
        {error && <div className="alert error u-fs-12 u-mb-1-5">{error}</div>}
        <div className="button-row">
          <button type="button" onClick={() => void submit(undefined)} disabled={submitting}>
            {submitting ? t('closing') : t('confirmClose')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const payload = hasSchema
          ? safeParseJson(text)
          : text;
        if (hasSchema && payload === SAFE_PARSE_INVALID) {
          setError(t('resumeInvalidJson'));
          return;
        }
        // Best-effort client-side outcomeSchema check — only the
        // top-level `type` discriminator (cheap, no Ajv dep). The host
        // is the authority and may reject with `400 INVALID_RESUME_VALUE`
        // for deeper schema constraints; this just catches the obvious
        // wrong-shape case (user typed an object when a string was
        // expected, etc.) without waiting for the round-trip.
        if (hasSchema) {
          const mismatch = topLevelTypeMismatch(payload, data?.outcomeSchema);
          if (mismatch) { setError(mismatch); return; }
        }
        void submit(payload);
      }}
      className="conversation-resume-form"
    >
      {prompt && (
        <div className="muted u-fs-12 u-mb-1">
          <strong>{t('agentPromptLabel')}</strong> {prompt}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={hasSchema ? t('resumeJsonPlaceholder') : t('resumeReplyPlaceholder')}
        rows={3}
        className="runconv-resume-textarea"
        style={{ fontFamily: hasSchema ? 'var(--mono)' : 'inherit' }}
        disabled={submitting}
      />
      {error && <div className="alert error u-fs-12 u-mt-1">{error}</div>}
      <div className="button-row u-mt-1-5">
        <button type="submit" disabled={submitting || text.trim().length === 0}>
          {submitting ? t('sending') : t('sendTurn')}
        </button>
      </div>
    </form>
  );
}

/** Group ordered RunEvents into per-conversation views, preserving turn
 *  order. `conversation.opened` seeds the view + initialTurn (index 0);
 *  `conversation.exchanged` appends; `conversation.closed` finalizes. */
function groupConversations(events: readonly RunEventDoc[]): ConversationView[] {
  const map = new Map<string, ConversationView>();
  for (const ev of events) {
    const payload = ev.payload;
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    const cid = typeof p.conversationId === 'string' ? p.conversationId : null;
    if (!cid) continue;
    if (ev.type === 'conversation.opened') {
      const view: ConversationView = {
        conversationId: cid,
        agentId: typeof p.agentId === 'string' ? p.agentId : undefined,
        capabilities: Array.isArray(p.capabilities) ? (p.capabilities as string[]) : [],
        schema: typeof p.schema === 'object' && p.schema ? (p.schema as Record<string, unknown>) : undefined,
        turns: [],
        closed: false,
      };
      const initial = coerceTurn(p.initialTurn);
      if (initial) view.turns.push(initial);
      map.set(cid, view);
    } else if (ev.type === 'conversation.exchanged') {
      const view = map.get(cid);
      if (!view) continue;
      const t = coerceTurn(p.turn);
      if (t) view.turns.push(t);
    } else if (ev.type === 'conversation.closed') {
      const view = map.get(cid);
      if (!view) continue;
      const t = coerceTurn(p.finalTurn);
      if (t) view.turns.push(t);
      view.closed = true;
      view.outcome = p.outcome;
    }
  }
  return [...map.values()];
}

function coerceTurn(raw: unknown): ConversationTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.messageId !== 'string' ||
    typeof r.from !== 'string' ||
    typeof r.role !== 'string' ||
    typeof r.turnIndex !== 'number' ||
    typeof r.ts !== 'number'
  ) {
    return null;
  }
  const role = r.role === 'user' || r.role === 'agent' || r.role === 'system' ? r.role : 'system';
  return {
    messageId: r.messageId,
    from: r.from,
    to: typeof r.to === 'string' ? r.to : undefined,
    role,
    turnIndex: r.turnIndex,
    content: r.content,
    ts: r.ts,
  };
}

function matchInterrupt(active: OpenInterrupt | null, conversationId: string): OpenInterrupt | null {
  if (!active) return null;
  if (active.kind !== 'conversation.exchange' && active.kind !== 'conversation.close') return null;
  const data = active.data as { conversationId?: unknown } | undefined;
  if (data && typeof data.conversationId === 'string' && data.conversationId === conversationId) {
    return active;
  }
  return null;
}

function renderContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  try {
    return JSON.stringify(c, null, 2);
  } catch {
    return String(c);
  }
}

const SAFE_PARSE_INVALID = Symbol('invalid-json');
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return SAFE_PARSE_INVALID;
  }
}

/** Returns null if the value's JS top-level type matches `schema.type`
 *  (a single string or an array). Returns a human-readable message
 *  otherwise. Skips deeper validation (`properties`, `items`, etc.) —
 *  the host is the schema authority. JSON Schema 2020-12 §6.1.1 type
 *  names: "string" / "number" / "integer" / "boolean" / "object" /
 *  "array" / "null". */
function topLevelTypeMismatch(value: unknown, schema: Record<string, unknown> | undefined): string | null {
  if (!schema) return null;
  const t = schema.type;
  const allowed: string[] = typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((s) => typeof s === 'string') : [];
  if (allowed.length === 0) return null;
  const actual = jsonTypeOf(value);
  if (allowed.includes(actual)) return null;
  if (actual === 'number' && allowed.includes('integer') && Number.isInteger(value)) return null;
  return i18n.t('runs:resumeTypeMismatch', {
    actual,
    required: allowed.map((s) => `"${s}"`).join(' or '),
  });
}

function jsonTypeOf(v: unknown): 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return t;
  if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return 'object';
}
