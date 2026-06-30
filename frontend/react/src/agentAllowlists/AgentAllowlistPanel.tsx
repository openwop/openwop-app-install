/**
 * Agent tool-allowlist editor (ADR 0104) — a super-admin admin screen to grant or
 * revoke an agent's offered tools without editing + redeploying a pack. Thin client
 * over the Phase-2 REST surface; the backend is authority (super-admin gated there,
 * so a non-admin gets a 403 rendered as a Notice). Pick an agent → toggle tools from
 * the catalog (manifest tools pre-checked) → Save (a full-replace override) or Reset
 * to the manifest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { CheckboxField } from '../ui/Field.js';
import { ShieldIcon, CheckIcon } from '../ui/icons/index.js';
import {
  listAgentAllowlists, getAgentAllowlist, setAgentAllowlist, clearAgentAllowlist,
  type AgentAllowlistRow, type AgentAllowlistDetail,
} from './agentAllowlistClient.js';

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Acronyms to upper-case in a humanized tool label (so `…http` → "HTTP", not "Http"). */
const ACRONYMS = new Set(['http', 'mcp', 'api', 'sql', 'ai', 'url', 'csv', 'pdf', 'llm', 'rag', 'a2a', 'crm', 'sso']);

/**
 * Plain-language label derived from a raw tool id (the wire form like
 * `core.openwop.integration.email-send`): take the last meaningful segment,
 * split on `-`/`_`, title-case the first word, upper-case known acronyms. Purely
 * derived (no hardcoded map) so it stays language-neutral; the raw id is still
 * shown beneath it for operators who need the exact wire name.
 */
export function toolLabel(id: string): string {
  const seg = id.split(/[.:/]/).filter(Boolean).pop() ?? id;
  const words = seg.split(/[-_]/).filter(Boolean);
  if (words.length === 0) return id;
  return words
    .map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function AgentAllowlistPanel(): JSX.Element {
  const { t } = useTranslation('agentAllowlists');
  const [agents, setAgents] = useState<AgentAllowlistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const navRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try { setAgents(await listAgentAllowlists()); }
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); }
  }, [t]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Roving keyboard nav for the agent list: ↑/↓ move selection (and focus) to the
  // adjacent agent, Home/End jump to the ends — so keyboard users don't have to Tab
  // through every agent to reach the one they want.
  const onNavKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (!agents || agents.length === 0) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = agents.findIndex((a) => a.agentId === selectedId);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? agents.length - 1
      : e.key === 'ArrowDown' ? Math.min(agents.length - 1, cur < 0 ? 0 : cur + 1)
      : Math.max(0, cur < 0 ? agents.length - 1 : cur - 1);
    const target = agents[next];
    if (!target) return;
    setSelectedId(target.agentId);
    navRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {agents === null ? (
        <StateCard icon={<ShieldIcon size={20} />} title={t('loading')} loading />
      ) : agents.length === 0 ? (
        <StateCard icon={<ShieldIcon size={22} />} title={t('noAgentsTitle')} body={t('noAgentsBody')} />
      ) : (
        <div className="u-grid u-grid-2 u-gap-4">
          <nav ref={navRef} className="surface-card u-flex u-flex-col u-gap-1" aria-label={t('agentListLabel')} onKeyDown={onNavKeyDown}>
            {agents.map((a) => (
              <button
                key={a.agentId}
                type="button"
                className={`ghost btn-sm u-justify-start ${selectedId === a.agentId ? 'is-active' : ''}`}
                aria-pressed={selectedId === a.agentId}
                aria-current={selectedId === a.agentId ? 'true' : undefined}
                onClick={() => setSelectedId(a.agentId)}
              >
                <span className="u-flex u-items-center u-gap-2 u-minw-0">
                  <span className="u-truncate">{a.label}</span>
                  {a.override ? <span className="chip chip--accent u-fs-11">{t('overriddenChip')}</span> : null}
                </span>
              </button>
            ))}
          </nav>
          {selectedId ? (
            <AgentEditor key={selectedId} agentId={selectedId} onChanged={refresh} onError={setError} />
          ) : (
            <StateCard icon={<ShieldIcon size={20} />} title={t('pickAgentTitle')} body={t('pickAgentBody')} />
          )}
        </div>
      )}
    </div>
  );
}

