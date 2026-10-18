/**
 * XCH-WALK-1b tripwire (LLM-EXCHANGE-AUDIT) — every locale's Enrich prompt must
 * name the REAL Tour Author tool. The es/fr/pt-BR prompts carried the
 * pre-rename id `tours.register-draft` for a day (#1933) and nothing caught it:
 * the prompt strings are model-facing but no test read them. The pin is the
 * tool-id SUFFIX — deliberately WITHOUT the `openwop:` prefix, because provider
 * tool-name sanitization strips/maps it, so the suffix is the recognizable form
 * in both raw and sanitized decls.
 *
 * w51 r2 (/grade-tests): the suffix is READ from the SSoT — the backend's
 * `WALKTHROUGH_REGISTER_DRAFT_TOOL_ID` — instead of a hand-written literal, so a
 * tool rename reds every locale here (probe ep-backend-id was vacuous against the
 * copy). The backend half is the allowlist guardrail test, which pins the full id
 * in the baseline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const TOOL_SRC = readFileSync(
  join(process.cwd(), '../../backend/typescript/src/features/walkthroughs/walkthroughAuthorTool.ts'),
  'utf8',
);
const TOOL_ID = /export const WALKTHROUGH_REGISTER_DRAFT_TOOL_ID = '([^']+)'/.exec(TOOL_SRC)?.[1];
const TOOL_SUFFIX = (TOOL_ID ?? '').replace(/^openwop:/, '');

describe('Enrich-with-AI prompt ↔ tool-id parity (all locales)', () => {
  it('reads the real tool id from the backend SSoT (non-vacuous)', () => {
    expect(TOOL_ID, 'WALKTHROUGH_REGISTER_DRAFT_TOOL_ID not found in walkthroughAuthorTool.ts').toMatch(/^openwop:[\w.-]+\.[\w.-]+$/);
    expect(TOOL_SUFFIX).not.toBe('');
  });

  it.each([['en', en.recordEnrichPrompt], ['es', es.recordEnrichPrompt], ['fr', fr.recordEnrichPrompt], ['pt-BR', ptBR.recordEnrichPrompt]] as const)(
    '%s recordEnrichPrompt names the real tool',
    (_locale, prompt) => {
      expect(prompt, 'recordEnrichPrompt must exist').toBeTruthy();
      expect(prompt).toContain(TOOL_SUFFIX);
      expect(prompt).not.toContain('tours.register-draft'); // the pre-rename id
    },
  );
});
