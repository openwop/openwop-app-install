/**
 * StructuredPromptEditor — a guided editor for an agent's system prompt /
 * instructions, organized into the canonical sections a good agent brief wants
 * (Role · Responsibilities · Voice · Tools · Escalation Rules · Guardrails ·
 * Examples). Each section is a compact Markdown field; the editor composes them
 * into ONE Markdown document (`## Role` … `## Examples`) which is the value the
 * host stores — so there's no new wire shape, just a nicer way to write the
 * same string.
 *
 * A "Raw Markdown" toggle drops to a single editor over the whole document for
 * power users (and for prompts authored elsewhere that don't follow the section
 * convention — those open in raw mode so nothing is silently restructured).
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownEditor } from '../ui/MarkdownEditor.js';

// `heading` is the structural Markdown token (`## Role`) that parsePrompt /
// composePrompt round-trip — it is NOT a display string and stays in English.
// `headingKey` / `hintKey` drive the localized labels shown to the author.
interface SectionDef { heading: string; headingKey: string; hintKey: string }

const SECTIONS: readonly SectionDef[] = [
  { heading: 'Role', headingKey: 'promptSectionRoleHeading', hintKey: 'promptSectionRoleHint' },
  { heading: 'Responsibilities', headingKey: 'promptSectionResponsibilitiesHeading', hintKey: 'promptSectionResponsibilitiesHint' },
  { heading: 'Voice', headingKey: 'promptSectionVoiceHeading', hintKey: 'promptSectionVoiceHint' },
  { heading: 'Tools', headingKey: 'promptSectionToolsHeading', hintKey: 'promptSectionToolsHint' },
  { heading: 'Escalation Rules', headingKey: 'promptSectionEscalationHeading', hintKey: 'promptSectionEscalationHint' },
  { heading: 'Guardrails', headingKey: 'promptSectionGuardrailsHeading', hintKey: 'promptSectionGuardrailsHint' },
  { heading: 'Examples', headingKey: 'promptSectionExamplesHeading', hintKey: 'promptSectionExamplesHint' },
];

const HEADINGS = SECTIONS.map((s) => s.heading);

interface Parsed { preamble: string; bodies: Record<string, string>; structured: boolean }

/** Split a system prompt into the known `## Section` bodies. Text before the
 *  first recognized heading is kept as `preamble`. `structured` is true when at
 *  least one known heading was found (used to choose the initial mode). */
function parsePrompt(value: string): Parsed {
  const bodies: Record<string, string> = {};
  const acc: Record<string, string[]> = {};
  HEADINGS.forEach((h) => { bodies[h] = ''; acc[h] = []; });
  const preamble: string[] = [];
  let current: string | null = null;
  let structured = false;
  // Track fenced code blocks so a `## Comment` line INSIDE ```…``` isn't
  // mistaken for a section boundary (it stays part of the current section's
  // body). A residual ambiguity remains for a literal `## Role` heading the user
  // types as prose outside a fence — that's inherent to the section convention.
  let inFence = false;
  for (const line of value.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m = /^##\s+(.+?)\s*$/.exec(line);
      if (m) {
        const name = HEADINGS.find((h) => h.toLowerCase() === m[1]!.toLowerCase());
        if (name) { current = name; structured = true; continue; }
      }
    }
    if (current) acc[current]!.push(line);
    else preamble.push(line);
  }
  HEADINGS.forEach((h) => { bodies[h] = acc[h]!.join('\n').trim(); });
  return { preamble: preamble.join('\n').trim(), bodies, structured };
}

function composePrompt(preamble: string, bodies: Record<string, string>): string {
  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trim());
  for (const h of HEADINGS) {
    const body = bodies[h]?.trim();
    if (body) parts.push(`## ${h}\n\n${body}`);
  }
  return parts.join('\n\n');
}

export function StructuredPromptEditor({
  value,
  onChange,
  autosaveKey,
}: {
  value: string;
  onChange: (value: string) => void;
  autosaveKey?: string;
}): JSX.Element {
  const { t } = useTranslation('agents');
  // Parse once on mount — the parent re-seeds by remounting (key), not by
  // pushing a new `value` mid-edit, so we never re-parse over live edits.
  const initial = useMemo(() => parsePrompt(value), [value]);
  const [mode, setMode] = useState<'guided' | 'raw'>(
    initial.structured || !value.trim() ? 'guided' : 'raw',
  );
  const [bodies, setBodies] = useState<Record<string, string>>(initial.bodies);
  const [preamble, setPreamble] = useState(initial.preamble);
  const [text, setText] = useState(value);

  const emit = (next: string) => { setText(next); onChange(next); };

  const setSection = (heading: string, body: string) => {
    const next = { ...bodies, [heading]: body };
    setBodies(next);
    emit(composePrompt(preamble, next));
  };

  const setPreambleBody = (body: string) => {
    setPreamble(body);
    emit(composePrompt(body, bodies));
  };

  const switchToGuided = () => {
    const p = parsePrompt(text);
    setBodies(p.bodies);
    setPreamble(p.preamble);
    setMode('guided');
  };

  return (
    <div>
      <div className="u-flex u-justify-between u-items-center u-gap-2 u-wrap u-mb-2">
        <span className="muted u-fs-12">
          {mode === 'guided'
            ? t('promptGuidedHint')
            : t('promptRawHint')}
        </span>
        <div className="u-iflex u-gap-1">
          <button
            type="button"
            className={mode === 'guided' ? 'primary btn-sm' : 'secondary btn-sm'}
            aria-pressed={mode === 'guided'}
            onClick={switchToGuided}
          >
            {t('promptGuidedSections')}
          </button>
          <button
            type="button"
            className={mode === 'raw' ? 'primary btn-sm' : 'secondary btn-sm'}
            aria-pressed={mode === 'raw'}
            onClick={() => setMode('raw')}
          >
            {t('promptRawMarkdown')}
          </button>
        </div>
      </div>

      {mode === 'raw' ? (
        <MarkdownEditor
          value={text}
          onChange={emit}
          rows={12}
          monospace
          autosaveKey={autosaveKey}
          placeholder={'## Role\n\nYou are …\n\n## Responsibilities\n\n- …'}
          ariaLabel={t('promptSystemPromptAria')}
        />
      ) : (
        <div className="u-flex u-flex-col u-gap-3">
          {preamble.trim() ? (
            <div>
              <div className="u-fs-13 u-fw-600">{t('promptIntro')}</div>
              <p className="structprompt-hint">{t('promptIntroHint')}</p>
              <MarkdownEditor value={preamble} onChange={setPreambleBody} rows={3} compact ariaLabel={t('promptIntro')} />
            </div>
          ) : null}
          {SECTIONS.map((s) => (
            <div key={s.heading}>
              <div className="u-fs-13 u-fw-600">{t(s.headingKey)}</div>
              <p className="structprompt-hint">{t(s.hintKey)}</p>
              <MarkdownEditor
                value={bodies[s.heading] ?? ''}
                onChange={(v) => setSection(s.heading, v)}
                rows={3}
                compact
                ariaLabel={t(s.headingKey)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
