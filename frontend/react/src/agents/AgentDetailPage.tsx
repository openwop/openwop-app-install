/**
 * Agent template detail — `/agents/templates/:agentId`.
 *
 * Read-only projection of `GET /v1/agents/:agentId` (RFC 0072 §A): the resolved
 * manifest metadata (persona/label, description, model class, tool allowlist,
 * memory shape, handoff schemas, confidence threshold, source pack pin). A
 * "Fork" button → `/agents/fork?fork=<agentId>` prefilled; a user-authored
 * template additionally shows "Delete" (pack-installed templates are immutable).
 *
 * The systemPrompt body itself is NOT projected over the inventory surface
 * (RFC 0072 §A SR-1 — system prompts are credential-adjacent and never cross the
 * read-only API). The detail view shows the `systemPromptRef` only; the body
 * lives in the pack manifest.
 */

import { useEffect, useState } from 'react'; // useState used by both AgentDetailPage (state) and AgentDetail (delete-in-flight + error)
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { slugify } from './agentUi.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteUserAgent, getAgent, type AgentEntry } from '../client/agentsClient.js';
import { ArrowLeftIcon, CheckIcon, CircleIcon } from '../ui/icons/index.js';
import { formatNumber } from '../i18n/format.js';

interface State {
  agent: AgentEntry | null;
  isLoading: boolean;
  error: string | null;
}

