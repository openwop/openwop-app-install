/**
 * XCH-WALK-1b tripwire (LLM-EXCHANGE-AUDIT) — every locale's Enrich prompt must
 * name the REAL Tour Author tool. The es/fr/pt-BR prompts carried the
 * pre-rename id `tours.register-draft` for a day (#1933) and nothing caught it:
 * the prompt strings are model-facing but no test read them. The pin is the
 * tool-id SUFFIX (`walkthroughs.register-draft`) — deliberately WITHOUT the
 * `openwop:` prefix, because provider tool-name sanitization strips/maps it,
 * so the suffix is the recognizable form in both raw and sanitized decls. The
 * backend half of the cross-tree pin is the allowlist guardrail test, which
 * pins the full id `openwop:walkthroughs.register-draft` in the baseline.
 */
import { describe, it, expect } from 'vitest';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const TOOL_SUFFIX = 'walkthroughs.register-draft';

describe('Enrich-with-AI prompt ↔ tool-id parity (all locales)', () => {
  it.each([['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as const)(
    '%s recordEnrichPrompt names the real tool',
    (_locale, catalog) => {
      const prompt = (catalog as Record<string, string>).recordEnrichPrompt;
      expect(prompt, 'recordEnrichPrompt must exist').toBeTruthy();
      expect(prompt).toContain(TOOL_SUFFIX);
      expect(prompt).not.toContain('tours.register-draft'); // the pre-rename id
    },
  );
});
