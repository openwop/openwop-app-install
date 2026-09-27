/**
 * ADR 0544 — the ONE renderer for attested claims.
 *
 * Both the public verification page and the applicant's consent dialog render
 * through this. That is the point rather than a convenience: matrix row 10 says
 * the disclosed number must be visible BEFORE consent, and the only way that
 * sentence stays true is if the applicant reads the SAME words the employer
 * will. A second "here's what you're about to share" summary would start
 * accurate and drift, and the drift would land on the one screen whose whole
 * purpose is telling someone what they are revealing.
 *
 * The backend makes the same commitment on its side: `previewAttestation` runs
 * the identical derivation and projection as `resolveAttestation`.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { CheckIcon } from '../../ui/icons/index.js';
import type { VerifierClaim } from './attestationVerifyClient.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * One claim as a sentence a person can act on.
 *
 * The switch covers every variant of the claim union AND has a default, because
 * the two failure modes are different. A type the union does not have is caught
 * by `tsc` at the union (this mirrors the backend's `VerifierClaim`); a type the
 * SERVER sends that this bundle predates can only be caught at runtime, and the
 * honest response is to omit it rather than render a fact bag whose meaning the
 * reader cannot recover.
 */
export function claimText(
  c: VerifierClaim,
  t: ReturnType<typeof useTranslation<'job-search'>>['t'],
  fmtDate: (v: string) => string,
): { text: string; detail?: string } | null {
  switch (c.type) {
    case 'authorised-by-person':
      return { text: t('claimAuthorised'), detail: t('claimAuthorisedDetail', { count: num(c.facts.maxSubmits) }) };
    case 'applications-in-window':
      return {
        text: t('claimCount', { count: num(c.facts.count) }),
        detail: t('claimCountDetail', {
          start: fmtDate(String(c.facts.windowStart ?? '')),
          end: fmtDate(String(c.facts.windowEnd ?? '')),
        }),
      };
    case 'warm-path-ratio':
      return { text: t('claimWarm', { warm: num(c.facts.warm), total: num(c.facts.total) }) };
    case 'human-reviewed':
      return { text: t('claimReviewed') };
    case 'resume-guarded':
      return { text: t('claimGuarded'), detail: t('claimGuardedDetail') };
    default:
      return null;
  }
}

export interface RenderedClaim {
  claim: VerifierClaim;
  text: string;
  detail?: string;
}

/** The claims this build can render, in order. Unknown types are dropped. */
export function useRenderedClaims(claims: VerifierClaim[]): RenderedClaim[] {
  const { t } = useTranslation('job-search');
  const fmt = useFormat();
  const out: RenderedClaim[] = [];
  for (const claim of claims) {
    const r = claimText(claim, t, (v) => (v ? fmt.date(v) : ''));
    if (r) out.push({ claim, ...r });
  }
  return out;
}

/** The shared list. `dense` drops the card chrome for use inside a dialog. */
export function ClaimList({ claims, dense }: { claims: RenderedClaim[]; dense?: boolean }): JSX.Element {
  return (
    <ul className="u-flex u-flex-col u-gap-2 u-list-none">
      {claims.map(({ claim, text, detail }) => (
        <li
          key={`${claim.type}:${claim.sourceDigest}`}
          className={`u-flex u-gap-2 u-items-start${dense ? '' : ' surface-card u-p-3'}`}
        >
          {/* Decorative: the sentence beside it carries the whole meaning, so
              announcing a checkmark would add a word and no information. */}
          <span aria-hidden="true" className="u-mt-1"><CheckIcon size={16} /></span>
          <span>
            <span>{text}</span>
            {detail ? <span className="muted"> {detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