export function AgentDetailPage(): JSX.Element {
  const { t } = useTranslation('agents');
  const { agentId } = useParams<{ agentId: string }>();
  const [state, setState] = useState<State>({ agent: null, isLoading: true, error: null });

  useEffect(() => {
    if (!agentId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const agent = await getAgent(agentId);
        if (cancelled) return;
        setState({ agent, isLoading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          agent: null,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  return (
    <section aria-labelledby="agent-detail-heading">
      <div className="u-mb-3">
        <Link to="/agents/templates" className="u-fs-12 u-ink-3">
          <ArrowLeftIcon size={12} /> {t('detailBack')}
        </Link>
      </div>

      {state.isLoading && (
        <StateCard loading title={t('detailLoading')} />
      )}
      {state.error && (
        <Notice variant="error">{t('detailLoadError', { error: state.error })}</Notice>
      )}
      {!state.isLoading && !state.error && !state.agent && (
        <StateCard
          icon={<CircleIcon size={20} />}
          title={t('detailNotInstalledTitle')}
          body={
            <>
              Agent <code>{agentId}</code> {t('detailNotInstalled')}{' '}
              <Link to="/agents/templates">{t('detailBackToList')}</Link>
            </>
          }
        />
      )}

      {state.agent && <AgentDetail agent={state.agent} />}
    </section>
  );
}

function AgentDetail({ agent }: { agent: AgentEntry }): JSX.Element {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  // User-authored agents carry `packName: 'user:<tenantId>'` (phase E1
  // synthesises that on register); pack-installed agents always carry
  // a real pack name (e.g. `core.openwop.agents.code-reviewer`). The
  // prefix is the cleanest discriminator without round-tripping a
  // separate `source` flag through the SDK.
  const isUserAuthored = agent.packName.startsWith('user:');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDelete(): Promise<void> {
    if (!isUserAuthored) return;
    if (!(await confirm({ title: t('detailDeleteConfirm', { persona: agent.persona }), danger: true, confirmLabel: t('common:delete') }))) {
      return;
    }
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteUserAgent(agent.agentId);
      navigate('/agents/templates');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setIsDeleting(false);
    }
  }

  return (
    <article>
      <header className="u-mb-4">
        <h2
          id="agent-detail-heading"
          className="u-mb-1 u-flex u-items-baseline u-gap-3 u-wrap"
        >
          {agent.label || agent.persona}
          <code className="muted u-fs-13 u-fw-400">
            @{slugify(agent.persona)}
          </code>
        </h2>
        {agent.description && (
          <p className="muted agentdetail-description">
            {agent.description}
          </p>
        )}
        <div className="u-flex u-gap-2 u-mt-3 u-items-center">
          <button
            type="button"
            className="secondary"
            onClick={() => navigate(`/agents/fork?fork=${encodeURIComponent(agent.agentId)}`)}
            title={t('detailForkTitle')}
          >
            {t('detailFork')}
          </button>
          {isUserAuthored ? (
            <button
              type="button"
              className="secondary u-text-danger"
              onClick={() => void onDelete()}
              disabled={isDeleting}
              title={t('detailDeleteTitle')}
            >
              {isDeleting ? t('detailDeleting') : t('detailDelete')}
            </button>
          ) : (
            <span className="muted agentdetail-pack-note">
              {t('detailNotDeletable')}
            </span>
          )}
        </div>
        {deleteError && (
          <div
            role="alert"
            className="agentdetail-delete-error"
          >
            {t('detailDeleteFailed', { error: deleteError })}
          </div>
        )}
      </header>

      <DetailSection title={t('detailSectionSource')}>
        <Row label={t('detailRowPack')} value={<code>{agent.packName}@{agent.packVersion}</code>} />
        <Row label={t('detailRowAgentId')} value={<code className="u-fs-11">{agent.agentId}</code>} />
      </DetailSection>

      <DetailSection title={t('detailSectionModel')}>
        <Row label={t('detailRowModelClass')} value={<code>{agent.modelClass}</code>} />
        {agent.confidenceThreshold !== undefined && (
          <Row
            label={t('detailRowConfidence')}
            value={<code>≥ {formatNumber(agent.confidenceThreshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</code>}
            hint={t('detailConfidenceHint')}
          />
        )}
        <Row
          label={t('detailRowHandoff')}
          value={agent.hasHandoffSchemas ? t('detailHandoffDeclared') : t('detailHandoffNotDeclared')}
          hint={
            agent.hasHandoffSchemas
              ? t('detailHandoffHintDeclared')
              : t('detailHandoffHintNot')
          }
        />
      </DetailSection>

      <DetailSection title={t('detailSectionMemory')}>
        {agent.memoryShape ? (
          <div className="u-flex u-gap-2 u-wrap">
            <MemoryBadge label={t('detailMemoryScratchpad')} enabled={agent.memoryShape.scratchpad ?? false} />
            <MemoryBadge label={t('detailMemoryConversation')} enabled={agent.memoryShape.conversation ?? false} />
            <MemoryBadge label={t('detailMemoryLongTerm')} enabled={agent.memoryShape.longTerm ?? false} />
          </div>
        ) : (
          <p className="muted agentdetail-section-note">
            {t('detailMemoryNone')}
          </p>
        )}
      </DetailSection>

      <DetailSection title={t('detailToolAllowlist', { count: agent.toolAllowlist.length })}>
        {agent.toolAllowlist.length === 0 ? (
          <p className="muted agentdetail-section-note">
            {t('detailNoTools')}
          </p>
        ) : (
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-wrap u-gap-1-5">
            {agent.toolAllowlist.map((tool) => (
              <li
                key={tool}
                className="agentdetail-tool-chip"
              >
                {tool}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      {agent.degraded && agent.degraded.length > 0 && (
        <DetailSection title={t('detailSectionDegraded')} tone="warning">
          <p className="muted agentdetail-degraded-note">
            {t('detailDegradedNote')}
          </p>
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-wrap u-gap-1-5">
            {agent.degraded.map((tier) => (
              <li
                key={tier}
                className="agentdetail-degraded-chip"
              >
                {tier}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </article>
  );
}

function DetailSection({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'warning';
}): JSX.Element {
  return (
    <section
      className="agentdetail-section"
      style={{
        border: `1px solid ${tone === 'warning' ? 'var(--color-warning)' : 'var(--color-border)'}`,
      }}
    >
      <h3
        className="agentdetail-section-title"
        style={{
          color: tone === 'warning' ? 'var(--color-warning)' : 'var(--ink-3)',
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="agentdetail-row">
      <span className="u-minw-160 u-fs-12 u-ink-3">{label}</span>
      <div className="u-flex-1 u-fs-13">
        <div>{value}</div>
        {hint && (
          <div className="muted agentdetail-row-hint">{hint}</div>
        )}
      </div>
    </div>
  );
}

function MemoryBadge({ label, enabled }: { label: string; enabled: boolean }): JSX.Element {
  return (
    <span
      className="agentdetail-memory-badge"
      style={{
        background: enabled ? 'var(--clay-wash)' : 'var(--color-surface-2)',
        color: enabled ? 'var(--clay)' : 'var(--ink-3)',
        border: `1px solid ${enabled ? 'var(--clay-rule)' : 'var(--color-border)'}`,
      }}
    >
      {enabled ? <CheckIcon size={12} /> : <CircleIcon size={12} />} {label}
    </span>
  );
}

