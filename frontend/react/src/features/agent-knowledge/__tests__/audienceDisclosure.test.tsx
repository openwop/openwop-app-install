/**
 * ADR 0664 D2 — the grant is real and intended; the disclosure was missing.
 *
 * ADR 0643 R3 decided that binding a corpus to an agent IS the grant: anyone who can address
 * that agent may retrieve it, and that access does not lapse when the binder's own does. This
 * ADR does not reverse that. It fixes the fact that the panel had ZERO strings saying so, so
 * a member could bind a private project corpus to a workspace-wide agent and be told nothing.
 *
 * Born red: `grep audience src/features/agent-knowledge/i18n/en.ts` returned nothing.
 *
 * The disclosure sits on the create-collection door because that is the SPA's actual grant
 * door — `bindCollection` exists in the client and has no importer. A test asserting copy on
 * a bind-existing control would be asserting a surface no user can reach.
 */
import { describe, expect, it } from 'vitest';
import { messages as en } from '../i18n/en';
import { messages as es } from '../i18n/es';
import { messages as fr } from '../i18n/fr';
import { messages as ptBR } from '../i18n/pt-BR';

const LOCALES: Record<string, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  es: es as unknown as Record<string, string>,
  fr: fr as unknown as Record<string, string>,
  'pt-BR': ptBR as unknown as Record<string, string>,
};

describe('ADR 0664 D2 — the audience disclosure', () => {
  it('exists in every locale and names the agent, so it says WHO can see it', () => {
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(bundle.audienceDisclosure, `${loc}: the disclosure must exist`).toBeTruthy();
      expect(bundle.audienceDisclosure, `${loc}: it must name the agent, not say "an agent"`).toContain('{{persona}}');
    }
  });

  it('states the part a reader would otherwise get wrong: access outlives the binder’s own', () => {
    // ADR 0643's recorded residual said only that a binding outlives its binder's MEMBERSHIP.
    // The wider fact — anyone who can use the agent, from the moment of binding — is what a
    // person needs BEFORE they bind, so the copy must carry it rather than imply it.
    expect(en.audienceDisclosure).toMatch(/not end when your own access/i);
    expect(en.audienceDisclosure).toMatch(/not in the project/i);
  });

  it('the restricted-collection warning is specific about the widening case', () => {
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(bundle.audienceBoundWarning, `${loc}: the restricted-collection warning must exist`).toBeTruthy();
      expect(bundle.audienceBoundWarning, `${loc}`).toContain('{{persona}}');
    }
  });

  it('notesHint no longer claims private-to-this-agent — that was never true', () => {
    // `AGKM-3`: notes survived a delete/re-create of the same persona, so "Private to this
    // agent" was false across that boundary. D1 closed the leak; the copy stops overclaiming
    // either way, because "private" was never the right word for something every user of the
    // agent can elicit.
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(bundle.notesHint, `${loc}: must not claim privacy it does not have`).not.toMatch(/private to this agent/i);
    }
    expect(en.notesHint).toMatch(/anyone who can use this agent/i);
  });

  it('every locale carries the same keys — a disclosure missing in one language is not a disclosure', () => {
    const keys = Object.keys(en).sort();
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(Object.keys(bundle).sort(), `${loc} key parity`).toEqual(keys);
    }
  });
});
