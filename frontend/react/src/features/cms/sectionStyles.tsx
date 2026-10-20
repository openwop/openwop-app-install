/**
 * ADR 0920 — CMS section styles: the presentation options a section may carry
 * (tone, split head) and the two data-driven pictures (the hero `plan` card and
 * the richText `chat`). Every field is optional; a section that sets none renders
 * exactly as before. Pictures are REAL TEXT (crawler = human, ADR 0593 §C9) and
 * INERT: what looks like a button or a chip is a styled span, never a control.
 */
import { useTranslation } from 'react-i18next';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const TONES = ['muted', 'inverse', 'accent'] as const;

/** The modifier classes for a section's `tone` and `head` (D1, D2). Unknown or
 *  absent values add nothing, so a stock section keeps its exact class list. */
export function sectionStyleClass(d: Record<string, unknown>): string {
  const tone = TONES.find((t) => t === d.tone);
  return `${tone ? ` fp-tone fp-tone--${tone}` : ''}${d.head === 'split' ? ' fp-split' : ''}`;
}

/** A 0..1 fraction from authored data, or null when absent or not a number. */
export function fraction(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/** A thin progress bar. Decorative: the adjacent text always states the
 *  progress, so colour is never the only signal (D3). */
export function ProgressBar({ value }: { value: number }): JSX.Element {
  return (
    <span className="fp-progress" aria-hidden="true">
      <span className="fp-progress__fill" style={{ inlineSize: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

/** D3 — the hero's example plan card. A `figure` named "Example plan", with the
 *  friend's note folded into the name so a screen reader hears it once, in order. */
export function PlanCard({ plan }: { plan: unknown }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const p = obj(plan);
  const title = str(p.title);
  if (!title) return null;
  const progress = fraction(p.progress);
  const lines = list(p.lines).map((l) => ({ label: str(obj(l).label), text: str(obj(l).text) })).filter((l) => l.text);
  const chips = list(p.chips).map(str).filter(Boolean);
  const bubble = str(p.bubble);
  const label = bubble ? t('planFigureLabelWithNote', { note: bubble }) : t('planFigureLabel');
  return (
    <figure className="fp-plan" aria-label={label}>
      {/* The note is already in the figure's name; hidden here so it is heard once. */}
      {bubble ? <p className="fp-plan__bubble" aria-hidden="true">{bubble}</p> : null}
      <div className="fp-plan__card">
        {str(p.eyebrow) ? <p className="fp-plan__eyebrow">{str(p.eyebrow)}</p> : null}
        <div className="fp-plan__head">
          <p className="fp-plan__title">{title}</p>
          {str(p.meta) ? <p className="fp-plan__meta">{str(p.meta)}</p> : null}
        </div>
        {progress !== null ? <ProgressBar value={progress} /> : null}
        {str(p.progressNote) ? <p className="fp-plan__note">{str(p.progressNote)}</p> : null}
        {str(p.stepTitle) ? (
          <div className="fp-plan__step">
            {str(p.stepEyebrow) ? <p className="fp-plan__step-eyebrow">{str(p.stepEyebrow)}</p> : null}
            <p className="fp-plan__step-title">{str(p.stepTitle)}</p>
            {lines.map((l, i) => (
              <p key={i} className="fp-plan__line">{l.label ? <strong>{l.label} </strong> : null}{l.text}</p>
            ))}
            {str(p.action) || chips.length > 0 ? (
              <p className="fp-plan__actions">
                {str(p.action) ? <span className="fp-plan__action">{str(p.action)}</span> : null}
                {chips.length > 0 ? <span className="fp-plan__chips">{chips.join(' · ')}</span> : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {str(p.note) ? (
          <p className="fp-plan__footer">
            {str(p.initial) ? <span className="fp-plan__avatar" aria-hidden="true">{str(p.initial).slice(0, 1)}</span> : null}
            {str(p.note)}
          </p>
        ) : null}
      </div>
    </figure>
  );
}

/** D5 — a conversation picture beside a richText section's copy. */
export function ChatCard({ chat }: { chat: unknown }): JSX.Element | null {
  const c = obj(chat);
  const title = str(c.title);
  const messages = list(c.messages)
    .map((m) => ({ from: obj(m).from === 'person' ? 'person' : 'guide', text: str(obj(m).text) }))
    .filter((m) => m.text);
  if (!title || messages.length === 0) return null;
  const proposal = obj(c.proposal);
  const hasProposal = Boolean(str(proposal.text));
  return (
    <figure className="fp-chat" aria-label={title}>
      <div className="fp-chat__head">
        <span className="fp-chat__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="fp-chat__who">
          <span className="fp-chat__title">{title}</span>
          {str(c.subtitle) ? <span className="fp-chat__subtitle">{str(c.subtitle)}</span> : null}
        </span>
        {str(c.badge) ? <span className="fp-chat__badge">{str(c.badge)}</span> : null}
      </div>
      <div className="fp-chat__body">
        {messages.map((m, i) => {
          const last = i === messages.length - 1;
          return (
            <div key={i} className={`fp-chat__msg fp-chat__msg--${m.from}`}>
              <p>{m.text}</p>
              {last && m.from === 'guide' && hasProposal ? <Proposal p={proposal} /> : null}
            </div>
          );
        })}
      </div>
      {str(c.placeholder) ? <p className="fp-chat__input">{str(c.placeholder)}</p> : null}
    </figure>
  );
}

function Proposal({ p }: { p: Record<string, unknown> }): JSX.Element {
  return (
    <div className="fp-chat__proposal">
      {str(p.label) ? <p className="fp-chat__proposal-label">{str(p.label)}</p> : null}
      <p className="fp-chat__proposal-text">{str(p.text)}</p>
      {str(p.accept) || str(p.decline) ? (
        <p className="fp-chat__proposal-actions">
          {str(p.accept) ? <span className="fp-chat__accept">{str(p.accept)}</span> : null}
          {str(p.decline) ? <span className="fp-chat__decline">{str(p.decline)}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** D4 — the small drawings a `panels` item may carry (closed set). Decorative. */
export function PanelArt({ kind }: { kind: string }): JSX.Element | null {
  if (kind === 'full-week') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 220 18" aria-hidden="true" focusable="false">
        {[0, 44, 82, 132, 170].map((x, i) => <rect key={i} x={x} y="1" width={[40, 34, 46, 34, 40][i]} height="16" rx="2" className="fp-art-block" />)}
        <rect x="212" y="1" width="8" height="16" rx="2" className="fp-art-accent" />
      </svg>
    );
  }
  if (kind === 'feed') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 120 30" aria-hidden="true" focusable="false">
        <circle cx="12" cy="18" r="2.5" className="fp-art-dot" /><circle cx="20" cy="10" r="3" className="fp-art-dot" />
        <rect x="34" y="3" width="44" height="24" rx="5" className="fp-art-frame" />
        <circle cx="88" cy="8" r="3.5" className="fp-art-dot" /><circle cx="100" cy="14" r="2.5" className="fp-art-dot" />
      </svg>
    );
  }
  if (kind === 'solo') {
    return (
      <svg className="fp-panel__art" viewBox="0 0 120 30" aria-hidden="true" focusable="false">
        <circle cx="30" cy="15" r="7" className="fp-art-ghost" />
        <circle cx="60" cy="15" r="9" className="fp-art-block" />
        <circle cx="90" cy="15" r="7" className="fp-art-ghost" />
      </svg>
    );
  }
  return null;
}
