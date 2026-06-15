/**
 * "Illustrative" badge — the data-honesty primitive (white-label PRD §9).
 *
 * Pin this on any panel whose numbers are EXAMPLE data rather than derived
 * from the live stores (a trend chart the store can't produce, a mocked
 * integration tile), so the app never lets fabricated data masquerade as real.
 * The stock app derives its surfaces from live stores and ships zero of
 * these; white-label forks add them wherever they stage example content.
 */
export function IllustrativeBadge({ detail }: {
  /** Optional hover explanation, e.g. "Example trend — not derived from your runs". */
  detail?: string;
}): JSX.Element {
  return (
    <span
      className="chip chip--muted illustrative-badge"
      title={detail ?? 'Illustrative example data — not derived from live records'}
    >
      Illustrative
    </span>
  );
}
