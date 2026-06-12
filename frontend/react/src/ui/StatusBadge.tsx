/**
 * StatusBadge — the one run/agent status pill (GAP-ANALYSIS E8). Replaces four
 * divergent conventions: a raw `status-badge ${status}` (worked only for exact
 * status strings) and a local tone map in RunsIndexPage that emitted
 * `status-success` / `status-in-progress` classes which DO NOT EXIST in
 * global.css — i.e. it rendered uncolored. This maps any status to the CSS
 * classes that actually carry color (`.status-badge.completed` etc.).
 */

const KNOWN = new Set(['completed', 'failed', 'cancelled', 'waiting-approval', 'waiting-input', 'paused', 'running']);

/** Map a run/agent status to the global.css status class that colors it.
 *  Returns '' for unknown statuses (base muted badge). */
export function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (KNOWN.has(s)) return s;
  if (s === 'succeeded' || s === 'success' || s === 'done' || s === 'active') return 'completed';
  if (s === 'error') return 'failed';
  if (s === 'waiting' || s === 'suspended' || s === 'input-required' || s === 'in-progress') return 'waiting-approval';
  // Connection-broker statuses (ADR 0024): a credential needing attention reads
  // as a warning; an intentionally dropped one as a neutral-negative cancel.
  if (s === 'needs-reconsent' || s === 'expired') return 'waiting-approval';
  if (s === 'revoked') return 'cancelled';
  return '';
}

export function StatusBadge({
  status,
  label,
  className,
  style,
}: {
  status: string;
  /** Display text; defaults to the raw status. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  const tone = statusTone(status);
  return (
    <span className={`status-badge${tone ? ` ${tone}` : ''}${className ? ` ${className}` : ''}`} style={style}>
      {label ?? status}
    </span>
  );
}
