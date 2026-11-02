/**
 * ADR 1001 D8 — the ONE field group for a multi-question clarification. Every
 * card that shows an agent's ask delegates here (the run page and inbox
 * `ClarificationDialog`, the chat feed's run card, the chat `ask-user` card);
 * each card keeps its own chrome and submit path.
 *
 * Text only: questions and choices are React text nodes — no markdown, no
 * links, no HTML — because they are model-authored and may echo tenant data.
 * Choices are native radios in a fieldset whose legend is the question (the
 * AutonomyPolicyPanel precedent), so arrow keys keep the radio contract.
 */
import { useId, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { TextareaField } from '../ui/Field.js';
import type { ClarifyQuestion, ClarifyValues } from './clarificationModel.js';

interface Props {
  questions: readonly ClarifyQuestion[];
  values: ClarifyValues;
  onChange: (id: string, value: string | boolean) => void;
  disabled?: boolean | undefined;
  /** Focus target for the first control; only the chat card passes one (an
   *  inline card on the run page must not take focus on mount, DESIGN.md §11). */
  firstFieldRef?: Ref<HTMLTextAreaElement | HTMLInputElement>;
}

export function ClarificationQuestions({ questions, values, onChange, disabled, firstFieldRef }: Props): JSX.Element {
  const { t } = useTranslation('interrupts');
  const baseId = useId();
  return (
    <div className="u-flex u-flex-col u-gap-3">
      {questions.map((q, qi) => {
        const name = `${baseId}-${qi}`;
        const ref = qi === 0 ? firstFieldRef : undefined;
        if (q.control.kind === 'text') {
          const v = values[q.id];
          // The question is a sentence: it heads the group in body type (a
          // bare legend), and the field keeps the short caption register
          // ("Your answer") — a field <label> is mono uppercase, which would
          // make a 500-character question shout.
          return (
            <fieldset key={q.id} className="u-border-0 u-p-0 u-m-0" disabled={disabled}>
              <legend className="u-fw-600 u-fs-13 u-mb-1">{q.question}</legend>
              <TextareaField
                ref={ref as Ref<HTMLTextAreaElement> | undefined}
                label={t('answerLabel')}
                rows={2}
                maxLength={q.control.maxLength}
                value={typeof v === 'string' ? v : ''}
                onChange={(e) => onChange(q.id, e.target.value)}
              />
            </fieldset>
          );
        }
        const options: Array<{ label: string; value: string | boolean }> = q.control.kind === 'choice'
          ? q.control.choices.map((c) => ({ label: c, value: c }))
          : [{ label: t('clarifyYes'), value: true }, { label: t('clarifyNo'), value: false }];
        return (
          <fieldset key={q.id} className="u-border-0 u-p-0 u-m-0" disabled={disabled}>
            <legend className="u-fw-600 u-fs-13 u-mb-1">{q.question}</legend>
            <div className="u-flex u-flex-col u-gap-1">
              {options.map((o, oi) => {
                const id = `${name}-${oi}`;
                return (
                  <label key={id} htmlFor={id} className="field-check-label u-flex u-items-start u-gap-2">
                    <input
                      id={id}
                      ref={oi === 0 ? (ref as Ref<HTMLInputElement> | undefined) : undefined}
                      type="radio"
                      name={name}
                      checked={values[q.id] === o.value}
                      onChange={() => onChange(q.id, o.value)}
                    />
                    <span className="u-min-w-0">{o.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
