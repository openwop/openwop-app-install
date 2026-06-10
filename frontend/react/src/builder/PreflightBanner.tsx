/**
 * Pre-flight warning banner — host-capability + engine-limit breaches
 * found on a Run/Validate click. Extracted from BuilderShell.tsx (pure
 * extraction — no behavior change).
 */

import { useBuilderStore } from './store/builderStore.js';
import type { PreflightIssue, LimitIssue } from './builderShellHelpers.js';

interface PreflightBannerProps {
  preflight: { caps: PreflightIssue[]; limits: LimitIssue[] };
  onCancel(): void;
  onRunAnyway(): void;
}

export function PreflightBanner({ preflight, onCancel, onRunAnyway }: PreflightBannerProps) {
  return (
    <div className="alert warning builder-toolbar-error">
      {preflight.caps.length > 0 && (
        <>
          <strong>
            Host can&apos;t run {preflight.caps.length} node{preflight.caps.length === 1 ? '' : 's'}.
          </strong>{' '}
          The connected host doesn&apos;t advertise the surface
          {preflight.caps.length === 1 ? '' : 's'} these nodes need — running now will fail with{' '}
          <code>HOST_CAPABILITY_MISSING</code>:
          <ul className="preflight-issue-list">
            {preflight.caps.map((i) => (
              <li key={i.nodeId}>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => useBuilderStore.getState().selectNode(i.nodeId)}
                >
                  {i.name}
                </button>{' '}
                needs <code>{i.missing.join(', ')}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {preflight.limits.length > 0 && (
        <>
          <strong>
            Workflow exceeds {preflight.limits.length} advertised host limit
            {preflight.limits.length === 1 ? '' : 's'}.
          </strong>
          <ul className="preflight-issue-list">
            {preflight.limits.map((i) => (
              <li key={i.kind}>{i.message}</li>
            ))}
          </ul>
        </>
      )}
      <div className="button-row">
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={onRunAnyway}>Run anyway</button>
      </div>
    </div>
  );
}
