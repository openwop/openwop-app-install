/**
 * The ONE challenge-outline renderer (ADR 0458 §2.3) — mounted by the canvas
 * editor's read-only center preview AND any shared/card mount. A clean read
 * surface over the working-draft doc: the challenge header (meta) + its
 * outcomes/achievements context, then a card per day showing title, the
 * user-facing why, the action instruction, the effort/evidence chips, its
 * achievement links, and its publisher-declared alternatives.
 *
 * DESIGN.md primitives only (`surface-card`, `chip`, `list-plain`, utility type
 * classes) — tokens, never hex; ui/icons, never emoji.
 */
import { useTranslation } from 'react-i18next';
import { ClockIcon, ShieldIcon, CheckIcon, LifeBuoyIcon } from '../../ui/icons/index.js';
import { coerceOutlineDoc, type DayNode, type EvidencePolicy } from './types.js';

function useEvidenceLabel(): (p: EvidencePolicy) => string {
  const { t } = useTranslation('challenge-outline');
  return (p) => t(`evidence_${p}`);
}

function DayCard({ day, evidenceLabel, achievementText }: { day: DayNode; evidenceLabel: (p: EvidencePolicy) => string; achievementText: (id: string) => string | null }): JSX.Element {
  const { t } = useTranslation('challenge-outline');
  const p = day.props;
  return (
    <li className="surface-card co-day">
      <div className="action-bar co-day__head">
        <span className="chip chip--muted">{t('dayLabel', { day: p.day })}</span>
        <strong className="co-day__title">{p.title || t('untitledDay')}</strong>
        {p.isRecovery ? <span className="chip chip--warning"><LifeBuoyIcon size={12} /> {t('recoveryChip')}</span> : null}
      </div>
      {p.userFacingWhy ? <p className="co-day__why muted u-fs-13">{p.userFacingWhy}</p> : null}
      {p.actionInstruction ? <p className="co-day__instruction">{p.actionInstruction}</p> : null}
      <div className="action-bar">
        <span className="chip"><ClockIcon size={12} /> {t('minutesChip', { count: p.estimatedMinutes })}</span>
        <span className="chip"><ShieldIcon size={12} /> {evidenceLabel(p.evidencePolicy)}</span>
        {/* Screen-polish: the chip shows the HUMAN evidence text (a creator
            judges the participant experience here); the id demotes to the
            tooltip. Unresolvable ids stay honest as mono ids. */}
        {p.achievementIds.map((id) => (
          <span key={id} className="chip chip--muted" title={id}>
            <CheckIcon size={12} /> {achievementText(id) ?? id}
          </span>
        ))}
      </div>
      {day.children.length > 0 && (
        <div className="co-day__alts">
          <h4 className="u-fs-13 muted">{t('alternativesHeading', { count: day.children.length })}</h4>
          <ul role="list" className="list-plain">
            {day.children.map((alt, i) => (
              <li key={alt.props.stableActivityId || i} className="co-alt">
                <span className="co-alt__title">{alt.props.title || t('untitledAlt')}</span>
                <span className="chip chip--muted">{evidenceLabel(alt.props.evidencePolicy)}</span>
                {alt.props.actionInstruction ? <p className="muted u-fs-13">{alt.props.actionInstruction}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function OutlineRenderer({ content }: { content: string; editPaths?: boolean }): JSX.Element {
  const { t } = useTranslation('challenge-outline');
  const evidenceLabel = useEvidenceLabel();
  let doc;
  try {
    doc = coerceOutlineDoc(JSON.parse(content) as Record<string, unknown>);
  } catch {
    doc = coerceOutlineDoc({});
  }
  const days = doc.frames[0]?.days ?? [];

  return (
    <div className="co-renderer">
      <header className="co-header">
        <p className="co-eyebrow u-fs-13 muted">{t('draftEyebrow')}</p>
        <h2 className="co-header__title">{doc.meta.title}</h2>
        {doc.meta.promise ? <p className="co-header__lede">{doc.meta.promise}</p> : null}
        <div className="action-bar">
          {doc.meta.audience ? <span className="chip chip--muted">{t('audienceChip', { audience: doc.meta.audience })}</span> : null}
          <span className="chip">{t('durationChip', { count: doc.meta.durationDays })}</span>
          <span className="chip">{t('budgetChip', { count: doc.meta.dailyMinutesBudget })}</span>
          {doc.meta.depthLevel ? <span className="chip chip--muted">{t(`depth_${doc.meta.depthLevel}`)}</span> : null}
        </div>
      </header>

      {doc.outcomes.length > 0 && (
        <section className="surface-card">
          <h3 className="u-fs-13 muted">{t('outcomesHeading')}</h3>
          <ul role="list" className="list-plain">
            {doc.outcomes.map((o) => (
              <li key={o.outcomeId} className="list-row">
                <div>
                  <strong>{o.measurableOutcome || o.outcomeId}</strong>
                  {o.method ? <span className="muted u-fs-13"> · {o.method}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {doc.achievements.length > 0 && (
        <section className="surface-card">
          <h3 className="u-fs-13 muted">{t('achievementsHeading')}</h3>
          <ul role="list" className="list-plain">
            {doc.achievements.map((a) => (
              <li key={a.achievementId} className="list-row">
                <div>
                  <strong>{a.observableEvidence || a.achievementId}</strong>
                  {a.outcomeIds.length > 0 && (
                    <span className="muted u-fs-13"> · {t('linksOutcomes', { count: a.outcomeIds.length })}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="u-fs-13 muted">{t('daysHeading', { count: days.length })}</h3>
        {days.length === 0 ? (
          <p className="muted u-fs-13 co-empty">{t('daysEmpty')}</p>
        ) : (
          <ol role="list" className="list-plain co-days">
            {days.map((d, i) => (
              <DayCard key={d.props.stableActivityId || i} day={d} evidenceLabel={evidenceLabel}
                achievementText={(id) => doc.achievements.find((a) => a.achievementId === id)?.observableEvidence ?? null} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
