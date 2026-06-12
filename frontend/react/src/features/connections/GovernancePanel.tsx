/**
 * Governance panel (ADR 0028 / ADR 0023 §12 T7) — superadmin-only card on the
 * Connections page: the provider allowlist and the per-action-kind policy.
 * Hidden entirely when the policy read 403s (non-admin) — never surface an
 * action that would fail.
 */
import { useCallback, useEffect, useState } from 'react';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { toast } from '../../ui/toast.js';
import { listProviders } from './connectionsClient.js';

const base = `${config.baseUrl}/v1/host/sample/governance`;

type KindPolicy = 'disabled' | 'draft-only' | 'approval-required';

interface PolicyDoc {
  providerAllowlist?: string[];
  actionPolicy?: Record<string, KindPolicy>;
}

interface PolicyResponse {
  policy: PolicyDoc;
  actionKinds: string[];
}

export function GovernancePanel(): JSX.Element | null {
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  // Self-loads the provider catalog (the panel mounts on pages that don't
  // otherwise hold it — the page-level ConnectionsManager owns its own copy).
  useEffect(() => {
    void listProviders()
      .then((ps) => setProviderIds(ps.map((p) => p.id)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void fetch(`${base}/policy`, fetchOpts({ headers: authedHeaders() }))
      .then(async (res) => {
        if (!res.ok) return; // 403 — not an admin; stay hidden
        const body = (await res.json()) as PolicyResponse;
        setDoc(body.policy ?? {});
        setKinds(body.actionKinds ?? []);
        setVisible(true);
      })
      .catch(() => {});
  }, []);

  const save = useCallback(async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const res = await fetch(`${base}/policy`, fetchOpts({
        method: 'PUT',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          ...(doc.providerAllowlist !== undefined ? { providerAllowlist: doc.providerAllowlist } : {}),
          ...(doc.actionPolicy !== undefined ? { actionPolicy: doc.actionPolicy } : {}),
        }),
      }));
      if (!res.ok) throw new Error(`save returned ${res.status}`);
      toast.success('Governance policy saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, [doc]);

  if (!visible || !doc) return null;

  const allowlistActive = doc.providerAllowlist !== undefined;
  return (
    <article className="surface-card u-grid u-gap-2">
      <header>
        <h2>Governance</h2>
        <p className="muted">Workspace policy: which providers may connect, and what each assistant action kind may do. Enforced at the connect, resolve, and dispatch seams.</p>
      </header>

      <section className="u-grid u-gap-1">
        <h3>Provider allowlist</h3>
        <label>
          <input
            type="checkbox"
            checked={allowlistActive}
            onChange={(e) => {
              const { providerAllowlist: _drop, ...rest } = doc;
              setDoc(e.target.checked ? { ...rest, providerAllowlist: providerIds } : rest);
            }}
          />{' '}
          Restrict connectable providers
        </label>
        {allowlistActive ? (
          <div className="u-flex u-gap-2">
            {providerIds.map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  checked={doc.providerAllowlist?.includes(p) ?? false}
                  onChange={(e) => {
                    const cur = new Set(doc.providerAllowlist ?? []);
                    if (e.target.checked) cur.add(p);
                    else cur.delete(p);
                    setDoc({ ...doc, providerAllowlist: [...cur] });
                  }}
                />{' '}
                {p}
              </label>
            ))}
          </div>
        ) : null}
      </section>

      <section className="u-grid u-gap-1">
        <h3>Action policy</h3>
        {kinds.map((kind) => (
          <label key={kind} className="u-flex u-gap-2">
            <span className="chip">{kind}</span>
            <select
              value={doc.actionPolicy?.[kind] ?? 'approval-required'}
              onChange={(e) =>
                setDoc({ ...doc, actionPolicy: { ...(doc.actionPolicy ?? {}), [kind]: e.target.value as KindPolicy } })
              }
            >
              <option value="approval-required">Approval required (execute on approve)</option>
              <option value="draft-only">Draft only (never executes)</option>
              <option value="disabled">Disabled (no drafts)</option>
            </select>
          </label>
        ))}
      </section>

      <span className="action-bar">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          Save policy
        </button>
      </span>
    </article>
  );
}
