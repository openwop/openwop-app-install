/**
 * Prompt Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Prompt library page. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their kind chip + sub-line + Tier-1
 * finding chips from the SAME helpers below, so the grid and list views never
 * diverge (the `primaryAction`/`subLine` precedent on `/agents`). Composed from
 * existing primitives — no bespoke CSS.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconButton } from '../ui/IconButton.js';
import {
  SettingsIcon,
  UserIcon,
  ListIcon,
  CodeIcon,
  PencilIcon,
  TrashIcon,
  AlertIcon,
} from '../ui/icons/index.js';
import type { PromptKind, PromptTemplate } from './types.js';
import { refToString } from './types.js';
import { lintPromptForTierOne } from './tierOneLint.js';
import { isUserPromptId } from './userPrompts.js';

const KIND_LABEL_KEY: Record<PromptKind, string> = {
  system: 'kindSystem',
  user: 'kindUser',
  'few-shot': 'kindFewShot',
  'schema-hint': 'kindSchemaHint',
} as const;

/** Kind is a category axis — differentiate by glyph + label, never by color. */
export function KindGlyph({ kind, size = 12 }: { kind: PromptKind; size?: number }): JSX.Element {
  if (kind === 'system') return <SettingsIcon size={size} aria-hidden />;
  if (kind === 'user') return <UserIcon size={size} aria-hidden />;
  if (kind === 'few-shot') return <ListIcon size={size} aria-hidden />;
  return <CodeIcon size={size} aria-hidden />; // schema-hint
}

/** The contextual one-liner from REAL fields — the prompt's description, else a
 *  no-description fallback. Shared by Card + Row. */
export function promptSubLine(p: PromptTemplate, t: TFunction): string {
  return p.description || t('subNoDescription');
}

/** The kind chip (glyph + label) — shared by Card + Row. */
export function PromptKindChip({ kind, t }: { kind: PromptKind; t: TFunction }): JSX.Element {
  return (
    <span className="chip chip--muted u-nowrap">
      <KindGlyph kind={kind} /> {t(KIND_LABEL_KEY[kind])}
    </span>
  );
}

/** Tier-1 lint finding chips — shared by Card + Row. Empty when `active` is
 *  false (the host isn't enforcing the subset). */
function TierOneChips({ p, t, active }: { p: PromptTemplate; t: TFunction; active: boolean }): JSX.Element | null {
  const findings = active ? lintPromptForTierOne(p) : [];
  if (findings.length === 0) return null;
  return (
    <>
      {findings.map((f) => (
        <span key={f.rule} className="chip chip--warning" title={t('tierOneFindingTitle')}>
          <AlertIcon size={12} aria-hidden /> {f.label}
        </span>
      ))}
    </>
  );
}

interface PromptViewProps {
  prompt: PromptTemplate;
  /** Whether the Tier-1 subset lint is being enforced by the host. */
  tierOneActive: boolean;
  /** Open the detail/render modal (the "use" action). */
  onSelect: (p: PromptTemplate) => void;
  /** Open the editor (user-authored prompts only). */
  onEdit: (p: PromptTemplate) => void;
  /** Open the delete-confirm (user-authored prompts only). */
  onDelete: (p: PromptTemplate) => void;
}

function PromptActions({
  p,
  t,
  onEdit,
  onDelete,
}: {
  p: PromptTemplate;
  t: TFunction;
  onEdit: (p: PromptTemplate) => void;
  onDelete: (p: PromptTemplate) => void;
}): JSX.Element {
  return (
    <>
      <IconButton
        label={t('editLabel', { name: p.name ?? p.templateId })}
        icon={<PencilIcon size={15} />}
        onClick={() => onEdit(p)}
      />
      <IconButton
        label={t('deleteLabel', { name: p.name ?? p.templateId })}
        className="icon-button u-text-danger"
        icon={<TrashIcon size={15} />}
        onClick={() => onDelete(p)}
      />
    </>
  );
}

export function PromptCard({ prompt: p, tierOneActive, onSelect, onEdit, onDelete }: PromptViewProps): JSX.Element {
  const { t } = useTranslation('prompts');
  const isUser = isUserPromptId(p.templateId);
  return (
    <div className="surface-card surface-card--interactive u-grid u-gap-2">
      <button
        type="button"
        className="u-button-bare u-grid u-gap-2 u-w-full u-text-left"
        onClick={() => onSelect(p)}
      >
        <div className="action-bar u-justify-between u-items-baseline u-gap-2">
          <code className="prompt-list-item-id">{refToString(p)}</code>
          <PromptKindChip kind={p.kind} t={t} />
        </div>
        {p.name && <div className="prompt-list-item-name">{p.name}</div>}
        <div className="muted prompt-list-item-desc">{promptSubLine(p, t)}</div>
        {p.tags && p.tags.length > 0 && (
          <div className="action-bar u-gap-2 u-wrap">
            {p.tags.map((tag) => (
              <span key={tag} className="chip chip--muted">{tag}</span>
            ))}
          </div>
        )}
        {tierOneActive && (
          <div className="action-bar u-gap-2 u-wrap">
            <TierOneChips p={p} t={t} active={tierOneActive} />
          </div>
        )}
      </button>
      {isUser && (
        <div className="action-bar u-gap-2 u-justify-end">
          <PromptActions p={p} t={t} onEdit={onEdit} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

export function PromptRow({ prompt: p, tierOneActive, onSelect, onEdit, onDelete }: PromptViewProps): JSX.Element {
  const { t } = useTranslation('prompts');
  const isUser = isUserPromptId(p.templateId);
  return (
    <div className="list-row">
      <button
        type="button"
        className="list-row-id u-button-bare"
        title={t('openPrompt', { name: p.name ?? p.templateId })}
        onClick={() => onSelect(p)}
      >
        <KindGlyph kind={p.kind} size={18} />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{p.name ?? p.templateId}</span>
          </span>
          <span className="list-row-sub">{promptSubLine(p, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <PromptKindChip kind={p.kind} t={t} />
        <TierOneChips p={p} t={t} active={tierOneActive} />
        {p.tags && p.tags.length > 0 ? <code className="prompt-list-item-id">{refToString(p)}</code> : null}
      </div>
      <div className="list-row-actions action-bar u-gap-2">
        <button type="button" className="secondary btn-sm" onClick={() => onSelect(p)}>
          {t('usePromptAction')}
        </button>
        {isUser && <PromptActions p={p} t={t} onEdit={onEdit} onDelete={onDelete} />}
      </div>
    </div>
  );
}
