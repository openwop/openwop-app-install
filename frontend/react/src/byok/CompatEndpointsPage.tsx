/**
 * Self-hosted / OpenAI-compatible endpoints as a standalone surface (ADR 0144) —
 * promotes the compat-endpoints card out of the Keys page into a first-class
 * Access Hub tab. The card (RFC 0108) is self-contained and returns null when the
 * compat provider is disabled, so this wrapper is intentionally thin.
 */
import { Navigate } from 'react-router-dom';
import { CompatEndpointsCard } from './CompatEndpointsCard.js';
import { useHub } from '../chrome/hubContext.js';

export function CompatEndpointsPage(): JSX.Element {
  const { embedded } = useHub();
  // Hub-tab-only surface (ADR 0144): a direct visit to `/access/endpoints` lands
  // un-embedded — bounce it into the hub so it renders inside the console chrome
  // rather than as a bare card (review finding #2).
  if (!embedded) return <Navigate to="/access?tab=endpoints" replace />;
  return (
    <section className="u-grid u-gap-4">
      <CompatEndpointsCard />
    </section>
  );
}
