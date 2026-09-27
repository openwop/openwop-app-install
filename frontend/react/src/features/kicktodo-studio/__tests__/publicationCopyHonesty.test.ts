/**
 * ADR 0458 P4 / ADR 0437 §12 correction — the candidate workspace does NOT
 * submit or approve a publication (submission is the factory's terminal step
 * from the embedded chat; approval is the reviews inbox). Until 2026-09-15 the
 * page's notice told the creator both actions were "here in the publication
 * gate" while its own docblock said they were deferred. This pins the copy to
 * the decision in every locale: it must name the chat and the inbox, and must
 * never claim the actions live on this screen.
 */
import { describe, expect, it } from 'vitest';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const LOCALES: Record<string, { workspaceDeferredActions: string }> = { en, es, fr, 'pt-BR': ptBR };

// The phrases that made the old copy false: "are here in the publication gate".
const FALSE_CLAIMS: Record<string, RegExp> = {
  en: /are here in the publication gate/i,
  es: /est[aá]n aqu[ií] en la puerta de publicaci[oó]n/i,
  fr: /sont ici, dans le contr[oô]le de publication/i,
  'pt-BR': /ficam aqui, no gate de publica[cç][aã]o/i,
};

// What the honest copy must name: the conversation (submission) and the inbox (approval).
const NAMES_THE_INBOX: Record<string, RegExp> = {
  en: /reviews inbox/i,
  es: /bandeja de revisiones/i,
  fr: /bo[iî]te de revue/i,
  'pt-BR': /caixa de revis[oõ]es/i,
};
// The submission half. The steward's review of #3838 found the comment above
// promised this case and nothing asserted it: delete the sentence that says
// submission is driven from the conversation and the test stayed green while
// its own comment claimed otherwise. Now it reds.
const NAMES_THE_CONVERSATION: Record<string, RegExp> = {
  en: /driven from that conversation/i,
  es: /desde esa conversaci[oó]n/i,
  fr: /depuis cette conversation/i,
  'pt-BR': /a partir dessa conversa/i,
};

describe('candidate workspace publication copy is honest (ADR 0458 P4)', () => {
  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`${locale}: never claims submit/approve happen on this screen, and names the conversation and the inbox`, () => {
      const copy = bundle.workspaceDeferredActions;
      expect(copy).not.toMatch(FALSE_CLAIMS[locale]!);
      expect(copy).toMatch(NAMES_THE_CONVERSATION[locale]!);
      expect(copy).toMatch(NAMES_THE_INBOX[locale]!);
    });
  }
});