function AgentEditor(props: { agentId: string; onChanged: () => Promise<void>; onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('agentAllowlists');
  const [detail, setDetail] = useState<AgentAllowlistDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await getAgentAllowlist(props.agentId);
      setDetail(d);
      setSelected(new Set(d.effective));
    } catch (e) { props.onError(e instanceof Error ? e.message : t('loadFailed')); }
  }, [props, t]);
  useEffect(() => { void load(); }, [load]);

  // The union of catalog + manifest + override ids, so manifest/override tools that
  // aren't currently mounted are still visible (flagged) rather than silently absent.
  const allIds = useMemo(() => {
    if (!detail) return [];
    return [...new Set([...detail.toolCatalog, ...detail.manifestAllowlist, ...(detail.override?.toolAllowlist ?? [])])].sort((a, b) => a.localeCompare(b));
  }, [detail]);

  if (!detail) return <StateCard icon={<ShieldIcon size={18} />} title={t('loading')} loading />;

  const manifest = new Set(detail.manifestAllowlist);
  const catalog = new Set(detail.toolCatalog);
  const dirty = !sameSet(selected, new Set(detail.effective));

  const toggle = (id: string): void => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async (): Promise<void> => {
    setBusy(true);
    try { await setAgentAllowlist(props.agentId, [...selected]); await load(); await props.onChanged(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };
  const reset = async (): Promise<void> => {
    setBusy(true);
    try { await clearAgentAllowlist(props.agentId); await load(); await props.onChanged(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('resetFailed')); }
    finally { setBusy(false); }
  };

  return (
    <section className="surface-card u-flex u-flex-col u-gap-3">
      <div className="u-flex u-flex-col u-gap-1">
        <span className="proj-eyebrow">{detail.persona}</span>
        <h2 className="u-fs-16 u-m-0">{detail.label}</h2>
        <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
          <span className="chip chip--muted u-fs-11">{t('agentIdChip', { id: detail.agentId })}</span>
          {detail.override
            ? <span className="chip chip--accent u-fs-11"><CheckIcon size={11} /> {t('usingOverride', { n: detail.override.toolAllowlist.length })}</span>
            : <span className="chip chip--muted u-fs-11">{t('usingManifest')}</span>}
        </div>
      </div>
      <p className="muted u-fs-12 u-m-0">{t('explainer')}</p>

      <fieldset className="u-flex u-flex-col u-gap-2 u-p-0 u-border-0" aria-label={t('toolChecklistLabel', { label: detail.label })}>
        {allIds.map((id) => (
          <CheckboxField
            key={id}
            checked={selected.has(id)}
            disabled={busy}
            onChange={() => toggle(id)}
            label={
              <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
                <span className="u-flex u-flex-col u-minw-0">
                  <span className="u-fs-12 u-fw-600">{toolLabel(id)}</span>
                  <code className="muted u-fs-11">{id}</code>
                </span>
                {manifest.has(id) ? <span className="chip chip--muted u-fs-11">{t('manifestTag')}</span> : null}
                {!catalog.has(id) ? <span className="chip chip--warning u-fs-11">{t('notMountedTag')}</span> : null}
              </span>
            }
          />
        ))}
      </fieldset>

      <div className="action-bar u-justify-end">
        <button type="button" className="secondary btn-sm" disabled={busy || !detail.override} onClick={() => void reset()}>{t('resetToManifest')}</button>
        <button type="button" className="primary btn-sm" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('saving') : t('saveOverride')}</button>
      </div>
    </section>
  );
}
