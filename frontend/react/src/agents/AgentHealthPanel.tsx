/**
 * Agent health (ADR 0029 Part 1 / ADR 0023 §12 T8) — the Chief of Staff's
 * operating metrics, surfaced at the bottom of its agent workspace page next to
 * Recurring tasks. It reuses the existing superadmin-gated /assistant/health
 * endpoint (the same builder the standalone page used) — no parallel metrics
 * store. The panel renders ONLY when the endpoint resolves (admins); for
 * non-admins getAssistantHealth returns null and the panel stays hidden.
 *
 * The metrics (action approval/edit/citation rates, taint share, stale
 * commitments, loop status) are the assistant's domain, so the workspace page
 * gates this on `roleKey === 'chief-of-staff'` — the same gate as Recurring
 * tasks. A generic per-agent telemetry surface would be a separate concept;
 * this deliberately reuses what already exists.
 */
import { useEffect, useState } from 'react';
import { getAssistantHealth, type AssistantHealth } from '../features/assistant/assistantClient.js';

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function AgentHealthPanel(): JSX.Element | null {
  const [health, setHealth] = useState<AssistantHealth | null>(null);

  useEffect(() => {
    // Admin-only; resolves null on 403 and the panel stays hidden.
    void getAssistantHealth().then(setHealth).catch(() => {});
  }, []);

  if (!health) return null;

  return (
    <article className="surface-card u-grid u-gap-2">
      <header>
        <h2>Agent health</h2>
        <p className="muted">
          Operating metrics (admin) — generated {new Date(health.generatedAt).toLocaleString()}
        </p>
      </header>
      <p className="u-m-0">
        Actions: {health.actions.pending} pending · {health.actions.sent} sent · {health.actions.failed} failed ·
        approval rate {pct(health.actions.approvalRate)} · edited {pct(health.actions.editRate)} ·
        cited {pct(health.actions.citationCoverage)} · from connected content {pct(health.actions.taintedShare)}
      </p>
      <p className="u-m-0">
        Commitments: {health.commitments.open} open · {health.commitments.stale} stale ·
        cited {pct(health.commitments.citationCoverage)}
      </p>
    </article>
  );
}
