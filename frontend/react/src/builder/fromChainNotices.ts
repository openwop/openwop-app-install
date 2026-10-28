/**
 * The warnings a "Use template" copy owes its author, from the `from-chain`
 * response (grade-ux TPI-3; XCH-UP-3). One pure function so the dashboard and
 * its test agree on exactly what is said, in what order.
 */
import type { TFunction } from 'i18next';
import type { InstantiateResult } from './persistence/backendStore.js';

export function fromChainNotices(out: Pick<InstantiateResult, 'incompleteNodes' | 'unfilledParams' | 'warnings'>, t: TFunction<'builder'>): string[] {
  const notes: string[] = [];
  // A step copied with blank REQUIRED config used to land looking complete.
  if (out.incompleteNodes?.length) {
    const fields = [...new Set(out.incompleteNodes.flatMap((n) => n.missing))];
    notes.push(t('builder:templateIncompleteConfig', { count: out.incompleteNodes.length, fields: fields.join(', ') }));
  }
  // XCH-UP-3 (Book AI) — a template param left blank never froze, so the first
  // run fails at the node that reads it. "Just copy" stays; name what is missing.
  if (out.unfilledParams?.length) {
    notes.push(t('builder:templateUnfilledParams', { count: out.unfilledParams.length, params: out.unfilledParams.join(', ') }));
  }
  if (out.warnings?.length) notes.push(t('builder:templateNeedsSetup', { nodes: out.warnings.join(', ') }));
  return notes;
}
