/**
 * `/roster` route — Standing Agent Roster + Org-Chart (RFCS/0086 + 0087).
 *
 * Manage named "digital-twin employee" agents (persona + the manifest they
 * run + their workflow portfolio), and view/build the org-chart — departments
 * of members with a responsibility roll-up (the union of a department's
 * members' portfolios). The org edge is descriptive only: it confers no
 * authority (RFC 0087 §B).
 *
 * Tenant scoping is server-side; the page never sends a tenantId.
 */

import { useCallback, useEffect, useState } from 'react';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import {
  createRosterEntry,
  deleteRosterEntry,
  getDepartmentRollup,
  getOrgChart,
  listRoster,
  putOrgChart,
  updateRosterEntry,
  type OrgChart,
  type ResponsibilityView,
  type RosterEntry,
} from './rosterClient.js';
import { toast } from '../ui/toast.js';

export function RosterPage(): JSX.Element {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [rollups, setRollups] = useState<Record<string, ResponsibilityView>>({});
  const [error, setError] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  const [agentId, setAgentId] = useState('core.openwop.agents.brief-writer');
  const [workflows, setWorkflows] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([listRoster(), getOrgChart()]);
      setRoster(r);
      setChart(c);
      // Department rollups in parallel, not sequentially (GAP-ANALYSIS E3):
      // one serial await per department turned N departments into N round-trip
      // latencies on load. Each still degrades independently on failure.
      const views: Record<string, ResponsibilityView> = {};
      await Promise.all(
        c.departments.map(async (d) => {
          try { views[d.departmentId] = await getDepartmentRollup(d.departmentId); } catch { /* skip */ }
        }),
      );
      setRollups(views);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!persona.trim() || !agentId.trim()) return;
    try {
      await createRosterEntry({
        persona: persona.trim(),
        agentRef: { agentId: agentId.trim() },
        workflows: workflows.split(',').map((w) => w.trim()).filter(Boolean),
      });
      setPersona('');
      setWorkflows('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (rosterId: string) => {
    const name = roster.find((r) => r.rosterId === rosterId)?.persona ?? 'this agent';
    if (!window.confirm(`Delete the agent “${name}”? This removes it and its board/schedules and can't be undone.`)) return;
    try {
      await deleteRosterEntry(rosterId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Flip a member between autonomy levels: `auto` runs heartbeat picks
  // immediately; `review` routes them to the approval inbox for human sign-off.
  const onToggleAutonomy = async (r: RosterEntry) => {
    const next = r.autonomyLevel === 'review' ? 'auto' : 'review';
    try {
      await updateRosterEntry(r.rosterId, { autonomyLevel: next });
      await refresh();
      toast.success(
        next === 'review'
          ? `${r.persona} now proposes — its picks need your sign-off in the Inbox.`
          : `${r.persona} now runs its picks automatically.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Convenience: put every roster member into one flat "All Agents" department,
  // so the org-chart + responsibility roll-up are demonstrable without a full
  // tree editor. reportsTo is null for all (no hierarchy) — descriptive only.
  const buildFlatChart = async () => {
    try {
      await putOrgChart({
        departments: [{ departmentId: 'dept-all', name: 'All Agents', parentDepartmentId: null, roles: [{ roleId: 'role-member', name: 'Member' }] }],
        members: roster.map((r) => ({ rosterId: r.rosterId, departmentId: 'dept-all', roleId: 'role-member', reportsTo: null })),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const personaOf = (rosterId: string): string => roster.find((r) => r.rosterId === rosterId)?.persona ?? rosterId;

  return (
    <section>
      <PageHeader
        eyebrow="Roster"
        title="Roster & Org-Chart"
        lede={<>Named "digital-twin employee" agents that own a workflow portfolio (RFC 0086), grouped into a descriptive org-chart (RFC 0087). Bind a roster member to a board on the <strong>Boards</strong> page to make its To&nbsp;Do column fire that agent's workflow.</>}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <h2 className="u-fs-16">Roster</h2>
      <form onSubmit={onCreate} className="u-flex u-gap-2 u-wrap u-mb-3">
        <input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Persona (e.g. Sally)" />
        <input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agentId" className="u-minw-240" />
        <input value={workflows} onChange={(e) => setWorkflows(e.target.value)} placeholder="workflows (comma-separated)" className="u-minw-240" />
        <button type="submit" className="primary">Add agent</button>
      </form>
      {roster.length === 0 ? (
        <p className="muted">No named agents yet. Add one above.</p>
      ) : (
        roster.map((r) => (
          <div key={r.rosterId} className="roster-card">
            <div className="u-flex u-justify-between u-items-baseline">
              <strong>{r.persona}</strong>
              <button type="button" className="secondary u-fs-12" onClick={() => void onDelete(r.rosterId)}>Delete</button>
            </div>
            <div className="muted u-fs-13">{r.rosterId} · runs <code>{r.agentRef.agentId}</code>{r.enabled ? '' : ' · disabled'}</div>
            <div className="u-flex u-items-center u-gap-2 u-mt-1-5">
              <span className={`chip ${r.autonomyLevel === 'review' ? 'chip--accent' : 'chip--muted'}`}>
                {r.autonomyLevel === 'review' ? 'review — proposes' : 'auto — runs'}
              </span>
              <button
                type="button"
                className="secondary u-fs-12"
                onClick={() => void onToggleAutonomy(r)}
                title={r.autonomyLevel === 'review'
                  ? 'Switch to auto: heartbeat picks run immediately'
                  : 'Switch to review: heartbeat picks need human sign-off (Inbox)'}
              >
                {r.autonomyLevel === 'review' ? 'Set auto' : 'Set review'}
              </button>
            </div>
            {r.workflows.length > 0 ? (
              <div className="u-fs-13 u-mt-1">portfolio: {r.workflows.map((w) => <code key={w} className="roster-wf-code">{w}</code>)}</div>
            ) : <div className="muted u-fs-13 u-mt-1">no workflows assigned</div>}
          </div>
        ))
      )}

      <h2 className="u-fs-16 u-mt-5">Org-chart</h2>
      <p className="roster-orgchart-lede">
        Departments + roles + reporting lines over roster members. An org edge is metadata only — it grants no authority
        (RFC 0087 §B). The responsibility roll-up is the union of a department's members' portfolios.
      </p>
      <button type="button" className="secondary roster-flatchart-btn" onClick={() => void buildFlatChart()} disabled={roster.length === 0}>
        Generate flat chart from roster
      </button>
      {!chart || chart.departments.length === 0 ? (
        <p className="muted">No org-chart yet. Use the button above to build a flat one from the roster (or PUT a structured chart via the API).</p>
      ) : (
        chart.departments.map((d) => {
          const view = rollups[d.departmentId];
          const members = chart.members.filter((m) => m.departmentId === d.departmentId);
          return (
            <div key={d.departmentId} className="roster-card">
              <strong>{d.name}</strong>
              {d.parentDepartmentId ? <span className="muted u-fs-12"> · under {chart.departments.find((x) => x.departmentId === d.parentDepartmentId)?.name ?? d.parentDepartmentId}</span> : null}
              <ul className="roster-member-list">
                {members.map((m) => (
                  <li key={m.rosterId} className="u-fs-14">
                    {personaOf(m.rosterId)} <span className="muted">({d.roles.find((r) => r.roleId === m.roleId)?.name ?? m.roleId}{m.reportsTo ? ` → reports to ${personaOf(m.reportsTo)}` : ''})</span>
                  </li>
                ))}
              </ul>
              {view ? (
                <div className="u-fs-13">
                  <span className="muted">responsible for: </span>
                  {view.responsibilities.length > 0 ? view.responsibilities.map((w) => <code key={w} className="roster-wf-code">{w}</code>) : <span className="muted">nothing yet</span>}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
